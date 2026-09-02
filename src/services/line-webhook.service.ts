// LINE OA webhook handler — role verification (C.4) + parent self-service, tap-driven (REQ-015) and bilingual
// TH/EN (TASK-039). Every user-facing string comes from `line-i18n` (`t(key, lang, vars)`); the user's language
// is resolved once per event from their LINE-link record (default TH, seeded from locale on link, toggled by the
// language button). Rich-menu/quick-reply taps arrive as postback events routed to the SAME handlers as keywords.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { lineLinkSessions, parents, teachers } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { getProfileLang, replyMessage, type LineMessage } from "../lib/line-client";
import {
  eventPostbackData,
  eventText,
  eventUserId,
  parsePostback,
  parseRoleChoice,
  type LineWebhookEvent,
} from "../lib/line-webhook";
import { addAdminLineUserId, getAdminLineUserIds } from "../lib/line-admin";
import { bookingPicker, childPicker, childrenFlex, textReply } from "../lib/line-reply";
import { childrenWithSessions, sessionLabel, needsChildStep } from "../lib/line-leave";
import { leaveCutoffKey, leaveNoticeMessage } from "../lib/leave-notice";
import { getSetting } from "./settings.service";
import {
  formatDroppedPostback,
  formatInboundEvent,
  formatUnknownAction,
} from "../lib/line-log";
import { linkRoleRichMenu } from "../lib/line-rich-menu";
import { t, type Lang } from "../lib/line-i18n";
import { resolveBotLang as resolveLang } from "../lib/line-lang";
import {
  decideMessageRoute,
  isSessionExpired,
  muteUntilFrom,
  shouldHandOver,
} from "../lib/line-routing";
import { moveRosterLink } from "../lib/roster-link";
import { parentChildrenNames, parentChildrenNote } from "../lib/line-pairing";
import { deliver2faCode, generate2faCode, matches2faCode } from "../lib/line-2fa";
import { bindFamilyLine } from "../lib/family-link";
import { claimReplyKey } from "../lib/teacher-link";
import { requestTeacherLink } from "./teacher-link.service";
import { calendarUrls } from "../lib/calendar-link";
import { isSuspended } from "../lib/suspend";
import { getCalendarTokenForLineUser } from "./calendar.service";
import {
  MAX_STUDENTS_PER_PARENT,
  createStudentForParent,
  findOrCreateParentByPhone,
  findParentByLineUserId,
  findParentByPhone,
  linkParentLine,
  listStudentsOfParent,
  normalizePhone,
} from "./parent.service";
import { hhmm, weekRange } from "../lib/time";
import { renderSchedule } from "../lib/line-schedule";
import {
  checkinByToken,
  findBookingsForTeacher,
  findTodayBookingsForParent,
  getCheckinQr,
} from "./checkin.service";
import { updateBookingStatus } from "./scheduler.service";

const SKIP_WORDS = ["ข้าม", "ไม่", "ไม่เพิ่ม", "เสร็จ", "จบ", "skip", "no", "done"];

/** Every postback action this handler has a branch for — anything else is logged as UNHANDLED (TASK-045). */
const KNOWN_POSTBACK_ACTIONS = new Set([
  "lang",
  "schedule",
  "calendar",
  "checkin",
  "qr",
  "leave",
  "children",
  "register",
  "menu",
  "help",
]);

type LinkRole = "customer" | "teacher" | "admin";
/**
 * TASK-232: `needs2fa` + `code` are set ONLY when the 2FA setting is on. The caller turns them into an
 * `AWAIT_2FA` session step — the branch, not a second flow.
 */
type VerifyResult = { ok: boolean; message: string; needs2fa?: boolean; code?: string };

async function reply(replyToken: string, text: string) {
  await replyMessage(replyToken, [{ type: "text", text }]);
}

async function send(replyToken: string, messages: LineMessage[]) {
  await replyMessage(replyToken, messages);
}

/**
 * 🔴 TASK-231 (reopened) — the TTL lives HERE, at the source, not in the router.
 *
 * The router is one caller; a rule at the source gives **every** reader the same answer, which is why a stale
 * row simply stops being found rather than being special-cased downstream. An expired session is not deleted —
 * it stays for the record — it just stops owning the chat, and silence then follows from the rules already
 * built rather than from a second mechanism.
 *
 * This is the fix for what §16 actually reported: an abandoned `สมัคร` used to leave a chat treating every
 * message it ever sent as a code attempt, forever. `สมัคร` still restarts from any state, so the cost of
 * expiring is one word retyped.
 */
async function getSession(lineUserId: string) {
  const row = await db.query.lineLinkSessions.findFirst({
    where: (s, { eq: e }) => e(s.lineUserId, lineUserId),
  });
  if (!row) return undefined;
  return isSessionExpired(row.updatedAt) ? undefined : row;
}

/**
 * ⚠️ The trap that makes the TTL safe rather than dangerous: **only `setStep` used to write this row.** A
 * parent retrying inside one step — a wrong code twice — would not have touched it, so a 30-minute window
 * would have run against someone who *is* actively replying and dropped them mid-registration.
 *
 * So every inbound message a session HANDLES refreshes it. `updated_at` carries `$onUpdate`, so this is a
 * no-op write whose only purpose is the timestamp — which is exactly what makes the window mean *inactivity*
 * instead of *age*.
 */
