// TASK-632 — the GROUP swap paid the new coach at the OLD coach's rate. Same money defect as TASK-625, on the path TASK-625
// does not touch; found while writing TASK-625's §3 query and cut the same day, because a candidate list handed to the owner
// while the same defect is still writing new rows says "here is what a CLOSED problem cost" when it is an OPEN one.
//
// 🔑 The fix REUSES the rule rather than re-deriving it: `seriesRateOf` + `RATE_REQUIRED`, resolved ONCE before the
//    transaction, nothing moved on the refusal. A second copy of this rule would be the defect it fixes, in the other path's name.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sched from "../services/scheduler.service";
import { db } from "../db";
import { bookings } from "../db/schema";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SCHED = code("src/services/scheduler.service.ts");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const SWAP = region(SCHED, "export async function swapGroupTeacher(", "\n}\n");
const GK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // the outgoing coach, paid 50000 on these rows
const T3 = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // the incoming coach, paid 28000 in this group's past
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const grow = (over: any = {}) => ({
  id: `g-${over.date ?? "x"}`, date: "2026-10-12", startTime: "15:00:00", endTime: "16:00:00", status: "CONFIRMED",
  bookingType: "GROUP", groupKey: GK, teacherId: T1, teacherRateMinor: 50000, otherTitle: "Group A", otherKind: null,
  campWeekDayId: null, additionalTeachers: [], badges: [], seats: [], student: null, coStudent: null, course: null,
  // the DTO the act returns at the end needs a teacher object; it has no bearing on any claim here
  teacher: { id: T1, name: "Bank", nickname: "Bank" }, ...over,
});
/** 🔑 The group's own memory of T3: a PAST date where they were paid 28000. The live dates pay T1 50000. */
const keyRows = () => [
  grow({ id: "g0", date: "2026-10-05", status: "ATTENDED", teacherId: T3, teacherRateMinor: 28000 }),
  grow({ id: "g1", date: "2026-10-12" }),
  grow({ id: "g2", date: "2026-10-19" }),
];
const liveFrom = (rows: any[], date: string) => rows.filter((r) => r.status === "CONFIRMED" && r.date >= date);

