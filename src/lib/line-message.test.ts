import { describe, expect, test } from "bun:test";
import { formatOutboxMessage } from "./line-message";

describe("LINE outbox message formatting (B.3)", () => {
  test("booking_confirmed → teacher message with details", () => {
    const msg = formatOutboxMessage(
      { kind: "booking_confirmed" },
      { studentName: "น้องเอ", subject: "คณิต", date: "2026-07-01", startTime: "13:00", endTime: "14:00" },
    );
    // 🔻 TASK-303 (REQ-085 §7.3) — the customer REPLACED this message. The property is unchanged — the details
    // reach the reader — but the labels are new and `เวลา`'s combined value SPLIT into a weekday and a range,
    // so the calendar date is deliberately no longer in it.
    expect(msg).toContain("CONFIRMED SCHEDULE:");
    expect(msg).toContain("น้องเอ");
    expect(msg).toContain("คณิต");
    expect(msg).toContain("Time : 13:00-14:00");
    // 🔻 TASK-343 (`REQ-087 §6b`) — **`Date` is now the REAL DATE, `DD-MM-YYYY`.** TASK-303 split
    // `เวลา: <date> <range>` into a WEEKDAY + a range, and the calendar date left the message entirely.
    // 🔴 **That put `Date : Friday` and `§7.1`'s `Date : Friday` in the same conversation as two different
    // facts** — *a per-session confirmation's only job is THIS class, on THIS day.*
    // 🔑 `REQ-085 §15` still holds — **WEEKDAY for a COURSE, DATE for a SESSION** — so this makes the
    // product CONSISTENT with the rule rather than breaking it. 🚫 `§7.1` is untouched.
    // 🔻 **It DEVIATES from the customer's own `§7.3`, and the OWNER is TELLING them, not asking.**
    // 🚫 Not a placeholder, not unsettled. 📌 Rewritten, never deleted.
    expect(msg).toContain("Date : 01-07-2026");
    expect(msg).not.toContain("Wednesday"); // the weekday is GONE from this message
    expect(msg).not.toContain("2026-07-01"); // …and the ISO form never reaches a reader
  });

  test("reschedule_requested → parent message with old + proposed slot", () => {
    const msg = formatOutboxMessage(
      { kind: "reschedule_requested", to: { date: "2026-07-03", startTime: "10:00" } },
      { studentName: "น้องบี", date: "2026-07-01", startTime: "13:00" },
    );
    expect(msg).toContain("แจ้งขอย้ายคาบเรียน");
    // ⚪ TASK-344 — a DEAD branch (no producer), fixed anyway. ⚠️ **It carried the raw ISO TWICE and is NOT a
    // `date:` field** — both dates are interpolated into COMBINED values, which is why every sweep that
    // grepped the field name walked past it. 📌 Nothing observable changed: nothing sends this.
    expect(msg).toContain("คาบเดิม: 01-07-2026 13:00");
    expect(msg).toContain("ปลายทางที่เสนอ: 03-07-2026 10:00");
    expect(msg).not.toContain("2026-07-01");
    expect(msg).not.toContain("2026-07-03");
  });

  test("missing context lines are omitted (no 'undefined')", () => {
    const msg = formatOutboxMessage({ kind: "booking_confirmed" }, {});
    expect(msg).not.toContain("undefined");
    // 🔻 TASK-303 — the header the customer chose. The property — an enrichment that found nothing still
    // produces a message rather than a wall of `undefined` — is exactly the same.
    expect(msg).toContain("CONFIRMED SCHEDULE:");
  });

  test("sick_leave → admin alert", () => {
    const msg = formatOutboxMessage(
      { kind: "sick_leave", studentName: "น้องซี", via: "line" },
      { date: "2026-07-01", startTime: "10:00" },
    );
    expect(msg).toContain("แจ้งลา");
    expect(msg).toContain("น้องซี");
  });

  test("teacher_assigned / teacher_unassigned → distinct titles, shared body (TASK-094)", () => {
    const ctx = { studentName: "น้องดี", subject: "อังกฤษ", date: "2026-08-20", startTime: "16:00", endTime: "17:00" };
    const assigned = formatOutboxMessage({ kind: "teacher_assigned" }, ctx);
    expect(assigned).toContain("ได้รับมอบหมาย");
    expect(assigned).toContain("น้องดี");
    // 🔴 TASK-344 — **LIVE, and the site neither @Sober's list nor my first sweep found.** This printed the
    // raw ISO to a TEACHER. 🔑 It hid because the date is not in a `date:` field — it is interpolated into a
    // combined `Time` value.
    expect(assigned).toContain("20-08-2026 16:00-17:00");
    expect(assigned).not.toContain("2026-08-20");

    const unassigned = formatOutboxMessage({ kind: "teacher_unassigned" }, ctx);
    expect(unassigned).toContain("ย้ายออกจากตาราง");
    expect(unassigned).toContain("น้องดี");
    // EN falls through cleanly too
    expect(formatOutboxMessage({ kind: "teacher_assigned" }, ctx, "EN")).toContain("assigned to you");
  });

  test("unknown kind → generic fallback", () => {
    expect(formatOutboxMessage({ kind: "something_else" })).toContain("แจ้งเตือนจากระบบ");
    expect(formatOutboxMessage({})).toContain("แจ้งเตือนจากระบบ");
  });
});

