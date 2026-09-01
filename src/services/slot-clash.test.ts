// REQ-078 AC-24 (revised) / TASK-238 — the clash refusal must name the teacher and the clashing booking.
//
// The owner's DEF-2 ruling was option ข: **overlap stays refused**, because honouring "warn, don't block" would
// need the calendar to show two things in one slot, and without that we would ship invisible double-bookings.
// So the capability is a follow-up REQ and only the MESSAGE changes — which makes the message the deliverable,
// and the composed string the thing to assert.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { GENERIC_SLOT_TAKEN, slotClashMessage } from "../lib/slot-clash";
import { SLOT_INACTIVE_STATUSES } from "../db/schema";

const SVC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const SCHEMA = readSrc(await Bun.file(new URL("../db/schema.ts", import.meta.url)).text());
const FN = (() => {
  const at = SVC.indexOf("async function describeSlotClash");
  const rest = SVC.slice(at);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
})();

describe("🔴 AC-24 — the sentence, verbatim from the REQ", () => {
  test("it names the teacher, the clashing booking and the time", () => {
    expect(
      slotClashMessage({ teacherName: "หนึ่ง", bookingName: "น้องเอ", time: "10:00-11:00" }),
    ).toBe("ครูหนึ่ง มีคาบสอนช่วงเวลานี้อยู่แล้ว (น้องเอ 10:00-11:00) กรุณาเลือกเวลาอื่น");
  });

  test("🔴 an อื่นๆ blocking another booking names the admin's TITLE, never the word อื่นๆ", () => {
    // The booking name is `displayName`. Being asked to type a real name is the entire point of the field.
    const msg = slotClashMessage({ teacherName: "Bank", bookingName: "ประชุมทีม", time: "10:00-11:00" });
    expect(msg).toContain("ประชุมทีม");
    expect(msg).not.toContain("อื่นๆ");
    expect(msg).not.toMatch(/\bOther\b/);
  });

  test("it is never the generic sentence when the clash IS identified", () => {
    const msg = slotClashMessage({ teacherName: "หนึ่ง", bookingName: "น้องเอ", time: "10:00-11:00" });
    expect(msg).not.toBe(GENERIC_SLOT_TAKEN);
    // …and it carries what the staff member's next action needs: which teacher, and what is already there.
    expect(msg).toContain("หนึ่ง");
    expect(msg).toContain("10:00-11:00");
  });
});

describe("the lookup that feeds it", () => {
  test("🔴 it reads on `db`, NOT on the transaction that just failed", () => {
    // A statement that raises 23505 inside a Postgres transaction leaves it ABORTED — every later query in it
    // fails with 25P02. Passing `tx` here would turn a clean 409 into a confusing 500, on the one path whose
    // whole job is to explain itself.
    expect(FN).toContain("db.query.bookings.findFirst");
    expect(FN).not.toContain("exec.");
    expect(FN).not.toContain("tx.");
  });

  test("🔑 it and the unique index share ONE definition of 'live' — not two that agree today", () => {
    // TASK-238 asserted the two lists matched. TASK-239 made that structural instead: the index's `WHERE` is
    // now BUILT from `SLOT_INACTIVE_STATUSES`, and this lookup reads the same constant. There is no second
    // list left to drift — which is a stronger property than two lists a test keeps in step.
    const indexWhere = SCHEMA.slice(
      SCHEMA.indexOf('uniqueIndex("bookings_teacher_slot_uq")'),
      SCHEMA.indexOf("bookings_date_idx"),
    );
    expect(indexWhere).toContain("sql.raw(SLOT_INACTIVE_SQL)");
    expect(SCHEMA).toContain("SLOT_INACTIVE_SQL = SLOT_INACTIVE_STATUSES.map(");
    expect(FN).toContain("nin(b.status, [...SLOT_INACTIVE_STATUSES])");
    // …and the list itself is still exactly the three the index has always excluded.
    expect([...SLOT_INACTIVE_STATUSES]).toEqual(["CANCELLED", "PENDING_RESCHEDULE", "SICK_LEAVE"]);
  });

  test("🔴 the emitted index predicate is byte-identical to the hand-written one it replaced", () => {
    // `sql.raw` inlines the text, so moving the source of the list changed no SQL and implies no migration.
    // If this ever stops matching, the running index and the schema have diverged — which `db:verify` cannot
    // see, because the index's NAME is unchanged either way (the `0022` blindness, one layer over).
    const literal = [...SLOT_INACTIVE_STATUSES].map((s) => `'${s}'`).join(", ");
    expect(`not in (${literal})`).toBe("not in ('CANCELLED', 'PENDING_RESCHEDULE', 'SICK_LEAVE')");
  });

  test("the booking name uses the `displayName` rule, not a second one", () => {
    expect(FN).toContain("row.otherTitle ?? row.student?.nickname ?? row.student?.name");
  });

  test("🔴 an unidentifiable clash falls back to the generic sentence — it never invents a name", () => {
    // The occupant may have been cancelled between the failed insert and this read. Refusing with less detail
    // is right there; inventing a teacher or a booking name would be worse than the generic sentence.
    expect(FN.match(/return GENERIC_SLOT_TAKEN/g)!.length).toBeGreaterThanOrEqual(3);
  });

  test("a failure in the lookup still produces a refusal, not a 500 on top of a conflict", () => {
    expect(FN).toContain("} catch {");
  });
});

describe("AC-25 — no clash, no message", () => {
  test("the description is built ONLY inside the 23505 branch", () => {
    // A refusal that fires when nothing clashes is worse than a generic one. The only caller is the unique-
    // violation handler, so on the happy path this code never runs at all.
    const calls = SVC.split("describeSlotClash(").length - 1;
    expect(calls).toBe(2); // the declaration, and the one call site
    const insert = SVC.slice(SVC.indexOf("async function insertBooking"), SVC.indexOf("export async function createBooking"));
    expect(insert).toContain('if (code === "23505") {');
    expect(insert.indexOf('code === "23505"')).toBeLessThan(insert.indexOf("describeSlotClash("));
  });
});

describe("regression — the four existing types", () => {
  test("course creation keeps its own, more specific refusal", () => {
    // `createCoursePackage` catches SLOT_TAKEN and replaces the message with a date-specific one, so courses
    // are untouched by construction rather than by a special case here.
    expect(SVC).toContain("มีคาบชนในวันที่ ${date} — เลือกวัน/เวลาอื่นสำหรับคอร์สนี้");
  });

  test("the plan-change and move paths are UNTOUCHED and still refuse generically", () => {
    // Stated rather than silently improved: TASK-238 is about the create path the อื่นๆ form uses. Widening it
    // to the move path would change a refusal Tanya is not testing, during a TEST_FAILED release.
    expect(SVC.split(`conflict("SLOT_TAKEN", "${GENERIC_SLOT_TAKEN}")`).length - 1).toBe(2);
  });
});
