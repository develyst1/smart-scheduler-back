// SPEC-062 / TASK-177 (REQ-057) — the PURE half of `course:cleanup`: what a delete would touch, and every
// reason it must not happen.
//
// 🔴 This decides deletions on a live customer database, so the rules live here — unit-tested, readable in one
// screen — rather than inline in a script where nobody can check them. The script does IO; this file decides.
//
// Two principles, both learned from things that have already gone wrong on this project:
//   1. **Refuse, never warn.** A warning on a delete tool is a delete that happens anyway, at 6pm, by someone
//      who has read it four times. Every check below stops the run — `--commit` does not override any of them.
//   2. **An explicit id, never a predicate.** The caller names one course. There is no `--name`, no LIKE, and
//      nothing here takes a filter: a tool that can express "everything like this" will eventually be handed
//      the wrong "this".

export interface CleanupCourse {
  id: string;
  size: number;
  source: string;
  usedSessions: number;
  startDate: string;
}

export interface CleanupBooking {
  id: string;
  date: string;
  status: string;
}

export interface CleanupInput {
  course: CleanupCourse;
  bookings: CleanupBooking[];
  student: { id: string; name: string; nickname: string | null };
  parent: { id: string; name: string; lineUserId: string | null; studentCount: number } | null;
  /** `bo.movement` rows with `refType='SALE'` whose `refId` is the course or any of its bookings. */
  postedSaleRefIds: string[];
  /** Only for `--remove-household`: does the student own anything else? */
  studentHasOtherEntitlements?: boolean;
}

export interface CleanupPlan {
  ok: boolean;
  /** Every reason this must not run. Non-empty ⇒ the script refuses, `--commit` or not. */
  refusals: string[];
  /** What a COMMIT would delete, per table — the dry run prints exactly these numbers. */
  counts: { bookings: number; course_packages: number };
  /** Human-readable blast radius for the owner's terminal (names, not ids). */
  bookingDates: string[];
}

export function planCourseCleanup(input: CleanupInput): CleanupPlan {
  const refusals: string[] = [];

  // ── The four refusals (AC-3/AC-8). Each names what it found, because "refused" without a reason sends the
  // owner back to us, and the whole point of this tool is that he does not have to ask.
  const attended = input.bookings.filter((b) => b.status === "ATTENDED");
  if (attended.length) {
    refusals.push(
      `มีคาบที่เรียนไปแล้ว (ATTENDED) ${attended.length} คาบ — ไม่ใช่ข้อมูลทดสอบ (${attended.map((b) => b.date).join(", ")})`,
    );
  }
  if (input.postedSaleRefIds.length) {
    refusals.push(
      `มีรายการขายที่ลงบัญชีแล้ว ${input.postedSaleRefIds.length} รายการ — ลบคอร์สจะทำให้บัญชีอ้างถึงสิ่งที่ไม่มีอยู่`,
    );
  }
  if (input.parent?.lineUserId) {
    refusals.push("ผู้ปกครองผูกบัญชี LINE แล้ว — บัญชีทดสอบไม่ผูก LINE");
  }
  if (input.parent && input.parent.studentCount > 1) {
    refusals.push(`ผู้ปกครองมีนักเรียน ${input.parent.studentCount} คน — ครัวเรือนจริง ไม่ใช่ข้อมูลทดสอบ`);
  }

  // 🔴 Deliberately NOT a refusal: `usedSessions > 0`. On an IMPORT course that is the count taught BEFORE the
  // import (REQ-064's `priorSessions`), not evidence of anything happening here — and the course the owner
  // actually needs to delete has `usedSessions = 4`. Refusing on it would make this tool useless for its one
  // job. `ATTENDED` is the honest test for "something really happened", and it is checked above.

  return {
    ok: refusals.length === 0,
    refusals,
    counts: { bookings: input.bookings.length, course_packages: 1 },
    bookingDates: [...input.bookings].sort((a, b) => a.date.localeCompare(b.date)).map((b) => b.date),
  };
}

/**
 * `--remove-household` is a second, narrower decision — and it is separate on purpose: cleaning up a fake
 * course must never become "and also delete a family" by accident. All three guards must hold, and failing
 * them refuses **only the household part**; the course cleanup still runs.
 */
export function planHouseholdRemoval(input: CleanupInput): { ok: boolean; refusals: string[] } {
  const refusals: string[] = [];
  if (!input.parent) {
    refusals.push("นักเรียนไม่มีผู้ปกครองผูกอยู่ — ไม่มีครัวเรือนให้ลบ");
    return { ok: false, refusals };
  }
  if (input.parent.studentCount !== 1) {
    refusals.push(`ผู้ปกครองมีนักเรียน ${input.parent.studentCount} คน — ลบครัวเรือนได้เฉพาะกรณีมีคนเดียว`);
  }
  if (input.studentHasOtherEntitlements) {
    refusals.push("นักเรียนยังมีคอร์ส/บัตร/คาบอื่นอยู่ — ไม่ลบ");
  }
  if (input.parent.lineUserId) {
    refusals.push("ผู้ปกครองผูกบัญชี LINE แล้ว — ไม่ลบ");
  }
  return { ok: refusals.length === 0, refusals };
}

/** The dry run's blast radius, in the owner's terminal — names and dates, never ids he'd have to look up. */
export function formatBlastRadius(input: CleanupInput, plan: CleanupPlan): string[] {
  const nick = input.student.nickname ? ` (${input.student.nickname})` : "";
  return [
    `คอร์ส: ${input.course.size} คาบ · ${input.course.source} · เริ่ม ${input.course.startDate}`,
    `นักเรียน: ${input.student.name}${nick}`,
    `ผู้ปกครอง: ${input.parent ? input.parent.name : "—"}`,
    `คาบที่จะถูกลบ (${plan.counts.bookings}): ${plan.bookingDates.join(", ") || "—"}`,
    `ตาราง: bookings ${plan.counts.bookings} · course_packages ${plan.counts.course_packages}`,
  ];
}
