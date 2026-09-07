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
  COURSE_PAUSE_NOTE,
  courseCurrent,
  courseOwedTarget,
  endableSessions,
  resumeAnchor,
  type PlanSession,
} from "./course-plan";
import { nextWeekdayOnOrAfter } from "./recurring";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));

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

describe("TASK-282 §5 — the real defect: a resumed course was RELOCATED into this week", () => {
  // 🔴 @Tanya, API-driven: a NOVEMBER course came back as SEPTEMBER. `resumeCourse` rebuilt from
  // `nextWeekdayOnOrAfter(today, course.weekday)` — which keeps the course's WEEKDAY and throws away its WEEK.
  // The route promises \"bring it back on its own slot\" and did not.
  const paused = (date: string) => ({ status: "CANCELLED", date, note: COURSE_PAUSE_NOTE });

  test("🔑 a NOVEMBER course comes back in NOVEMBER — not on this week's calendar", () => {
    const rows = [paused("2026-11-03"), paused("2026-11-10"), paused("2026-11-17")];
    expect(resumeAnchor(rows, "2026-09-08")).toBe("2026-11-03");
  });

  test("…and the whole regenerated series is November, on the course's own weekday", () => {
    // Tuesday = 2. The anchor is snapped by the caller, so a make-up that landed on another weekday cannot
    // put the series off the course's slot.
    const rows = [paused("2026-11-03"), paused("2026-11-10")];
    const start = nextWeekdayOnOrAfter(resumeAnchor(rows, "2026-09-08"), 2);
    expect(start).toBe("2026-11-03");
  });

  test("🚫 but a resume never schedules into the PAST — an old pause comes back from today", () => {
    // The floor is the half that keeps this from being a plain \"use the old dates\": a course paused in July
    // has no future dates of its own left, and re-creating them would put lessons behind the calendar.
    const rows = [paused("2026-07-05"), paused("2026-07-12")];
    expect(resumeAnchor(rows, "2026-09-08")).toBe("2026-09-08");
  });

  test("a course with no pause-cancelled rows falls back to today — the old behaviour, kept", () => {
    // Nothing to anchor on: a resume with zero owed sessions, or a course whose cancelled rows were an
    // admin's rather than a pause's.
    expect(resumeAnchor([], "2026-09-08")).toBe("2026-09-08");
    expect(resumeAnchor([{ status: "CANCELLED", date: "2026-11-03", note: "ยกเลิกโดยแอดมิน" }], "2026-09-08")).toBe("2026-09-08");
  });

  test("🔑 the service computes the anchor ONCE and both the gate and the loop read it", () => {
    // ⚠️ The expiry gate projects the dates the resume is ABOUT to create. It used to build them from a
    // second, hand-written copy of the same expression — so a fix applied to one and not the other would warn
    // about September while writing November. Asserted as ONE `start`, and no surviving today-anchor.
    const S = src("src/services/scheduler.service.ts");
    expect(S).toContain("const start = nextWeekdayOnOrAfter(resumeAnchor(rows, bangkokNow().date), course.weekday);");
    expect(S).toContain("const projected = owed > 0 ? courseSessionDates(start, owed).map((date) => ({ date })) : [];");
    expect(S).not.toContain("nextWeekdayOnOrAfter(bangkokNow().date, course.weekday)");
    // 🚫 And the pause's marker is the NAMED one, so `resumeAnchor` cannot stop matching it silently.
    expect(S).toContain("note: COURSE_PAUSE_NOTE");
  });
});
