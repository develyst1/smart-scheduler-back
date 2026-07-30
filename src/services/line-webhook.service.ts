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
import { bookingPicker, childrenFlex, textReply } from "../lib/line-reply";
import {
  formatDroppedPostback,
  formatInboundEvent,
  formatUnknownAction,
} from "../lib/line-log";
import { linkRoleRichMenu } from "../lib/line-rich-menu";
import { t, type Lang } from "../lib/line-i18n";
import { resolveBotLang as resolveLang } from "../lib/line-lang";
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
  "checkin",
  "leave",
  "children",
  "register",
  "menu",
  "help",
]);

type LinkRole = "customer" | "teacher" | "admin";
type VerifyResult = { ok: boolean; message: string };

async function reply(replyToken: string, text: string) {
  await replyMessage(replyToken, [{ type: "text", text }]);
}

async function send(replyToken: string, messages: LineMessage[]) {
  await replyMessage(replyToken, messages);
}

async function getSession(lineUserId: string) {
  return db.query.lineLinkSessions.findFirst({
    where: (s, { eq: e }) => e(s.lineUserId, lineUserId),
  });
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

/** Flip the stored language on whichever link record matches (parent/teacher). Returns the new language. */
async function toggleLang(lineUserId: string, current: Lang): Promise<Lang> {
  const next: Lang = current === "EN" ? "TH" : "EN";
  await Promise.all([
    db.update(teachers).set({ lineLang: next }).where(eq(teachers.lineUserId, lineUserId)),
    db.update(parents).set({ lineLang: next }).where(eq(parents.lineUserId, lineUserId)),
  ]);
  return next;
}

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
    const nick = code.trim();
    const rows = await db.select().from(teachers);
    const teacher = rows.find((tt) => tt.nickname.toLowerCase() === nick.toLowerCase());
    if (!teacher) return { ok: false, message: t("verify_teacher_notfound", lang, { nick }) };
    if (teacher.lineUserId && teacher.lineUserId !== lineUserId) {
      return { ok: false, message: t("verify_teacher_other", lang) };
    }
    await db.update(teachers).set({ lineUserId }).where(eq(teachers.id, teacher.id));
    return { ok: true, message: t("verify_teacher_ok", lang, { nick: teacher.nickname }) };
  }

  // customer / parent — keyed by phone. One phone = one parent (many children).
  const phone = normalizePhone(code);
  if (phone.length < 9) return { ok: false, message: t("verify_parent_badphone", lang) };
  const existing = await findParentByPhone(phone);
  if (existing) {
    if (existing.lineUserId && existing.lineUserId !== lineUserId) {
      return { ok: false, message: t("verify_parent_other", lang) };
    }
    await linkParentLine(existing.id, lineUserId);
    const kids = await listStudentsOfParent(existing.id);
    const list = kids.length ? t("verify_parent_students", lang, { names: kids.map((k) => k.name).join(", ") }) : "";
    return { ok: true, message: t("verify_parent_ok_existing", lang, { phone, list }) };
  }
  await findOrCreateParentByPhone(phone, { lineUserId });
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
const bookingLabel = (b: { student: { name: string }; startTime: string }) =>
  `${b.student.name} ${hhmm(b.startTime)}`;

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

async function doCheckin(lineUserId: string, replyToken: string, date: string, lang: Lang) {
  const today = await findTodayBookingsForParent(lineUserId, date);
  if (!today.length) return send(replyToken, [textReply(t("empty_checkin", lang), lang)]);
  if (today.length === 1) return doCheckinBooking(lineUserId, today[0]!.id, replyToken, date, lang);
  const picks = today.map((b) => ({ id: b.id, label: bookingLabel(b) }));
  return send(replyToken, [bookingPicker(t("pick_checkin", lang), "checkin", picks, lang)]);
}

async function doCheckinBooking(lineUserId: string, bookingId: string, replyToken: string, date: string, lang: Lang) {
  const today = await findTodayBookingsForParent(lineUserId, date);
  const b = today.find((x) => x.id === bookingId); // authorize: must be one of THIS parent's today bookings
  if (!b) return send(replyToken, [textReply(t("checkin_notfound", lang), lang)]);
  const qr = await getCheckinQr(b.id);
  try {
    const result = await checkinByToken(qr.token);
    const key = result.already ? "checkin_already" : "checkin_ok";
    return send(replyToken, [textReply(t(key, lang, { name: b.student.name, time: hhmm(b.startTime) }), lang)]);
  } catch (e: any) {
    return send(replyToken, [textReply(e?.message ?? t("checkin_err", lang), lang)]);
  }
}

async function doLeave(lineUserId: string, replyToken: string, date: string, lang: Lang) {
  const today = await findTodayBookingsForParent(lineUserId, date);
  const eligible = today.filter((b) => b.status === "CONFIRMED");
  if (!eligible.length) return send(replyToken, [textReply(t("empty_leave", lang), lang)]);
  if (eligible.length === 1) return doLeaveBooking(lineUserId, eligible[0]!.id, replyToken, date, lang);
  const picks = eligible.map((b) => ({ id: b.id, label: bookingLabel(b) }));
  return send(replyToken, [bookingPicker(t("pick_leave", lang), "leave", picks, lang)]);
}

