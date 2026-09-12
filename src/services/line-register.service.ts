// TASK-347 (`REQ-088`) — **the registration DECISIONS, extracted ONCE. Two doors, one decision.**
//
// 🔴 The finding under `REQ-088`: the customer's parents do not TYPE `สมัคร`. The 8-screen chat flow has a
// failure mode no copy fixes ⇒ a PAGE. **The LOGIC existed — the SURFACE did not.** But the logic lived inside
// `line-webhook.service.ts`, wrapped in reply-tokens and session steps, and a page needs the decision WITHOUT
// the replies. This file is TASK-315's `afterParentLink` shape applied to the whole link/create sequence.
//
// 🔑 **RULE 1, verbatim from the task:** ***the page calls the SAME writer the chat calls. If the page grows a
// rule of its own, it is wrong.*** ⇒ every function here is called by BOTH doors, and the chat keeps only its
// REPLIES. `line-register-req088.test.ts` asserts the absence of a second copy on both sides.
//
// 🚫 Nothing here renders a word. Outcomes are discriminated unions; the chat maps them to `t()` keys and the
// page maps them to CODES. **The server owns decisions; the surfaces own words.**
import { eq } from "drizzle-orm";
import { db } from "../db";
import { lineLinkSessions, parents, teachers } from "../db/schema";
import { bindFamilyLine, familyOfLineUser } from "../lib/family-link";
import { getProfileLang } from "../lib/line-client";
import { linkKnownRichMenu, linkRoleRichMenu } from "../lib/line-rich-menu";
import type { Lang } from "../lib/line-i18n";
import { notifyAdmins } from "../lib/line-admin";
import { isReservedWord } from "../lib/line-commands";
import { decideDuplicate, parseBirthDate } from "../lib/line-add-student";
import { moveRosterLink } from "../lib/roster-link";
import { getSetting } from "./settings.service";
import {
  MAX_STUDENTS_PER_PARENT,
  assertCanAddStudent,
  createStudentForParent,
  findOrCreateParentByPhone,
  findParentByLineUserId,
  findParentByPhone,
  linkParentLine,
  listStudentsOfParent,
  normalizePhone,
} from "./parent.service";

type ParentRow = typeof parents.$inferSelect;

// ── the 2FA switch — READ by both doors, so neither is a door that ignores it (Rule 3) ─────────────────────
/** `line_parent_2fa`: off today, and it ships as a SETTING so turning it on is never a rebuild (TASK-232). */
export async function twoFaEnabled(): Promise<boolean> {
  return (await getSetting("line_parent_2fa")).value === "on";
}

// ── the chat's session row: cleared by BOTH doors on success (Rule 4) ─────────────────────────────────────
/** Drop the chat wizard's row. A parent may have half-started `สมัคร` before an admin sent the link. */
export async function clearLinkSession(lineUserId: string) {
  await db.delete(lineLinkSessions).where(eq(lineLinkSessions.lineUserId, lineUserId));
}

// ── the 2FA challenge, parked on the chat's session row — ONE writer and ONE reader of `draft.twoFaCode` ──
/**
 * TASK-232 — park the 2FA challenge on the session (`draft`, not `pending_role` — TASK-233's reasoning stands).
 * 🔻 TASK-347 — moved here and made an UPSERT: the chat always has a row at this point (it is at `AWAIT_CODE`),
 * the page has none. Same column, same shape, same step; both doors write it through this one function.
 */
export async function setTwoFaChallenge(lineUserId: string, code: string) {
  await db
    .insert(lineLinkSessions)
    .values({ lineUserId, step: "AWAIT_2FA", draft: { twoFaCode: code } })
    .onConflictDoUpdate({
      target: lineLinkSessions.lineUserId,
      set: { step: "AWAIT_2FA", draft: { twoFaCode: code }, updatedAt: new Date() },
    });
}

/** The parked challenge, read back through one accessor so `draft`'s shape has a single reader. */
export const twoFaCodeOf = (session: { draft?: Record<string, unknown> | null } | null | undefined): string | null =>
  typeof session?.draft?.twoFaCode === "string" ? (session.draft.twoFaCode as string) : null;

/** The same accessor for a door that has no session row in hand (the page). */
export async function parkedTwoFaCode(lineUserId: string): Promise<string | null> {
  const row = await db.query.lineLinkSessions.findFirst({ where: (s, { eq: e }) => e(s.lineUserId, lineUserId) });
  return twoFaCodeOf(row as any);
}

// ── PHONE → FAMILY: the one lookup decision ────────────────────────────────────────────────────────────────
/**
 * The three refusals a phone can earn, and the two ways it can succeed. **Exactly `verifyAndLink`'s customer
 * branch, as a value instead of a reply** — the chat's `verify_parent_badphone` / `verify_parent_other` /
 * `verify_parent_other_family` keys map 1:1 onto the three refusals.
 */