async function touchSession(lineUserId: string) {
  await db
    .update(lineLinkSessions)
    .set({ updatedAt: new Date() })
    .where(eq(lineLinkSessions.lineUserId, lineUserId));
}

async function setStep(lineUserId: string, step: string, pendingRole: string | null = null) {
  await db
    .insert(lineLinkSessions)
    .values({ lineUserId, step, pendingRole })
    .onConflictDoUpdate({
      target: lineLinkSessions.lineUserId,
      set: { step, pendingRole, updatedAt: new Date() },
    });
}

async function clearSession(lineUserId: string) {
  await db.delete(lineLinkSessions).where(eq(lineLinkSessions.lineUserId, lineUserId));
}

/**
 * SPEC-071 / TASK-231 — AC-18's two-strikes handover.
 *
 * An unrecognised reply **inside a flow**: first one re-prompts exactly as before, second one stops trying and
 * hands the chat to a person, muting the bot so it does not talk over them.
 *
 * 🔴 The counter is `unexpected_count` — the TWO-STRIKES counter, **not** the invite/code attempt counter that
 * was cut with the invite. TASK-230 shipped the column; this is its only writer.
 *
 * ⚠️ It **resets on success** (`resetStrikes`, called on every valid answer) and dies with the session row. A
 * counter that only ever increments would hand someone a locked chat in June for a typo in March.
 */
async function strikeOrPrompt(
  lineUserId: string,
  session: { unexpectedCount?: number | null },
  replyToken: string,
  promptOnFirstStrike: string,
  lang: Lang,
) {
  const next = (session.unexpectedCount ?? 0) + 1;
  if (shouldHandOver(next)) {
    // Hand over, and get out of the way. The session is deliberately KEPT: a person is about to read the
    // whole conversation, and deleting the step would erase what the parent was in the middle of.
    await db
      .update(lineLinkSessions)
      .set({ unexpectedCount: 0, mutedUntil: muteUntilFrom() })
      .where(eq(lineLinkSessions.lineUserId, lineUserId));
    return reply(replyToken, t("handover_to_admin", lang));
  }
  await db
    .update(lineLinkSessions)
    .set({ unexpectedCount: next })
    .where(eq(lineLinkSessions.lineUserId, lineUserId));
  return reply(replyToken, promptOnFirstStrike);
}

/**
 * SPEC-071 Amendment #2 / TASK-232 — is the 6-digit step switched on?
 *
 * 🔴 Read from `app_settings` on every use, never cached: **turning it on must be a setting, not a rebuild**,
 * and a cached flag would make it a restart. Default `off` is the owner's recorded choice, not a soft launch.
 */
async function twoFaEnabled(): Promise<boolean> {
  return (await getSetting("line_parent_2fa")).value === "on";
}

/**
 * TASK-232 — park the 2FA challenge on the session. It rides in `pending_role` because that column already
 * carries "what this step is waiting on", and the alternative is a migration for a branch that ships OFF.
 * ⚠️ Named so a reader is not surprised by a code in a column called `pending_role`.
 */
async function setTwoFaChallenge(lineUserId: string, code: string) {
  await setStep(lineUserId, "AWAIT_2FA", code);
}

/** AC-19 — a valid answer clears the strikes. Cheap, and it is what keeps the counter about THIS confusion. */
async function resetStrikes(lineUserId: string) {
  await db
    .update(lineLinkSessions)
    .set({ unexpectedCount: 0 })
    .where(eq(lineLinkSessions.lineUserId, lineUserId));
}

async function detectLinkedRole(lineUserId: string): Promise<LinkRole | null> {
  const [teacher, parent, admins] = await Promise.all([
    db.query.teachers.findFirst({ where: (t2, { eq: e }) => e(t2.lineUserId, lineUserId) }),
    findParentByLineUserId(lineUserId),
    getAdminLineUserIds(),
  ]);
  if (teacher) return "teacher";
  if (parent) return "customer";
  if (admins.includes(lineUserId)) return "admin";
  return null;
}

/** A suspended household is refused at the bot boundary and gets NO data back (REQ-019 / TASK-048). */
async function isSuspendedLineParent(lineUserId: string): Promise<boolean> {
  const parent = await findParentByLineUserId(lineUserId);
  return isSuspended(parent?.suspendedAt);
}

/** Flip the stored language on whichever link record matches (parent/teacher). Returns the new language. */
async function toggleLang(lineUserId: string, current: Lang): Promise<Lang> {
  const next: Lang = current === "EN" ? "TH" : "EN";
  await Promise.all([
    db.update(teachers).set({ lineLang: next }).where(eq(teachers.lineUserId, lineUserId)),
    db.update(parents).set({ lineLang: next }).where(eq(parents.lineUserId, lineUserId)),
  ]);
  return next;
}

// `moveRosterLink` moved to `lib/roster-link.ts` in TASK-075 so the approval path can reuse it — this module
// now imports `teacher-link.service`, so that module importing back would be a cycle.

