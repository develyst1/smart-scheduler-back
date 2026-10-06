// SPEC-067 / TASK-211 (REQ-074) — cancelling a 1HR or voucher booking with an auditable reason.
//
// The claim that matters is not "the code takes a reasonCode" — it is that a cancellation made by mistake is
// FINDABLE afterwards, and that cancelling does not touch money. Both are asserted at the source, because the
// cancel path is one transaction with no pure seam and because "no money moved" is provable by absence.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { END_REASONS, isEndReason, SESSION_CANCEL_REASONS } from "../lib/course-plan"; // 🔻 TASK-690

const SRC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const FN = SRC.slice(SRC.indexOf("export async function updateBookingStatus"));
const BODY = FN.slice(0, FN.indexOf("\n}\n") + 2);
const CANCEL = BODY.slice(BODY.indexOf('} else if (action === "cancel")'), BODY.indexOf('} else if (action === "sick-leave"'));

describe("the reason is the SAME enum as a course ending (TASK-211)", () => {
  test("🔴 one vocabulary, not two — the enum is imported, never re-declared", async () => {
    // A parallel reason-set would split "find every admin-error cancellation" into two queries that drift.
    // 🔻 TASK-690 — NARROWED, and the principle is KEPT: a SESSION cancel now takes `SESSION_CANCEL_REASONS` (END_REASONS +
    // `SCHOOL_ISSUE`, REQ-112's trigger T3). That is NOT a parallel vocabulary — it is built BY SPREAD from `END_REASONS` in
    // `lib/course-plan.ts`, so "every admin-error cancellation" is still ONE query over ONE set of codes. What the claim forbids is a
    // second LITERAL list, and that is asserted: no list of codes appears in the service, and the sibling is derived.
    expect(CANCEL).toContain("SESSION_CANCEL_REASONS");
    expect(CANCEL).toContain("isSessionCancelReason");
    expect(CANCEL).not.toMatch(/\["ADMIN_ERROR"/); // no second literal list here
    const PLAN = await Bun.file(new URL("../lib/course-plan.ts", import.meta.url)).text();
    expect(PLAN).toContain("export const SESSION_CANCEL_REASONS = [...END_REASONS, SCHOOL_ISSUE] as const;"); // derived, never re-typed
  });

  test("the four values: REQ-036's three + TASK-406's TEACHER_LEAVE", () => {
    expect([...END_REASONS]).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR", "TEACHER_LEAVE"]); // 🔻 TASK-406: the 4th — a teacher's own leave
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

describe("required for the NON-COURSE types — and ONLY those", () => {
  test("🔴 SINGLE_SESSION, VOUCHER, FIRST_TRIAL (TASK-220) and OTHER (TASK-224)", () => {
    // A first trial belongs with the other two: it is a **standalone session that bills** at day-end when
    // attended, so cancelling one is exactly the act the audit question is about. Leaving it out made "find
    // every cancellation someone made by mistake" silently incomplete — the worst kind of wrong for a query
    // whose whole purpose is completeness.
    //
    // TASK-224 (AC-13) adds `OTHER` for the same reason: an อื่นๆ booking is standalone and can bill, so its
    // cancel is found by the same `WHERE cancel_reason = 'ADMIN_ERROR'` as every other standalone type — on
    // day one, rather than after someone notices the gap.
    expect(CANCEL).toContain(
      'REASON_ENUM_REQUIRED = new Set(["SINGLE_SESSION", "VOUCHER", "FIRST_TRIAL", "OTHER", "GROUP"])', // 🔻 TASK-397: a group date's cancel is audited like an OTHER's
    );
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
    // 🔻 TASK-656 — one exception, stated: a course session now carries the code `SCHOOL_ISSUE` (REQ-112 trigger T3) and ONLY that code.
    // Still never REQUIRED (the set below does not list it) and every other code is still ignored ⇒ byte-identical for all other reasons.
    expect(CANCEL).not.toMatch(/REASON_ENUM_REQUIRED = new Set\(\[[^\]]*COURSE_PACKAGE/);
    expect(CANCEL.split('"COURSE_PACKAGE"').length - 1).toBe(1);
    expect(CANCEL).toContain('current.bookingType === "COURSE_PACKAGE" && reasonCode === SCHOOL_ISSUE');
    // …and the write only sets the column when the enum applies.
    expect(CANCEL).toContain("...(enumReason ? { cancelReason: enumReason } : {})");
  });

  test("an unknown code is refused with the allowed list, not silently stored", () => {
    expect(CANCEL).toContain('"INVALID_REASON"');
    // 🔻 TASK-690 — the allowed list a session cancel returns is the SESSION set; the claim (a refusal NAMES what is allowed rather
    // than silently storing the unknown) is unchanged.
    expect(CANCEL).toContain("allowed: SESSION_CANCEL_REASONS");
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
