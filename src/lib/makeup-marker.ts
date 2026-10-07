// TASK-702 (REQ-115, owner-ruled T1) — the make-up MARKER: `bookings.is_makeup`. A make-up is born CONFIRMED (an ordinary class in every status
// question), so the STATUS can no longer say "this class grew from a leave" — the MARKER does. ONE fact, one column, written by the two make-up
// writers and BACKFILLED by migration `0066` from the populations below.
//
// 🔴 ONE LIST. The migration's SQL, the owner's BEFORE/AFTER read (`MAKEUP_COUNT_READ_SQL`) and the writers' notes are all derived from THIS file, and a
// test pins the migration TEXT equal to `makeupPopulationSql()` — two copies of a population list drift, and a drift here is a make-up that becomes an
// ordinary class (the plan engine can never trim it again: silent, permanent, per row, on the customer's live system).
//
// ⚠️ P3/P4 depend on NOTES the system itself writes. A note a person typed is exactly what code-reading cannot see — which is why the migration
// ALSO refuses to finish when it finds a course row whose note mentions `ขยาย` and is in none of the populations (`makeupSuspectSql`), and why the
// owner reads the real distinct notes FIRST (TASK-702 §2a step 0).

/** The note the RECONCILE append writes on a make-up it creates (a plan edit, a resume, an insert's re-plan, a declared absence at creation). */
export const MAKEUP_NOTE_RECONCILE = "คาบขยายอัตโนมัติจากการปรับแผนคอร์ส";
/** The note the LEAVE writer (`updateBookingStatus` sick-leave) writes on its make-up. */
export const MAKEUP_NOTE_LEAVE = "คาบขยายอัตโนมัติจากการลา";
/** The note the TRIM overwrites a make-up's note with when it cancels it — so a trimmed UNLINKED make-up is in none of P1–P3 (P4). */
export const MAKEUP_NOTE_TRIMMED = "ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)";
/** The note a leave's Undo writes on the make-up it cancels. */
export const MAKEUP_NOTE_UNDONE = "ยกเลิกคาบขยาย — ย้อนกลับการลา";

/** P3 — the notes a make-up is BORN with. */
export const MAKEUP_BIRTH_NOTES = [MAKEUP_NOTE_RECONCILE, MAKEUP_NOTE_LEAVE] as const;
/** P4 — the notes a CANCELLED make-up carries after the trim / the Undo overwrote its birth note. */
export const MAKEUP_CANCEL_NOTES = [MAKEUP_NOTE_TRIMMED, MAKEUP_NOTE_UNDONE] as const;

const quoted = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

/**
 * The union P1 ∪ P2 ∪ P3 ∪ P4 as a SQL predicate over `bookings` (the table's own columns; `booking_type` is NOT in it — callers AND it).
 *  P1 `status = 'EXTENDED'`            — the engine creates every make-up in this status
 *  P2 `extended_from_id IS NOT NULL`   — linked to the leave it replaces (survives confirm, attend, cancel)
 *  P3 `note IN (birth notes)`          — catches a make-up appended WITHOUT a link (TASK-553's case) that was later CONFIRMED
 *  P4 `status = 'CANCELLED' AND note IN (cancel notes)` — an unlinked make-up the trim / the Undo cancelled (its note was overwritten)
 */
export const makeupPopulationSql = (): string =>
  `"status" = 'EXTENDED' OR "extended_from_id" IS NOT NULL OR "note" IN (${quoted(MAKEUP_BIRTH_NOTES)}) OR ("status" = 'CANCELLED' AND "note" IN (${quoted(MAKEUP_CANCEL_NOTES)}))`;

/** A course row whose note MENTIONS a make-up but is in NO population — a note an older version wrote, or a person typed. The migration refuses to finish while any exists. */
export const makeupSuspectSql = (): string =>
  `"booking_type" = 'COURSE_PACKAGE' AND "note" LIKE '%ขยาย%' AND NOT (${makeupPopulationSql()})`;

/** Step 0 — the owner's READ of the real notes (bare SQL, via @Porter), on sid AND uat, BEFORE the list is frozen. */
export const MAKEUP_NOTES_READ_SQL = `SELECT note, status, (extended_from_id IS NOT NULL) AS linked, count(*)
FROM bookings
WHERE booking_type = 'COURSE_PACKAGE' AND note LIKE '%ขยาย%'
GROUP BY 1, 2, 3 ORDER BY 4 DESC;`;

/** §2d — the owner's BEFORE read (SELECT only): each population and the union. AFTER: `SELECT count(*) FROM bookings WHERE is_makeup` must equal `union_`. */
export const MAKEUP_COUNT_READ_SQL = `SELECT count(*) FILTER (WHERE "status" = 'EXTENDED') AS p1,
       count(*) FILTER (WHERE "extended_from_id" IS NOT NULL) AS p2,
       count(*) FILTER (WHERE "note" IN (${quoted(MAKEUP_BIRTH_NOTES)})) AS p3,
       count(*) FILTER (WHERE "status" = 'CANCELLED' AND "note" IN (${quoted(MAKEUP_CANCEL_NOTES)})) AS p4,
       count(*) FILTER (WHERE ${makeupPopulationSql()}) AS union_
FROM bookings WHERE "booking_type" = 'COURSE_PACKAGE';`;
