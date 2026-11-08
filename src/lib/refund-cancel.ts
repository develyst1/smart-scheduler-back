// TASK-892 (SPEC-099 §10 (1), REQ-120 §9 / §9.1 C-f) — the internal "a refund cancels the refunded plan" act. The back office records the
// refund (TASK-893); this is the one door it calls on the scheduling side so the COURSE or VOUCHER stops: its not-yet-held sessions are
// cancelled and it is marked ended, by the SAME functions the admin's "ยกเลิกคอร์ส / ยกเลิกวอยเชอร์" button runs (`endCourse` / `endVoucher`,
// `scheduler.service.ts`). NOTHING in those functions changes; this file only chooses the reason and maps the answer.
//
//   • reason  = `CUSTOMER_CANCELLED` (`lib/course-plan.ts:443` END_REASONS and `:455` COURSE_END_REASONS both list it), note = "refund".
//   • success = `endCourse` / `endVoucher` return `{ cancelled: true, removedSessions: n, … }` (scheduler.service.ts:6406 / :6570) → `cancelledSessions: n`.
//   • already ended = both functions refuse a second end with `conflict("ALREADY_ENDED", …)`: a 409 with the CODE `ALREADY_ENDED`
//     (course: scheduler.service.ts:6421-6423 · voucher: :6581-6582). That one refusal is mapped to a success that says so
//     (`cancelledSessions: 0, alreadyCancelled: true`): a refund is retried, and a retry must not look like an error. The OTHER codes
//     (`COURSE_ENDED`, `VOUCHER_ENDED`, … used by the re-plan doors) are different refusals and are NOT mapped.
//   • unknown id = both functions throw `notFound(...)` (course: :5496-5497 via `loadCourseForEnd`; voucher: :6541) → 404, passed through.
// The family's notice is LINE (the owner's) and not this file's business; a teacher's "class cancelled" notice is whatever `endCourse` /
// `endVoucher` already send (`sendCourseDroppedToTeachers`).
import { ApiException } from "./http";

export type RefundRefType = "COURSE" | "VOUCHER";
export const REFUND_END_REASON = "CUSTOMER_CANCELLED";
export const REFUND_END_NOTE = "refund";

export interface RefundCancelDeps {
  endCourse(id: string, input: { reason: string; note?: string | null }, actor?: string | null): Promise<{ removedSessions: number }>;
  endVoucher(id: string, input: { reason: string; note?: string | null }, actor?: string | null): Promise<{ removedSessions: number }>;
}

export interface RefundCancelResult {
  cancelledSessions: number;
  alreadyCancelled: boolean;
}

/** True only for the "this plan was already ended" refusal of `endCourse` / `endVoucher`: a 409 with the code ALREADY_ENDED. */
export const isAlreadyEnded = (e: unknown): boolean => e instanceof ApiException && e.status === 409 && e.code === "ALREADY_ENDED";

/**
 * Cancel the refunded plan. Success → `{ cancelledSessions: n, alreadyCancelled: false }`; already ended → `{ 0, true }`; every other
 * refusal (404 unknown id, a 400 from the reason check, anything unexpected) is rethrown untouched.
 */
export async function refundCancel(
  input: { refType: RefundRefType; refId: string; actor?: string | null },
  deps: RefundCancelDeps,
): Promise<RefundCancelResult> {
  const end = input.refType === "COURSE" ? deps.endCourse : deps.endVoucher;
  try {
    const r = await end.call(deps, input.refId, { reason: REFUND_END_REASON, note: REFUND_END_NOTE }, input.actor ?? null);
    const n = r?.removedSessions;
    if (!Number.isInteger(n) || n < 0) throw new Error(`${input.refType} end returned no session count: ${JSON.stringify(r)}`);
    return { cancelledSessions: n, alreadyCancelled: false };
  } catch (e) {
    if (isAlreadyEnded(e)) return { cancelledSessions: 0, alreadyCancelled: true };
    throw e;
  }
}

// The real functions are loaded on first use (this file stays importable without the scheduling service); a test replaces them.
let override: RefundCancelDeps | null = null;
/** TEST SEAM ONLY: route tests install fakes here (and clear them with `null`). Production never calls it. */
export function setRefundCancelDeps(d: RefundCancelDeps | null): void {
  override = d;
}
export async function refundCancelDeps(): Promise<RefundCancelDeps> {
  if (override) return override;
  const s = await import("../services/scheduler.service");
  return { endCourse: s.endCourse, endVoucher: s.endVoucher };
}
