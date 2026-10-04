// TASK-634 (BACK half) — the group-swap door must be able to answer its own refusal.
//
// 🔴 Why this is not a nicety: TASK-632 rates the incoming coach from the group's OWN memory, and @Sober established there is
//    no other source of a coach's rate in this system (`freelance_budgets.rate_minor` is the freelance CEILING's drawdown, and
//    nothing reads it here; there is no teacher-level default). ⇒ a coach NEW to the series could never be priced — **and a
//    coach new to this series is exactly what a cover IS.** TASK-632 alone would trade a silent money defect for a HARD BLOCK.
// 🔑 The refusal is right. A refusal with no answer is not.
// 🔴 And the assertion this file exists for: widening these two doors did NOT widen WHO MAY PRICE A COACH.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sched from "../services/scheduler.service";
import * as series from "../services/other-series.service";
import * as v from "../validation";
import { bodyEditsCoachRate } from "./coach-rate-visibility"; // TASK-584 — the key-59 gate's own predicate
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
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // the outgoing coach, on 50000
const T3 = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // the incoming coach — NEVER paid in this group
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const grow = (over: any = {}) => ({
  id: `g-${over.date ?? "x"}`, date: "2026-10-12", startTime: "15:00:00", endTime: "16:00:00", status: "CONFIRMED",
  bookingType: "GROUP", groupKey: GK, teacherId: T1, teacherRateMinor: 50000, otherTitle: "Group A", otherKind: null,
  campWeekDayId: null, additionalTeachers: [], badges: [], seats: [], student: null, coStudent: null, course: null,
  teacher: { id: T1, name: "Bank", nickname: "Bank" }, ...over,
});
/** 🔑 A group the incoming coach has NEVER taught — the case TASK-632 alone makes impossible. */
const strangerToTheSeries = () => [grow({ id: "g1", date: "2026-10-12" }), grow({ id: "g2", date: "2026-10-19" })];

