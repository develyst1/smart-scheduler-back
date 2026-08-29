// SPEC-067 / TASK-211 (REQ-074) — cancelling a 1HR or voucher booking with an auditable reason.
//
// The claim that matters is not "the code takes a reasonCode" — it is that a cancellation made by mistake is
// FINDABLE afterwards, and that cancelling does not touch money. Both are asserted at the source, because the
// cancel path is one transaction with no pure seam and because "no money moved" is provable by absence.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { END_REASONS, isEndReason } from "../lib/course-plan";

const SRC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const FN = SRC.slice(SRC.indexOf("export async function updateBookingStatus"));
const BODY = FN.slice(0, FN.indexOf("\n}\n") + 2);
const CANCEL = BODY.slice(BODY.indexOf('} else if (action === "cancel")'), BODY.indexOf('} else if (action === "sick-leave"'));

describe("the reason is the SAME enum as a course ending (TASK-211)", () => {
  test("🔴 one vocabulary, not two — the enum is imported, never re-declared", () => {
    // A parallel reason-set would split "find every admin-error cancellation" into two queries that drift.
    expect(CANCEL).toContain("END_REASONS");
    expect(CANCEL).toContain("isEndReason");
    expect(CANCEL).not.toMatch(/\["ADMIN_ERROR"/); // no second literal list here
  });

  test("the three values are exactly REQ-036's", () => {
    expect([...END_REASONS]).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR"]);
    expect(isEndReason("ADMIN_ERROR")).toBe(true);
    expect(isEndReason("OTHER")).toBe(false);
  });

  test("🔴 the reason is stored in its OWN column, not buried in the free-text note", () => {
    // `note` holds the human sentence; `cancelReason` holds the machine one. Only a column makes the audit
    // query a WHERE instead of a LIKE that a rephrasing breaks.
    expect(CANCEL).toContain("cancelReason: enumReason");
    expect(CANCEL).toContain("note: cancelReason ?? current.note");
  });
});

describe("required for the three NON-COURSE types — and ONLY those", () => {
  test("🔴 SINGLE_SESSION, VOUCHER and FIRST_TRIAL (TASK-220 added the trial)", () => {
    // A first trial belongs with the other two: it is a **standalone session that bills** at day-end when
    // attended, so cancelling one is exactly the act the audit question is about. Leaving it out made "find
    // every cancellation someone made by mistake" silently incomplete — the worst kind of wrong for a query
    // whose whole purpose is completeness.
    expect(CANCEL).toContain('REASON_ENUM_REQUIRED = new Set(["SINGLE_SESSION", "VOUCHER", "FIRST_TRIAL"])');
    expect(CANCEL).toContain('throw new ApiException(400, "REASON_REQUIRED"');
  });

  test("⛔ the coupling to the FE's `canCancelWithReason` is written at the site, not just in a task file", () => {
    // If the two lists ever diverge, the dialog asks for a reason nobody stores — or the API refuses a cancel
    // the UI offers. Fern put the same warning on her half.
    expect(CANCEL).toContain("canCancelWithReason");
  });

  test("🔑 a COURSE_PACKAGE cancel is byte-identical to before — it is a reschedule, not a forfeit", () => {
    // A course session's cancel re-owes a make-up (SPEC-028 §11.3): a different act, with its own rules.
    // Forcing an enum onto it here would change a path REQ-074 never asked about.
    expect(CANCEL).not.toContain('"COURSE_PACKAGE"');
    // …and the write only sets the column when the enum applies.
    expect(CANCEL).toContain("...(enumReason ? { cancelReason: enumReason } : {})");
  });

  test("an unknown code is refused with the allowed list, not silently stored", () => {
    expect(CANCEL).toContain('"INVALID_REASON"');
    expect(CANCEL).toContain("allowed: END_REASONS");
  });
});

describe("🔴 no money moves — record the reason, build no refund", () => {
  test("the cancel branch posts nothing to the ledger", () => {
    // A SINGLE_SESSION posts revenue at day-end when ATTENDED (so a cancel before that posted nothing), and a
    // voucher posts at SALE (so cancelling a session cannot un-post it). Any refund here would be inventing
    // a money rule nobody has decided.
    for (const forbidden of ["recordSale", "boMovement", "insert(boMovement", "refund"]) {
      expect(CANCEL).not.toContain(forbidden);
    }
  });

  test("what it DOES give back is the consumed unit, which is not money", () => {
    // Correcting a mis-marked attendance returns the session/hour it consumed (TASK-144) — unchanged here.
    expect(CANCEL).toContain("returnsConsumedUnit(current.status)");
  });
});
