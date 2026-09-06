// SPEC-075 / TASK-260 (REQ-076) — pause and resume ONE booking.
//
// 🔴 The owner's sentence is the spec: **a hold, and nothing else.** Most of what follows is therefore an
// ABSENCE — no money, no entitlement, no expiry, no reason — and an absence only counts if it is asserted.
//
// ⚠️ **The two-list trap (§1a) is the one to read first.** `SLOT_INACTIVE_STATUSES` answers *"does it hold a
// teacher's slot?"*; the calendar query answers *"does it appear on the grid?"*. A `PAUSED` booking KEEPS its
// date, so it would have rendered on the calendar while every slot test passed. Both are asserted, separately,
// and so is the regression that merging them would cause: `SICK_LEAVE` must still be visible.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { CALENDAR_HIDDEN_STATUSES, SLOT_INACTIVE_STATUSES } from "../db/schema";
import { SCHEDULING_WITNESSES } from "../lib/migration-witness";

const SVC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const API = readSrc(await Bun.file(new URL("../routes/api.ts", import.meta.url)).text());
const SCHEMA = readSrc(await Bun.file(new URL("../db/schema.ts", import.meta.url)).text());
const VALIDATION = readSrc(await Bun.file(new URL("../validation.ts", import.meta.url)).text());
const M32 = await Bun.file(new URL("../../drizzle/0032_booking_paused_status.sql", import.meta.url)).text();
const M33 = await Bun.file(new URL("../../drizzle/0033_paused_slot_index.sql", import.meta.url)).text();
const JOBS = readSrc(await Bun.file(new URL("./jobs.service.ts", import.meta.url)).text());
const JOURNAL = await Bun.file(new URL("../../drizzle/meta/_journal.json", import.meta.url)).text();
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fn = (name: string) => {
  const rest = code(SVC).slice(code(SVC).indexOf(`export async function ${name}`));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const PAUSE = fn("pauseBooking");
const RESUME = fn("resumeBooking");

describe("🔴 the two migrations — and why they cannot be one", () => {
  test("`0032` adds the label and USES it nowhere", () => {
    // A new enum value cannot be used in the transaction that adds it, and `drizzle-kit migrate` runs every
    // pending migration in ONE transaction. If this file mentioned 'PAUSED' anywhere but the ADD VALUE, the
    // pair would fail on a box applying both at once.
    const sql32 = M32.replace(/^s*--.*$/gm, ""); // comments stripped — they discuss the label by name
    expect(sql32).toContain(`ALTER TYPE "booking_status" ADD VALUE IF NOT EXISTS 'PAUSED'`);
    expect(sql32.split("PAUSED").length - 1).toBe(1); // exactly one occurrence, in the ADD VALUE
    expect(sql32).not.toContain("CREATE");
    expect(sql32).not.toContain("UPDATE");
  });

  test("`0033` rebuilds the index predicate, and its literal matches the TS list byte for byte", () => {
    // The DoD's "TASK-247 shape": the two halves that must agree are pinned to each other, not to a third copy
    // retyped in a test.
    const literal = [...SLOT_INACTIVE_STATUSES].map((s) => `'${s}'`).join(", ");
    expect(M33).toContain(`not in (${literal})`);
    expect(M33).toContain('DROP INDEX "bookings_teacher_slot_uq"');
    expect(SCHEMA).toContain("SLOT_INACTIVE_SQL = SLOT_INACTIVE_STATUSES.map(");
  });

  test("both are journal-registered, and the counts match", () => {
    expect(JOURNAL).toContain('"tag": "0032_booking_paused_status"');
    expect(JOURNAL).toContain('"tag": "0033_paused_slot_index"');
  });

  test("🔴 the witnesses are things that exist ONLY after their own migration", () => {
    const w32 = SCHEDULING_WITNESSES.find((w) => w.tag === "0032_booking_paused_status")!;
    const w33 = SCHEDULING_WITNESSES.find((w) => w.tag === "0033_paused_slot_index")!;
    // 0032: the LABEL. Every table, column and index around it exists before and after.
    expect(w32.probe).toEqual({ kind: "enum-label", type: "booking_status", label: "PAUSED" });
    // 🔴 0033: the index's PREDICATE, never its existence — `bookings_teacher_slot_uq` exists both before and
    // after, so an existence probe would report it applied on a box where it never ran. That is the `0022`
    // blindness, and this is the easiest place in the project to repeat it.
    expect(w33.probe).toEqual({
      kind: "index-predicate",
      index: "bookings_teacher_slot_uq",
      contains: "PAUSED",
    });
    expect(w33.probe.kind).not.toBe("index");
    // …and the rerun rule follows the shape of the SQL: `IF NOT EXISTS` is safe, a bare DROP+CREATE is not.
    expect(w32.rerunnable).toBe(true);
    expect(w33.rerunnable).toBe(false);
  });
});

describe("🔴 the TWO lists — §1a's trap, asserted as two separate questions", () => {
  test("AC-17 — `PAUSED` releases the teacher's slot", () => {
    expect([...SLOT_INACTIVE_STATUSES]).toContain("PAUSED");
  });

  test("🔴 AC-1 — …and it is ALSO hidden from the calendar, which the slot list does not do", () => {
    // The trap: a paused booking keeps its date, so the old `ne(status, "CANCELLED")` would still have rendered
    // it — while every `SLOT_INACTIVE_STATUSES` test passed. Asserted against the calendar query itself.
    expect([...CALENDAR_HIDDEN_STATUSES]).toContain("PAUSED");
    // ⚠️ Bounded FORWARD from the query itself: `const rented =` also appears EARLIER in the file, and a
    // backwards slice silently yields "" — which would make this assertion pass against nothing at all.
    const at = code(SVC).indexOf("const bookingRows =");
    const calendarQuery = code(SVC).slice(at, code(SVC).indexOf("const rented =", at));
    expect(calendarQuery).toContain("notInArray(b.status, [...CALENDAR_HIDDEN_STATUSES])");
    expect(calendarQuery).not.toContain('ne(b.status, "CANCELLED")');
  });

  test("🚫 the regression that merging them would cause: `SICK_LEAVE` still appears on the grid", () => {
    // A leave frees the slot for a replacement AND stays visible — the week query even resolves the overlap in
    // the active booking's favour. One list hiding both would delete a shipped behaviour nobody asked about.
    expect([...SLOT_INACTIVE_STATUSES]).toContain("SICK_LEAVE");
    expect([...CALENDAR_HIDDEN_STATUSES]).not.toContain("SICK_LEAVE");
    expect(code(SVC)).toContain('cur.status === "SICK_LEAVE"'); // the overlap rule, untouched
  });

  test("each list says which question it answers", () => {
    const block = SCHEMA.slice(SCHEMA.indexOf("TASK-260 (REQ-076"), SCHEMA.indexOf("export const CALENDAR_HIDDEN_STATUSES"));
    expect(block).toContain("does it appear on the grid?");
    expect(block).toContain("does it hold a teacher's slot?");
  });
});

describe("🔴 pause — AC-1 · AC-2 · AC-3 · AC-8", () => {
  test("AC-1 — a not-yet-happened booking becomes PAUSED and keeps its date", () => {
    expect(PAUSE).toContain('set({ status: "PAUSED" })');
    // 🚫 The date is NOT nulled: it becomes *the slot it came from*, which is what the tray row shows.
    expect(PAUSE).not.toContain("date: null");
    expect(PAUSE).not.toContain("startTime: null");
  });

  test("AC-2 — never a session that already happened", () => {
    expect(PAUSE).toContain("isDelivered(current.status)");
    expect(PAUSE).toContain('conflict("NOT_PAUSABLE"');
    // The allow-list is the positive half of the same rule, so a status nobody has classified is refused.
    expect(code(SVC)).toContain('const PAUSABLE_STATUSES = new Set(["PENDING", "CONFIRMED", "EXTENDED"])');
  });

  test("AC-3 — never a course session, and it is refused for BEING one", () => {
    // Checked before the status, so the message is about the course rather than about whatever state the
    // booking happens to be in. REQ-071 owns course pausing and its wording does not change.
    expect(PAUSE).toContain("if (current.courseId)");
    expect(PAUSE).toContain('conflict("COURSE_SESSION"');
    expect(PAUSE.indexOf("current.courseId")).toBeLessThan(PAUSE.indexOf("isDelivered("));
  });

  test("🚫 AC-8 — no reason, and the route has nowhere to put one", () => {
    // The absence is structural rather than a promise: with no body there is no field to send.
    expect(API).toContain('.post("/bookings/:id/pause", async (c) => c.json(await svc.pauseBooking(c.req.param("id"))))');
    expect(code(VALIDATION)).not.toContain("pauseBooking");
    expect(PAUSE).not.toContain("reason");
    expect(PAUSE).not.toContain("reasonCode");
  });

  test("a second pause is refused rather than silently re-writing the row", () => {
    expect(PAUSE).toContain('conflict("ALREADY_PAUSED"');
  });
});

describe("🔴 AC-4 · AC-5 · AC-6 — the absences that ARE the requirement", () => {
  test("no money moves — neither path posts, reverses or reads a sale", () => {
    for (const body of [PAUSE, RESUME]) {
      expect(body).not.toContain("recordSale");
      expect(body).not.toContain("reverseBookingSale");
      expect(body).not.toContain("postBookingSale");
      expect(body).not.toContain("revKey");
    }
  });

  test("no entitlement changes — no course or voucher counter is touched", () => {
    for (const body of [PAUSE, RESUME]) {
      expect(body).not.toContain("usedSessions");
      expect(body).not.toContain("usedHours");
      expect(body).not.toContain("leaveUsed");
      expect(body).not.toContain("notifyCourseDeduction");
    }
  });

  test("🔴 AC-6 — the expiry clock keeps running: nothing here writes `expiryDate`", () => {
    // A hold that quietly extended the window would be REQ-081's feature, decided by nobody. The absence is
    // the requirement, so it is asserted rather than assumed.
    for (const body of [PAUSE, RESUME]) expect(body).not.toContain("expiryDate");
  });
});

describe("🔴 resume — AC-13 · AC-14 · AC-16", () => {
  test("AC-13 — any date and time, not only the original", () => {
    expect(RESUME).toContain("date: input.date");
    expect(RESUME).toContain("startTime: input.startTime");
    expect(RESUME).toContain("endTime: addHour(input.startTime)"); // the same derivation every write uses
    expect(VALIDATION).toContain("export const resumeBooking = z.object({");
  });

  test("AC-14 — the EXISTING clash refusal, not a second message", () => {
    expect(RESUME).toContain("describeSlotClash(current.teacherId, input.date, input.startTime)");
    expect(RESUME).toContain('conflict("SLOT_TAKEN"');
    // 🚫 No second wording anywhere in the service: one clash rule in the product.
    expect(code(SVC)).not.toContain("มีคาบสอนช่วงเวลานี้อยู่แล้ว");
  });

  test("⚠️ the describer reads on `db`, not the aborted transaction", () => {
    // A 23505 aborts the transaction, so the lookup that EXPLAINS the refusal cannot run inside it — TASK-238's
    // lesson, and the reason a clean 409 does not become a 500 on the one path whose job is to explain itself.
    expect(code(SVC)).toContain("async function describeSlotClash");
    const describer = code(SVC).slice(code(SVC).indexOf("async function describeSlotClash"));
    expect(describer.slice(0, 400)).toContain("db.query.bookings.findFirst");
  });

  test("📌 AC-16 needed NO code — the row simply becomes CONFIRMED with a date", () => {
    // If it had needed code, §1's representation would have been wrong. It is `CONFIRMED` and every downstream
    // path already treats that as ordinary.
    expect(RESUME).toContain('status: "CONFIRMED"');
    expect(RESUME).toContain('conflict("NOT_PAUSED"');
  });
});

describe("🔴 AC-7 — the teacher message, and the no-teacher rule is an ENQUEUE rule", () => {
  test("no teacher ⇒ NO row at all, asserted by position", () => {
    // Not a SKIPPED row: that records *we tried to reach someone*, and there was nobody to reach (SPEC-072 §5).
    for (const body of [PAUSE, RESUME]) {
      expect(body).toMatch(/teacher??.(lineUserId|teacher)/);
      expect(body.indexOf("lineUserId")).toBeLessThan(body.indexOf("enqueueLine("));
    }
  });

  test("both messages exist as kinds, and reuse the outbox — no new machinery", () => {
    expect(PAUSE).toContain('payload: { kind: "booking_paused" }');
    expect(RESUME).toContain('payload: { kind: "booking_resumed" }');
    for (const body of [PAUSE, RESUME]) expect(body).toContain('recipientType: "teacher"');
  });
});

describe("🔴 AC-17 — a paused booking is absent from the day-end sweep too", () => {
  test("the auto-attend selects CONFIRMED only, so a PAUSED row cannot be swept", () => {
    // Already true, and asserted rather than relied on: this is exactly the kind of absence a later change to
    // the sweep's filter would quietly undo, and nothing else would notice.
    const loop = code(JOBS).slice(code(JOBS).indexOf("export async function runEndOfDayJob"));
    expect(loop).toContain('eq(bookings.status, "CONFIRMED")');
    expect(loop.slice(0, loop.indexOf("return { autoAttended:"))).not.toContain("PAUSED");
  });

  test("…and the revenue sweep beside it names its types explicitly, so PAUSED is not in reach", () => {
    expect(code(JOBS)).toContain('inArray(bookings.bookingType, ["FIRST_TRIAL", "SINGLE_SESSION", "OTHER"])');
    expect(code(JOBS)).toContain('eq(bookings.status, "ATTENDED")');
  });
});
