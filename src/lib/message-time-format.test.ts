// TASK-283 — DEF-3: `TODAY'S SCHEDULE` printed `09:00:00-10:00`, seconds on the START only.
//
// 🔴 @Porter's point, and the reason this is a task rather than a line: *"Your test compares `CONFIRMED`
// against `DEDUCTION` and both are right. The defect lives in the third rendering, which the comparison does
// not reach."* TASK-257 §2 made `Time` mean one thing by comparing TWO messages; the daily block is Decision 6
// and did not exist when that assertion was written.
//
// ⇒ **This file enumerates the message kinds that print a `Time` from ONE list — `TEMPLATE_FIELDS` — instead
// of naming them.** A fourth template cannot be added without joining it, in two independent ways:
//   1. `TIME_OWNER` is a `Record<TemplateKey, …>`, so a new key is a COMPILE error until it declares itself;
//   2. the loop cross-checks that declaration against `TEMPLATE_FIELDS`, so declaring `null` for a template
//      that does print a `Time` FAILS rather than opts out.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupReminders, type ReminderSession } from "./daily-reminder";
import { formatOutboxMessage } from "./line-message";
import { TEMPLATE_FIELDS, type TemplateKey } from "./line-message-fields";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));

/**
 * 🔑 Where each template's `Time` is BUILT — the file that puts the two ends onto the payload or the context,
 * and the exact expression that formats each end. `null` means "this template prints no `Time`".
 *
 * 🚫 Deliberately the BUILD site, never the render site. The three renderers all join `start-end` from values
 * handed to them; trimming at the join would make two places responsible for the same fact, and the next
 * message added would be the third.
 */
const TIME_OWNER: Record<TemplateKey, { kind: string; file: string; start: string; end: string } | null> = {
  confirmed_schedule: {
    kind: "course_confirmed",
    file: "src/services/scheduler.service.ts",
    start: "startTime: hhmm(course.startTime),",
    // TASK-257 §2 derived the end HERE with the same `addHour` every booking write uses, rather than in the
    // renderer — so `Time` is a range and this message agrees with COURSE DEDUCTION about what that means.
    end: "endTime: addHour(course.startTime),",
  },
  course_deduction: {
    kind: "course_deduction",
    file: "src/services/outbox.service.ts",
    start: "startTime: hhmm(b.startTime),",
    end: "endTime: hhmm(b.endTime),",
  },
  todays_schedule: {
    kind: "daily_reminder",
    // 🔴 The fix. This was `src/services/jobs.service.ts` for the END and NOWHERE for the START — the two ends
    // of one range with two different owners, one of whom did not exist. Both now live in the pure builder
    // that constructs the row, like the other two templates.
    file: "src/lib/daily-reminder.ts",
    start: "startTime: hhmm(s.startTime),",
    end: "endTime: s.endTime ? hhmm(s.endTime) : null,",
  },
};

describe("🔑 TASK-283 — every message that prints a `Time`, from ONE list", () => {
  test("each template either prints no `Time`, or names ONE file that formats BOTH of its ends", () => {
    // The enumeration is `TEMPLATE_FIELDS` itself — the table that decides which fields a template renders.
    // Nothing here restates "there are three"; the list is read, not typed.
    const audit = (Object.keys(TEMPLATE_FIELDS) as TemplateKey[]).map((key) => {
      const owner = TIME_OWNER[key];
      const printsTime = TEMPLATE_FIELDS[key].includes("time");
      if (!printsTime) return { key, printsTime, declared: owner !== null };
      const s = owner ? src(owner.file) : "";
      return {
        key,
        printsTime,
        declared: owner !== null,
        // 🔴 BOTH ends, in the SAME file. One end formatted and the other not is exactly the defect.
        start: s.includes(owner?.start ?? " "),
        end: s.includes(owner?.end ?? " "),
      };
    });

    expect(audit).toEqual([
      { key: "confirmed_schedule", printsTime: true, declared: true, start: true, end: true },
      { key: "todays_schedule", printsTime: true, declared: true, start: true, end: true },
      { key: "course_deduction", printsTime: true, declared: true, start: true, end: true },
    ]);
  });

  test("🚫 …and none of them trims at the RENDER site — the join stays a join", () => {
    // If a renderer ever starts slicing, the build-site assertion above could pass while the real guarantee
    // moved somewhere it has to be repeated per message.
    for (const f of ["src/lib/line-today-schedule.ts", "src/lib/line-message.ts"]) {
      expect({ f, trims: src(f).includes("hhmm(") }).toEqual({ f, trims: false });
    }
  });
});

