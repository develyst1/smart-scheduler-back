import { describe, expect, test } from "bun:test";
import {
  COURSE_DELIVERED,
  COURSE_LIVE,
  canInsert,
  courseCurrent,
  deriveLiveEndDate,
  exceedsExtensionCeiling,
  isCoursePlanRow,
  isDelivered,
  planCourseMoves,
  requiresCancelReason,
  type PlanSession,
} from "./course-plan";
import { courseExpiry } from "./recurring";
import { addDays } from "./time";

// Apply a plan to a synthetic session list (the DB applier does this for real). Appended sessions get a
// fresh id + a date strictly after the current max, mirroring findFreeExtensionDate("after the last live").
function apply(sessions: PlanSession[], size: number): PlanSession[] {
  const plan = planCourseMoves(sessions, size);
  let next = [...sessions];
  for (const id of plan.cancelIds) {
    next = next.map((s) => (s.id === id ? { ...s, status: "CANCELLED" } : s));
  }
  let seq = next.length;
  let maxDate = next.reduce((m, s) => (s.date > m ? s.date : m), "0000-00-00");
  for (const a of plan.append) {
    seq++;
    maxDate = bump(maxDate);
    next.push({ id: `ext${seq}`, status: "EXTENDED", date: maxDate, extendedFromId: a.extendedFromId });
  }
  return next;
}
const bump = (d: string) => `${d.slice(0, 8)}${String(Number(d.slice(8)) + 7).padStart(2, "0")}`;
const maxLive = (ss: PlanSession[]) =>
  ss.filter((s) => COURSE_LIVE.has(s.status)).reduce((m, s) => (s.date > m ? s.date : m), "0000-00-00");

const S = (id: string, status: string, date: string, ext: string | null = null): PlanSession => ({
  id,
  status,
  date,
  extendedFromId: ext,
});

describe("planCourseMoves — at target is a no-op (TASK-092)", () => {
  test("a full course with only a date/teacher edit yields zero moves", () => {
    const ss = [S("a", "CONFIRMED", "2026-08-07"), S("b", "CONFIRMED", "2026-08-14")];
    expect(planCourseMoves(ss, 2)).toEqual({ append: [], cancelIds: [] });
  });
});

describe("planCourseMoves — owner's worked example VERBATIM (7·14·21·28)", () => {
  test("plan 4 → leave the 14th (append one at the end) → insert on the 15th (the appended is cancelled) ⇒ still 4 LIVE, ends 28", () => {
    const size = 4;
    let ss = [
      S("s7", "CONFIRMED", "2026-08-07"),
      S("s14", "CONFIRMED", "2026-08-14"),
      S("s21", "CONFIRMED", "2026-08-21"),
      S("s28", "CONFIRMED", "2026-08-28"),
    ];
    expect(courseCurrent(ss)).toBe(4);

    // mark the 14th absent (SICK_LEAVE) → short by one → append 1, linked to that leave
    ss = ss.map((s) => (s.id === "s14" ? { ...s, status: "SICK_LEAVE" } : s));
    const shortPlan = planCourseMoves(ss, size);
    expect(shortPlan.append).toEqual([{ extendedFromId: "s14" }]);
    expect(shortPlan.cancelIds).toEqual([]);
    ss = apply(ss, size); // appends an EXTENDED after the 28th
    expect(courseCurrent(ss)).toBe(4);
    expect(maxLive(ss) > "2026-08-28").toBe(true); // ends after the 28th now

    // admin inserts a make-up on the 15th (hand-placed, LIVE) → long by one
    ss.push(S("ins15", "CONFIRMED", "2026-08-15"));
    const longPlan = planCourseMoves(ss, size);
    expect(longPlan.append).toEqual([]);
    expect(longPlan.cancelIds).toHaveLength(1); // cancels the newest EXTENDED (the appended one)
    const cancelled = ss.find((s) => s.id === longPlan.cancelIds[0])!;
    expect(cancelled.status).toBe("EXTENDED");
    ss = apply(ss, size);

    // ⇒ still 4 LIVE sessions, and the plan ends on the 28th
    expect(courseCurrent(ss)).toBe(4);
    expect(maxLive(ss)).toBe("2026-08-28");
  });
});

describe("planCourseMoves — a round trip never drifts off size", () => {
  test("absence → insert → absence → insert keeps current == size", () => {
    const size = 6;
    let ss: PlanSession[] = Array.from({ length: 6 }, (_, i) =>
      S(`c${i}`, "CONFIRMED", `2026-09-${String(7 + i * 7).padStart(2, "0")}`),
    );
    // start valid
    expect(courseCurrent(ss)).toBe(6);
    for (let cycle = 0; cycle < 2; cycle++) {
      // absence on the 2nd session of the chain (still CONFIRMED)
      const victim = ss.find((s) => s.status === "CONFIRMED")!;
      ss = ss.map((s) => (s.id === victim.id ? { ...s, status: "SICK_LEAVE" } : s));
      ss = apply(ss, size); // append
      expect(courseCurrent(ss)).toBe(6);
      // insert a make-up (hand-placed)
      ss.push(S(`ins${cycle}`, "CONFIRMED", "2026-09-01"));
      ss = apply(ss, size); // cancels the appended
      expect(courseCurrent(ss)).toBe(6);
    }
  });
});