// ═══ SPEC-066 / TASK-201 (REQ-072) — ONE message for a whole course ═══
//
// The point of this feature is that a teacher gets **one** message for one decision. These tests are about
// what that message has to say to be worth reading at all: which family, which slot, and what they have
// already told us they will miss.
describe("course_confirmed (TASK-201)", () => {
  const payload = {
    kind: "course_confirmed",
    courseId: "c1",
    studentName: "น้องเอ",
    subject: "Surfskate",
    startDate: "2026-09-06",
    weekday: 0,
    startTime: "10:00",
    confirmed: 10,
    plannedLeaveDates: ["2026-09-14", "2026-09-28"],
    note: "แพ้ถั่ว",
  };

  test("TH: the slot is named in words, not a weekday number", () => {
    // ⚠️ TASK-257 §1/§2: the heading is now the customer's own, and the weekday stands ALONE — the time moved
    // to `Time`, as a range, where `COURSE DEDUCTION` already had it. The property here is unchanged: a teacher
    // reads "อาทิตย์", never "0".
    const out = formatOutboxMessage(payload, {}, "TH");
    expect(out).toContain("📅CONFIRMED SCHEDULE:");
    expect(out).toContain("น้องเอ");
    expect(out).toContain("Date : Sunday");
    expect(out).not.toContain("Date : 0");
  });

  test("EN renders the same facts", () => {
    const out = formatOutboxMessage(payload, {}, "EN");
    expect(out).toContain("📅CONFIRMED SCHEDULE:"); // the customer's heading, English in both languages
    expect(out).toContain("Date : Sunday");
  });

  test("🔴 TASK-206: the planned leaves are DATES, not a count — the owner asked WHICH DAYS", () => {
    // "2 planned leaves" tells a teacher the schedule they just confirmed is wrong somewhere, and not where.
    // This asserts the RENDERED STRING, because a `plannedLeaves: 2` field compiled perfectly and was useless.
    // ⚠️ TASK-253 renamed the label to the customer's own (`**Advance Leave Notice`); the RULE is unchanged.
    const out = formatOutboxMessage(payload, {}, "TH");
    expect(out).toContain("**Advance Leave Notice");
    expect(out).toContain("2026-09-14");
    expect(out).toContain("2026-09-28");
    // …and the leave line is never a bare tally: what follows the label is a date, not "2".
    const leaveLine = out.split("\n").find((l) => l.includes("Advance Leave"))!;
    expect(leaveLine).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(leaveLine.trim().endsWith(": 2")).toBe(false);
  });

  test("dates render in order, comma-separated — a teacher reads it as a list of days", () => {
    const scrambled = { ...payload, plannedLeaveDates: ["2026-09-14", "2026-09-28"] };
    const out = formatOutboxMessage(scrambled, {}, "EN");
    expect(out).toContain("2026-09-14, 2026-09-28");
  });

  test("🔴 the empty case prints `(-)` — for the parent AND, since 2026-09-07, the teacher", () => {
    // The history matters here because this line has now been reversed twice, in opposite directions.
    // TASK-206: absent for a teacher — *an empty leave line reads as a problem to a coach scanning a
    // schedule.* TASK-253: `ไม่มี` for a parent — *silence cannot be told from a missing feature*, and the
    // audience projection let both be true at once.
    //
    // 🔻 TASK-269 §3, owner *เอาหมด*: the teacher's copy is the parent's, **including the empty case**. The
    // parent's reason applies to a coach at least as much — a coach reads it to find out whether a child on
    // their roster will be absent — and *identical except when it is empty* is a third rule nobody asked for.
    // 🔴 Pinned as its OWN case, deliberately, because it reverses TASK-206 and must not arrive as a side
    // effect of an omissions table going empty.
    const none = { ...payload, plannedLeaveDates: [] };
    expect(formatOutboxMessage(none, {}, "TH", "parent")).toContain("**Advance Leave Notice : (-)");
    // 🔻 TASK-284 (REQ-085 §7.1c) — `(-)`, and the SAME in both languages. It was `ไม่มี` / `None`; the owner
    // ruled the template's system-generated values English, and `(-)` is neither language's word. **The
    // property this test protects — that the line PRINTS rather than vanishing — is unchanged and is the
    // whole reason it exists.**
    expect(formatOutboxMessage(none, {}, "EN", "parent")).toContain("**Advance Leave Notice : (-)");
    expect(formatOutboxMessage(none, {}, "TH", "teacher")).toContain("**Advance Leave Notice : (-)");
    expect(formatOutboxMessage(none, {}, "EN", "teacher")).toContain("**Advance Leave Notice : (-)");
    // A payload that never carried the field at all must behave the same, not crash.
    const { plannedLeaveDates: _d, ...missing } = payload;
    expect(formatOutboxMessage(missing, {}, "TH", "parent")).toContain("**Advance Leave Notice : (-)");
  });

  test("everything it needs is in the PAYLOAD — it renders with no booking context at all", () => {
    // A course summary is not a fact about any one session; enriching it from a booking would make the
    // message depend on which session happened to be referenced.
    const out = formatOutboxMessage(payload, {}, "TH");
    expect(out).toContain("2026-09-06");
    expect(out).toContain("Surfskate");
  });

  test("a missing note simply does not appear (no empty label)", () => {
    const { note: _n, ...withoutNote } = payload;
    expect(formatOutboxMessage(withoutNote, {}, "TH")).not.toContain("หมายเหตุ");
  });
});