describe("TASK-283 — the rendered messages", () => {
  const session = (o: Partial<ReminderSession> = {}): ReminderSession => ({
    id: "b1",
    date: "2026-09-08",
    // 🔴 RAW, exactly as the `time` column hands them over — the whole point of the fixture.
    startTime: "09:00:00",
    endTime: "10:00:00",
    status: "CONFIRMED",
    teacherId: "t1",
    teacherLineUserId: "Ut1",
    studentId: "s1",
    studentName: "น้องเอ",
    parentId: "p1",
    parentLineUserId: "Up1",
    subjectName: "Surfskate",
    bookingType: "COURSE_PACKAGE",
    size: 6,
    remaining: "4/6 ครั้ง",
    expiryDate: "2026-12-31",
    coach: "ครูหนึ่ง",
    ...o,
  });
  const today = (s: ReminderSession[]) =>
    formatOutboxMessage(
      { kind: "daily_reminder", rows: groupReminders(s)[0]!.rows } as any,
      {},
      "TH",
      "parent",
    );

  test("🔑 `TODAY'S SCHEDULE` prints `09:00-10:00` — the owner's exact line", () => {
    expect(today([session()])).toBe(
      "⏱️TODAY'S SCHEDULE:\nStudent : น้องเอ\nProgram : Surfskate 6 HR\nDate : 2026-09-08\n" +
        "Time : 09:00-10:00\nCoach : ครูหนึ่ง\nRemaining : 4/6 ครั้ง\n*Expiry date : 2026-12-31",
    );
  });

  test("…and in the numbered multi-class block, where the owner actually saw it", () => {
    const out = today([session(), session({ id: "b2", startTime: "11:00:00", endTime: "12:00:00" })]);
    expect(out).toContain("1) Time : 09:00-10:00");
    expect(out).toContain("2) Time : 11:00-12:00");
    // 🚫 No seconds anywhere in the message — the net, not the two lines.
    expect(out).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test("a class with no end time still prints its start, trimmed", () => {
    expect(today([session({ endTime: null })])).toContain("Time : 09:00\n");
  });

  test("🚫 `CONFIRMED SCHEDULE` is byte-identical — asserted, not assumed", () => {
    const COURSE = {
      kind: "course_confirmed",
      studentName: "น้องเอ",
      subject: "Private Freeskate",
      bookingType: "COURSE_PACKAGE",
      size: 6,
      expiryDate: "2026-12-31",
      coach: "ครูหนึ่ง",
      startDate: "2026-09-06",
      weekday: 0,
      startTime: "10:00",
      endTime: "11:00",
      plannedLeaveDates: ["2026-09-14"],
      note: "แพ้ถั่ว",
    };
    expect(formatOutboxMessage(COURSE as any, {}, "TH", "parent")).toBe(
      "📅CONFIRMED SCHEDULE:\nStudent : น้องเอ\nProgram : Private Freeskate 6 HR\nDate : อาทิตย์\n" +
        "Time : 10:00-11:00\nStart : 2026-09-06\nCoach : ครูหนึ่ง\n*Expiry date : 2026-12-31\n" +
        "**Advance Leave Notice : 2026-09-14\nSessions : 6\nRemark : แพ้ถั่ว",
    );
  });

  test("🚫 `COURSE DEDUCTION` is byte-identical — asserted, not assumed", () => {
    const ctx = {
      studentName: "น้องเอ",
      subject: "Private Freeskate",
      coach: "ครูหนึ่ง",
      date: "2026-09-06",
      startTime: "10:00",
      endTime: "11:00",
    };
    expect(
      formatOutboxMessage(
        { kind: "course_deduction", bookingType: "COURSE_PACKAGE", total: 6, remaining: "4/6 ครั้ง" } as any,
        ctx as any,
        "TH",
        "parent",
      ),
    ).toBe(
      "💡COURSE DEDUCTION\nStudent : น้องเอ\nProgram : Private Freeskate 6 HR\nDate : 2026-09-06\n" +
        "Time : 10:00-11:00\nCoach : ครูหนึ่ง\nRemaining : 4/6 ครั้ง",
    );
  });
});
