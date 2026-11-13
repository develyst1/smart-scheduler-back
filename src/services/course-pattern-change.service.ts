// 🔻 TASK-971 (REQ-5016 AC5, SPEC-109 §3.4) — CHANGE THE PATTERN of a course mid-course: `POST /courses/:id/change-pattern[/preview]` `{ fromDate, pattern: Slot[] (1…21) }`, on TASK-838's shape (`runCourseTeacherTimeChange`).
//
// ONE transaction; the UNTAUGHT rows (live, dated `fromDate` or later — `lib/pattern-change.ts`) are re-placed IN ORDER onto `expandPattern(course.startDate, pattern, n, new Set(), fromDate)` (the §8b seam), the count kept, each row on its slot's own coach
// and time; taught rows stay. `assertTeacherBookable` + `reconcileBookingHolds` per moved row; a clash is 409 `SLOT_TAKEN` naming the date and the whole act rolls back; a row that was CONFIRMED goes back to PENDING (its confirmation was of the old slot) and the
// course is flagged `reconfirmNeededSince` — the family hears at "ยืนยันทั้งคอร์ส" (one schedule message per person), exactly as TASK-838; the coaches hear the TASK-838 pair (`sendCourseTeacherChange`). `course_slots` is REWRITTEN here and ONLY here: 2+ slots ⇒
// the rows replaced; a ONE-slot result ⇒ the rows deleted and the course's own weekday / start_time carry it. The expiry grows to cover the new last row and never shrinks (`replanExpiry`, recorded). The preview is the act inside a transaction that is ALWAYS
// rolled back. 🚫 Not touched: size, `usedSessions`, `leaveUsed`, the sale, the course's default rate. (Its own file, not `scheduler.service.ts`: that file is edited by several desks at once.)
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bookings, courseSlots, coursePackages } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { ApiException, notFound, pgErrorCode } from "../lib/http";
import { replanExpiry } from "../lib/course-plan";
import { isWholeCourseTeacherChange } from "../lib/first-coach";
import { hhmmOf, orderPattern, type Slot } from "../lib/course-pattern";
import { isPatternChangeRefusal, planPatternChange, slotsToStore } from "../lib/pattern-change";
import { addHour } from "../lib/time";
import { assertCourseWritable, assertTeacherBookable, loadBookingDTO, reconcileBookingHolds, recordExpiryChange, sendCourseTeacherChange } from "./scheduler.service";

type PatternInput = { fromDate: string; pattern: Slot[] };

