// TASK-282 §3.1 — the EVIDENCE for the confirm-or-correct, not the fix.
//
// 🔴 Sober's §2(a): *"a declared leave is counted as neither current nor delivered, so `owed` includes it, and
// the resume creates a replacement for a session the family has already spent."*
//
// This file exists to answer that with arithmetic instead of prose. It simulates `dropCourse` + `resumeCourse`
// using **the same pure functions those two call** — `endableSessions`, `courseOwedTarget`, `courseCurrent` —
// so the numbers here are the service's own, not a restatement of them.
//
// ⚠️ It asserts what the code DOES today. It is deliberately not the DoD's `4, not 6` test: that expectation
// follows from §2(a), and §2(a) is the thing under examination.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  courseCurrent,
  courseOwedTarget,
  endableSessions,
  replanExpiry,
  type PlanSession,
} from "./course-plan";
import { courseSessionDates, weekdayOf } from "./recurring";
import * as v from "../validation";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
/** Comments stripped before any `not.toContain`: a doc block that NAMES the thing it removed would otherwise
 *  fail the assertion that it is gone — my own prose defeating my own test. */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

type Row = PlanSession & { id: string };
const row = (id: string, status: string, date = "2026-09-01"): Row => ({
  id,
  status,
  date,
  extendedFromId: null,
  bookingType: "COURSE_PACKAGE",
});

/**
 * `dropCourse` → `resumeCourse`, in the order and with the reads the service uses:
 * - pause  : every `endableSessions` row becomes CANCELLED (a raw UPDATE — **no reconcile fires**, which is
 *            the half of Sober's §2 that IS right).
 * - resume : `owed = courseOwedTarget(course) − courseCurrent(rows)`, then that many inserts.
 */
function pauseThenResume(course: { size: number; priorSessions?: number | null }, rows: Row[]) {
  const doomed = new Set(endableSessions(rows).map((r) => r.id));
  const afterPause = rows.map((r) => (doomed.has(r.id) ? { ...r, status: "CANCELLED" } : r));
  const created = Math.max(0, courseOwedTarget(course) - courseCurrent(afterPause));
  return { cancelled: doomed.size, created, totalRows: afterPause.length + created };
}

describe("TASK-282 §3.1 — does a declared leave inflate what the resume creates?", () => {
  test("🔑 the owner's case: 6-session course, 2 leaves, nothing attended ⇒ 6 cancelled, 6 created, 14 rows", () => {
    // A leave that stayed within quota EARNS an `EXTENDED` make-up (`scheduler.service.ts:2774`), and
    // `EXTENDED` **is** in `COURSE_LIVE`. So at pause time the two leaves are already represented by two live
    // rows — and those are cancelled with the rest.
    const rows = [
      row("p1", "PENDING"), row("p2", "PENDING"), row("p3", "PENDING"), row("p4", "PENDING"),
      row("s1", "SICK_LEAVE"), row("s2", "SICK_LEAVE"),
      row("e1", "EXTENDED"), row("e2", "EXTENDED"),
    ];
    const r = pauseThenResume({ size: 6 }, rows);
    // 🔴 Sober's 14 is reproduced EXACTLY — and it contains no over-creation.
    expect(r).toEqual({ cancelled: 6, created: 6, totalRows: 14 });
  });

  test("🔑 the invariant: on a course at plan target, CREATED === CANCELLED, whatever the leave count", () => {
    // `courseCurrent` counts LIVE + DELIVERED. A paused course has zero live, so the resume creates
    // `planSize − delivered`, which is what was live a moment earlier. The leave count is on neither side of
    // that subtraction, so it cannot move the answer.
    for (const leaves of [0, 1, 2]) {
      const live = 6 - leaves;
      const rows = [
        ...Array.from({ length: live }, (_, i) => row(`p${i}`, "PENDING")),
        ...Array.from({ length: leaves }, (_, i) => row(`s${i}`, "SICK_LEAVE")),
        ...Array.from({ length: leaves }, (_, i) => row(`e${i}`, "EXTENDED")),
      ];
      const r = pauseThenResume({ size: 6 }, rows);
      expect({ leaves, ...r }).toEqual({ leaves, cancelled: 6, created: 6, totalRows: 12 + leaves });
    }
  });

  test("delivered sessions are NOT handed back — 2 attended ⇒ only 4 created", () => {
    const rows = [
      row("a1", "ATTENDED"), row("a2", "ATTENDED"),
      row("p1", "PENDING"), row("p2", "PENDING"),
      row("s1", "SICK_LEAVE"), row("s2", "SICK_LEAVE"),
      row("e1", "EXTENDED"), row("e2", "EXTENDED"),
    ];
    expect(pauseThenResume({ size: 6 }, rows)).toEqual({ cancelled: 4, created: 4, totalRows: 12 });
  });

  test("a course with no leaves is unchanged — the path that already worked", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`p${i}`, "PENDING"));
    expect(pauseThenResume({ size: 6 }, rows)).toEqual({ cancelled: 6, created: 6, totalRows: 12 });
  });

  test("pause → resume → pause → resume does not grow the owed count", () => {
    let rows = [
      row("p1", "PENDING"), row("p2", "PENDING"), row("p3", "PENDING"), row("p4", "PENDING"),
      row("s1", "SICK_LEAVE"), row("s2", "SICK_LEAVE"),
      row("e1", "EXTENDED"), row("e2", "EXTENDED"),
    ];
    const cycle = (n: number) => {
      const r = pauseThenResume({ size: 6 }, rows);
      const doomed = new Set(endableSessions(rows).map((x) => x.id));
      rows = [
        ...rows.map((x) => (doomed.has(x.id) ? { ...x, status: "CANCELLED" } : x)),
        ...Array.from({ length: r.created }, (_, i) => row(`n${n}-${i}`, "PENDING")),
      ];
      return r.created;
    };
    // ⚠️ (b) is real and is display-only: the ROW COUNT grows by 6 each cycle. The owed count does not.
    expect([cycle(1), cycle(2)]).toEqual([6, 6]);
    expect(rows).toHaveLength(20);
  });
});