async function verifyAndLink(
  lineUserId: string,
  role: LinkRole,
  code: string,
  lang: Lang,
): Promise<VerifyResult> {
  if (role === "admin") {
    const expected = process.env.LINE_ADMIN_VERIFY_CODE ?? "229";
    if (code.trim() !== expected) return { ok: false, message: t("verify_admin_bad", lang) };
    await addAdminLineUserId(lineUserId);
    return { ok: true, message: t("verify_admin_ok", lang) };
  }

  if (role === "teacher") {
    // 🔐 TASK-075: a nickname claim no longer links anyone. It queues a request for staff to approve.
    // This line used to be `db.update(teachers).set({ lineUserId })` — i.e. typing a teacher's nickname
    // granted that teacher's access, immediately, to whoever typed it. `teachers.lineUserId` is now written
    // only by `approveTeacherLinkRequest`.
    const nick = code.trim();
    const outcome = await requestTeacherLink(lineUserId, nick);
    // ⚠️ `pending` and `pending-ambiguous` deliberately share one reply key: the bot must not tell an
    // unauthenticated stranger whether a nickname exists, or how many teachers share it.
    const message = t(claimReplyKey(outcome), lang, { nick });
    // They stay UNLINKED until approved — no teacher menu, no schedule pushes. `ok:false` keeps the session
    // at AWAIT_CODE so a typo can be retyped, exactly as the ambiguous case already did.
    return { ok: false, message };
  }

  // customer / parent — keyed by phone. One phone = one parent (many children).
  const phone = normalizePhone(code);
  if (phone.length < 9) return { ok: false, message: t("verify_parent_badphone", lang) };
  const existing = await findParentByPhone(phone);
  if (existing) {
    if (existing.lineUserId && existing.lineUserId !== lineUserId) {
      return { ok: false, message: t("verify_parent_other", lang) };
    }
    // 🔴 SPEC-071 / TASK-232 — the mirror of the check above, and the one the unique index enforces: this LINE
    // ACCOUNT may already belong to a different family. Refused here so the parent gets a sentence they can
    // act on instead of a `23505`, and refused at all because the alternative is silently re-pointing an
    // account — a parent opening the app to **another family's children** (TASK-047's failure, other route).
    const bind = await bindFamilyLine(existing.id, lineUserId);
    if (!bind.ok) return { ok: false, message: t("verify_parent_other_family", lang) };

    await linkParentLine(existing.id, lineUserId);
    await moveRosterLink(lineUserId, "customer"); // role change moves the link (TASK-046)
    const kids = await listStudentsOfParent(existing.id);

    // 🔴 REQ-079 §2 — the phone alone now returns the children BY NAME. TASK-047 withheld them, and that
    // reasoning was NOT refuted: the owner put the danger to the customer in those words and **the customer
    // chose the convenience**.
    //
    // 🔀 The 2FA branch is the whole switchable part. ON: the parent gets the COUNT and a prompt, and the
    // names are gated behind the code — TASK-047's rule still applies wherever a gate exists. OFF (default,
    // the owner's choice): the names come straight back. **Nothing below this line differs between the two
    // except which note is built**, which is what makes turning it on a setting rather than a rebuild.
    if (await twoFaEnabled()) {
      const code = generate2faCode();
      deliver2faCode(lineUserId, code); // throws loudly if delivery was never configured — see lib/line-2fa.ts
      return {
        ok: true,
        needs2fa: true,
        code,
        message:
          t("verify_parent_ok_existing", lang, { phone, list: parentChildrenNote(kids.length, lang) }) +
          "\n" +
          t("twofa_prompt", lang),
      };
    }
    const list = parentChildrenNames(
      kids.map((k: any) => k.nickname ?? k.name),
      lang,
    );
    return { ok: true, message: t("verify_parent_ok_existing", lang, { phone, list }) };
  }
  await findOrCreateParentByPhone(phone, { lineUserId });
  await moveRosterLink(lineUserId, "customer"); // role change moves the link (TASK-046)
  return { ok: true, message: t("verify_parent_ok_new", lang, { phone }) };
}

/** Create one student under the linked parent and craft the right reply. */
async function addStudentAndReply(
  lineUserId: string,
  name: string,
  replyToken: string,
  opts: { continueSession: boolean },
  lang: Lang,
) {
  const parent = await findParentByLineUserId(lineUserId);
  if (!parent) {
    await clearSession(lineUserId);
    return reply(replyToken, t("add_no_parent", lang));
  }
  try {
    const { student, count } = await createStudentForParent(parent.id, { name });
    const atMax = count >= MAX_STUDENTS_PER_PARENT;
    if (opts.continueSession && !atMax) {
      return reply(replyToken, t("added_more", lang, { name: student.name, count }));
    }
    await clearSession(lineUserId);
    const note = atMax ? t("added_atmax_note", lang, { max: MAX_STUDENTS_PER_PARENT }) : "";
    return reply(replyToken, `${t("added_done", lang, { name: student.name, note })}\n\n${t("menu_body", lang)}`);
  } catch (e: any) {
    // createStudentForParent throws a Thai validation message (shared with the REST API — out of the LINE
    // reply layer's i18n scope); surface it, and drop the session on the "over max" case.
    const msg = e?.message ?? t("add_generic_err", lang);
    if (msg.includes("สูงสุด")) {
      await clearSession(lineUserId);
      return reply(replyToken, `${msg}\n\n${t("menu_body", lang)}`);
    }
    return reply(replyToken, msg); // keep the session so they can retry the name
  }
}

