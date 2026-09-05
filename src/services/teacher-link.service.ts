// REQ-020 Stage 2 / TASK-075 — teacher link requests: queue, approve, reject, unlink.
//
// 🔐 **`approveTeacherLinkRequest` is the ONLY code path in this app that sets `teachers.lineUserId` to a
// non-null value.** (The two places that set it to `null` are unlink, below, and the role-move in
// `line-webhook.service.ts` — clearing a link grants nothing.) That single-writer property is what the whole
// task buys: "how did this account get linked?" has exactly one answer.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { teacherLinkRequests, teachers } from "../db/schema";
import { badRequest, conflict, notFound } from "../lib/http";
import {
  APPROVAL_MESSAGE,
  claimQueues,
  decideApproval,
  decideClaim,
  type ClaimOutcome,
} from "../lib/teacher-link";
import { moveRosterLink } from "../lib/roster-link";
import { linkRoleRichMenu, unlinkRichMenuFromUser } from "../lib/line-rich-menu";
import { enqueueLine } from "../lib/line";
import { t, type Lang } from "../lib/line-i18n";

/** The teacher's own stored language, so the approval notice arrives in the language they chose. */
const resolveLangOf = (teacher: { lineLang?: string | null } | null | undefined): Lang =>
  teacher?.lineLang === "EN" ? "EN" : "TH";

/**
 * A nickname claim from the LINE bot. Creates or refreshes ONE pending request; never links anything.
 *
 * Re-claiming updates the existing PENDING row (the partial unique index makes a duplicate impossible even
 * if two messages race), so a confused teacher retrying three times leaves staff one row, not three.
 */
export async function requestTeacherLink(
  lineUserId: string,
  claimedNickname: string,
): Promise<ClaimOutcome> {
  const nick = claimedNickname.trim();
  const rows = await db.select().from(teachers);
  const matches = rows.filter((t) => t.nickname.toLowerCase() === nick.toLowerCase());
  const outcome = decideClaim(matches, lineUserId);
  if (!claimQueues(outcome)) return outcome;

  // Ambiguous → no teacher on the row; staff name them at approval. Never guess.
  const teacherId = outcome === "pending" ? (matches.find((t) => !t.archived)?.id ?? null) : null;

  const existing = await db.query.teacherLinkRequests.findFirst({
    where: (r, { and: a, eq: e }) => a(e(r.lineUserId, lineUserId), e(r.status, "PENDING")),
  });
  if (existing) {
    await db
      .update(teacherLinkRequests)
      .set({ claimedNickname: nick, teacherId, createdAt: new Date() })
      .where(eq(teacherLinkRequests.id, existing.id));
  } else {
    await db.insert(teacherLinkRequests).values({ lineUserId, claimedNickname: nick, teacherId });
  }
  return outcome;
}

/** Staff queue. Pending first and newest last is deliberate: it reads as a worklist, oldest at the top. */
export async function listTeacherLinkRequests(status = "PENDING") {
  const rows = await db
    .select({
      id: teacherLinkRequests.id,
      lineUserId: teacherLinkRequests.lineUserId,
      claimedNickname: teacherLinkRequests.claimedNickname,
      teacherId: teacherLinkRequests.teacherId,
      status: teacherLinkRequests.status,
      createdAt: teacherLinkRequests.createdAt,
      decidedAt: teacherLinkRequests.decidedAt,
      decidedBy: teacherLinkRequests.decidedBy,
    })
    .from(teacherLinkRequests)
    .where(eq(teacherLinkRequests.status, status))
    .orderBy(desc(teacherLinkRequests.createdAt));

  // Candidates for a collision request, so the FE can offer the actual choice rather than a free-text id.
  const all = await db.select().from(teachers);
  // ⚠️ The raw LINE userId is **dropped**, not blanked: it's an account identifier, and the queue only needs
  // enough to tell two rows apart. Destructured out so nothing can re-add it by spreading the row.
  return rows.map(({ lineUserId, ...r }) => ({
    ...r,
    lineUserRef: `${lineUserId.slice(0, 6)}…`,
    // Candidates for a collision, so the FE offers the actual choice instead of a free-text id — and staff
    // physically cannot approve one without naming someone.
    candidates: all
      .filter((t) => !t.archived && t.nickname.toLowerCase() === r.claimedNickname.toLowerCase())
      .map((t) => ({ id: t.id, nickname: t.nickname, name: t.name })),
  }));
}

export async function countPendingTeacherLinks(): Promise<number> {
  return (
    await db
      .select({ id: teacherLinkRequests.id })
      .from(teacherLinkRequests)
      .where(eq(teacherLinkRequests.status, "PENDING"))
  ).length;
}