async function runCoursePatternChange(tx: any, id: string, input: PatternInput, actor: string | null) {
  const course = await tx.query.coursePackages.findFirst({ where: (c: any, { eq: e }: any) => e(c.id, id) });
  if (!course) throw notFound("ไม่พบคอร์ส");
  const rows = await tx.query.bookings.findMany({
    where: (b: any, { and: a, eq: e }: any) => a(e(b.courseId, id), e(b.bookingType, "COURSE_PACKAGE")),
    orderBy: (b: any, { asc }: any) => [asc(b.date), asc(b.startTime)],
  });
  await assertCourseWritable(tx, id); // an ENDED or PAUSED course refuses with its own words, as every re-plan door does
  const plan = planPatternChange(
    rows.map((r: any) => ({ id: r.id, date: r.date, startTime: r.startTime, endTime: r.endTime, status: r.status, teacherId: r.teacherId, bookingType: r.bookingType })),
    { startDate: course.startDate, fromDate: input.fromDate, pattern: input.pattern.map((s) => ({ weekday: s.weekday, startTime: hhmmOf(s.startTime), teacherId: s.teacherId })) },
    bangkokNow().date,
  );
  if (isPatternChangeRefusal(plan)) throw new ApiException(plan.status, plan.code === "PATTERN_INVALID" ? "VALIDATION" : plan.code, plan.message);
  const byId = new Map(plan.moves.map((m) => [m.id, m]));
  for (const rowId of plan.order) {
    const m = byId.get(rowId)!;
    await assertTeacherBookable(tx, m.to.teacherId, m.to.date);
    const reconfirm = m.toStatus !== m.status ? { status: m.toStatus, confirmedAt: null, checkinToken: null, checkinTokenExpiresAt: null } : {};
    try {
      await tx.update(bookings).set({ teacherId: m.to.teacherId, date: m.to.date, startTime: m.to.startTime, endTime: addHour(m.to.startTime), ...reconfirm }).where(eq(bookings.id, m.id));
    } catch (e: any) {
      if (pgErrorCode(e) === "23505")
        throw new ApiException(409, "SLOT_TAKEN", `วันที่ ${m.to.date} ครูมีคาบอื่นในเวลา ${hhmmOf(m.to.startTime)} แล้ว — ไม่ได้ย้ายคาบใด (เลือกเวลาหรือครูอื่น)`, { date: m.to.date, time: hhmmOf(m.to.startTime) });
      throw e;
    }
    await reconcileBookingHolds(tx, m.id, m.to.teacherId, m.toStatus, false); // the freelance ceiling moves from the old coach to the new one
  }
  const ordered = orderPattern(course.startDate, input.pattern);
  const stored = slotsToStore(ordered);
  await tx.delete(courseSlots).where(eq(courseSlots.courseId, id)); // 2+ slots ⇒ replaced below; a ONE-slot result ⇒ none left (the course's own weekday / start_time carry it)
  if (stored) await tx.insert(courseSlots).values(orderPattern(course.startDate, stored).map((s, i) => ({ courseId: id, ord: i, weekday: s.weekday, startTime: hhmmOf(s.startTime), teacherId: s.teacherId })));
  const expiryDate = replanExpiry(course.expiryDate, plan.lastDate); // grows to cover the new last row, never shrinks
  const only = ordered.length === 1 ? ordered[0]! : null;
  await tx
    .update(coursePackages)
    .set({
      weekday: ordered[0]!.weekday, startTime: hhmmOf(ordered[0]!.startTime), expiryDate, ...(plan.needsReconfirm > 0 ? { reconfirmNeededSince: new Date() } : {}),
      // 🔻 TASK-860 (F4) — a REAL whole-course coach change is recorded as TASK-838 does; only a ONE-slot result has ONE coach to record (a several-coach pattern has no single "latest" coach to name)
      ...(only && isWholeCourseTeacherChange(plan.moves, only.teacherId) ? { latestTeacherId: only.teacherId, coachChangedAt: new Date() } : {}),
    })
    .where(eq(coursePackages.id, id));
  await recordExpiryChange(tx, { courseId: id, from: course.expiryDate, to: expiryDate, actor });
  await sendCourseTeacherChange(tx, plan.moves);
  const movedRows = [];
  for (const m of [...plan.moves].sort((a, b) => a.to.date.localeCompare(b.to.date) || a.to.startTime.localeCompare(b.to.startTime))) movedRows.push(await loadBookingDTO(tx, m.id));
  return {
    moved: plan.n,
    rows: movedRows,
    notices: {
      coachesUnassigned: new Set(plan.moves.filter((m) => m.from.teacherId !== m.to.teacherId).map((m) => m.from.teacherId)).size,
      coachesAssigned: new Set(plan.moves.filter((m) => m.from.teacherId !== m.to.teacherId).map((m) => m.to.teacherId)).size,
      needsReconfirm: plan.needsReconfirm, // rows back to PENDING: the family hears at "ยืนยันทั้งคอร์ส"
    },
    firstDate: plan.firstDate,
    lastDate: plan.lastDate,
    expiryDate,
    previousExpiryDate: course.expiryDate as string,
    expiryExtended: expiryDate !== course.expiryDate,
    patternSlots: stored ? stored.length : 1,
  };
}

export async function changeCoursePattern(id: string, input: PatternInput, actor?: string | null) {
  return db.transaction(async (tx: any) => runCoursePatternChange(tx, id, input, actor ?? null));
}

class PatternPreviewRollback extends Error { constructor(readonly result: Awaited<ReturnType<typeof runCoursePatternChange>>) { super("preview-rollback"); } }
/** The act's OWN run inside a transaction that is ALWAYS rolled back — a preview that cannot disagree with the act (the same shape, nothing written). Every refusal of the act (incl. SLOT_TAKEN naming the date) is the preview's too. */
export async function previewCoursePattern(id: string, input: PatternInput) {
  try {
    await db.transaction(async (tx: any) => {
      throw new PatternPreviewRollback(await runCoursePatternChange(tx, id, input, null));
    });
  } catch (e: any) {
    if (e instanceof PatternPreviewRollback) return e.result;
    throw e;
  }
  throw new Error("unreachable");
}