describe("planCourseMoves — contraction touches only appended EXTENDED, never delivered/hand-placed", () => {
  test("cancels the EXTENDED, not the attended nor the hand-placed CONFIRMED", () => {
    const ss = [
      S("done", "ATTENDED", "2026-08-07"),
      S("live1", "CONFIRMED", "2026-08-14"),
      S("hand", "CONFIRMED", "2026-08-15"), // hand-placed insert
      S("ext", "EXTENDED", "2026-09-04", "leaveX"), // appended
    ];
    // current = 4, size 3 → over by 1 → must cancel `ext` only
    const plan = planCourseMoves(ss, 3);
    expect(plan.cancelIds).toEqual(["ext"]);
  });

  test("attended sessions always count toward size (delivered)", () => {
    expect(COURSE_DELIVERED.has("ATTENDED")).toBe(true);
    expect(COURSE_DELIVERED.has("NO_SHOW")).toBe(true); // owner: NO_SHOW consumes the session
    const ss = [S("a", "ATTENDED", "2026-08-07"), S("n", "NO_SHOW", "2026-08-14")];
    expect(courseCurrent(ss)).toBe(2);
    expect(planCourseMoves(ss, 2)).toEqual({ append: [], cancelIds: [] });
  });
});

describe("seam-keeper — a soft-linked SINGLE_SESSION extra never counts (SPEC-033 / TASK-112)", () => {
  // An extra shares the courseId but is bookingType SINGLE_SESSION. The engine (courseCurrent/planCourseMoves/
  // canInsert) must ignore it, so `size`/owed/moves are unchanged and its cancel doesn't re-owe.
  const EXTRA = (id: string, status: string, date: string): PlanSession => ({
    id,
    status,
    date,
    extendedFromId: null,
    bookingType: "SINGLE_SESSION",
  });
  const full = [
    S("c0", "CONFIRMED", "2026-09-07"),
    S("c1", "CONFIRMED", "2026-09-14"),
  ].map((s) => ({ ...s, bookingType: "COURSE_PACKAGE" }));

  test("adding an extra leaves current == size and yields NO moves (6 stays 6 — here 2 stays 2)", () => {
    expect(courseCurrent(full)).toBe(2);
    const withExtra = [...full, EXTRA("x", "CONFIRMED", "2026-09-10")];
    expect(courseCurrent(withExtra)).toBe(2); // the extra doesn't count
    expect(planCourseMoves(withExtra, 2)).toEqual({ append: [], cancelIds: [] }); // no re-plan
  });

  test("cancelling the extra does NOT re-owe — plan stays at size, no append", () => {
    // extra CONFIRMED → CANCELLED. A COURSE_PACKAGE cancel would drop current and append; an extra must not.
    const withExtra = [...full, EXTRA("x", "CANCELLED", "2026-09-10")];
    expect(courseCurrent(withExtra)).toBe(2);
    expect(planCourseMoves(withExtra, 2).append).toHaveLength(0);
  });

  test("the extra never makes a full course look insertable", () => {
    const withExtra = [...full, EXTRA("x", "CONFIRMED", "2026-09-10")];
    expect(canInsert(withExtra, 2)).toBe(false); // full COURSE_PACKAGE + an extra ⇒ still nothing to reschedule
  });

  test("isCoursePlanRow — COURSE_PACKAGE and legacy (absent type) count; SINGLE_SESSION does not", () => {
    expect(isCoursePlanRow({ bookingType: "COURSE_PACKAGE" })).toBe(true);
    expect(isCoursePlanRow({})).toBe(true); // absent ⇒ treated as a plan row (back-compat)
    expect(isCoursePlanRow({ bookingType: "SINGLE_SESSION" })).toBe(false);
    expect(isCoursePlanRow({ bookingType: "VOUCHER" })).toBe(false);
  });

  test("a genuine COURSE_PACKAGE absence still re-owes with the extra present (extra doesn't mask the gap)", () => {
    const shorted = [
      { ...S("c0", "SICK_LEAVE", "2026-09-07"), bookingType: "COURSE_PACKAGE" },
      { ...S("c1", "CONFIRMED", "2026-09-14"), bookingType: "COURSE_PACKAGE" },
      EXTRA("x", "CONFIRMED", "2026-09-10"),
    ];
    expect(courseCurrent(shorted)).toBe(1); // only the CONFIRMED course row counts
    expect(planCourseMoves(shorted, 2).append).toHaveLength(1); // re-owes the leave, extra ignored
  });
});