// ── Shared tap/keyword actions (reused by both the keyword branch and the postback branch) ──
// (`bookingLabel` — name + time — retired by TASK-145: check-in, leave and qr now all use `sessionLabel`.)

function parentActionItems(lang: Lang) {
  const mk = (labelKey: string, action: string) => ({
    type: "action" as const,
    action: { type: "postback" as const, label: t(labelKey, lang), data: `action=${action}`, displayText: t(labelKey, lang) },
  });
  return [mk("btn_checkin", "checkin"), mk("btn_leave", "leave"), mk("btn_children", "children"), mk("btn_register", "register")];
}

function doMenu(replyToken: string, lang: Lang) {
  return send(replyToken, [{ type: "text", text: t("menu_body", lang), quickReply: { items: parentActionItems(lang) } }]);
}

/** TASK-145 (AC-3): the check-in picker names the SESSION, like the leave one. Button labels are clamped to
 *  LINE's 20 chars, so the full row also goes in the prompt body — otherwise the program is what gets cut. */
function sessionPicker(
  prompt: string,
  action: "checkin" | "leave" | "qr",
  rows: any[],
  lang: Lang,
  // check-in and qr have no "which child?" step (leave does), so their rows must still name the child —
  // otherwise a two-child parent sees two times and can't tell whose is whose. That is Gap-A's whole point.
  withChild = false,
) {
  const picks = rows.map((b) => ({
    id: b.id,
    label: withChild
      ? `${b.student.nickname || b.student.name} · ${sessionLabel(b, lang)}`
      : sessionLabel(b, lang),
  }));
  const body = [prompt, ...picks.map((p) => `· ${p.label}`)].join("\n");
  return bookingPicker(body, action, picks, lang);
}

async function doCheckin(lineUserId: string, replyToken: string, date: string, lang: Lang) {
  const today = await findTodayBookingsForParent(lineUserId, date);
  if (!today.length) return send(replyToken, [textReply(t("empty_checkin", lang), lang)]);
  if (today.length === 1) return doCheckinBooking(lineUserId, today[0]!.id, replyToken, date, lang);
  return send(replyToken, [sessionPicker(t("pick_checkin", lang), "checkin", today, lang, true)]);
}

/** TASK-145 Gap-A: `qr` used to hand back `today[0]` — a multi-child parent could only ever reach their FIRST
 *  child's check-in link. Same id-keyed picker as check-in when more than one is eligible. */
async function doQr(lineUserId: string, replyToken: string, date: string, lang: Lang, bookingId?: string) {
  const today = await findTodayBookingsForParent(lineUserId, date);
  if (!today.length) return send(replyToken, [textReply(t("qr_none", lang), lang)]);
  const chosen = bookingId ? today.find((x) => x.id === bookingId) : today.length === 1 ? today[0] : undefined;
  if (!chosen) {
    if (bookingId) return send(replyToken, [textReply(t("checkin_notfound", lang), lang)]); // not this parent's
    return send(replyToken, [sessionPicker(t("pick_qr", lang), "qr", today, lang, true)]);
  }
  const qr = await getCheckinQr(chosen.id);
  return send(replyToken, [
    textReply(
      t("qr_line", lang, { name: chosen.student.name, time: hhmm(chosen.startTime), url: qr.url, window: qr.window }),
      lang,
    ),
  ]);
}

async function doCheckinBooking(lineUserId: string, bookingId: string, replyToken: string, date: string, lang: Lang) {
  const today = await findTodayBookingsForParent(lineUserId, date);
  const b = today.find((x) => x.id === bookingId); // authorize: must be one of THIS parent's today bookings
  if (!b) return send(replyToken, [textReply(t("checkin_notfound", lang), lang)]);
  const qr = await getCheckinQr(b.id);
  try {
    const result = await checkinByToken(qr.token);
    const key = result.already ? "checkin_already" : "checkin_ok";
    // TASK-145 (AC-3): the confirmation names WHICH session was checked in, not just the child and the time.
    const body = t(key, lang, {
      name: b.student.name,
      time: hhmm(b.startTime),
      teacher: b.teacher?.nickname ?? "-",
      program: b.subject?.name ?? "-",
    });
    return send(replyToken, [textReply(body, lang)]);
  } catch (e: any) {
    return send(replyToken, [textReply(e?.message ?? t("checkin_err", lang), lang)]);
  }
}

/** TASK-135: leave is per session, so the flow names the session — and asks which child first when more than
 *  one has a class today. `studentId` is the answer to that step (arrives on the postback). */
async function doLeave(lineUserId: string, replyToken: string, date: string, lang: Lang, studentId?: string) {
  const today = await findTodayBookingsForParent(lineUserId, date);
  let eligible = today.filter((b) => b.status === "CONFIRMED");
  if (!eligible.length) return send(replyToken, [textReply(t("empty_leave", lang), lang)]);
  if (studentId) {
    eligible = eligible.filter((b) => b.studentId === studentId); // authorize: still this parent's own rows
    if (!eligible.length) return send(replyToken, [textReply(t("empty_leave", lang), lang)]);
  } else if (needsChildStep(eligible)) {
    return send(replyToken, [childPicker(t("pick_leave_child", lang), childrenWithSessions(eligible), lang)]);
  }
  if (eligible.length === 1) return doLeaveBooking(lineUserId, eligible[0]!.id, replyToken, date, lang);
  return send(replyToken, [sessionPicker(t("pick_leave", lang), "leave", eligible, lang)]);
}