export type PhoneLookup =
  | { outcome: "found"; parent: ParentRow; children: unknown[] }
  | { outcome: "new"; phone: string }
  | { outcome: "phone-invalid" }
  | { outcome: "phone-bound-to-other-line" }
  | { outcome: "line-bound-to-other-family" };

/**
 * READ-ONLY. `phone` as typed; the digits are the key (TASK-278 §6).
 * 🔑 `line-bound-to-other-family` is PRE-CHECKED here without writing, so a page can say it before a tap —
 * and `linkFamilyByPhone` re-checks it at the write, because a lookup is never trusted by the write.
 */
export async function lookupFamilyByPhone(lineUserId: string, code: string): Promise<PhoneLookup> {
  const phone = normalizePhone(code);
  if (phone.length < 9) return { outcome: "phone-invalid" };
  const existing = await findParentByPhone(phone);
  if (!existing) return { outcome: "new", phone };
  if (existing.lineUserId && existing.lineUserId !== lineUserId) return { outcome: "phone-bound-to-other-line" };
  const current = await familyOfLineUser(lineUserId);
  if (current && current !== existing.id) return { outcome: "line-bound-to-other-family" };
  return { outcome: "found", parent: existing, children: await listStudentsOfParent(existing.id) };
}

export type FamilyLink =
  | { outcome: "linked"; parent: ParentRow; children: unknown[]; isNew: boolean }
  | Exclude<PhoneLookup, { outcome: "found" } | { outcome: "new" }>;

/**
 * ✍️ THE BIND — `verifyAndLink`'s customer writes, in the chat's order, minus every reply:
 * find-or-create the parent by phone · `bindFamilyLine` (the refusal the unique index would otherwise throw
 * as a `23505`) · `linkParentLine` · `moveRosterLink` (a role change moves the link, TASK-046).
 * 🔑 A NEW phone creates the parent HERE (`isNew: true`, children `[]`) — so the page's `/create` always means
 * one thing, and `afterParentLink`'s "children ⇒ no forced add" decision is rendered from `children.length`
 * by both doors rather than decided twice.
 */
export async function linkFamilyByPhone(lineUserId: string, code: string): Promise<FamilyLink> {
  const phone = normalizePhone(code);
  if (phone.length < 9) return { outcome: "phone-invalid" };
  const existing = await findParentByPhone(phone);
  if (existing) {
    if (existing.lineUserId && existing.lineUserId !== lineUserId) return { outcome: "phone-bound-to-other-line" };
    // 🔴 SPEC-071 / TASK-232 — the mirror of the check above, and the one the unique index enforces: this LINE
    // ACCOUNT may already belong to a different family. Refused here so the parent gets something they can act
    // on instead of a `23505`, and refused at all because the alternative is silently re-pointing an account —
    // a parent opening the app to **another family's children** (TASK-047's failure, other route).
    const bind = await bindFamilyLine(existing.id, lineUserId);
    if (!bind.ok) return { outcome: "line-bound-to-other-family" };
    await linkParentLine(existing.id, lineUserId);
    await moveRosterLink(lineUserId, "customer");
    return { outcome: "linked", parent: existing, children: await listStudentsOfParent(existing.id), isNew: false };
  }
  // A NEW phone — EXACTLY the chat's two lines: the parent row is created with this account as its primary
  // (`parents.line_user_id`, which `familyOfLineUser` reads as the fallback), and the roster link moves.
  // 🚫 No `bindFamilyLine` here and no "is this account already someone's" check — because the CHAT has neither.
  // ⚠️ NAMED, NOT FIXED (TASK-347 report): an account already bound to family A that enters a NEW phone creates
  // an orphan parent B carrying its id, and `familyOfLineUser` keeps answering A. That is the chat's behaviour
  // today; adding the guard HERE would give it to both doors — and change the chat, which this task forbids.
  const parent = await findOrCreateParentByPhone(phone, { lineUserId });
  await moveRosterLink(lineUserId, "customer");
  return { outcome: "linked", parent, children: [], isNew: true };
}

/**
 * What the chat does AFTER a successful link and BEFORE it clears or advances the session — seed the language
 * from the LINE profile, then link the role's rich menu (and, for a family, the รู้จักแล้ว menu, TASK-234).
 * 🔑 Extracted so a page-registered parent lands in EXACTLY the chat's end state, in the chat's ORDER:
 * lang → menus → session. ⚠️ Best-effort on purpose, as the chat has always treated it: a menu that fails to
 * link is logged, not fatal — the parent is linked either way.
 */
export async function settleLinkedRole(lineUserId: string, role: "customer" | "teacher"): Promise<Lang> {
  const seed: Lang = (await getProfileLang(lineUserId)) ?? "TH";
  await Promise.all([
    db.update(teachers).set({ lineLang: seed }).where(eq(teachers.lineUserId, lineUserId)),
    db.update(parents).set({ lineLang: seed }).where(eq(parents.lineUserId, lineUserId)),
  ]).catch((e) => console.error("[line-register] seed lang failed:", e));
  try {
    await linkRoleRichMenu(lineUserId, role, seed);
    if (role === "customer") await linkKnownRichMenu(lineUserId, seed);
  } catch (e) {
    console.error("[line-register] linkRoleRichMenu failed:", e);
  }
  return seed;
}