// ═══ SPEC-066 / TASK-208 (REQ-072 3B) — the reminder reuses the verified composer ═══
describe("daily_reminder (TASK-208)", () => {
  const rows = [
    { date: "2026-09-05", startTime: "09:00", studentName: "น้องเอ", subjectName: "Surfskate", status: "CONFIRMED" },
    { date: "2026-09-05", startTime: "11:00", studentName: "น้องบี", subjectName: "Bike", status: "PENDING" },
  ];

  // 🔴 TASK-256 re-cut this body to REQ-077 Parent 2 (@Porter's Decision 6). The three assertions below used to
  // pin `renderSchedule`'s layout — `🗓️ ตารางวันนี้`, `09:00  น้องเอ`. That composer is NOT deleted (it still
  // serves the teacher's `ตาราง` command and is the fallback if the customer prefers what they have); this
  // message simply no longer uses it. **The property each test was protecting is kept, restated in the new
  // layout** — which is why these were rewritten rather than removed.
  test("🔴 it renders as the customer's TODAY'S SCHEDULE, with their labels", () => {
    const out = formatOutboxMessage({ kind: "daily_reminder", rows }, {}, "TH");
    expect(out).toContain("⏱️TODAY'S SCHEDULE:");
    expect(out).toContain("น้องเอ");
    expect(out).toContain("น้องบี");
  });

  test("one message lists every session that person has today — not one message each", () => {
    // The non-negotiable this file has always guarded: one message per person per day. Two classes ⇒ two
    // numbered blocks in ONE message, never two messages.
    const out = formatOutboxMessage({ kind: "daily_reminder", rows }, {}, "TH");
    expect(out.split("\n").filter((l) => /^\d\) /.test(l))).toHaveLength(2);
    // 🔴 TASK-283 — these asserted `09:00:00` and `11:00:00`, and that was the DEFECT written down as an
    // expectation: the owner read `Time : 09:00:00-10:00` on his phone. The fixture above hand-builds the
    // payload, so it bypassed `groupReminders` and kept passing after the fix — a test defending a value no
    // real payload can carry any more. Corrected rather than deleted: the property here is *two numbered
    // blocks in ONE message*, and it is untouched. `message-time-format.test.ts` owns the format itself.
    expect(out).toContain("1) Time : 09:00");
    expect(out).toContain("2) Time : 11:00");
  });

  test("EN renders the same list", () => {
    // The customer's labels are English in both languages — their template, not a translation.
    expect(formatOutboxMessage({ kind: "daily_reminder", rows }, {}, "EN")).toContain("TODAY'S SCHEDULE:");
  });

  test("a malformed payload degrades to the empty-state, never a crash in the worker", () => {
    // The worker renders whatever is in the outbox, including rows queued by an older deploy.
    expect(formatOutboxMessage({ kind: "daily_reminder" }, {}, "TH")).toContain("ไม่มีคาบสอนในช่วงนี้");
  });
});