async function doLeaveBooking(lineUserId: string, bookingId: string, replyToken: string, date: string, lang: Lang) {
  const today = await findTodayBookingsForParent(lineUserId, date);
  const b = today.find((x) => x.id === bookingId && x.status === "CONFIRMED"); // authorize + eligible
  if (!b) return send(replyToken, [textReply(t("empty_leave", lang), lang)]);
  // TASK-146: a refusal (LEAVE_NOTICE_TOO_LATE from the cut-off, LEAVE_LOCKED, …) used to propagate out of
  // this handler — the outer catch logged it and **the parent got no reply at all**. AC-7 wants them to read
  // the reason, so the server's message is surfaced instead of silence.
  let result;
  try {
    result = await updateBookingStatus(b.id, "sick-leave", "แจ้งลาผ่าน LINE");
  } catch (e: any) {
    // AC-7 finish (TASK-146 Q1, Sober's ruling): the service throws its message in Thai because it doesn't know
    // the caller's language. For the cut-off refusal — the one a parent actually hits — re-render it bot-side in
    // THEIR language, reusing the exported `leaveNoticeMessage` (no duplicated copy, no service signature
    // change). Every other refusal still surfaces the server's own message, which beats the old silence.
    if (e?.code === "LEAVE_NOTICE_TOO_LATE") {
      const teacherType = b.teacher?.type;
      const { value: cutoffHours } = await getSetting(leaveCutoffKey(teacherType ?? "FULL_TIME"));
      return send(replyToken, [textReply(leaveNoticeMessage(cutoffHours, b.startTime, lang), lang)]);
    }
    return send(replyToken, [textReply(e?.message ?? t("leave_err", lang), lang)]);
  }
  const locked = result.locked ? t("leave_lockline", lang) : "";
  const extended = result.extended
    ? t("leave_extline", lang, { date: result.extended.date, time: result.extended.startTime })
    : "";
  // TASK-135 (AC-1/AC-3): the confirmation names the session that was cancelled — date · time · teacher.
  const body = t("leave_ok_session", lang, {
    name: b.student.name,
    date: b.date,
    time: hhmm(b.startTime),
    teacher: b.teacher?.nickname ?? "-",
    extended,
    locked,
  });
  return send(replyToken, [textReply(body, lang)]);
}

async function doChildren(lineUserId: string, replyToken: string, lang: Lang) {
  const parent = await findParentByLineUserId(lineUserId);
  const kids = parent ? await listStudentsOfParent(parent.id) : [];
  if (!kids.length) return send(replyToken, [textReply(t("children_none", lang), lang)]);
  const title = `${t("children_title", lang)} (${kids.length}/${MAX_STUDENTS_PER_PARENT})`;
  return send(replyToken, [childrenFlex(title, kids.map((k) => k.name), lang)]);
}

/** Teacher "my schedule" (REQ-016 / TASK-043) — today or this week (**Mon–Sun** via `weekRange`; it was
 *  Sun–Sat, so teachers were reading the wrong week too — REQ-069 / TASK-175), read-only.
 *  Teacher resolved from `lineUserId` inside the service; every reply keeps a toggle + back-to-menu quick reply. */
async function doTeacherSchedule(
  lineUserId: string,
  replyToken: string,
  lang: Lang,
  range: "today" | "week",
) {
  const { date } = bangkokNow();
  const wk = weekRange(date);
  const [from, to] = range === "week" ? [wk.start, wk.end] : [date, date];
  const bookings = await findBookingsForTeacher(lineUserId, from, to);
  const rows = bookings.map((b: any) => ({
    date: b.date,
    startTime: b.startTime,
    studentName: b.student?.name ?? "",
    subjectName: b.subject?.name ?? "",
    status: b.status,
    attendeeNote: b.attendeeNote ?? null, // TASK-178 (REQ-068) — shown under the session when present
  }));
  const toggle =
    range === "week"
      ? {
          type: "action" as const,
          action: { type: "postback" as const, label: t("btn_today", lang), data: "action=schedule", displayText: t("btn_today", lang) },
        }
      : {
          type: "action" as const,
          action: { type: "postback" as const, label: t("btn_week", lang), data: "action=schedule&range=week", displayText: t("btn_week", lang) },
        };
  // REQ-017: offer the phone-calendar subscription right where the teacher is reading their schedule.
  const calendarBtn = {
    type: "action" as const,
    action: {
      type: "postback" as const,
      label: t("btn_calendar", lang),
      data: "action=calendar",
      displayText: t("btn_calendar", lang),
    },
  };
  return send(replyToken, [textReply(renderSchedule(rows, lang, range), lang, [toggle, calendarBtn])]);
}

/** Reply with the teacher's private `.ics` subscription link (REQ-017 / TASK-044). Token is resolved from the
 *  caller's own `lineUserId` — never from the payload — and created on first ask. */
