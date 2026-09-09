// TASK-300 — 🔴 **the gating assertion.** Does a make-up land on a date the family declared absent?
//
// ⚠️ @Sober's instruction: **write this, run it, report the result BEFORE touching code.** The task is
// test-gated because the owner ran the MIRROR of this arrangement (absences in weeks 1–3 with the live session
// at week 4) and it behaved correctly — that ordering cannot produce the defect. **The defect needs the last
// declared absence to FOLLOW the last live week.**
//
// 🔑 What is REAL here and what is reconstructed, stated plainly so the result can be trusted:
// - `firstFreeWeeklySlot` is the actual placement function, called unchanged.
// - `SLOT_INACTIVE_STATUSES` is the actual status list, imported.
// - The two lines of glue — the anchor (`liveAfterCancel.reduce(max, course.startDate)`) and the occupancy
//   predicate — are reconstructed from `reconcileCoursePlan`, because both are inline in a
//   DB-bound function. ⇒ **a source assertion below pins that those two lines still read as reproduced here**,
//   so this cannot quietly stop describing the code it claims to describe.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { firstFreeWeeklySlot } from "./extension-slot";
import { SLOT_INACTIVE_STATUSES } from "../db/schema";
import { addDays } from "./time";
import { readSrc } from "./read-src";

const START = "2026-09-01";
const week = (n: number) => addDays(START, (n - 1) * 7);
const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));

type Row = { date: string; status: string };

/** The owner's arrangement: a 4-session course with weeks 2, 3 and 4 declared absent — week 1 stays LIVE. */
const rows: Row[] = [
  { date: week(1), status: "PENDING" },
  { date: week(2), status: "SICK_LEAVE" },
  { date: week(3), status: "SICK_LEAVE" },
  { date: week(4), status: "SICK_LEAVE" },
];

/**
 * `scheduler.service.ts` — the SAVE's anchor. 🔻 It filtered on `COURSE_LIVE`, which excludes `SICK_LEAVE`, so a
 * declared absence was invisible to it and the search started BEFORE the absent weeks. TASK-300 moved it to
 * the last PLANNED session — every row the course still has, absent or not — which is the preview's anchor.
 */
const saveAnchor = (all: Row[]) =>
  all.filter((r) => r.status !== "CANCELLED").reduce((m, r) => (r.date > m ? r.date : m), START);

/** `scheduler.service.ts:2143` — a slot is occupied only by a booking whose status is not slot-inactive. */
const occupied = (all: Row[], claimed: Set<string>) => (d: string) =>
  claimed.has(d) ||
  all.some((r) => r.date === d && !(SLOT_INACTIVE_STATUSES as readonly string[]).includes(r.status));

/** Place `n` make-ups the way the save does: one at a time, each advancing the anchor. */
async function placeAsSaveDoes(all: Row[], n: number): Promise<string[]> {
  let from = saveAnchor(all);
  const claimed = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = await firstFreeWeeklySlot(from, occupied(all, claimed));
    claimed.add(d);
    out.push(d);
    from = d;
  }
  return out;
}

/** `scheduler.service.ts:2027` — the PREVIEW anchors on the last PLANNED session, absent or not. */
async function placeAsPreviewDoes(all: Row[], n: number): Promise<string[]> {
  let from = all.reduce((m, r) => (r.date > m ? r.date : m), START);
  const claimed = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = await firstFreeWeeklySlot(from, occupied(all, claimed));
    claimed.add(d);
    out.push(d);
    from = d;
  }
  return out;
}