describe("cancel re-owes a makeup — every course cancel is a reschedule (TASK-105 §11.3)", () => {
  test("a CANCELLED session drops current below size → planCourseMoves appends one makeup", () => {
    // Whatever the session WAS (a live CONFIRMED or a delivered ATTENDED), once cancelled its status is CANCELLED
    // — out of the plan — so the same re-owe fires for both the delivered and non-delivered cancel.
    const size = 4;
    const base = [
      S("s7", "CONFIRMED", "2026-08-07"),
      S("s14", "CONFIRMED", "2026-08-14"),
      S("s21", "CONFIRMED", "2026-08-21"),
      S("s28", "CONFIRMED", "2026-08-28"),
    ];
    // non-delivered cancel: s14 CONFIRMED → CANCELLED
    const afterLiveCancel = base.map((s) => (s.id === "s14" ? { ...s, status: "CANCELLED" } : s));
    expect(courseCurrent(afterLiveCancel)).toBe(3);
    expect(planCourseMoves(afterLiveCancel, size).append).toHaveLength(1);

    // delivered cancel: s7 was ATTENDED, then cancelled-with-reason → CANCELLED
    const afterDeliveredCancel = base.map((s) => (s.id === "s7" ? { ...s, status: "CANCELLED" } : s));
    expect(courseCurrent(afterDeliveredCancel)).toBe(3);
    expect(planCourseMoves(afterDeliveredCancel, size).append).toHaveLength(1);
  });

  test("NO_SHOW still consumes — a session left NO_SHOW keeps current at size (no re-owe, unchanged)", () => {
    const ss = [S("a", "ATTENDED", "2026-08-07"), S("n", "NO_SHOW", "2026-08-14")];
    expect(courseCurrent(ss)).toBe(2);
    expect(planCourseMoves(ss, 2)).toEqual({ append: [], cancelIds: [] });
  });
});

describe("guards for the applier (TASK-093)", () => {
  test("isDelivered — attended/no-show only", () => {
    expect(isDelivered("ATTENDED")).toBe(true);
    expect(isDelivered("NO_SHOW")).toBe(true);
    for (const s of ["PENDING", "CONFIRMED", "EXTENDED", "SICK_LEAVE", "CANCELLED"]) {
      expect(isDelivered(s)).toBe(false);
    }
  });

  test("requiresCancelReason — a delivered cancel needs a reason; a live cancel doesn't (TASK-105)", () => {
    expect(requiresCancelReason("ATTENDED")).toBe(true);
    expect(requiresCancelReason("NO_SHOW")).toBe(true);
    for (const s of ["PENDING", "CONFIRMED", "EXTENDED", "SICK_LEAVE"]) {
      expect(requiresCancelReason(s)).toBe(false);
    }
  });

  test("canInsert — needs an outstanding owed session (short, or an appended EXTENDED to absorb)", () => {
    const full = [S("a", "CONFIRMED", "2026-08-07"), S("b", "CONFIRMED", "2026-08-14")];
    expect(canInsert(full, 2)).toBe(false); // exactly full, nothing to absorb → refuse

    const withExtended = [...full, S("e", "EXTENDED", "2026-09-04", "leaveX")];
    expect(canInsert(withExtended, 2)).toBe(true); // an appended session the reconcile can cancel

    const short = [S("a", "CONFIRMED", "2026-08-07"), S("l", "SICK_LEAVE", "2026-08-14")];
    expect(canInsert(short, 2)).toBe(true); // current 1 < 2 → fills the gap directly
  });

  test("exceedsExtensionCeiling — a size-6 lands exactly on week 8; week 9 is refused", () => {
    const start = "2026-08-01";
    const ceiling = courseExpiry(start, 6); // start + MAX_WEEK(6)=8 weeks
    expect(exceedsExtensionCeiling(ceiling, start, 6)).toBe(false); // week 8 allowed (owner-confirmed)
    expect(exceedsExtensionCeiling(addDays(ceiling, 7), start, 6)).toBe(true); // week 9 refused
  });
});

describe("deriveLiveEndDate — displayed end is derived from LIVE sessions (TASK-097)", () => {
  test("max date over LIVE only — ignores delivered/cancelled/sick", () => {
    const ss = [
      S("a", "ATTENDED", "2026-09-30"), // delivered, later — must NOT count
      S("b", "CONFIRMED", "2026-08-14"),
      S("c", "EXTENDED", "2026-08-28"),
      S("d", "SICK_LEAVE", "2026-09-10"), // not live
      S("e", "CANCELLED", "2026-12-01"), // not live
    ];
    expect(deriveLiveEndDate(ss)).toBe("2026-08-28");
  });
  test("null when nothing is live", () => {
    expect(deriveLiveEndDate([S("a", "ATTENDED", "2026-08-07"), S("b", "CANCELLED", "2026-08-14")])).toBeNull();
    expect(deriveLiveEndDate([])).toBeNull();
  });
});