async function doTeacherCalendar(lineUserId: string, replyToken: string, lang: Lang) {
  const token = await getCalendarTokenForLineUser(lineUserId);
  if (!token) return send(replyToken, [textReply(t("cal_not_teacher", lang), lang)]);
  const { webcal } = calendarUrls(token);
  return send(replyToken, [textReply(t("cal_link", lang, { url: webcal }), lang)]);
}

async function handleParentCommand(lineUserId: string, text: string, replyToken: string, lang: Lang) {
  const raw = text.trim();
  const cmd = raw.toLowerCase();
  const { date } = bangkokNow();

  if (["เมนู", "menu", "help", "ช่วยเหลือ"].includes(cmd)) return doMenu(replyToken, lang);

  // Add a student — inline ("เพิ่มนักเรียน น้องเอ") or start a name prompt.
  const addMatch = raw.match(/^(?:เพิ่มนักเรียน|เพิ่มลูก|add)\s*(.*)$/i);
  if (addMatch) {
    const name = (addMatch[1] ?? "").trim();
    if (name) return addStudentAndReply(lineUserId, name, replyToken, { continueSession: false }, lang);
    await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");
    return reply(replyToken, t("add_student_name_prompt", lang, { max: MAX_STUDENTS_PER_PARENT }));
  }

  if (["นักเรียน", "ลูก", "รายชื่อ", "children", "students"].includes(cmd)) {
    return doChildren(lineUserId, replyToken, lang);
  }

  if (["qr", "คิวอาร์"].includes(cmd)) return doQr(lineUserId, replyToken, date, lang);

  if (["เช็คอิน", "checkin", "check-in"].includes(cmd)) return doCheckin(lineUserId, replyToken, date, lang);

  const checkinMatch = cmd.match(/^เช็คอิน\s*(\d+)$/);
  if (checkinMatch) {
    const today = await findTodayBookingsForParent(lineUserId, date);
    const b = today[Number(checkinMatch[1]) - 1];
    if (!b) return reply(replyToken, t("num_notfound", lang));
    return doCheckinBooking(lineUserId, b.id, replyToken, date, lang);
  }

  if (["ลา", "แจ้งลา", "sick", "leave"].includes(cmd)) return doLeave(lineUserId, replyToken, date, lang);

  const leaveMatch = cmd.match(/^ลา\s*(\d+)$/);
  if (leaveMatch) {
    const today = await findTodayBookingsForParent(lineUserId, date);
    const eligible = today.filter((b) => b.status === "CONFIRMED");
    const b = eligible[Number(leaveMatch[1]) - 1];
    if (!b) return reply(replyToken, t("num_notfound", lang));
    return doLeaveBooking(lineUserId, b.id, replyToken, date, lang);
  }

  // 🔴 AC-16 — SILENCED FALLBACK #1 (parent), and the loudest of the four. This was `return doMenu(...)`, so a
  // linked parent typing ANYTHING got the menu back — including while a human was mid-conversation with them.
  //
  // Every recognised command above still answers, deliberately: `ลา` is how a parent reports sick leave and
  // `เช็คอิน` is how they check in. Silencing those would be "silenced the wrong branch and nobody notices for
  // a week" — the failure this task warns about, on the two flows a family uses most.
  return;
}

