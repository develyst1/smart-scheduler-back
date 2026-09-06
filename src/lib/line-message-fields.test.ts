// SPEC-072 / TASK-253 (REQ-077) — one payload, two renderings; and the per-type table.
//
// 🔴 The failure this whole design exists to avoid is NOT the privacy one. `scheduler.service.ts` builds the
// course payload once for the parent and the teacher on purpose — *"two copies… one of them would be missed,
// which is how the parent ends up reading a different schedule from the teacher."* A second payload, or a
// `teacher_course_confirmed` kind, would re-create exactly that, and a coach and a family disagreeing about
// **when the class is** is worse than the privacy problem being solved.
//
// ⇒ The assertions below are mostly about IDENTITY: the two copies must differ in the removed lines **and in
// nothing else**. Asserting only the absence would pass for two renderers that had quietly drifted apart.
import { describe, expect, test } from "bun:test";
import { formatOutboxMessage } from "./line-message";
import {
  AUDIENCE_OMITS,
  TEMPLATE_FIELDS,
  TYPE_OMITS,
  notifyTypeOf,
  programLabel,
  visibleFields,
  type NotifyType,
} from "./line-message-fields";

const COURSE = {
  kind: "course_confirmed",
  courseId: "c1",
  studentName: "น้องเอ",
  subject: "Private Freeskate",
  bookingType: "COURSE_PACKAGE",
  size: 6,
  expiryDate: "2026-12-31",
  coach: "ครูหนึ่ง",
  startDate: "2026-09-06",
  weekday: 0,
  startTime: "10:00",
  confirmed: 6,
  plannedLeaveDates: ["2026-09-14"],
  note: "แพ้ถั่ว",
};

describe("🔴 ONE payload, TWO renderings — the same object, projected", () => {
  const parent = formatOutboxMessage(COURSE, {}, "TH", "parent");
  const teacher = formatOutboxMessage(COURSE, {}, "TH", "teacher");

  test("the teacher's copy loses `*Expiry date` and `**Advance Leave Notice`", () => {
    // @Porter's call, flagged for the customer: a course's expiry and a family's declared absences are the
    // FAMILY's business. A coach needs who · what · when · where they stand today.
    expect(parent).toContain("*Expiry date : 2026-12-31");
    expect(parent).toContain("**Advance Leave Notice : 2026-09-14");
    expect(teacher).not.toContain("Expiry date");
    expect(teacher).not.toContain("Advance Leave");
  });

  test("🔑 …and EVERY OTHER LINE is identical — the identity, not just the absence", () => {
    // The real risk is drift, not disclosure. If these two ever stop being one payload projected two ways, this
    // is the assertion that says so — a parent and a coach reading a different schedule.
    const strip = (s: string) =>
      s.split("\n").filter((l) => !l.includes("Expiry date") && !l.includes("Advance Leave"));
    expect(strip(parent)).toEqual(strip(teacher));
  });

  test("📌 `Coach` is KEPT on the teacher's copy — someone covering needs to see whose class it is", () => {
    expect(teacher).toContain("Coach : ครูหนึ่ง");
    expect(parent).toContain("Coach : ครูหนึ่ง");
  });

  test("the default audience is the FULLER message, so an un-updated caller cannot strip lines", () => {
    expect(formatOutboxMessage(COURSE, {}, "TH")).toEqual(parent);
  });

  test("the customer's labels and separator, so a rendered message diffs against their draft", () => {
    expect(parent).toContain("Student : น้องเอ");
    expect(parent).toContain("Program : Private Freeskate 6 HR");
    expect(parent).toContain("Start : 2026-09-06");
    expect(parent).toContain("Time : 10:00");
    expect(parent).toContain("Date : อาทิตย์ 10:00");
  });

  test("⚠️ the count and the note survive BELOW the block — one line each to delete", () => {
    // The template does not list them, but removing them would drop the number this message exists to announce
    // and TASK-219's fix (a note typed at booking reaching the one message a teacher reads). Additive and
    // reversible; flagged for @Sober rather than decided silently.
    expect(parent).toContain("แพ้ถั่ว");
    expect(teacher).toContain("แพ้ถั่ว");
    expect(parent).toContain("6");
  });
});

describe("🔴 the per-type table — all five types, both audiences, one table-shaped place", () => {
  const ALL: NotifyType[] = ["COURSE", "VOUCHER", "ONE_HOUR", "FIRST_TRIAL", "OTHER"];

  test("`Remaining` and `*Expiry date` exist ONLY for course and voucher", () => {
    // A 1HR, a 1st Trial and an อื่นๆ have no balance and no expiry; printing an empty or a zero would state
    // something false about money.
    for (const type of ALL) {
      const fields = visibleFields("todays_schedule", type, "parent");
      const moneyed = type === "COURSE" || type === "VOUCHER";
      expect(fields.includes("remaining")).toBe(moneyed);
      expect(fields.includes("expiry")).toBe(moneyed);
    }
  });

  test("the teacher never sees expiry or advance-leave, whatever the type", () => {
    for (const type of ALL) {
      for (const template of ["confirmed_schedule", "todays_schedule", "course_deduction"] as const) {
        const fields = visibleFields(template, type, "teacher");
        expect(fields).not.toContain("expiry");
        expect(fields).not.toContain("advanceLeave");
      }
    }
  });

  test("`Start` is on CONFIRMED SCHEDULE only — a single session IS its date", () => {
    expect(TEMPLATE_FIELDS.confirmed_schedule).toContain("start");
    expect(TEMPLATE_FIELDS.todays_schedule).not.toContain("start");
    expect(TEMPLATE_FIELDS.course_deduction).not.toContain("start");
  });

  test("🔑 every rule is DATA — reverting one of @Porter's decisions is one line", () => {
    // Each per-type rule is unreviewed by the customer and labelled reversible. A decision that costs a rewrite
    // to reverse was not really reversible, so the tables are the whole mechanism and this asserts that shape.
    expect(TYPE_OMITS.COURSE).toEqual([]);
    expect(TYPE_OMITS.ONE_HOUR).toEqual(["remaining", "expiry"]);
    expect(AUDIENCE_OMITS.parent).toEqual([]);
    expect(AUDIENCE_OMITS.teacher).toEqual(["expiry", "advanceLeave"]);
  });

  test("field order is the customer's own line order", () => {
    expect(visibleFields("confirmed_schedule", "COURSE", "parent")).toEqual([
      "student", "program", "date", "time", "start", "coach", "expiry", "advanceLeave",
    ]);
    expect(visibleFields("todays_schedule", "COURSE", "parent")).toEqual([
      "student", "program", "date", "time", "coach", "remaining", "expiry",
    ]);
  });
});

