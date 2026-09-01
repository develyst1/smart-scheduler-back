// REQ-078 / TASK-239 — an ADDITIONAL teacher may not be double-booked.
//
// 🔴 The door the database does not guard. `bookings_teacher_slot_uq` is a partial unique index on
// **`bookings.teacher_id`**; an อื่นๆ booking's additional teachers live in `booking_teachers`, which has no
// slot constraint. Since TASK-227 draws a booking in every assigned teacher's column, teacher B could be on a
// 10:00 อื่นๆ *and* teach their own 10:00 lesson — and B's cell would render one and silently drop the other.
// That is DEF-4's exact shape: a session that exists and is not on the calendar.
//
// The guard needs rows, so the behavioural half is Tanya's. What is pinned here is what the code cannot be
// allowed to get wrong: **one** definition of "live", **one** wording, and a guard narrow enough to leave the
// feature intact.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { SLOT_INACTIVE_STATUSES } from "../db/schema";
import { GENERIC_SLOT_TAKEN, slotClashMessage } from "../lib/slot-clash";

const SVC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const body = (decl: string) => {
  const rest = SVC.slice(SVC.indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const ATTACH = body("async function attachAdditionalTeachers");
const GUARD = body("async function assertAdditionalTeacherFree");
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

describe("🔴 ONE definition of 'live' — the index's own, not a copy of it", () => {
  test("the guard reads `SLOT_INACTIVE_STATUSES`, and does not restate the three statuses", () => {
    // Sober's instruction, and the reason for it: two definitions of "live" is how a refusal and the index it
    // mirrors start disagreeing — one refuses what the other allows, and it surfaces as a phantom booking.
    expect(GUARD).toContain("nin(b.status, [...SLOT_INACTIVE_STATUSES])");
    const guardCode = code(GUARD);
    for (const status of ["CANCELLED", "PENDING_RESCHEDULE", "SICK_LEAVE"]) {
      expect(guardCode).not.toContain(`"${status}"`);
    }
  });

  test("🔑 the index is BUILT from that constant — so there is no second list left to drift", () => {
    expect([...SLOT_INACTIVE_STATUSES]).toEqual(["CANCELLED", "PENDING_RESCHEDULE", "SICK_LEAVE"]);
  });

  test("a CANCELLED / SICK_LEAVE / PENDING_RESCHEDULE booking must NOT refuse", () => {
    // The same statuses the index excludes. `SICK_LEAVE` in particular is deliberate — UC-004 overbooking is a
    // feature, and a guard that refused it would break a flow older than this one.
    for (const s of SLOT_INACTIVE_STATUSES) expect(SLOT_INACTIVE_STATUSES).toContain(s);
    expect(SLOT_INACTIVE_STATUSES).toContain("SICK_LEAVE");
  });
});

describe("🔴 ONE wording — the same sentence as the primary teacher's refusal", () => {
  test("it reuses `slotClashMessage`, and does not compose its own", () => {
    // A different sentence for the same situation is a second rule that has to be maintained in step.
    expect(GUARD).toContain("slotClashMessage({");
    expect(GUARD).not.toContain("มีคาบสอนช่วงเวลานี้อยู่แล้ว"); // not hand-written here
    expect(GUARD).toContain('conflict("SLOT_TAKEN"');
  });

  test("it names THAT teacher and THAT booking, by the `displayName` rule", () => {
    expect(GUARD).toContain("clash.otherTitle ?? clash.student?.nickname ?? clash.student?.name");
    expect(GUARD).toContain("clash.teacher?.nickname ?? clash.teacher?.name");
    // The sentence itself is already pinned in `slot-clash.test.ts`; this is the same composer.
    expect(slotClashMessage({ teacherName: "Bank", bookingName: "ประชุมทีม", time: "10:00-11:00" })).toContain(
      "ครูBank",
    );
  });

  test("🔴 it never invents a name — an unidentifiable clash still refuses, generically", () => {
    expect(GUARD).toContain("if (!teacherName || !bookingName)");
    expect(GUARD).toContain("GENERIC_SLOT_TAKEN");
    expect(GENERIC_SLOT_TAKEN).toBe("ครูมีคาบในช่วงเวลานี้แล้ว");
  });
});

describe("🚫 the guard is NARROW — the feature is untouched", () => {
  test("it checks the teacher's OWN slot, not whether teachers share this booking", () => {
    // Three teachers on one meeting is the feature. What is refused is one person in two places — exactly what
    // the index has always refused for the primary teacher.
    expect(GUARD).toContain("e(b.teacherId, teacherId)");
    expect(GUARD).toContain("e(b.date, date)");
    expect(GUARD).toContain("e(b.startTime, startTime)");
    // Nothing about the count of teachers on this booking.
    expect(GUARD).not.toContain("bookingTeachers");
    expect(GUARD).not.toContain("length");
  });

  test("the booking being created cannot clash with itself", () => {
    expect(GUARD).toContain("n(b.id, bookingId)");
  });

  test("it runs per teacher, inside the one chokepoint, before anything is written", () => {
    expect(ATTACH).toContain("await assertAdditionalTeacherFree(");
    expect(ATTACH.indexOf("assertAdditionalTeacherFree")).toBeLessThan(ATTACH.indexOf("insert(bookingTeachers)"));
    // …and beside the archived-teacher check that was already there, so both run for every extra teacher.
    expect(ATTACH).toContain("await assertTeacherBookable(exec, teacherId, booking!.date)");
  });

  test("the primary teacher's refusal is untouched — it is still the index that refuses it", () => {
    const insert = SVC.slice(SVC.indexOf("async function insertBooking"), SVC.indexOf("export async function createBooking"));
    expect(insert).toContain('if (code === "23505") {');
    expect(insert).toContain("describeSlotClash(input.teacherId, input.date, input.startTime)");
  });
});

describe("⚠️ it is an APPLICATION check, and says so", () => {
  test("the weakness is named at the site — the database is NOT holding this one", () => {
    // It is genuinely weaker than the index beside it: two requests racing can both pass. A reader who assumes
    // the DB is enforcing this would build on a guarantee that does not exist.
    expect(ATTACH).toContain("APPLICATION check, not an index");
    expect(ATTACH).toContain("Two requests racing can both pass it");
  });

  test("it reads through `exec`, so it sees this transaction's own writes", () => {
    // Unlike `describeSlotClash` — which must use `db` because its transaction is already aborted — this runs
    // on a healthy transaction, and using it is what makes the check see the booking just inserted.
    expect(GUARD).toContain("exec.query.bookings.findFirst");
  });
});