describe("TASK-282 — where the resume DOES over-create, and it is not the counter", () => {
  test("🔴 an OVER-QUOTA leave got no make-up, so the resume creates one row more than it cancelled", () => {
    // `updateBookingStatus`'s leave branch only appends the `EXTENDED` when `canTakeLeave(course)` — otherwise
    // it sets `locked = true` and creates nothing (`scheduler.service.ts:2782`). The plan is then deliberately
    // SHORT, and there is no reconcile on the leave path to close it.
    // ⇒ The pause cancels 5 and the resume regenerates to the plan target of 6. The lock is spent, silently.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(`p${i}`, "PENDING")),
      row("s1", "SICK_LEAVE"),
    ];
    expect(pauseThenResume({ size: 6 }, rows)).toEqual({ cancelled: 5, created: 6, totalRows: 12 });
  });

  test("🔴 …and an IMPORTED course loses one instead — the withheld phantoms are not regenerated", () => {
    // `withholdImportCancels` deliberately leaves an import carrying more rows than `planSize` (TASK-166: the
    // owner decides whether a real child's lesson disappears). The pause cancels all 5 of them; the resume
    // measures against `size − priorSessions = 4`. Nobody chose that.
    const rows = Array.from({ length: 5 }, (_, i) => row(`p${i}`, "PENDING"));
    expect(pauseThenResume({ size: 6, priorSessions: 2 }, rows)).toEqual({
      cancelled: 5,
      created: 4,
      totalRows: 9,
    });
  });
});