describe("🔑 TASK-300 — the gating assertion, run before any code was touched", () => {
  test("🔴 no make-up lands on a date carrying a declared absence for the SAME course", async () => {
    // ⚠️ The DATES, not the count — a count would pass on the broken build.
    const placed = await placeAsSaveDoes(rows, 3);
    const absentDates = rows.filter((r) => r.status === "SICK_LEAVE").map((r) => r.date);
    expect(placed.filter((d) => absentDates.includes(d))).toEqual([]);
  });

  test("🔑 the preview and the save place them in the SAME weeks", async () => {
    // The assertion the task exists for: today there are two placement rules, and the admin is shown the
    // stricter one while the save applies the other.
    expect(await placeAsSaveDoes(rows, 3)).toEqual(await placeAsPreviewDoes(rows, 3));
  });

  test("the MIRROR arrangement the owner actually ran — absences in weeks 1–3, live week 4", async () => {
    // 🟢 This is the case that behaved correctly and is why the task is gated: the anchor is already past every
    // absence, so both rules agree. It must keep passing whatever the first two do.
    const mirrored: Row[] = [
      { date: week(1), status: "SICK_LEAVE" },
      { date: week(2), status: "SICK_LEAVE" },
      { date: week(3), status: "SICK_LEAVE" },
      { date: week(4), status: "PENDING" },
    ];
    expect(await placeAsSaveDoes(mirrored, 3)).toEqual([week(5), week(6), week(7)]);
    expect(await placeAsSaveDoes(mirrored, 3)).toEqual(await placeAsPreviewDoes(mirrored, 3));
  });

  test("⚠️ the reconstruction still matches the source it claims to reproduce", async () => {
    // Without this, the two glue lines above could drift from the service and this file would keep reporting
    // on code that no longer exists — the failure mode that makes a reconstructed test worse than none.
    const SVC = src("src/services/scheduler.service.ts");
    expect(SVC).toContain('const plannedRows = rows.filter((r: any) => !cancelledSet.has(r.id) && r.status !== "CANCELLED");');
    expect(SVC).toContain("(m: string, r: any) => (r.date > m ? r.date : m),");
    expect(SVC).toContain("notInArray(b.status, [...SLOT_INACTIVE_STATUSES]),");
    expect(SVC).toContain("let fromDate = sessions[sessions.length - 1]?.date ?? input.startDate;");
  });
});

describe("TASK-300 — the two cases the fix must NOT break", () => {
  test("🔑 a leave taken AFTER creation — and the anchors do NOT merely coincide here", () => {
    // ⚠️ Named rather than left implied, because the DoD asks and the honest answer is more than "same result".
    // A post-creation leave on the LAST session had the identical defect: the old anchor fell back to the
    // second-to-last LIVE row, and the last session's own date — now `SICK_LEAVE`, therefore slot-inactive —
    // read as free. ⇒ the make-up landed on the very session that was just marked absent.
    // 🔑 So the planned anchor is not a creation-time special case; it is strictly better on both paths, which
    // is why there is ONE rule and no branch.
    const afterLeave: Row[] = [
      { date: week(1), status: "ATTENDED" },
      { date: week(2), status: "ATTENDED" },
      { date: week(3), status: "PENDING" },
      { date: week(4), status: "SICK_LEAVE" }, // the leave, on the final session
    ];
    return placeAsSaveDoes(afterLeave, 1).then((placed) => {
      expect(placed).toEqual([week(5)]);
      expect(placed).not.toContain(week(4));
    });
  });

  test("🚫 another student may still be booked into the freed slot — `SLOT_INACTIVE_STATUSES` is untouched", () => {
    // §3's ruling depends on this: the bug was never that the slot is free. A student on leave DOES free the
    // teacher's slot for someone ELSE (UC-004). What was wrong is that *this* course reused *its own* absent
    // week. ⇒ `SICK_LEAVE` stays slot-inactive, and a different booking still sees that date as available.
    expect([...SLOT_INACTIVE_STATUSES]).toContain("SICK_LEAVE");
    const someoneElseSees = occupied(rows, new Set())(week(2));
    expect(someoneElseSees).toBe(false);
  });

  test("🚫 the mirroring and TASK-299's ceiling are untouched", () => {
    const SVC = src("src/services/scheduler.service.ts");
    // The make-up still mirrors teacher/subject/time from the absence it replaces…
    expect(SVC).toContain("const template = (a.extendedFromId ? byId.get(a.extendedFromId) : null)");
    // 🔻 TASK-308 — it is no longer BOUNDED at all: §12 deleted the refusal and the expiry stretches to fit.
    // The MIRRORING is what this test is about, and that is unchanged.
    expect(SVC).toContain("if (extDate > expiryAfterAppends) expiryAfterAppends = extDate;");
  });
});