/** Drives the REAL `swapGroupTeacher`: `current` + the two findMany reads (targets, then the key for the rate lookup). */
const arm = (all: any[], opts: { anchor?: string } = {}) => {
  const writes: any[] = [];
  const anchor = all.find((r) => r.id === (opts.anchor ?? "g1"));
  const tx: any = {
    query: {
      teacherLeaveDays: { findFirst: async () => undefined },
      teachers: { findFirst: async () => ({ id: T3, nickname: "Ple", name: "Ple", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: "U3" }) },
      bookings: { findFirst: async () => anchor, findMany: async () => [] },
      appSettings: { findMany: async () => [], findFirst: async () => null },
      boItem: { findMany: async () => [] },
    },
    update: (table: any) => ({ set: (patch: any) => ({ where: async (w: any) => { writes.push({ op: "update", table: table === bookings ? "bookings" : "other", patch, where: String(w) }); } }) }),
    insert: () => ({ values: () => Object.assign(Promise.resolve(), { returning: async () => [{ id: "new" }], onConflictDoNothing: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => anchor) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async (args: any) => {
    // the rate lookup asks for the WHOLE key with its extras; the move asks for the live slice
    if (args?.with?.additionalTeachers) return all;
    return liveFrom(all, anchor.date);
  }) as any));
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  return { writes };
};
/** The GROUP-ROW writes. ⚠️ Distinguished from the SEAT writes by the rate, not by the verb: both set `teacherId`, and my
 *  first version counted all four as group rows — the same mistake as a write assertion that does not read the WHERE. */
const groupWrites = (writes: any[]) => writes.filter((w) => w.op === "update" && "teacherRateMinor" in w.patch);
const seatWrites = (writes: any[]) => writes.filter((w) => w.op === "update" && !("teacherRateMinor" in w.patch));

describe("🔴 TASK-632 — the group swap pays the INCOMING coach, on every date it moves", () => {
  test("🔑 by value: the group rows carry T3's OWN rate (28000, from the group's own past) — never T1's 50000 left in place", async () => {
    const { writes } = arm(keyRows());
    const out = await sched.swapGroupTeacher("g1", { teacherId: T3, fromHereOn: true });
    expect(out.moved).toBe(2);
    const rated = groupWrites(writes).filter((w) => "teacherRateMinor" in w.patch);
    expect(rated).toHaveLength(2);
    expect(rated.map((w) => w.patch)).toEqual([{ teacherId: T3, teacherRateMinor: 28000 }, { teacherId: T3, teacherRateMinor: 28000 }]);
    expect(rated.map((w) => w.patch.teacherRateMinor)).not.toContain(50000); // 🔴 the defect's own shape, as an absence
  });

  test("🔴 a swap it cannot rate moves NOTHING — refused before the transaction, not half-way through the dates", async () => {
    const noMemory = [grow({ id: "g1", date: "2026-10-12" }), grow({ id: "g2", date: "2026-10-19" })]; // T3 appears nowhere
    const { writes } = arm(noMemory);
    await expect(sched.swapGroupTeacher("g1", { teacherId: T3, fromHereOn: true })).rejects.toMatchObject({ code: "RATE_REQUIRED", status: 400 });
    expect(writes).toEqual([]);
  });

  test("✅ the from-here-on filter is untouched: the PAST date is neither moved nor re-rated (E14's lesson)", async () => {
    const { writes } = arm(keyRows());
    await sched.swapGroupTeacher("g1", { teacherId: T3, fromHereOn: true });
    expect(writes.filter((w) => String(w.where).includes("g0"))).toEqual([]);
    expect(groupWrites(writes)).toHaveLength(2); // g1 and g2 — never g0
    expect(seatWrites(writes)).toHaveLength(2);  // …and their seats, also only for those two dates
  });

  test("🔴 THE ABSENCE: the SEAT write carries NO rate — a seat's override is a COURSE question (TASK-633), not a side effect of a swap", async () => {
    const { writes } = arm(keyRows());
    await sched.swapGroupTeacher("g1", { teacherId: T3, fromHereOn: true });
    expect(seatWrites(writes)).toHaveLength(2); // one per group date — the seats follow their row
    for (const w of seatWrites(writes)) expect(w.patch).toEqual({ teacherId: T3 });
  });
});

describe("🔑 TASK-632 — the rule is REUSED, and the seat answer is written down rather than assumed", () => {
  test("ONE resolution, before the transaction, and it is TASK-562's own function — no second rate rule on this path", () => {
    expect(SWAP).toContain("const rate = seriesRateOf(keyRows as any, input.teacherId);");
    expect(SWAP).toContain("if (targets.length && rate == null) throw RATE_REQUIRED(targets[0]!.date);");
    expect((SWAP.match(/seriesRateOf\(/g) ?? []).length).toBe(1);
    expect((SWAP.match(/RATE_REQUIRED\(/g) ?? []).length).toBe(1);
    expect(SWAP.indexOf("const rate =")).toBeLessThan(SWAP.indexOf("await db.transaction("));
    // 🔑 the lookup reads the WHOLE key, not the slice being moved — a coach's rate may be recorded on a past date
    expect(SWAP).toContain("where: (b, { and: a, eq: e }) => a(e(b.groupKey, groupKey), e(b.bookingType, \"GROUP\")),");
  });
  test("⚠️ a SEAT does carry a rate that is READ — so the absence above is an answer, not an unread column", () => {
    // by value through the DTO rule: a COURSE_PACKAGE row's override is surfaced; a GROUP row's is not `rate`
    const M = code("src/db/mappers.ts");
    expect(M).toContain("rate: rateFacts(b, b.course ?? null),");
    expect(code("src/lib/coach-rate.ts")).toContain('if (row?.bookingType !== "COURSE_PACKAGE") return null;');
    // …and the seat write in the swap names only the teacher
    expect(SWAP).toContain("await tx.update(bookings).set({ teacherId: input.teacherId }).where(and(eq(bookings.groupId, g.id)");
  });
  test("⚠️ the GAP is written at the door, not discovered later: this path has no `rateMinor` to answer the refusal with", () => {
    const RAW = readSrc(readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8"));
    expect(RAW).toContain("This door has no such field");
    expect(code("src/validation.ts")).toContain("export const groupSeriesSwap = z.object({ to: ID, fromDate: DATE.optional() });");
  });
});