describe("TASK-282 §7 — resume is a RE-PLAN. Nothing is restored; the admin gives the schedule.", () => {
  // 🔻 §5's reviving design is WITHDRAWN by the owner: *"ให้ไปเริ่มตามสูตรใหม่ เหมือนวางแผนใหม่ … เอาเหมือนตอนสร้าง
  // คอร์สเลย"*. The defect was never the anchor — it was that ANY anchor is inferred. Nobody infers it now.
  const SVC = code(src("src/services/scheduler.service.ts"));
  const RESUME = SVC.slice(
    SVC.indexOf("export async function resumeCourse("),
    SVC.indexOf("export async function endCourse("),
  );

  test("🔑 a NOVEMBER course resumed in September comes back on the ADMIN'S schedule — asserted on the dates", () => {
    // The DoD's wording is deliberate: *asserted on the dates, not on "not today"*. `courseSessionDates` is
    // the course-CREATION planner, and it is what lays these out — the input changed, not the algorithm.
    expect(courseSessionDates("2026-11-03", 4)).toEqual([
      "2026-11-03",
      "2026-11-10",
      "2026-11-17",
      "2026-11-24",
    ]);
    // …and the course's stored slot follows the answer, so the NEXT reader is not left on the old weekday.
    expect(weekdayOf("2026-11-03")).toBe(2);
    expect(RESUME).toContain("weekday: weekdayOf(input.startDate),");
    expect(RESUME).toContain("startTime: input.startTime,");
    expect(RESUME).toContain("const dates = owed > 0 ? courseSessionDates(input.startDate, owed) : [];");
  });

  test("🔑 the body is REQUIRED — `{}` is refused, and there is only ONE path", () => {
    // 🔴 This IS the DEF-2 fix, not a side effect: `{}` and `{ expiryDate }` were two paths through one
    // function and only one of them was ever trialled.
    expect(v.resumeCourse.safeParse({}).success).toBe(false);
    expect(v.resumeCourse.safeParse({ startDate: "2026-11-03" }).success).toBe(false);
    expect(v.resumeCourse.safeParse({ startTime: "10:00" }).success).toBe(false);
    expect(v.resumeCourse.safeParse({ startDate: "2026-11-03", startTime: "10:00" }).success).toBe(true);
  });

  test("🚫 …and the two fields that are NOT asked for, each for its own reason", () => {
    const parsed = v.resumeCourse.parse({
      startDate: "2026-11-03",
      startTime: "10:00",
      weekday: 5,
      expiryDate: "2027-01-01",
    });
    // `weekday` — derived from the start date, as course creation does; three fields can contradict, two cannot.
    // `expiryDate` — an OUTPUT now (DEF-4), so there is no expiry request left to be wrong.
    expect(parsed).toEqual({ startDate: "2026-11-03", startTime: "10:00" });
  });

  test("🔑 the expiry is DERIVED and always covers the last planned session — the DEF-4 case", () => {
    // A re-plan that runs PAST the old expiry: the expiry follows the course, which is the owner's
    // *"วันหมดอายุก็งอกไปสิ เรื่องปกติ"* and the case a request-checking validator could never catch.
    expect(replanExpiry("2026-10-20", "2026-12-01")).toBe("2026-12-01");
    // 🚫 …and it never SHRINKS: a re-plan finishing early must not take back a window the family already had.
    expect(replanExpiry("2026-12-31", "2026-11-24")).toBe("2026-12-31");
    // Nothing owed ⇒ no last session ⇒ nothing moves.
    expect(replanExpiry("2026-12-31", null)).toBe("2026-12-31");
  });

  test("the response carries the new last session AND the new expiry, for TASK-287 to state", () => {
    // @Porter: the expiry moved BECAUSE the course moved. A number that changed on its own reads as a second
    // admin act, which is the one thing the confirmation must not imply.
    expect(RESUME).toContain("lastSession,");
    expect(RESUME).toContain("expiryDate,");
    expect(RESUME).toContain("expiryExtended: expiryDate !== course.expiryDate,");
    // 🚫 The old warning is gone: it reported that the sessions might fall outside the expiry, and the expiry
    // is now derived FROM them — the condition cannot occur.
    expect(RESUME).not.toContain("expiryWarning");
  });

  test("🚫 `EXPIRY_REQUIRED` is gone from the resume — and the EDIT path never had it", () => {
    // §7.2: do not leave a throw nothing can trigger. Checked across the whole service, not just this body,
    // so a copy surviving elsewhere fails here.
    expect(SVC).not.toContain("EXPIRY_REQUIRED");
    // The edit keeps `expiryImpact` — it is still the warning there, and only the resume's GATE was removed.
    expect(SVC).toContain("const impact = expiryImpact(");
  });

  test("`recordExpiryChange` still fires, in the same transaction, before the writes", () => {
    expect(RESUME).toContain(
      "await recordExpiryChange(tx, { courseId: id, from: course.expiryDate, to: expiryDate, actor });",
    );
    expect(RESUME.indexOf("recordExpiryChange")).toBeLessThan(RESUME.indexOf("insertBooking"));
  });

  test("🚫 the old cancelled rows are UNTOUCHED — nothing revived, nothing re-dated", () => {
    // The whole of the owner's ruling in one assertion: a re-plan lays out new sessions and leaves history
    // alone. An update or a delete against `bookings` in this body would be the design he rejected.
    expect(RESUME).not.toContain("update(bookings)");
    expect(RESUME).not.toContain("tx.delete");
    expect(RESUME).not.toContain("CANCELLED");
  });

  test("a slot clash still refuses with `SLOT_TAKEN`, and the whole resume rolls back", () => {
    expect(RESUME).toContain('if (e?.code === "SLOT_TAKEN")');
    expect(RESUME).toContain("ระบบไม่ย้ายคาบให้เอง");
    // One transaction around everything — a clash on session 4 must not leave three on the calendar.
    expect(RESUME).toContain("db.transaction");
  });

  test("🚫 no new scheduler was invented — `courseSessionDates` is the creation planner", () => {
    expect(RESUME.match(/courseSessionDates\(/g)).toHaveLength(1);
    expect(RESUME).not.toContain("nextWeekdayOnOrAfter");
    expect(RESUME).not.toContain("bangkokNow");
  });
});