async function doLeaveBooking(lineUserId: string, bookingId: string, replyToken: string, date: string, lang: Lang) {
  const today = await findTodayBookingsForParent(lineUserId, date);
  const b = today.find((x) => x.id === bookingId && x.status === "CONFIRMED"); // authorize + eligible
  if (!b) return send(replyToken, [textReply(t("empty_leave", lang), lang)]);
  const result = await updateBookingStatus(b.id, "sick-leave", "แจ้งลาผ่าน LINE");
  const locked = result.locked ? t("leave_lockline", lang) : "";
  const extended = result.extended
    ? t("leave_extline", lang, { date: result.extended.date, time: result.extended.startTime })
    : "";
  return send(replyToken, [textReply(t("leave_ok", lang, { name: b.student.name, extended, locked }), lang)]);
}

async function doChildren(lineUserId: string, replyToken: string, lang: Lang) {
  const parent = await findParentByLineUserId(lineUserId);
  const kids = parent ? await listStudentsOfParent(parent.id) : [];
  if (!kids.length) return send(replyToken, [textReply(t("children_none", lang), lang)]);
  const title = `${t("children_title", lang)} (${kids.length}/${MAX_STUDENTS_PER_PARENT})`;
  return send(replyToken, [childrenFlex(title, kids.map((k) => k.name), lang)]);
}

/** Teacher "my schedule" (REQ-016 / TASK-043) — today or this week (Sun–Sat via `weekRange`), read-only.
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
  return send(replyToken, [textReply(renderSchedule(rows, lang, range), lang, [toggle])]);
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

  if (["qr", "คิวอาร์"].includes(cmd)) {
    const today = await findTodayBookingsForParent(lineUserId, date);
    if (!today.length) return reply(replyToken, t("qr_none", lang));
    const b = today[0]!;
    const qr = await getCheckinQr(b.id);
    return reply(
      replyToken,
      t("qr_line", lang, { name: b.student.name, time: hhmm(b.startTime), url: qr.url, window: qr.window }),
    );
  }

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

  return doMenu(replyToken, lang);
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

  // Multi-turn: adding students (right after linking, or via "เพิ่มนักเรียน").
  if (session?.step === "AWAIT_STUDENT_NAME") {
    if (SKIP_WORDS.includes(lower)) {
      await clearSession(lineUserId);
      return reply(replyToken, `${t("skip_done", lang)}\n\n${t("menu_body", lang)}`);
    }
    return addStudentAndReply(lineUserId, text.trim(), replyToken, { continueSession: true }, lang);
  }

  // Already-linked routing.
  const linked = await detectLinkedRole(lineUserId);
  if (linked === "customer") return handleParentCommand(lineUserId, text, replyToken, lang);
  if (linked === "teacher") {
    if (["ตาราง", "ตารางสอน", "schedule"].includes(lower)) {
      return doTeacherSchedule(lineUserId, replyToken, lang, "today"); // keyword fallback (REQ-015 principle)
    }
    return reply(replyToken, ["เมนู", "menu"].includes(lower) ? t("teacher_linked_menu", lang) : t("teacher_linked", lang));
  }
  if (linked === "admin") {
    return reply(replyToken, ["เมนู", "menu"].includes(lower) ? t("admin_linked_menu", lang) : t("admin_linked", lang));
  }

  // Linking conversation.
  if (!session) return reply(replyToken, t("welcome", lang));

  if (session.step === "CHOOSE_ROLE") {
    const role = parseRoleChoice(text);
    if (!role) return reply(replyToken, t("role_prompt", lang));
    await setStep(lineUserId, "AWAIT_CODE", role);
    return reply(replyToken, t(`code_${role}`, lang));
  }

  if (session.step === "AWAIT_CODE" && session.pendingRole) {
    const role = session.pendingRole as LinkRole;
    const res = await verifyAndLink(lineUserId, role, text, lang);
    if (!res.ok) return reply(replyToken, res.message); // keep session for retry
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
    if (role === "customer") {
      // Linked — now offer to add children (multi-turn).
      await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");
      return reply(replyToken, `${res.message}\n\n${t("add_student_prompt", lang, { max: MAX_STUDENTS_PER_PARENT })}`);
    }
    await clearSession(lineUserId);
    return reply(replyToken, res.message);
  }

  return reply(replyToken, t("welcome", lang));
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
    return send(replyToken, [textReply(t("teacher_linked", lang), lang)]);
  }
  if (linked !== "customer") return send(replyToken, [textReply(t("welcome", lang), lang)]);

  switch (action) {
    case "checkin":
      return params.bookingId
        ? doCheckinBooking(lineUserId, params.bookingId, replyToken, date, lang)
        : doCheckin(lineUserId, replyToken, date, lang);
    case "leave":
      return params.bookingId
        ? doLeaveBooking(lineUserId, params.bookingId, replyToken, date, lang)
        : doLeave(lineUserId, replyToken, date, lang);
    case "children":
      return doChildren(lineUserId, replyToken, lang);
    case "register":
      await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");
      return send(replyToken, [textReply(t("add_student_name_prompt", lang, { max: MAX_STUDENTS_PER_PARENT }), lang)]);
    default: // menu / help / unknown → the menu
      return doMenu(replyToken, lang);
  }
}

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