async function handleMessage(ev: LineWebhookEvent) {
  const replyToken = ev.replyToken;
  const lineUserId = eventUserId(ev);
  const text = eventText(ev);
  if (!replyToken || !lineUserId || !text) return;
  const lang = await resolveLang(lineUserId);
  const lower = text.toLowerCase();

  // Registration (re)start — works from any state.
  if (["สมัคร", "register", "ลงทะเบียน", "เริ่มต้น"].includes(lower)) {
    await setStep(lineUserId, "CHOOSE_ROLE", null);
    return reply(replyToken, t("role_prompt", lang));
  }

  const session = await getSession(lineUserId);
  const linked = await detectLinkedRole(lineUserId);

  // TASK-046: an in-progress multi-turn conversation (adding a student, OR linking) must win over
  // already-linked routing — otherwise an already-linked user can never finish `สมัคร`.
  // TASK-231 adds two outcomes around that rule: a MUTED chat, and SILENCE.
  const route = decideMessageRoute(session?.step, linked, { mutedUntil: session?.mutedUntil });

  // 🔴 AC-17 — a human is talking in this chat. Deliver nothing, and do NOT touch the session: the parent may
  // be mid-flow, and clearing their step would lose it while a person is helping them.
  if (route === "muted") return;

  // The inactivity window is measured from the last message the session HANDLED, so refresh it here — before
  // any branch below can return — for exactly the two routes a session owns. A `linked` or `silence` route is
  // not a session conversation and must not keep a dead row alive.
  if (route === "add-student" || route === "linking") await touchSession(lineUserId);

  // Multi-turn: adding students (right after linking, or via "เพิ่มนักเรียน").
  if (route === "add-student") {
    if (SKIP_WORDS.includes(lower)) {
      await clearSession(lineUserId);
      return reply(replyToken, `${t("skip_done", lang)}\n\n${t("menu_body", lang)}`);
    }
    return addStudentAndReply(lineUserId, text.trim(), replyToken, { continueSession: true }, lang);
  }

  // Already-linked routing (only when no conversation is in progress).
  if (route === "linked") {
    if (linked === "customer") {
      if (await isSuspendedLineParent(lineUserId)) return reply(replyToken, t("suspended_notice", lang));
      return handleParentCommand(lineUserId, text, replyToken, lang);
    }
    if (linked === "teacher") {
      if (["ตาราง", "ตารางสอน", "schedule"].includes(lower)) {
        return doTeacherSchedule(lineUserId, replyToken, lang, "today"); // keyword fallback (REQ-015 principle)
      }
      if (["ปฏิทิน", "calendar"].includes(lower)) {
        return doTeacherCalendar(lineUserId, replyToken, lang); // keyword fallback (REQ-017)
      }
      // 🔴 AC-16 — SILENCED FALLBACK #2 (teacher). `ตาราง` / `ปฏิทิน` above still answer: they are recognised
      // commands the teacher deliberately typed, and REQ-015/REQ-017 keep them as the keyboard route to the
      // rich menu. What stops is the catch-all `teacher_linked` reply to anything else — which is the
      // `yo` → *"ไม่พบครูชื่อเล่น yo"* class of noise from §16's screenshot.
      if (["เมนู", "menu"].includes(lower)) return reply(replyToken, t("teacher_linked_menu", lang));
      return;
    }
    if (linked === "admin") {
      // 🔴 AC-16 — SILENCED FALLBACK #3 (admin). Same rule: `เมนู` is a command, everything else is stray.
      if (["เมนู", "menu"].includes(lower)) return reply(replyToken, t("admin_linked_menu", lang));
      return;
    }
  }

  // 🔴 AC-16 — SILENCED FALLBACK #4, and the one §16 is actually about: an UNLINKED chat with no session used
  // to get `welcome` for any text at all. `สมัคร` (handled at the top of this function, from any state) is
  // still the way in, and the rich-menu postbacks are unaffected.
  if (route === "silence") return;

  // Linking conversation.
  if (!session) return;

  if (session.step === "CHOOSE_ROLE") {
    const role = parseRoleChoice(text);
    // AC-18 — an unrecognised reply INSIDE a flow. Second one hands over to a human instead of re-prompting.
    if (!role) return strikeOrPrompt(lineUserId, session, replyToken, t("role_prompt", lang), lang);
    await resetStrikes(lineUserId); // AC-19: a valid answer clears the count — see `strikeOrPrompt`.
    await setStep(lineUserId, "AWAIT_CODE", role);
    return reply(replyToken, t(`code_${role}`, lang));
  }

  // 🔀 TASK-232 — the 2FA step. Unreachable while `line_parent_2fa` is `off`, because nothing sets this step;
  // it exists from day one so switching the setting on is a setting change and not a rebuild.
  if (session.step === "AWAIT_2FA") {
    if (!matches2faCode(session.pendingRole, text)) {
      // A wrong code is an unrecognised reply INSIDE a flow, so it is on the same two-strikes rule as every
      // other step — rather than a second, bespoke lockout. 🚫 The deleted designs' attempt counts are NOT
      // inherited; if the owner wants a different one here, it is his call on switch-on (`lib/line-2fa.ts`).
      return strikeOrPrompt(lineUserId, session, replyToken, t("twofa_bad", lang), lang);
    }
    await resetStrikes(lineUserId);
    const parent = await findParentByLineUserId(lineUserId);
    const kids = parent ? await listStudentsOfParent(parent.id) : [];
    // Verified — NOW the names. This is TASK-047's rule intact: the gate exists, so it is honoured.
    await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");
    return reply(
      replyToken,
      `${parentChildrenNames(kids.map((k: any) => k.nickname ?? k.name), lang)}\n\n${t("add_student_prompt", lang, { max: MAX_STUDENTS_PER_PARENT })}`.trim(),
    );
  }

  if (session.step === "AWAIT_CODE" && session.pendingRole) {
    const role = session.pendingRole as LinkRole;
    const res = await verifyAndLink(lineUserId, role, text, lang);
    // AC-18 — this is the exact branch §16's screenshot came from (`yo` → *"ไม่พบครูชื่อเล่น yo"*): it kept the
    // session and re-prompted forever. Second failure now hands over to a human instead.
    if (!res.ok) return strikeOrPrompt(lineUserId, session, replyToken, res.message, lang);
    await resetStrikes(lineUserId);
    if (role !== "admin") {
      // Seed the language from the LINE profile locale (best-effort), then link the role's rich menu.
      const seed: Lang = (await getProfileLang(lineUserId)) ?? "TH";
      await Promise.all([
        db.update(teachers).set({ lineLang: seed }).where(eq(teachers.lineUserId, lineUserId)),
        db.update(parents).set({ lineLang: seed }).where(eq(parents.lineUserId, lineUserId)),
      ]).catch((e) => console.error("[line-webhook] seed lang failed:", e));
      try {
        await linkRoleRichMenu(lineUserId, role, seed);
      } catch (e) {
        console.error("[line-webhook] linkRoleRichMenu failed:", e);
      }
    }
    // 🔀 TASK-232 — the ONE place the 2FA switch changes the flow. `needs2fa` is set only when the setting is
    // on, so with it off this branch never runs and the path below is byte-identical to before.
    if (res.needs2fa && res.code) {
      await setTwoFaChallenge(lineUserId, res.code);
      return reply(replyToken, res.message);
    }
    if (role === "customer") {
      // Linked — now offer to add children (multi-turn).
      await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");
      return reply(replyToken, `${res.message}\n\n${t("add_student_prompt", lang, { max: MAX_STUDENTS_PER_PARENT })}`);
    }
    await clearSession(lineUserId);
    return reply(replyToken, res.message);
  }

  // 🔴 AC-16 — SILENCED FALLBACK #5: a session row exists but its `step` is none of the ones above (a state we
  // no longer use, or a row left behind by an older flow). It used to answer `welcome` to anything, which is
  // stray text in a chat that merely LOOKS busy — the same defect as #4 wearing a stale session.
  return;
}

