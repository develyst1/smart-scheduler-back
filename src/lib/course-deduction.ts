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
import { familyLineUserIds } from "./family-link";

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
  // 🔴 TASK-335 (`REQ-087 §1c`) — `ครั้ง` is GONE. It was THAI inside a value the SYSTEM generates, which
  // `REQ-085 §4` rules out: *"eng ล้วน ไม่ควรไทยเลยแม้แต่ติด"*. 🔑 **Nobody reported it — it is `Date : อังคาร`
  // again, in the one message family nobody had swept.**
  //
  // 🔑 REMOVED rather than TRANSLATED, and that is the whole judgement: **`14/15` beside `Remaining :` already
  // says "14 of 15 left"**, the `n/N` FORM carries the meaning that `HR` carries for a course, and the owner
  // has already signed off that shape on the course card. ⇒ **a word would restate the label.** ⚠️ And
  // *`sessions` · `times` · `classes`* is a COPY decision that belongs to the customer — **removing a Thai
  // word applies a ruling; choosing an English one would invent a string.** 📌 If they want a unit, it is one
  // constant here.
  //
  // ⚠️ TWO READERS, and BOTH are outbox messages: `deductionPayload` (COURSE DEDUCTION) and
  // `jobs.service.ts` (the daily reminder's `Remaining`) ⇒ **`§4` governs both, so both are fixed by this
  // line.** 🚫 The CARD's owner-verified `เหลือ 6/10` does NOT come through here — `line-course-view.ts`
  // renders its own and imports nothing from this file. **There was nothing to un-share.**
  return kind === "course" ? `${left} HR` : `${left}/${total}`;
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

/**
 * The payload — money facts only. Student, program, date, time and coach are enriched from `bookingId`.
 *
 * 🔑 TASK-332 half 2 — **the return type is DECLARED, not inferred.** `remaining` is a rendered LABEL
 * (`"0 HR"`, `"0/6 ครั้ง"`), never a bare number — and until now that was a fact we re-established by READING
 * `remainingLabel`. ⇒ **the day someone changes it to return a count, this annotation fails HERE**, rather
 * than the number travelling to a renderer that used to drop a falsy `0` on the floor.
 * ⚠️ **It does NOT reach the renderer.** The payload crosses a JSON column and `row.payload as any` destroys
 * every type on it. **Closing that is TASK-333, and it is why half 2 stops at this line.**
 */
export function deductionPayload(
  input: DeductionInput,
  /**
   * 🔴 TASK-336 (`REQ-087 §1b`) — the SESSION'S OWN note, read by `notifyCourseDeduction` from the booking
   * this deduction is about. **A second parameter rather than a field on `DeductionInput`** because no CALLER
   * supplies it: an input field nobody sets reads as one somebody forgot.
   * 🔑 On the PAYLOAD and not on `ctx`, for `§7.3`'s own stated reason — *"the note must survive a row that has
   * since been edited or deleted"* — **and that reason is stronger here: a deduction is a RECEIPT for
   * something that already happened, so if the booking is edited afterwards the receipt must still say what it
   * said.**
   */
  attendeeNote: string | null,
): {
  kind: "course_deduction";
  bookingType: "COURSE_PACKAGE" | "VOUCHER";
  remaining: string;
  total: number;
  expiryDate: string | null;
  attendeeNote: string | null;
} {
  return {
    kind: "course_deduction",
    // The renderer's per-type table is keyed on the booking type, and these two are the only types that reach
    // here at all (see the guard in `notifyCourseDeduction`).
    bookingType: input.kind === "course" ? "COURSE_PACKAGE" : "VOUCHER",
    remaining: remainingLabel(input.kind, input.total - input.used, input.total),
    total: input.total,
    expiryDate: input.expiryDate,
    attendeeNote,
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
  // 🔴 TASK-259 — EVERY account the family has linked, through the one accessor. This used to read
  // `parents.line_user_id` directly, so the second parent received nothing and nothing said so.
  const accounts = await familyAccountsOfStudent(exec, input.studentId);
  /**
   * 🔴 TASK-336 — the note is read HERE, from the `bookingId` this function already takes, and **not passed in
   * by the four call sites.** ONE decision instead of four copies — the shape that has bitten us all week.
   * ⚠️ And the deciding fact is not tidiness: **the day-end's `select` is an explicit column list
   * (`id · courseId · voucherId · studentId`) and does NOT carry `attendeeNote`** — so two of the four sites,
   * *and they are the MAJORITY path since REQ-070*, would have needed their query widened to hand it over.
   * ⇒ **reading it here needs nothing from any caller, and a deduction site added later inherits it.**
   * 📌 One extra read per deduction, inside the same transaction as the write, so it sees exactly the row that
   * was just attended.
   */
  const booking = await exec.query.bookings.findFirst({
    where: (b: any, { eq: e }: any) => e(b.id, input.bookingId),
  });
  const payload = deductionPayload(input, booking?.attendeeNote ?? null);

  // An unlinked family still writes ONE SKIPPED row — that is `enqueueLine`'s job and it is how the reach is
  // counted; most `uat` parents were imported and have never linked. 🚫 Not one skipped row per nobody.
  if (!accounts.length) {
    await enqueueLine(
      { recipientType: "parent", recipientLineUserId: null, bookingId: input.bookingId, payload },
      exec,
    );
    return;
  }
  for (const lineUserId of accounts) {
    await enqueueLine(
      {
        recipientType: "parent",
        recipientLineUserId: lineUserId,
        // The row carries the booking, so the worker enriches student · program · date · time · coach from it —
        // the same facts every other booking-based message reads, rather than a second copy in this payload.
        bookingId: input.bookingId,
        payload,
      },
      exec,
    );
  }
}

/**
 * Every LINE account that may act for this student's family — `[]` when there is no parent or no link.
 *
 * 🔑 The student → parent hop stays here (it is this caller's own question); "which accounts does that family
 * have" is asked of `familyLineUserIds`, the ONE accessor. TASK-255's read found three copies of the second
 * half, all of them reading a column that names only one device.
 */
async function familyAccountsOfStudent(exec: any, studentId: string): Promise<string[]> {
  const student = await exec.query.students.findFirst({
    where: (s: any, { eq }: any) => eq(s.id, studentId),
  });
  if (!student?.parentId) return [];
  return familyLineUserIds(student.parentId, exec);
}