// ═══ TASK-219 (REQ-007's missing half) — the note reaches the teacher on the booking they read ═══
//
// The owner proved the gap by typing a note and getting a confirmation without it. `course_confirmed` has
// carried the note since TASK-201; `booking_confirmed` — the message a teacher actually reads on the day —
// did not. These assert the RENDERED STRING both ways, because a payload field that is present and unrendered
// looks identical to one that was never sent.
describe("booking_confirmed carries the attendee note (TASK-219)", () => {
  const ctx = { studentName: "น้องเอ", subject: "Surfskate", date: "2026-09-05", startTime: "10:00" };

  test("🔴 the note is rendered when there is one", () => {
    const out = formatOutboxMessage({ kind: "booking_confirmed", attendeeNote: "แพ้ถั่ว" }, ctx, "TH");
    // TASK-303 — the label is `Remark` now (REQ-085 §7.3). The property — the note REACHES the reader — is
    // unchanged, and it is why this test exists.
    expect(out).toContain("Remark");
    expect(out).toContain("แพ้ถั่ว");
  });

  test("EN renders it too", () => {
    const out = formatOutboxMessage({ kind: "booking_confirmed", attendeeNote: "peanut allergy" }, ctx, "EN");
    expect(out).toContain("peanut allergy");
  });

  test("🔴 the line is ABSENT when there is no note — an empty label reads as a note that went missing", () => {
    for (const payload of [
      { kind: "booking_confirmed" },
      { kind: "booking_confirmed", attendeeNote: null },
      { kind: "booking_confirmed", attendeeNote: "" },
    ]) {
      const out = formatOutboxMessage(payload, ctx, "TH");
      expect(out).not.toContain("Remark");
      expect(out).not.toContain("undefined");
    }
  });

  test("🔑 the note comes from the PAYLOAD, not the enriched booking context", () => {
    // The worker builds `ctx` from the row the outbox references; the note must survive a row that was since
    // edited or deleted — the same reason `sick_leave` carries its own student name.
    const out = formatOutboxMessage({ kind: "booking_confirmed", attendeeNote: "จากpayload" }, {}, "TH");
    expect(out).toContain("จากpayload");
  });

  test("the fields the message already had are unchanged (regression)", () => {
    // 🔻 TASK-303 — the note must not displace the rest of the message, which is what this guards and still
    // does. `เวลา: 2026-09-05 10:00` became `Date` + `Time`, so the combined value is asserted as its two
    // halves — and the calendar date is deliberately gone.
    const out = formatOutboxMessage({ kind: "booking_confirmed", attendeeNote: "x" }, ctx, "TH");
    expect(out).toContain("CONFIRMED SCHEDULE:");
    expect(out).toContain("น้องเอ");
    // 🔻 TASK-343 — `Date` carries the real date now; the note still must not displace it, which is what
    // this regression actually guards.
    expect(out).toContain("Date : 05-09-2026");
    expect(out).toContain("Time : 10:00");
    expect(out).not.toContain("2026-09-05"); // never the ISO form
  });
});
