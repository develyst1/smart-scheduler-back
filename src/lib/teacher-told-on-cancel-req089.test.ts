// TASK-370 (`REQ-089 §6`, item 7) — the coach is told when a CONFIRMED class is taken off his week: one
// `class_cancelled_teacher` per single cancel, one `course_dropped_teacher` per course PER COACH on a drop or an
// end. The owner's hard constraint is the HOUSE FORMAT (`leave_notice`'s shape), so the renderings are pinned by
// FORM — the bilingual stamp, the customer's `Label : value` block in his field order, the appended lines — and
// deliberately NOT by the words in the stamps: those are placeholders until the owner has seen them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cancelReasonText, formatOutboxMessage } from "./line-message";
import { TEMPLATE_FIELDS, TEMPLATE_NONE } from "./line-message-fields";
import { END_REASONS } from "./course-plan";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
};
const CTX = { studentName: "มะขิด", subject: "Freeskate", date: "2026-09-22", startTime: "12:00", endTime: "13:00", coach: "Ek" } as any;

describe("🔑 `cancelReasonText` — the ONE reason rule: code label → note → (-)", () => {
  test("each closed code has a label in both languages, and the two languages differ", () => {
    for (const c of END_REASONS) {
      const th = cancelReasonText(c, "ignored", "TH");
      const en = cancelReasonText(c, "ignored", "EN");
      expect({ c, th: th.length > 0, en: en.length > 0, differ: th !== en, rawCode: th === c || en === c }).toEqual({ c, th: true, en: true, differ: true, rawCode: false });
    }
  });
  test("no code ⇒ the note; blank note ⇒ the house (-); an unknown code is not a label", () => {
    expect(cancelReasonText(null, "พักคอร์สชั่วคราว", "TH")).toBe("พักคอร์สชั่วคราว");
    expect(cancelReasonText(undefined, "   ", "TH")).toBe(TEMPLATE_NONE);
    expect(cancelReasonText(null, null, "EN")).toBe("(-)");
    expect(cancelReasonText("NOT_A_CODE", "the note", "EN")).toBe("the note");
  });
});

describe("🔑 `class_cancelled_teacher` — `leave_notice`'s shape, line for line", () => {
  const render = (lang: "TH" | "EN", payload: Record<string, unknown> = {}) =>
    formatOutboxMessage({ kind: "class_cancelled_teacher", bookingType: "COURSE_PACKAGE", size: 6, cancelReason: "CUSTOMER_CANCELLED", ...payload } as any, CTX, lang, "teacher");

  test("the FORM: a bilingual stamp with ‼️, then the customer's block in his order, then Reason", () => {
    const lines = render("TH").split("\n");
    expect(lines[0]).toMatch(/^[A-Z ]+ \/ \S+ ‼️$/); // `LEAVE NOTICE / แจ้งลา ‼️`'s shape — words not frozen
    expect(lines.slice(1)).toEqual([
      "Student : มะขิด",
      "Program : Freeskate 6 HR",
      "Date : 22-09-2026",
      "Time : 12:00-13:00",
      "Coach : Ek",
      `Reason : ${cancelReasonText("CUSTOMER_CANCELLED", null, "TH")}`,
    ]);
  });

  test("EN: the same labels (the customer's are English in both languages), the same stamp, the reason in English", () => {
    const th = render("TH").split("\n"), en = render("EN").split("\n");
    expect(en[0]).toBe(th[0]);
    expect(en.slice(1, 6)).toEqual(th.slice(1, 6));
    expect(en[6]).toBe(`Reason : ${cancelReasonText("CUSTOMER_CANCELLED", null, "EN")}`);
  });

  test("a 1HR cancel: the program label is the house one, and Reason falls back to the note", () => {
    const out = formatOutboxMessage({ kind: "class_cancelled_teacher", bookingType: "SINGLE_SESSION", note: "แม่โทรมายกเลิก" } as any, CTX, "TH", "teacher");
    expect(out).toContain("Program : Freeskate 1 HR");
    expect(out).toContain("Reason : แม่โทรมายกเลิก");
  });

  test("the `leave_notice` twin renders the identical block for the same session — one shape, two stamps", () => {
    const leave = formatOutboxMessage({ kind: "leave_notice", bookingType: "COURSE_PACKAGE", size: 6 } as any, CTX, "TH", "teacher").split("\n");
    const mine = render("TH").split("\n");
    expect(mine.slice(1, 6)).toEqual(leave.slice(1, 6));
    expect(TEMPLATE_FIELDS.class_cancelled).toEqual(TEMPLATE_FIELDS.leave_notice);
  });
});

