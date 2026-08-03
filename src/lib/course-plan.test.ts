import { describe, expect, test } from "bun:test";
import {
  COURSE_DELIVERED,
  COURSE_LIVE,
  canInsert,
  courseCurrent,
  exceedsExtensionCeiling,
  isDelivered,
  planCourseMoves,
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

describe("guards for the applier (TASK-093)", () => {
  test("isDelivered — attended/no-show only", () => {
    expect(isDelivered("ATTENDED")).toBe(true);
    expect(isDelivered("NO_SHOW")).toBe(true);
    for (const s of ["PENDING", "CONFIRMED", "EXTENDED", "SICK_LEAVE", "CANCELLED"]) {
      expect(isDelivered(s)).toBe(false);
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