const arm = (all: any[], anchorId = "g1") => {
  const writes: any[] = [];
  // ⚠️ the anchor is NAMED, not `all[0]`: my first version took the first row of the fixture, which in the remembered-rate
  // case is a PAST date — so the swap moved three rows and the test failed on the harness, not on the code.
  const anchor = all.find((r) => r.id === anchorId)!;
  const tx: any = {
    query: {
      teacherLeaveDays: { findFirst: async () => undefined },
      teachers: { findFirst: async () => ({ id: T3, nickname: "Ple", name: "Ple", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: "U3" }) },
      bookings: { findFirst: async () => anchor, findMany: async () => [] },
      appSettings: { findMany: async () => [], findFirst: async () => null },
      boItem: { findMany: async () => [] },
    },
    update: (table: any) => ({ set: (patch: any) => ({ where: async () => { writes.push({ op: "update", table: table === bookings ? "bookings" : "other", patch }); } }) }),
    insert: () => ({ values: () => Object.assign(Promise.resolve(), { returning: async () => [{ id: "new" }], onConflictDoNothing: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => anchor) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async (args: any) => (args?.with?.additionalTeachers ? all : all.filter((r) => r.date >= anchor.date))) as any));
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  return { writes };
};
const groupWrites = (w: any[]) => w.filter((x) => x.op === "update" && "teacherRateMinor" in x.patch);
const seatWrites = (w: any[]) => w.filter((x) => x.op === "update" && !("teacherRateMinor" in x.patch));

describe("🔴 TASK-634 — the case TASK-632 made impossible, by name", () => {
  test("🔑 a group swap to a coach the series has NEVER paid, WITH a rate supplied, SUCCEEDS and pays that coach", async () => {
    const { writes } = arm(strangerToTheSeries());
    const out = await sched.swapGroupTeacher("g1", { teacherId: T3, fromHereOn: true, rateMinor: 33000 });
    expect(out.moved).toBe(2);
    expect(groupWrites(writes).map((w) => w.patch)).toEqual([
      { teacherId: T3, teacherRateMinor: 33000 },
      { teacherId: T3, teacherRateMinor: 33000 },
    ]);
    expect(groupWrites(writes).map((w) => w.patch.teacherRateMinor)).not.toContain(50000); // never the outgoing coach's
  });
  test("…and WITHOUT one it is still refused, with nothing moved (TASK-632's rule, untouched)", async () => {
    const { writes } = arm(strangerToTheSeries());
    await expect(sched.swapGroupTeacher("g1", { teacherId: T3, fromHereOn: true })).rejects.toMatchObject({ code: "RATE_REQUIRED" });
    expect(writes).toEqual([]);
  });
  test("🔑 the GIVEN rate WINS over the series' memory — it is an answer, not a suggestion", async () => {
    // the group DOES remember T3 at 28000 (a past date) — and the admin says 31000 anyway
    const remembered = [grow({ id: "g0", date: "2026-10-05", status: "ATTENDED", teacherId: T3, teacherRateMinor: 28000 }), ...strangerToTheSeries()];
    const { writes } = arm(remembered);
    await sched.swapGroupTeacher("g1", { teacherId: T3, fromHereOn: true, rateMinor: 31000 });
    expect(groupWrites(writes).map((w) => w.patch.teacherRateMinor)).toEqual([31000, 31000]);
  });
  test("🔴 and the supplied rate STILL does not reach the seats — an admin pricing the GROUP may not answer TASK-633 by accident", async () => {
    const { writes } = arm(strangerToTheSeries());
    await sched.swapGroupTeacher("g1", { teacherId: T3, fromHereOn: true, rateMinor: 33000 });
    expect(seatWrites(writes)).toHaveLength(2);
    for (const w of seatWrites(writes)) expect(w.patch).toEqual({ teacherId: T3 });
  });
  test("✅ the delegating series door passes the rate THROUGH — it does not resolve one of its own", () => {
    const OS = code("src/services/other-series.service.ts");
    expect(OS).toContain("const r = await swapGroupTeacher(anchor.id, { teacherId: input.to, fromHereOn: true, rateMinor: input.rateMinor });");
    expect(region(OS, "export async function swapGroupSeriesTeacher(", "\n}\n")).not.toMatch(/seriesRateOf|RATE_REQUIRED/);
  });
});

describe("🔴 TASK-634 — widening the doors did NOT widen who may price a coach", () => {
  test("🔑 BY VALUE on the gate's own predicate: a swap WITH a rate is privileged, a swap WITHOUT one is not", () => {
    // the gate reads the BODY (TASK-584 / TASK-585: at any depth, by field NAME) — it has no opinion about which door or scope
    expect(bodyEditsCoachRate({ to: T3, fromDate: "2026-10-12", rateMinor: 33000 })).toBe(true);
    expect(bodyEditsCoachRate({ teacherId: T3, fromHereOn: true, rateMinor: 33000 })).toBe(true);
    expect(bodyEditsCoachRate({ to: T3, fromDate: "2026-10-12" })).toBe(false); // ⇒ an ordinary swap still costs no key
    expect(bodyEditsCoachRate({ teacherId: T3, fromHereOn: true })).toBe(false);
    // 🔑 null counts as an edit (clearing IS an edit) — the same answer at both doors, because it is one predicate
    expect(bodyEditsCoachRate({ teacherId: T3, fromHereOn: true, rateMinor: null })).toBe(true);
  });
  test("…and the gate is CALLED at both new doors, before the service", () => {
    const API = code("src/routes/api.ts");
    const door = (path: string) => region(API, `.patch("${path}"`, "})");
    for (const p of ["/group-series/:key/teacher", "/bookings/:id/group-teacher"]) {
      expect(door(p)).toContain('assertMayEditCoachRate(c.req.valid("json"), viewerOf(c));');
      expect(door(p).indexOf("assertMayEditCoachRate")).toBeLessThan(door(p).indexOf("await")); // the guard runs FIRST
    }
  });
  test("⚠️ the CONTRACT CHANGE is named where it happened, on TWO doors — and what did not change is named beside it", () => {
    const RAW = readSrc(readFileSync(resolve(root, "src/validation.ts"), "utf8"));
    expect(RAW).toContain("CONTRACT CHANGE on TWO doors: a body that was a 400 is now accepted");
    expect(RAW).toContain("who may price a coach");
    // ✅ both doors accept the rate now; 🚫 and the rest of each shape is unchanged
    expect(v.groupSeriesSwap.safeParse({ to: T3, fromDate: "2026-10-12", rateMinor: 33000 }).success).toBe(true);
    expect(v.groupTeacherSwap.safeParse({ teacherId: T3, fromHereOn: true, rateMinor: 33000 }).success).toBe(true);
    expect(v.groupSeriesSwap.safeParse({ to: T3 }).success).toBe(true); // `fromDate` was always optional here
    expect(v.groupTeacherSwap.safeParse({ teacherId: T3, rateMinor: 33000 }).success).toBe(false); // `fromHereOn` still required
    expect(v.groupTeacherSwap.safeParse({ teacherId: T3, fromHereOn: true, rateMinor: -1 }).success).toBe(false); // still a non-negative int
    expect(v.groupTeacherSwap.safeParse({ teacherId: T3, fromHereOn: true, rateMinor: 1.5 }).success).toBe(false);
  });
  test("🚫 still ONE resolution site and ONE refusal on this path — the widening added neither", () => {
    expect(SWAP).toContain("const rate = input.rateMinor ?? seriesRateOf(keyRows as any, input.teacherId);");
    expect((SWAP.match(/seriesRateOf\(/g) ?? []).length).toBe(1);
    expect((SWAP.match(/RATE_REQUIRED\(/g) ?? []).length).toBe(1);
    expect(SWAP.indexOf("const rate =")).toBeLessThan(SWAP.indexOf("await db.transaction("));
  });
});
