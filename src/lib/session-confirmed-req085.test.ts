// TASK-303 (REQ-085 §7.3) — the per-session confirmation, REPLACED rather than edited.
//
// 🔴 §4 is why this file is strict: **this is the highest-volume notification in the product** — a parent, per
// booking, on the ordinary path. A break here is not a wrong label on a screen someone can re-read; it is a
// wrong message in a family's LINE, unrecallable.
//
// ⚠️ §3's trap, and it points the OTHER way from `§7.1`, which was finished an hour before this: `§7.1` has TWO
// opposite empty-field rules; **`§7.3` has only ONE.** There is no `Advance Leave Notice` here and **no `(-)`
// to inherit.** The risk was never forgetting a rule — it was CARRYING one across.
import { describe, expect, test } from "bun:test";
import { formatOutboxMessage } from "./line-message";

const ctx = {
  studentName: "Aiwa",
  subject: "Private Freeskate",
  date: "2026-09-08", // a Tuesday
  startTime: "11:00",
  endTime: "12:00",
};
const payload = {
  kind: "booking_confirmed",
  bookingType: "SINGLE_SESSION",
  attendeeNote: "เตรียมเฉพาะ Safety ให้น้อง",
};
const render = (o: Record<string, unknown> = {}, c: Record<string, unknown> = {}, lang: "TH" | "EN" = "TH") =>
  formatOutboxMessage({ ...payload, ...o }, { ...ctx, ...c }, lang, "parent");

describe("🔑 TASK-303 — the whole message, pinned BYTE-FOR-BYTE against §7.3's block", () => {
  test("the customer's block, exactly", () => {
    expect(render()).toBe(
      "📅CONFIRMED SCHEDULE:\n" +
        "Student : Aiwa\n" +
        "Program : Private Freeskate 1 HR\n" +
        "Date : Tuesday\n" +
        "Time : 11:00-12:00\n" +
        "Remark : เตรียมเฉพาะ Safety ให้น้อง\n",
    );
  });

  test("🔑 the calendar DATE appears NOWHERE — asserted as an absence, because that is what the split did", () => {
    // `เวลา: 2026-09-08 10:00-11:00` carried the date; `Date` names the WEEKDAY and `Time` the range. The date
    // itself is gone, and that is the part a reader skimming the new format would not notice was missing.
    expect(render()).not.toContain("2026-09-08");
    expect(render()).not.toContain("2026");
  });

  test("`Date` is an ENGLISH WEEKDAY, in both languages", () => {
    // Same convention as §7.1 — the product's, not this message's quirk.
    expect(render({}, {}, "EN")).toContain("Date : Tuesday");
    expect(render({}, { date: "2026-09-06" })).toContain("Date : Sunday");
  });
});

describe("🔴 TASK-303 §3 — ONE empty-field rule here, and the `(-)` must NOT have travelled", () => {
  test("🔑 `Remark` is ABSENT — the whole line — when there is no note", () => {
    const out = render({ attendeeNote: null });
    expect(out).not.toContain("Remark");
    expect(out).toBe(
      "📅CONFIRMED SCHEDULE:\nStudent : Aiwa\nProgram : Private Freeskate 1 HR\nDate : Tuesday\nTime : 11:00-12:00\n",
    );
  });

  test("⚠️ …and `(-)` NEVER appears on this message — the rule that was NOT inherited", () => {
    // 🔑 The assertion this task exists to make. `§7.1` prints `(-)` for an absent `Advance Leave Notice`;
    // this message has no such field, so carrying the placeholder across would invent a line the customer
    // never asked for — and it would look deliberate.
    for (const o of [{}, { attendeeNote: null }, { attendeeNote: "" }]) {
      for (const c of [{}, { studentName: undefined }, { subject: undefined }]) {
        expect(render(o, c)).not.toContain("(-)");
      }
    }
  });

  test("🚫 no `Advance Leave Notice` field at all", () => {
    expect(render()).not.toContain("Advance Leave");
  });
});

describe("TASK-303 — a human's words are reproduced exactly as typed (§8.2)", () => {
  test("🔑 a Thai student name and a Thai `Remark` are byte-identical", () => {
    const out = render(
      { attendeeNote: "เตรียมเฉพาะ Freeskate ให้น้อง" },
      { studentName: "น้องดีซี" },
    );
    expect(out).toContain("Student : น้องดีซี");
    expect(out).toContain("Remark : เตรียมเฉพาะ Freeskate ให้น้อง");
    // …and unchanged in the EN rendering, because a human's words have no language switch.
    expect(out).toBe(render({ attendeeNote: "เตรียมเฉพาะ Freeskate ให้น้อง" }, { studentName: "น้องดีซี" }, "EN"));
  });
});

describe("🚫 TASK-303 §5 — `§7.1`'s course-level message is UNCHANGED", () => {
  test("🔴 both now open with `CONFIRMED SCHEDULE`, so this is asserted rather than assumed", () => {
    // The next person to edit one of these will find the other. `§7.1` keeps its `Start`, `Coach`,
    // `*Expiry date` and `**Advance Leave Notice`; none of them may leak into `§7.3` and none of
    // `§7.3`'s brevity may leak back.
    // 🔻 TASK-318 (`§16.4`) — `Sessions` was on that list and has been REMOVED from `§7.1` itself, so it is
    // no longer one of the lines that must not leak: it is a line that must not exist.
    const course = formatOutboxMessage(
      {
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
        plannedLeaveDates: [],
        note: null,
      } as any,
      {},
      "TH",
      "parent",
    );
    expect(course).toBe(
      "📅CONFIRMED SCHEDULE:\nStudent : น้องเอ\nProgram : Private Freeskate 6 HR\nDate : Sunday\n" +
        "Time : 10:00-11:00\nStart : 2026-09-06\nCoach : ครูหนึ่ง\n*Expiry date : 2026-12-31\n" +
        // 🔻 TASK-318 (`§16.4`) — `Sessions : 6` is gone from `§7.1`; the line above it is now the last.
        "**Advance Leave Notice : (-)",
    );
    // 🔑 The two messages differ in every field but the header — which is the customer's choice, and the
    // reason the CODE has to be the thing that tells them apart.
    expect(course).not.toBe(render());
  });
});
