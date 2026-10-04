// TASK-620 (REQ-111 A) — the LINE message inventory for the customer's brand person: two CSVs (UTF-8 + BOM, so Excel reads
// the Thai), `push.csv` (what the system sends by itself) and `replies.csv` (the bot's chat answers).
//
// 🔴 READ-ONLY. It renders through the SAME functions the outbox worker and the bot use (`formatOutboxMessage`,
// `allChatStrings`, `TEMPLATE_FIELDS` …) so the list cannot drift from the code, and it never copies a message string.
// 🔴 No database, no LINE: the env that would reach either is blanked BEFORE anything is imported, and every sample value
// is an invented, obviously fake one (`Student A`, `Coach B`). No names, no phones, no ids.
//
//   bun run scripts/inventory-line-messages.ts <out-dir>
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

for (const k of ["DATABASE_URL", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"]) delete process.env[k];
process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/none"; // a lazy client that could never connect anyway

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: bun run scripts/inventory-line-messages.ts <out-dir>");

const { formatOutboxMessage } = await import("../src/lib/line-message");
const { allChatStrings, t, REGISTRATION_COPY } = await import("../src/lib/line-i18n");
const { TEMPLATE_FIELDS, TYPE_OMITS, TEMPLATE_NONE, notifyTypeOf } = await import("../src/lib/line-message-fields");
const { ATTENTION_CHECKS } = await import("../src/lib/attention");
const { RENTAL_TIER_WORDS } = await import("../src/lib/rental-row");

const ROOT = resolve(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n");

// ── The fake facts every message is rendered with ──────────────────────────────────────────────────────────────────
const D1 = "2026-10-15", D2 = "2026-10-22", D3 = "2026-10-29";
const ctx = { studentName: "Student A", teacherNickname: "Coach B", coach: "Coach B", subject: "Private FREESKATE", date: D1, startTime: "10:00", endTime: "11:00" };
const course = { bookingType: "COURSE_PACKAGE", size: 6 };
const slot = (date: string) => ({ date, startTime: "10:00", endTime: "11:00" });
const rentalCode = Object.keys(RENTAL_TIER_WORDS)[0]!;

type Aud = "parent" | "teacher" | "admin";
type Row = { kind: string; variant?: string; audiences: Aud[]; when: string; template?: keyof typeof TEMPLATE_FIELDS; payload: (lang: "TH" | "EN") => Record<string, unknown>; flag?: string };

// One entry per kind the outbox carries. `when` and `audiences` are read from the producers (scheduler / jobs / camp /
// other-series / rental / undo / teacher-link / attention / line-register / line-webhook services). An `admin` row is
// rendered as `parent` — the worker's own rule (`outbox.service.ts`: anything not `teacher` reads the fuller copy).
const KINDS: Row[] = [
  { kind: "booking_confirmed", audiences: ["parent", "teacher"], template: "session_confirmed", when: "A single session (or each seat of a bulk confirm) is confirmed.", payload: () => ({ ...course, attendeeNote: "Sample remark" }) },
  { kind: "course_confirmed", audiences: ["parent", "teacher"], template: "confirmed_schedule", when: "A whole course is confirmed — one message for the course.", payload: () => ({ ...course, studentName: "Student A", subject: "Private FREESKATE", weekday: 4, startTime: "10:00", endTime: "11:00", startDate: D1, expiryDate: "2027-01-15", coach: "Coach B", plannedLeaveDates: [D2], note: "Sample remark" }) },
  { kind: "course_deduction", audiences: ["parent"], template: "course_deduction", when: "A course session is used (attended / cut at day-end) — tells the family what is left.", payload: () => ({ ...course, total: 6, remaining: "4 HR", expiryDate: "2027-01-15", attendeeNote: "Sample remark" }) },
  { kind: "course_deduction", variant: "voucher", audiences: ["parent"], template: "course_deduction", when: "Same, for a voucher (its own title).", payload: () => ({ bookingType: "VOUCHER", total: 10, remaining: "8 HR", expiryDate: "2027-01-15" }) },
  { kind: "leave_notice", audiences: ["admin", "teacher"], template: "leave_notice", when: "A parent declares leave for a session — the coach and the admins are told.", payload: () => ({ ...course, attendeeNote: "Sample remark" }) },
  { kind: "class_cancelled_parent", audiences: ["parent"], template: "class_cancelled", when: "An admin cancels a class, or the coach's leave cancels it — to the family.", payload: () => ({ ...course, cancelReason: "TEACHER_LEAVE" }) },
  { kind: "class_cancelled_teacher", audiences: ["teacher"], template: "class_cancelled", when: "A confirmed class the coach was expecting is cancelled.", payload: () => ({ ...course, cancelReason: "CUSTOMER_CANCELLED" }) },
  { kind: "makeup_cancelled_parent", audiences: ["parent"], template: "class_cancelled", when: "A make-up class is cancelled — to the family, with the class the re-plan added.", payload: () => ({ ...course, newClassDates: [D2] }) },
  { kind: "class_on_again_teacher", audiences: ["teacher"], template: "class_on_again", when: "A leave is undone and the class is back on — to the coach only.", payload: () => ({ ...course }) },
  { kind: "class_moved_teacher", audiences: ["teacher"], template: "class_moved", when: "A class is moved to another day/time — to the coach.", payload: () => ({ ...course, from: slot(D1), to: slot(D2) }) },
  { kind: "class_moved_parent", audiences: ["parent"], template: "class_moved", when: "A class is moved to another day/time — to the family.", payload: () => ({ ...course, from: slot(D1), to: slot(D2) }) },
  { kind: "course_dropped_teacher", audiences: ["teacher"], template: "course_dropped", when: "A course is dropped — the coach loses its remaining classes.", payload: () => ({ size: 6, studentName: "Student A", dates: [D2, D3], startTime: "10:00", endTime: "11:00", cause: "dropped", cancelReason: "PROGRAM_CHANGED" }) },
  { kind: "course_dropped_teacher", variant: "ended", audiences: ["teacher"], template: "course_dropped", when: "Same, when the course is ENDED early or a whole voucher is cancelled (its own title).", payload: () => ({ size: 6, studentName: "Student A", dates: [D2, D3], startTime: "10:00", endTime: "11:00", cause: "ended", cancelReason: "CUSTOMER_CANCELLED" }) },
  { kind: "rental_added_teacher", audiences: ["teacher"], template: "rental_added", when: "Equipment rental is added to today's class after the morning reminder went.", payload: () => ({ ...course, rental: { code: rentalCode, remark: null } }) },
  { kind: "teacher_assigned", audiences: ["teacher"], when: "A coach is put on a class (teacher change / added to a series).", payload: () => ({}) },
  { kind: "teacher_unassigned", audiences: ["teacher"], when: "A coach is taken off a class.", payload: () => ({}) },
  { kind: "other_teacher_added", audiences: ["teacher"], when: "A coach is added to an 'Other' (อื่นๆ) series — one message per coach.", payload: () => ({ title: "Event C", startTime: "10:00", endTime: "11:00", dates: [D1, D2] }) },
  { kind: "other_teacher_removed", audiences: ["teacher"], when: "A coach is removed from an 'Other' series.", payload: () => ({ title: "Event C", startTime: "10:00", endTime: "11:00", dates: [D1, D2] }) },
  { kind: "other_series_cancelled", audiences: ["teacher"], when: "A whole 'Other' series is cancelled — every coach on it.", payload: () => ({ title: "Event C", startTime: "10:00", endTime: "11:00", dates: [D1, D2], reason: "ADMIN_ERROR" }) },
  { kind: "booking_paused", audiences: ["teacher"], when: "A booking is put on hold (course paused).", payload: () => ({ studentName: "Student A" }) },
  { kind: "booking_resumed", audiences: ["teacher"], when: "A held booking comes back.", payload: () => ({ studentName: "Student A" }) },
  { kind: "daily_reminder", audiences: ["parent", "teacher"], when: "Every morning (scheduled job) — today's classes.", payload: () => ({ rows: [{ date: D1, startTime: "10:00", endTime: "11:00", studentName: "Student A", subjectName: "Private FREESKATE", bookingType: "COURSE_PACKAGE", size: 6, remaining: "4 HR", expiryDate: "2027-01-15", coach: "Coach B", attendeeNote: "Sample remark" }] }) },
  { kind: "weekly_schedule_teacher", audiences: ["teacher"], when: "Every Monday (scheduled job) — the coach's week. English only by the owner's ruling.", payload: () => ({ rows: [{ date: D1, startTime: "10:00", endTime: "11:00", program: "Private FREESKATE", studentName: "Student A", status: "CONFIRMED", name: "Student A", subject: "Private FREESKATE", note: "Sample remark" }] }) },
  { kind: "camp_reminder", variant: "coach", audiences: ["teacher"], when: "The day before / morning of a camp day — the coach's camp roster.", payload: () => ({ audience: "teacher", rows: [{ weekName: "Camp Week 1", date: D1, total: 3, full: 1, am: 1, pm: 1, names: ["Student A", "Student B", "Student C"] }] }) },
  { kind: "camp_reminder", variant: "family", audiences: ["parent"], when: "The day before / morning of a camp day — the family's camp day.", payload: () => ({ audience: "parent", rows: [{ child: "Student A", weekName: "Camp Week 1", date: D1, half: "AM" }] }) },
  { kind: "camp_deduction", audiences: ["parent"], when: "Day-end camp credit cut — what is left. English only by the owner's ruling.", payload: () => ({ studentName: "Student A", date: D1, remainingDays: 1.5, totalDays: 5 }) },
  { kind: "makeup_far_out", audiences: ["admin"], when: "A make-up could only be placed very far out — admins are warned.", payload: () => ({ weeks: 26, replaces: D1, landedOn: "2027-04-15" }) },
  { kind: "daily_digest", audiences: ["admin"], when: "Every morning 08:00 (scheduled job) — the attention list for admins.", payload: () => ({ checks: ATTENTION_CHECKS.map((c) => ({ key: c.key, count: 1, items: [{ id: "x", label: "Student A" }] })) }) },
  // TASK-623 — the producer (`notifyTeacherOfLeaveDay`) sends these only when an admin acts ON BEHALF of the coach; the lift carries no actor.
  { kind: "teacher_leave_recorded", variant: "classes on that day", audiences: ["teacher"], when: "An admin records a leave day for the coach (not sent when the coach records it themselves) — classes already booked that day.", payload: () => ({ date: D2, classes: 2, actor: "Admin D" }) },
  { kind: "teacher_leave_recorded", variant: "no classes that day", audiences: ["teacher"], when: "Same, when nothing is booked that day — the 'not cancelled' line is not printed.", payload: () => ({ date: D2, classes: 0, actor: "Admin D" }) },
  { kind: "teacher_leave_lifted", audiences: ["teacher"], when: "An admin removes a leave day the coach had — bookings are open again.", payload: () => ({ date: D2, actor: null }) },
  { kind: "teacher_link_approved", audiences: ["teacher"], when: "An admin approves a coach's LINE link.", payload: (lang) => ({ text: t("verify_teacher_ok", lang, { nick: "Coach B" }) }) }, // the producer builds the text this way
  // Dead branches: rendered by the code, but nothing sends them today (no producer).
  { kind: "reschedule_requested", audiences: ["admin"], when: "NOT SENT TODAY — no producer (old reschedule flow).", payload: () => ({ to: slot(D2) }), flag: "NO PRODUCER" },
  { kind: "sick_leave", audiences: ["admin"], when: "NOT SENT TODAY — no producer.", payload: () => ({ via: "line", studentName: "Student A" }), flag: "NO PRODUCER" },
  { kind: "leave_teacher", audiences: ["teacher"], when: "NOT SENT TODAY — no producer.", payload: () => ({ studentName: "Student A" }), flag: "NO PRODUCER" },
  // Sent, but no `case` in `formatOutboxMessage`: they print the generic `ob_default` (the code says "BLOCKED ON COPY").
  { kind: "student_registered", audiences: ["admin"], when: "A family registers a child through LINE.", payload: () => ({ studentName: "Student A" }), flag: "NO WORDING YET" },
  { kind: "parent_asked_for_admin", audiences: ["admin"], when: "A parent asks to talk to an admin in the chat.", payload: () => ({}), flag: "NO WORDING YET" },
  { kind: "teacher_asked_for_admin", audiences: ["admin"], when: "A coach asks to talk to an admin in the chat.", payload: () => ({}), flag: "NO WORDING YET" },
  { kind: "admin_asked_for_admin", audiences: ["admin"], when: "An admin account asks for an admin in the chat.", payload: () => ({}), flag: "NO WORDING YET" },
  { kind: "unlinked_asked_for_admin", audiences: ["admin"], when: "Someone not linked yet asks for an admin in the chat.", payload: () => ({}), flag: "NO WORDING YET" },
];

// ── Drift guard: every `case` in the renderer is listed above, and every listed non-case falls to the default ─────
const LM = read("src/lib/line-message.ts");
const switchBody = LM.slice(LM.indexOf("function buildOutboxMessage("));
const CASES = new Set([...switchBody.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!));
const listed = new Set(KINDS.map((k) => k.kind));
const missing = [...CASES].filter((c) => !listed.has(c));
if (missing.length) throw new Error(`renderer kinds not in the inventory: ${missing.join(", ")}`);
const DEFAULT_TEXT = { TH: t("ob_default", "TH"), EN: t("ob_default", "EN") };

// ── Sheet 1: push ──────────────────────────────────────────────────────────────────────────────────────────────────
const fieldsOf = (msg: string) => msg.split("\n").map((l) => l.match(/^\s*([A-Za-z*][A-Za-z *]*?)\s?:\s/)?.[1]?.trim()).filter(Boolean).join(" · ");
const emptyRule = (r: Row, type: string) => {
  if (!r.template) return "";
  const tf = TEMPLATE_FIELDS[r.template];
  const parts = ["a field with no value is left out (no empty label)"];
  if (tf.includes("advanceLeave")) parts.push(`'**Advance Leave Notice' prints ${TEMPLATE_NONE} when there is none`);
  const omits = (["ONE_HOUR", "FIRST_TRIAL", "OTHER"] as const).map((x) => TYPE_OMITS[x]).flat().filter((f) => tf.includes(f));
  if (omits.length) parts.push(`1 HR / 1st Trial / Other: no ${[...new Set(omits)].join(", ")}`);
  if (type) parts.push(`(sample rendered as ${type})`);
  return parts.join("; ");
};

const push: string[][] = [["#", "audience", "when it is sent", "kind", "TH message", "EN message", "fields, in order", "empty-field rule", "Fern's revision", "flag"]];
const pushTexts: string[] = [];
const unrendered: string[] = [];
for (const r of KINDS) {
  for (const aud of r.audiences) {
    const render = (lang: "TH" | "EN") => {
      try { return formatOutboxMessage({ kind: r.kind, ...r.payload(lang) } as any, ctx, lang, aud === "teacher" ? "teacher" : "parent"); }
      catch (e) { unrendered.push(`${r.kind}/${aud}/${lang}: ${(e as Error).message}`); return ""; }
    };
    const th = render("TH"), en = render("EN");
    pushTexts.push(th, en);
    const flags = [r.flag];
    if (!r.flag && (th === DEFAULT_TEXT.TH || en === DEFAULT_TEXT.EN)) flags.push("NO WORDING YET");
    if (!th || !en) flags.push("COULD NOT RENDER");
    const type = r.template ? notifyTypeOf((r.payload("EN").bookingType as string) ?? "COURSE_PACKAGE") : "";
    push.push([String(push.length), aud, r.when, r.variant ? `${r.kind} (${r.variant})` : r.kind, th, en, fieldsOf(en), emptyRule(r, type), "", flags.filter(Boolean).join(", ")]);
  }
}

// ── Sheet 2: replies — every dictionary key NOT already shown in sheet 1, plus the registration screens ───────────────
// "Shown in sheet 1" is decided from the OUTPUT: a key whose every literal piece (the text between `{vars}`) appears in
// some rendered push message in that language. No hand-kept list of which keys the notifications use.
const inPush = (text: string) => {
  const pieces = text.split(/\{[a-zA-Z_]+\}/).map((p) => p.trim()).filter((p) => p.length >= 2);
  return pieces.length > 0 && pieces.every((p) => pushTexts.some((m) => m.includes(p)));
};
const REG = new Set(Object.keys(REGISTRATION_COPY));
const seen = new Set<string>();
const replies: string[][] = [["#", "key", "TH", "EN", "Fern's revision", "flag"]];
const flagCount: Record<string, number> = {};
for (const [key, th, en] of allChatStrings()) {
  if (seen.has(key)) continue; // a registration screen appears in the table AND in REGISTRATION_COPY — once is enough
  seen.add(key);
  if (REG.has(key)) { replies.push([String(replies.length), key, th, "(same message — the screen is bilingual in one text)", "", ""]); continue; }
  if (inPush(th) && (!en || inPush(en))) continue;
  const flag = en ? "" : "NO EN";
  replies.push([String(replies.length), key, th, en, "", flag]);
}

// ── HARD-CODED: wording that does not come from the dictionary ────────────────────────────────────────────────────
// Scanned in the files that BUILD messages: everything `line-message.ts` imports from `./`, everything the two chat
// services import from `../lib/`, and those two services themselves. A literal counts when it is human text: Thai
// letters, or an English phrase (a space and a capital/emoji start, 8+ chars). Comments, imports, `throw` and `console`
// lines are skipped. ⚠️ A heuristic, and declared as one: every hit is listed so a person can judge it.
const importsOf = (file: string, prefix: string) =>
  [...read(file).matchAll(new RegExp(`from "${prefix.replace(/\./g, "\\.")}([a-z0-9-]+)"`, "g"))].map((m) => `src/lib/${m[1]}.ts`);
const scanFiles = [...new Set([
  ...importsOf("src/lib/line-message.ts", "./"),
  ...importsOf("src/services/line-webhook.service.ts", "../lib/"),
  ...importsOf("src/services/line-register.service.ts", "../lib/"),
  "src/services/line-webhook.service.ts", "src/services/line-register.service.ts", "src/lib/line-message.ts", "src/lib/line-message-fields.ts",
])].filter((f) => f !== "src/lib/line-i18n.ts" && readdirSync(join(ROOT, f, "..")).includes(f.split("/").pop()!)).sort();
// Files in that set whose text never reaches a LINE user as a message — each with its reason.
const NOT_MESSAGES: Record<string, string> = {
  "src/lib/http.ts": "API error bodies for the web app",
  "src/lib/full-address.ts": "address normalisation data",
  "src/lib/line-client.ts": "transport (headers, error logs)",
  "src/lib/teacher-link.ts": "approval refusals shown on the staff web page",
  "src/lib/line-commands.ts": "words a user TYPES (the bot reads them, never sends them)",
  "src/lib/line-add-student.ts": "words a user TYPES",
  "src/lib/line-webhook.ts": "words a user TYPES (role choice)",
  "src/lib/line-log.ts": "webhook log lines",
  "src/lib/family-link.ts": "an operator log line",
};
const NOT_TEXT = /^Bearer |GREATEST\(|`?bun run /; // auth headers · SQL · an operator's CLI hint
const THAI = /[฀-๿]/;
const hard: string[][] = [];
for (const f of scanFiles) {
  if (NOT_MESSAGES[f]) continue;
  read(f).split("\n").forEach((src, i) => {
    const line = src.trim();
    if (!line || /^(\/\/|\*|\/\*|import )/.test(line) || /\bthrow\b|console\.|new Error\(|bun run /.test(line)) return;
    const code = line.replace(/\s\/\/\s.*$/, "");
    for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      const s = m[2]!;
      // an English phrase · or a TEMPLATE literal whose own text (its `${…}` holes removed) holds a Capitalised word and no
      // code shape — not a key (`_`), a query/log (`=`), a path (`/x`) or a `[tag]` log line (`Full ${n} · AM` counts)
      const own = s.replace(/\$\{[^}]*\}/g, "");
      const english = (s.length >= 8 && / /.test(s) && /^[A-Z\p{Extended_Pictographic}]/u.test(s))
        || (m[1] === "`" && /\b[A-Z][A-Za-z]*\b/.test(own) && !/[=_]|\/[A-Za-z]|^\s*\[/.test(own));
      if ((THAI.test(s) || english) && !NOT_TEXT.test(s)) hard.push([`${f.replace(/^src\//, "")}:${i + 1}`, s]);
    }
  });
}
for (const [where, s] of hard) replies.push([String(replies.length), where, THAI.test(s) ? s : "", THAI.test(s) ? "" : s, "", "HARD-CODED"]);

// ── Write ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const csv = (rows: string[][]) => "﻿" + rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "push.csv"), csv(push));
writeFileSync(join(outDir, "replies.csv"), csv(replies));
for (const r of [...push.slice(1).map((r) => r[9]!), ...replies.slice(1).map((r) => r[5]!)]) for (const f of r.split(", ").filter(Boolean)) flagCount[f] = (flagCount[f] ?? 0) + 1;
console.log(JSON.stringify({
  pushRows: push.length - 1, pushKinds: new Set(KINDS.map((k) => k.kind)).size, rendererCases: CASES.size,
  replyRows: replies.length - 1, hardCodedScanned: scanFiles.length - Object.keys(NOT_MESSAGES).length, hardCodedSkipped: NOT_MESSAGES, flags: flagCount, unrendered,
}, null, 2));
