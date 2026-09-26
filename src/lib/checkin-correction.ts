// SPEC-043 / TASK-144 (REQ-050 Gap-C) — correcting a wrong check-in must RETURN what it consumed.
//
// `attend` increments `course_packages.used_sessions` / `vouchers.used_hours` and, until now, nothing ever
// decremented them: cancelling a mis-marked attendance released the freelance hold and re-owed a course
// make-up, but the family's session/hour stayed spent. For a voucher there is no make-up, so the hour was
// simply gone. Porter's ruling: this is money owed to a family, not tidiness.
//
// Pure so the rule is testable without a DB; the service does the mutation inside the existing transaction.

/** Only an ATTENDED booking ever consumed a unit — a PENDING/CONFIRMED/SICK_LEAVE cancel must not refund. */
export const returnsConsumedUnit = (statusBeforeCancel: string): boolean => statusBeforeCancel === "ATTENDED";

// 🔻 TASK-496 — `afterReturn` (one unit back, floored at zero) is gone: the cancel now writes
// `GREATEST(used_sessions - 1, 0)` / `GREATEST(used_hours - 1, 0)` in SQL, so the floor is part of the write (pinned by
// `counter-sql-req108.test.ts`). A JS helper nothing calls, with tests of its own, is green coverage of dead code.
