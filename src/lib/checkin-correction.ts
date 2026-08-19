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

/** One session = one unit (`attend` adds exactly 1 to either counter). Never below zero, whatever the row holds. */
export const afterReturn = (consumed: number, units = 1): number => Math.max(0, (consumed ?? 0) - units);
