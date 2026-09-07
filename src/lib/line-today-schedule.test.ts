// SPEC-072 / TASK-256 (REQ-077 Parent 2 · @Porter's Decision 6) — `TODAY'S SCHEDULE`.
//
// 🔴 The assertions that matter here are `toBe` against the customer's own literal. A `toContain` would pass on
// a message that had grown a stray line, lost its blank line, or reordered their fields — and the whole point of
// Decision 6 is that **one class renders EXACTLY as they wrote it**, because that is the common case and the one
// they wrote the template for.
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";
import { renderTodaySchedule, type TodayRow } from "./line-today-schedule";
import { groupReminders, reminderKey, type ReminderSession } from "./daily-reminder";

const REMINDER = readSrc(await Bun.file(new URL("./daily-reminder.ts", import.meta.url)).text());

const course = (o: Partial<TodayRow> = {}): TodayRow => ({
  date: "6 Sep 2026",
  startTime: "10:00-11:00",
  studentName: "น้องดีซี",
  subjectName: "Private Freeskate",
  bookingType: "COURSE_PACKAGE",
  size: 6,
  remaining: "4 HR",
  expiryDate: "30 Nov 2026",
  coach: "Ek",
  ...o,
});

describe("🔴 ONE class — the customer's template, byte for byte", () => {
  test("it renders exactly as REQ-077 Parent 2 is written", () => {
    // Their field order, their labels, their ` : ` separator, no numbering, nothing hoisted. If this ever needs
    // a `toContain` to pass, the common case has drifted from the document they signed off.
    expect(renderTodaySchedule([course()], "TH", "parent")).toBe(
      [
        "⏱️TODAY'S SCHEDULE:",
        "Student : น้องดีซี",
        "Program : Private Freeskate 6 HR",
        "Date : 6 Sep 2026",
        "Time : 10:00-11:00",
        "Coach : Ek",
        "Remaining : 4 HR",
        "*Expiry date : 30 Nov 2026",
      ].join("\n"),
    );
  });

  test("a 1HR loses `Remaining` and `*Expiry date` — it has neither (the per-type table)", () => {
    expect(renderTodaySchedule([course({ bookingType: "SINGLE_SESSION", size: null, remaining: null, expiryDate: null })], "TH", "parent")).toBe(
      [
        "⏱️TODAY'S SCHEDULE:",
        "Student : น้องดีซี",
        "Program : Private Freeskate 1 HR",
        "Date : 6 Sep 2026",
        "Time : 10:00-11:00",
        "Coach : Ek",
      ].join("\n"),
    );
  });

  test("🔴 the teacher's copy IS the parent's — the customer's own 09-05 draft, confirmed 09-07", () => {
    // Was: *the teacher drops `*Expiry date`*. 🔻 TASK-269 §3 restores it. The customer's draft says
    // *ครู 2. ⏱️TODAY'S SCHEDULE — identical to the parent's #2*, and the owner confirmed *เอาหมด*.
    // ⚠️ Stated here rather than discovered: emptying the table changes THREE templates, not just the one
    // the report was about, because it is per-audience.
    const teacher = renderTodaySchedule([course()], "TH", "teacher");
    const parent = renderTodaySchedule([course()], "TH", "parent");
    expect(teacher).toContain("Remaining : 4 HR");
    expect(teacher).toContain("Coach : Ek");
    expect(teacher).toBe(parent);
  });

  test("an อื่นๆ session is named by its title and grows no program it does not have", () => {
    const out = renderTodaySchedule(
      [course({ bookingType: "OTHER", studentName: null, subjectName: null, title: "ประชุมทีม", remaining: null, expiryDate: null, size: null })],
      "TH",
      "teacher",
    );
    expect(out).toContain("Student : ประชุมทีม");
    expect(out).toContain("Program : ประชุมทีม");
    expect(out).not.toContain("null");
    // No FIELD line ends in a bare label — the customer's own heading ends in a colon, so it is excluded by name
    // rather than by loosening the pattern.
    for (const l of out.split("\n").slice(1)) expect(l).not.toMatch(/:\s*$/);
  });

  test("no classes ⇒ the empty state, not a bare header", () => {
    expect(renderTodaySchedule([], "TH")).toContain("ไม่มีคาบสอนในช่วงนี้");
  });
});