/**
 * 🔐 The single grant path. Re-validates everything at decision time — between the request and now the
 * teacher may have been linked, archived or deleted, and approving must fail cleanly rather than overwrite.
 */
export async function approveTeacherLinkRequest(
  id: string,
  input: { teacherId?: string; decidedBy?: string } = {},
) {
  const request = await db.query.teacherLinkRequests.findFirst({
    where: (r, { eq: e }) => e(r.id, id),
  });
  if (!request) throw notFound("ไม่พบคำขอผูกบัญชี");

  const candidateId = request.teacherId ?? input.teacherId ?? null;
  const teacher = candidateId
    ? await db.query.teachers.findFirst({ where: (t, { eq: e }) => e(t.id, candidateId) })
    : null;

  const decision = decideApproval(request, input.teacherId, teacher);
  if (!decision.ok) {
    const message = APPROVAL_MESSAGE[decision.error];
    // "Needs more input" vs "the world moved under you" are different problems for the person clicking.
    throw decision.error === "teacher-required" || decision.error === "teacher-missing"
      ? badRequest(message)
      : conflict(decision.error.toUpperCase().replace(/-/g, "_"), message);
  }

  // 🔐 THE grant. Nothing else in the app sets `teachers.lineUserId` to a non-null value.
  await db
    .update(teachers)
    .set({ lineUserId: request.lineUserId })
    .where(eq(teachers.id, decision.teacherId));
  await db
    .update(teacherLinkRequests)
    .set({
      status: "APPROVED",
      teacherId: decision.teacherId,
      decidedAt: new Date(),
      decidedBy: input.decidedBy ?? null,
    })
    .where(eq(teacherLinkRequests.id, id));

  // One LINE account = one role — the same roster move the immediate-link flow did (TASK-046). It has to
  // happen HERE now, because approval is where the link is actually granted.
  await moveRosterLink(request.lineUserId, "teacher");

  const lang = resolveLangOf(teacher);
  // Best-effort side effects: the link is already granted and must not be rolled back because LINE is down.
  // Loud on failure — TASK-066's lesson: a silent `void` is how a broken step goes unnoticed for days.
  try {
    await linkRoleRichMenu(request.lineUserId, "teacher", lang);
  } catch (e) {
    console.error("[teacher-link] approved but rich-menu link failed:", e);
  }
  // The bot promised "you'll be told once it's approved" — not sending would make it a lie.
  await enqueueLine({
    recipientType: "teacher",
    recipientLineUserId: request.lineUserId,
    payload: { kind: "teacher_link_approved", text: t("verify_teacher_ok", lang, { nick: teacher!.nickname }) },
  }).catch((e) => console.error("[teacher-link] approval notice not enqueued:", e));

  return { ok: true as const, teacherId: decision.teacherId, lineUserId: request.lineUserId };
}

export async function rejectTeacherLinkRequest(id: string, decidedBy?: string) {
  const [row] = await db
    .update(teacherLinkRequests)
    .set({ status: "REJECTED", decidedAt: new Date(), decidedBy: decidedBy ?? null })
    .where(and(eq(teacherLinkRequests.id, id), eq(teacherLinkRequests.status, "PENDING")))
    .returning();
  if (!row) throw notFound("ไม่พบคำขอที่รออนุมัติ");
  return { ok: true as const };
}

/**
 * Unlink a teacher's LINE account. A departed teacher otherwise keeps receiving schedule pushes forever with
 * no way to stop it. Reversible by design — they can claim again, which queues a normal request.
 */
export async function unlinkTeacherLine(teacherId: string) {
  // 🔴 TASK-249 — the SECOND DB link-clear (the grep @Sober asked for). Same defect as C-13, other role: a
  // departed teacher kept `ตารางของฉัน` on their phone, the buttons of an account they no longer have.
  // ⚠️ Read the account BEFORE the write — `returning()` hands back the row as it now IS, and by then the id
  // needed to unlink the menu is already `null`.
  const before = await db.query.teachers.findFirst({ where: (t2, { eq: e }) => e(t2.id, teacherId) });
  const [row] = await db
    .update(teachers)
    .set({ lineUserId: null })
    .where(eq(teachers.id, teacherId))
    .returning();
  if (!row) throw notFound("ไม่พบครู");
  // Best-effort, and after the write: an unreachable Messaging API must not fail an unlink the database has
  // already made true.
  if (before?.lineUserId) {
    await unlinkRichMenuFromUser(before.lineUserId).catch((e) =>
      console.error(`[teacher-link] menu unlink failed for ${before.lineUserId} (the DB link IS cleared):`, e),
    );
  }
  return { ok: true as const, teacherId };
}