describe("`Program` per type — the REQ's table, as data", () => {
  test("course = package with its size · voucher = its programme", () => {
    expect(programLabel("COURSE", { subject: "Private Freeskate", size: 6 })).toBe("Private Freeskate 6 HR");
    expect(programLabel("VOUCHER", { subject: "Surfskate" })).toBe("Surfskate");
  });

  test("1HR and 1st Trial name the activity and what it is", () => {
    expect(programLabel("ONE_HOUR", { subject: "Surfskate" })).toBe("Surfskate 1 HR");
    expect(programLabel("FIRST_TRIAL", { subject: "Surfskate" })).toBe("Surfskate 1st Trial");
  });

  test("🔴 อื่นๆ is named by the TITLE the admin typed — it has no subject", () => {
    // Being asked to type a real name is the entire point of that field (REQ-078), and it is never the word
    // "อื่นๆ" itself.
    expect(programLabel("OTHER", { title: "ประชุมผู้ปกครอง" })).toBe("ประชุมผู้ปกครอง");
    expect(programLabel("OTHER", { subject: "Surfskate", title: null })).toBeUndefined();
  });

  test("nothing true to say ⇒ `undefined`, so the omit-empty rule prints no blank label", () => {
    expect(programLabel("ONE_HOUR", { subject: null })).toBeUndefined();
    expect(programLabel("COURSE", { subject: "  " })).toBeUndefined();
    expect(programLabel("COURSE", { subject: "Surfskate", size: null })).toBe("Surfskate");
  });

  test("the DB enum maps once, and an unknown type renders the SMALLEST message", () => {
    expect(notifyTypeOf("COURSE_PACKAGE")).toBe("COURSE");
    expect(notifyTypeOf("SINGLE_SESSION")).toBe("ONE_HOUR");
    expect(notifyTypeOf("FIRST_TRIAL")).toBe("FIRST_TRIAL");
    expect(notifyTypeOf("VOUCHER")).toBe("VOUCHER");
    expect(notifyTypeOf("OTHER")).toBe("OTHER");
    // Never one that invents a balance it cannot know.
    expect(notifyTypeOf(undefined)).toBe("ONE_HOUR");
    expect(TYPE_OMITS[notifyTypeOf("SOMETHING_NEW")]).toContain("remaining");
  });
});

describe("🚫 the four lesson types' `booking_confirmed` is BYTE-IDENTICAL — owner-verified (TASK-228 / AC-16)", () => {
  const ctx = { studentName: "น้องเอ", subject: "Surfskate", date: "2026-09-06", startTime: "10:00", endTime: "11:00" };

  test("the shipped text, asserted in full rather than eyeballed", () => {
    // 🔴 This is the message the owner read on a phone and approved. It is in the blast radius of TASK-253 and
    // it must not shift by a byte — including its `: ` separator, which the new block deliberately does not use.
    expect(formatOutboxMessage({ kind: "booking_confirmed" }, ctx, "TH")).toBe(
      "📅 ยืนยันตารางสอน\nนักเรียน: น้องเอ\nวิชา: Surfskate\nเวลา: 2026-09-06 10:00-11:00",
    );
  });

  test("…and the audience does not change it — this template has no family-only line", () => {
    const parent = formatOutboxMessage({ kind: "booking_confirmed" }, ctx, "TH", "parent");
    const teacher = formatOutboxMessage({ kind: "booking_confirmed" }, ctx, "TH", "teacher");
    expect(parent).toBe(teacher);
  });

  test("an อื่นๆ booking still leads with the typed title, on its own line", () => {
    const out = formatOutboxMessage({ kind: "booking_confirmed" }, { ...ctx, title: "ประชุมผู้ปกครอง" }, "TH");
    expect(out.split("\n")[1]).toBe("ประชุมผู้ปกครอง");
  });

  test("the other three live kinds are unchanged by the audience too", () => {
    const kinds = [
      { kind: "sick_leave", studentName: "น้องเอ" },
      { kind: "leave_teacher", studentName: "น้องเอ" },
      { kind: "teacher_assigned" },
    ];
    for (const payload of kinds) {
      expect(formatOutboxMessage(payload, ctx, "TH", "parent")).toBe(
        formatOutboxMessage(payload, ctx, "TH", "teacher"),
      );
    }
  });
});