// ── ADD A CHILD: the guards, in the chat's order, into the ONE writer ──────────────────────────────────────
/**
 * 🔴 TASK-314 — AC-9's duplicate rule, where BOTH doors reach it. The rule's whole content is *"ask for MORE
 * DETAIL, never demand a rename"*; the decision itself is the pure `decideDuplicate`.
 */
export async function duplicateOutcomeFor(parentId: string, name: string) {
  const siblings = await listStudentsOfParent(parentId);
  return decideDuplicate(siblings.map((s: any) => s.name), name);
}

/**
 * 🔴 TASK-314 — the ONE LINE-side student creator, and AC-11 lives in it: **the admin is told, on every door.**
 * ⚠️ It is HERE and not in `createStudentForParent`, because that service function is also the staff screen's
 * write — an admin adding a student would then be notified of their own act. The rule is *"a parent registered
 * a child over LINE"*, and this is the LINE side. Order unchanged: the row first, then the message.
 * 🔻 TASK-347 — the household `province` write JOINS the writer. The chat wrote it beside the student in its
 * confirm step; the page would otherwise need a second call. **One writer, one place, both doors.**
 */
export async function createStudentFromLine(
  parent: { id: string; phone: string },
  input: { name: string; birthDate?: string | null; province?: string | null },
) {
  const created = await createStudentForParent(parent.id, { name: input.name, birthDate: input.birthDate ?? null });
  if (input.province) {
    await db.update(parents).set({ province: input.province }).where(eq(parents.id, parent.id));
  }
  await notifyAdmins({ kind: "student_registered", studentName: created.student.name, parentPhone: parent.phone });
  return created;
}

export type AddChild =
  | { outcome: "created"; student: { id: string; name: string }; birthDate: string | null; count: number; atMax: boolean }
  | { outcome: "not-linked" }
  | { outcome: "name-required" }
  | { outcome: "name-reserved"; word: string }
  | { outcome: "family-full"; max: number }
  | { outcome: "name-duplicate-needs-detail"; name: string }
  | { outcome: "birthdate-invalid" };

/**
 * ✍️ The page's whole add-child sequence — **the chat's guards, in the chat's ORDER, through the chat's
 * functions**: `isReservedWord` (TASK-245) → `assertCanAddStudent` (the cap, asked FIRST so nobody fills a form
 * and is refused at the end — the chat's own ordering, SA instruction) → `duplicateOutcomeFor` (skipped when
 * detail was already provided, exactly as the chat skips it at `AWAIT_STUDENT_DETAIL`) → `parseBirthDate`
 * (day-first text, refusing ISO on purpose — the SAME parser) → `createStudentFromLine`.
 * 📌 The chat cannot call this composition because it asks its questions one STEP at a time; what it calls is
 * every function in it, in this order. The order is asserted against the chat's source.
 */
export async function addChildForLineParent(
  lineUserId: string,
  input: { name: string; birthDate?: string | null; province?: string | null; detailProvided?: boolean },
): Promise<AddChild> {
  const parent = await findParentByLineUserId(lineUserId);
  if (!parent) return { outcome: "not-linked" };
  const name = (input.name ?? "").trim();
  if (!name) return { outcome: "name-required" };
  if (isReservedWord(name)) return { outcome: "name-reserved", word: name };
  try {
    await assertCanAddStudent(parent.id);
  } catch {
    return { outcome: "family-full", max: MAX_STUDENTS_PER_PARENT };
  }
  if (!input.detailProvided && (await duplicateOutcomeFor(parent.id, name)) === "more-detail") {
    return { outcome: "name-duplicate-needs-detail", name };
  }
  // 🔑 ข้าม on this door is an ABSENT field (contract §C3), not the word: an empty value is the skip. Any value
  // that IS provided goes through the chat's parser unchanged — same day-first rule, same refusal of ISO.
  // ⚠️ Caught by the test before it shipped: `parseBirthDate("")` is a REFUSAL, not a skip — only the word is.
  const given = (input.birthDate ?? "").trim();
  const parsed = given ? parseBirthDate(given) : ({ ok: true, value: null } as const);
  if (!parsed.ok) return { outcome: "birthdate-invalid" };
  const province = (input.province ?? "").trim() || null;
  const { student, count } = await createStudentFromLine(parent, { name, birthDate: parsed.value, province });
  return {
    outcome: "created",
    student: { id: student.id, name: student.name },
    birthDate: parsed.value,
    count,
    atMax: count >= MAX_STUDENTS_PER_PARENT,
  };
}