describe("🔴 SEVERAL classes — Decision 6's blocks, under a header of what is genuinely constant", () => {
  const two = [
    course(),
    course({ startTime: "11:00-12:00", studentName: "น้องเอ", subjectName: "Balance Play", remaining: "2 HR", expiryDate: "12 Dec 2026" }),
  ];

  test("it renders as Decision 6's own example", () => {
    expect(renderTodaySchedule(two, "TH", "parent")).toBe(
      [
        "⏱️TODAY'S SCHEDULE:",
        "Date : 6 Sep 2026",
        "Coach : Ek",
        "",
        "1) Time : 10:00-11:00",
        "   Student : น้องดีซี",
        "   Program : Private Freeskate 6 HR",
        "   Remaining : 4 HR",
        "   *Expiry date : 30 Nov 2026",
        "",
        "2) Time : 11:00-12:00",
        "   Student : น้องเอ",
        "   Program : Balance Play 6 HR",
        "   Remaining : 2 HR",
        "   *Expiry date : 12 Dec 2026",
      ].join("\n"),
    );
  });

  test("classes are ordered by time, however the query returned them", () => {
    const out = renderTodaySchedule([two[1]!, two[0]!], "TH", "parent");
    expect(out.indexOf("10:00-11:00")).toBeLessThan(out.indexOf("11:00-12:00"));
  });
});

describe("🔴 §2 — `Coach` hoists only when the DATA agrees, never because Decision 6 said it is constant", () => {
  test("two classes, DIFFERENT coaches ⇒ `Coach` is in each block and NOT in the header", () => {
    // The case Decision 6 did not have in front of it: a parent with two children can have two coaches in a
    // day. Hoisting would print one coach's name above another coach's class — in the message a parent reads to
    // know who is teaching their child, that is a false statement, not a layout wrinkle.
    const out = renderTodaySchedule(
      [course(), course({ startTime: "11:00-12:00", studentName: "น้องเอ", coach: "Bank" })],
      "TH",
      "parent",
    );
    const lines = out.split("\n");
    const header = lines.slice(0, lines.indexOf(""));
    expect(header).toEqual(["⏱️TODAY'S SCHEDULE:", "Date : 6 Sep 2026"]);
    expect(out).toContain("   Coach : Ek");
    expect(out).toContain("   Coach : Bank");
  });

  test("two classes, the SAME coach ⇒ `Coach` in the header only", () => {
    const out = renderTodaySchedule([course(), course({ startTime: "11:00-12:00", studentName: "น้องเอ" })], "TH", "parent");
    expect(out.split("\n")[2]).toBe("Coach : Ek");
    expect(out).not.toContain("   Coach :");
  });

  test("🔑 …so a coach's eight-class day still hoists — hoisting is a property of the DATA, not the audience", () => {
    // @Porter's intent, delivered exactly: his reason for one shared rule was *"two formats for one message is
    // how they drift apart"*, and computing the hoist keeps one rule rather than a parent/teacher special case.
    const eight = Array.from({ length: 8 }, (_, i) =>
      course({ startTime: `${9 + i}:00-${10 + i}:00`, studentName: `น้อง${i}` }),
    );
    const out = renderTodaySchedule(eight, "TH", "teacher");
    expect(out.split("\n")[2]).toBe("Coach : Ek");
    expect(out).not.toContain("   Coach :");
    expect(out.split("\n").filter((l) => /^\d\) /.test(l))).toHaveLength(8);
  });

  test("⚠️ a multi-teacher booking (REQ-078) can break the agreement on a COACH's own copy too", () => {
    // Two blocks with different teacher LISTS: the recipient is on both, but they are not the same `Coach`.
    const out = renderTodaySchedule(
      [course({ coach: "Ek, Bank" }), course({ startTime: "11:00-12:00", coach: "Ek" })],
      "TH",
      "teacher",
    );
    expect(out).toContain("   Coach : Ek, Bank");
    expect(out).toContain("   Coach : Ek");
  });

  test("`Date` is hoisted always — the message is one day by construction", () => {
    const out = renderTodaySchedule([course(), course({ startTime: "11:00-12:00", coach: "Bank" })], "TH", "parent");
    expect(out.split("\n")[1]).toBe("Date : 6 Sep 2026");
    expect(out).not.toContain("   Date :");
  });

  test("🚫 a field one block would OMIT never gets hoisted from the other", () => {
    // A course beside a 1HR: the 1HR has no expiry at all, so a header line would announce a value that block
    // was entitled not to have. Hoisting is per-field agreement, and "absent" never agrees with a value.
    const out = renderTodaySchedule(
      [course(), course({ startTime: "11:00-12:00", bookingType: "SINGLE_SESSION", remaining: null, expiryDate: null, size: null })],
      "TH",
      "parent",
    );
    expect(out.split("\n").filter((l) => l.startsWith("*Expiry date"))).toHaveLength(0);
    expect(out).toContain("   *Expiry date : 30 Nov 2026");
  });

  test("📌 `Program` stays in the block even when every class shares it — my call, and the reason", () => {
    // @Sober's question. It follows §2's rule mechanically, but a block reduced to `Time` + `Student` reads as
    // truncated — a block should stand on its own. So `Program` is deliberately NOT hoistable, and that is one
    // line (`HOISTABLE`) to change if he disagrees.
    const out = renderTodaySchedule(
      [course(), course({ startTime: "11:00-12:00", studentName: "น้องเอ" })],
      "TH",
      "parent",
    );
    expect(out.split("\n").filter((l) => l.includes("Program : Private Freeskate 6 HR"))).toHaveLength(2);
  });
});