describe("🔑 `course_dropped_teacher` — one message per course per coach: the block, then Sessions / Date list / Time / Reason", () => {
  const dates = ["2026-09-22", "2026-09-29", "2026-10-06"];
  const render = (lang: "TH" | "EN", payload: Record<string, unknown> = {}) =>
    formatOutboxMessage({ kind: "course_dropped_teacher", cause: "dropped", size: 6, dates, startTime: "12:00", endTime: "13:00", note: "พักคอร์สชั่วคราว", ...payload } as any, { studentName: "มะขิด", subject: "Freeskate", coach: "Ek" } as any, lang, "teacher");

  test("the FORM, with the three dates in DD-MM-YYYY joined by `, ` — the §7.1 list's own join", () => {
    const lines = render("TH").split("\n");
    expect(lines[0]).toMatch(/^[A-Z ]+ \/ \S+ ‼️$/);
    expect(lines.slice(1)).toEqual([
      "Student : มะขิด",
      "Program : Freeskate 6 HR",
      "Coach : Ek",
      "Sessions : 3",
      "Date : 22-09-2026, 29-09-2026, 06-10-2026",
      "Time : 12:00-13:00",
      "Reason : พักคอร์สชั่วคราว",
    ]);
  });

  test("an END prints a different stamp from a DROP, and the closed end reason as its Reason", () => {
    const drop = render("TH").split("\n")[0];
    const end = render("TH", { cause: "ended", cancelReason: "PROGRAM_CHANGED", note: null }).split("\n");
    expect(end[0]).not.toBe(drop);
    expect(end[0]).toMatch(/^[A-Z ]+ \/ \S+ ‼️$/);
    expect(end.at(-1)).toBe(`Reason : ${cancelReasonText("PROGRAM_CHANGED", null, "TH")}`);
  });

  test("🚫 no cap on the list — every date a coach loses prints (a size-10 with two make-ups: twelve)", () => {
    const many = Array.from({ length: 12 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    const out = render("EN", { dates: many, size: 10 });
    expect(out).toContain("Sessions : 12");
    for (const d of many) expect(out).toContain(d.split("-").reverse().join("-"));
    expect(out).not.toMatch(/more|อีก/);
  });

  test("no dates (a payload nobody should build) ⇒ no Sessions/Date lines, never a bare label", () => {
    const out = render("TH", { dates: [] });
    expect(out).not.toContain("Sessions :");
    expect(out).not.toContain("Date :");
    expect(out).toContain("Reason : พักคอร์สชั่วคราว");
  });
});

describe("🔴 the wiring — the CONFIRMED gate, one per coach, every existing send untouched (source)", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  const SINGLE = region(SVC, "async function sendClassCancelledToTeacher(", "async function sendCourseDroppedToTeachers(");
  const BULK = region(SVC, "async function sendCourseDroppedToTeachers(", "export async function applyPlanChange(");
  const CANCEL = region(SVC, '} else if (action === "cancel") {', '} else if (action === "sick-leave"');
  const PAUSE = region(SVC, "export async function pauseBooking(", "export async function resumeBooking(");
  const DROP = region(SVC, "export async function dropCourse(", "export async function resumeCourse(");
  const END = region(SVC, "export async function endCourse(", "\n}\n");

  test("single: gated on the PRE-write status being CONFIRMED; a PENDING one earns nothing", () => {
    expect(SINGLE).toContain('if (current.status !== "CONFIRMED") return null;');
    expect(SINGLE).toContain('kind: "class_cancelled_teacher"');
    expect(CANCEL).toContain("notification = await sendClassCancelledToTeacher(tx, current, {");
    // …and it is the ONLY send on the cancel branch: the parent was not told before and is not told now.
    expect((CANCEL.match(/enqueueLine\(/g) ?? []).length).toBe(0);
    expect((CANCEL.match(/sendClassCancelledToTeacher\(/g) ?? []).length).toBe(1);
    expect(CANCEL).not.toContain("enqueueParentCopies");
  });

  test("bulk: only the rows that WERE confirmed, grouped by coach, one row each, `bookingId` = his first date", () => {
    expect(BULK).toContain("for (const b of confirmedOnly(cancelled)) {");
    expect(BULK).toContain("byTeacher.set(b.teacherId, [...(byTeacher.get(b.teacherId) ?? []), b]);");
    expect(BULK).toContain("for (const [teacherId, rows] of byTeacher) {");
    expect(BULK).toContain("bookingId: first.id,");
    expect(BULK).toContain("dates: ordered.map((r) => r.date),");
    expect((BULK.match(/enqueueLine\(/g) ?? []).length).toBe(1);
    expect(SVC).toContain('const confirmedOnly = <T extends { status: string }>(rows: T[]): T[] => rows.filter((r) => r.status === "CONFIRMED");');
  });

  test("drop AND end call it, each after its own cancel loop with the pre-write rows; `cause` names which", () => {
    expect(DROP).toContain('await sendCourseDroppedToTeachers(tx, course, paused, "dropped", { cancelReason: null, note: COURSE_PAUSE_NOTE });');
    expect(END).toContain('await sendCourseDroppedToTeachers(tx, course, doomed, "ended", { cancelReason: input.reason, note: input.note?.trim() || null });');
    expect(DROP.indexOf("sendCourseDroppedToTeachers")).toBeGreaterThan(DROP.indexOf('status: "CANCELLED", note: COURSE_PAUSE_NOTE'));
    expect(END.indexOf("sendCourseDroppedToTeachers")).toBeGreaterThan(END.indexOf('status: "CANCELLED", note: "ยกเลิกคอร์ส'));
  });

  test("🚫 the single PAUSE is UNTOUCHED — TASK-260's `booking_paused` is still its one send, and no second pause message exists", () => {
    expect((PAUSE.match(/enqueueLine\(/g) ?? []).length).toBe(1);
    expect(PAUSE).toContain('payload: { kind: "booking_paused" }');
    expect(PAUSE).not.toContain("class_cancelled_teacher");
    expect(src("src/lib/line-i18n.ts")).toContain('TH: "คาบนี้ถูกพักไว้ชั่วคราวค่ะ — {student} · {date} {time} · ยังไม่มีกำหนดใหม่",');
  });

  test("unlinked ⇒ SKIPPED by `enqueueLine` itself: both senders pass `teacher?.lineUserId ?? null`, never branch on it", () => {
    for (const R of [SINGLE, BULK]) {
      expect(R).toContain("recipientLineUserId: teacher?.lineUserId ?? null,");
      expect(R).not.toContain("if (teacher?.lineUserId)");
    }
    expect(code(src("src/lib/line.ts"))).toContain('status: "SKIPPED",');
  });

  test("the words are PLACEHOLDERS, said so beside the keys; the reason labels cover exactly END_REASONS", () => {
    const I18N = src("src/lib/line-i18n.ts");
    expect(I18N).toContain("PLACEHOLDERS — MINE, and the customer has NOT seen them** (TASK-370");
    for (const c of END_REASONS) expect(I18N).toContain(`ob_reason_${c}:`);
    expect((I18N.match(/ob_reason_[A-Z_]+:/g) ?? []).length).toBe(END_REASONS.length);
  });
});