/** Rich-menu / quick-reply taps arrive as postback events — route each action to the SAME handler the
 *  keyword uses (keyword input stays supported). Business logic is untouched; only the entry point changes. */
async function handlePostback(ev: LineWebhookEvent) {
  const replyToken = ev.replyToken;
  const lineUserId = eventUserId(ev);
  const data = eventPostbackData(ev);
  if (!replyToken || !lineUserId || !data) {
    console.warn(formatDroppedPostback(ev)); // was a silent return — TASK-045
    return;
  }
  const { action, params } = parsePostback(data);
  // A typo'd/stale action would otherwise be indistinguishable from "nothing arrived" (TASK-045).
  if (!KNOWN_POSTBACK_ACTIONS.has(action)) console.warn(formatUnknownAction(action, lineUserId));
  const { date } = bangkokNow();
  const lang = await resolveLang(lineUserId);

  // Language toggle — flip, re-link the matching-language menu, confirm in the NEW language.
  if (action === "lang") {
    const next = await toggleLang(lineUserId, lang);
    const linked = await detectLinkedRole(lineUserId);
    if (linked === "customer" || linked === "teacher") {
      try {
        await linkRoleRichMenu(lineUserId, linked, next);
      } catch (e) {
        console.error("[line-webhook] relink menu on toggle failed:", e);
      }
    }
    return send(replyToken, [textReply(t("lang_switched", next), next)]);
  }

  const linked = await detectLinkedRole(lineUserId);
  if (linked === "teacher") {
    if (action === "schedule") {
      return doTeacherSchedule(lineUserId, replyToken, lang, params.range === "week" ? "week" : "today");
    }
    if (action === "calendar") return doTeacherCalendar(lineUserId, replyToken, lang);
    return send(replyToken, [textReply(t("teacher_linked", lang), lang)]);
  }
  if (linked !== "customer") return send(replyToken, [textReply(t("welcome", lang), lang)]);
  // Suspended household → refuse every postback too, not just typed commands (TASK-048).
  if (await isSuspendedLineParent(lineUserId)) {
    return send(replyToken, [textReply(t("suspended_notice", lang), lang)]);
  }

  switch (action) {
    case "checkin":
      return params.bookingId
        ? doCheckinBooking(lineUserId, params.bookingId, replyToken, date, lang)
        : doCheckin(lineUserId, replyToken, date, lang);
    case "leave":
      return params.bookingId
        ? doLeaveBooking(lineUserId, params.bookingId, replyToken, date, lang)
        : doLeave(lineUserId, replyToken, date, lang, params.studentId); // studentId = the AC-3 child step
    case "qr":
      return doQr(lineUserId, replyToken, date, lang, params.bookingId);
    case "children":
      return doChildren(lineUserId, replyToken, lang);
    case "register":
      await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");
      return send(replyToken, [textReply(t("add_student_name_prompt", lang, { max: MAX_STUDENTS_PER_PARENT }), lang)]);
    default: // menu / help / unknown → the menu
      return doMenu(replyToken, lang);
  }
}

/**
 * 🚫 NOT silenced by TASK-231, deliberately.
 *
 * A `follow` event is someone **adding the OA** — they just knocked on the door, and AC-16 is about stray text
 * in a chat nobody addressed. Greeting a new follower is the one moment the bot is certainly not talking over
 * a human, and it is also how anyone learns that `สมัคร` is the way in. Silencing it would leave a new parent
 * with an empty chat and no idea what to type.
 */
async function handleFollow(ev: LineWebhookEvent) {
  const replyToken = ev.replyToken;
  const lineUserId = eventUserId(ev);
  if (!replyToken) return;
  const lang = lineUserId ? await resolveLang(lineUserId) : "TH";
  return reply(replyToken, t("welcome", lang));
}

/** Process one webhook POST body (already signature-verified). */
export async function handleLineWebhookEvents(events: LineWebhookEvent[]) {
  for (const ev of events) {
    // One line per inbound event BEFORE dispatch (TASK-045) — so a rich-menu tap that reaches us is visible
    // even when it succeeds. Never logs the full userId or any token (see lib/line-log.ts).
    console.info(formatInboundEvent(ev));
    try {
      if (ev.type === "follow") await handleFollow(ev);
      else if (ev.type === "message") await handleMessage(ev);
      else if (ev.type === "postback") await handlePostback(ev);
    } catch (e) {
      console.error("[line-webhook] event error:", e);
    }
  }
}