describe("🚫 what must not regress", () => {
  const s = (o: Partial<ReminderSession> & { id: string }): ReminderSession => ({
    date: "2026-09-06",
    startTime: "10:00:00",
    status: "CONFIRMED",
    teacherId: "t1",
    teacherLineUserId: "Ut1",
    studentId: "st1",
    studentName: "น้องเอ",
    parentId: "p1",
    parentLineUserId: "Up1",
    subjectName: "Surfskate",
    ...o,
  });

  test("ONE message per person per day — the grouping is untouched", () => {
    const groups = groupReminders([s({ id: "b1" }), s({ id: "b2", startTime: "11:00:00", studentName: "น้องบี" })]);
    expect(groups.filter((g) => g.recipientType === "parent")).toHaveLength(1);
    expect(groups.find((g) => g.recipientType === "parent")!.rows).toHaveLength(2);
  });

  test("`reminderKey` is unchanged — the send-once guarantee must not depend on the body", () => {
    expect(reminderKey("parent", "p1", "2026-09-06")).toBe("reminder:parent:p1:2026-09-06");
    expect(REMINDER).toContain("`reminder:${recipientType}:${personId}:${date}`");
  });

  test("a cancelled or leave row still produces no reminder", () => {
    expect(groupReminders([s({ id: "b1", status: "CANCELLED" })])).toHaveLength(0);
    expect(groupReminders([s({ id: "b1", status: "SICK_LEAVE" })])).toHaveLength(0);
  });

  test("🚫 `renderSchedule` is NOT deleted — it is owner-verified and the fallback", () => {
    // It still serves the teacher's `ตาราง` command, and @Porter's review batch may yet prefer what the coaches
    // have been reading for weeks.
    expect(Bun.file(new URL("./line-schedule.ts", import.meta.url)).size).toBeGreaterThan(0);
  });
});
