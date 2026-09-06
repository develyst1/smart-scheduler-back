// SPEC-072 §3 / TASK-254 (REQ-077 Parent 3) — `COURSE DEDUCTION`: a session was used, and here is what is left.
//
// 🔴 **It has TWO triggers, and the one everybody forgets is the majority.** Quota is written when an admin
// marks attendance *and* at the day-end auto-attend — and since REQ-070 the day-end auto-attends every unmarked
// class, so **most sessions are deducted by the job, not by a person.** A message wired only to the manual path
// would be missing for most classes **and would pass every test anyone thought to write**, because the test
// would check the path its author was looking at. ⇒ one helper, called from both.
//
// 🔴 **`Remaining` is the balance AFTER the deduction, taken FROM THE WRITE.** @Porter: *the message exists to
// answer "เหลือเท่าไหร่", and a before-figure in a message headed DEDUCTION is the one number that must never be
// ambiguous.* The manual site holds the pre-value and adds one; the day-end writes `used + 1` in SQL and reads
// the row back. 🚫 Never a second SELECT: a concurrent write between them would print a number that was true at
// neither moment.
import { enqueueLine } from "./line";

/** Which balance was drawn down. It is also the answer to "does this booking get the message at all". */
export type DeductionKind = "course" | "voucher";

/**
 * What is left, as the customer writes it: `2 HR` for a course, `4/6 ครั้ง` for a voucher.
 *
 * 📌 The voucher form is `remaining/total`, matching `courseLine`'s owner-verified `เหลือ 6/10` (TASK-234) —
 * the same number in the same shape wherever a family reads it. Pure.
 */
export function remainingLabel(kind: DeductionKind, remaining: number, total: number): string {
  const left = Math.max(0, remaining);
  return kind === "course" ? `${left} HR` : `${left}/${total} ครั้ง`;
}

export interface DeductionInput {
  bookingId: string;
  studentId: string | null;
  kind: DeductionKind;
  /** 🔴 AFTER the write — `used` as the database now holds it. */
  used: number;
  /** Purchased size (course) or total hours (voucher). */
  total: number;
  expiryDate: string | null;
}

/** The payload — money facts only. Student, program, date, time and coach are enriched from `bookingId`. */
export function deductionPayload(input: DeductionInput) {
  return {
    kind: "course_deduction",
    // The renderer's per-type table is keyed on the booking type, and these two are the only types that reach
    // here at all (see the guard in `notifyCourseDeduction`).
    bookingType: input.kind === "course" ? "COURSE_PACKAGE" : "VOUCHER",
    remaining: remainingLabel(input.kind, input.total - input.used, input.total),
    total: input.total,
    expiryDate: input.expiryDate,
  };
}

/**
 * Queue the parent's `COURSE DEDUCTION` for one session — the ONE writer, called from both deduction sites.
 *
 * 🔑 **Idempotency comes from being tied to the write, not from a key.** Both call sites deduct only when the
 * booking actually moves to ATTENDED (the manual path guards on `status !== "ATTENDED"`; the day-end selects
 * `status = CONFIRMED`), so a re-run of the day-end — which we have just told the owner is the safe recovery for
 * the AC-5 gap — **deducts nothing and therefore announces nothing.**
 * ⚠️ The outbox's `idempotencyKey` (TASK-218) was the obvious candidate and **cannot be used here**: its own
 * signature says it may only be used OUTSIDE a transaction, because the duplicate is detected by swallowing a
 * `23505` and a swallowed constraint error leaves the surrounding transaction aborted. Both deduction sites are
 * inside one. Enqueuing after the commit instead would buy a key and lose atomicity — and a crash in between
 * would lose the message with no re-run able to recover it, because the second run deducts nothing.
 *
 * 🚫 **No student ⇒ no row.** An อื่นๆ booking may have no student, and a row addressed to nobody still lands in
 * the outbox as SKIPPED and reads as *we tried to reach a family* when there was none (SPEC-072 §5). In practice
 * an อื่นๆ never deducts — it draws on no balance — so this should be unreachable; it is asserted rather than
 * assumed.
 */
export async function notifyCourseDeduction(exec: any, input: DeductionInput): Promise<void> {
  if (!input.studentId) return;
  const parentLineUserId = await lookupParentLine(exec, input.studentId);
  // An unlinked parent still writes a SKIPPED row — that is `enqueueLine`'s job and it is how the reach is
  // counted; most `uat` parents were imported and have never linked.
  await enqueueLine(
    {
      recipientType: "parent",
      recipientLineUserId: parentLineUserId,
      // The row carries the booking, so the worker enriches student · program · date · time · coach from it —
      // the same facts every other booking-based message reads, rather than a second copy in this payload.
      bookingId: input.bookingId,
      payload: deductionPayload(input),
    },
    exec,
  );
}

/** The parent's LINE id for a student, or `null` — `null` is a first-class answer, not an error. */
async function lookupParentLine(exec: any, studentId: string): Promise<string | null> {
  const student = await exec.query.students.findFirst({
    where: (s: any, { eq }: any) => eq(s.id, studentId),
  });
  if (!student?.parentId) return null;
  const parent = await exec.query.parents.findFirst({
    where: (p: any, { eq }: any) => eq(p.id, student.parentId),
  });
  return parent?.lineUserId ?? null;
}
