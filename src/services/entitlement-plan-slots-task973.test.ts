import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../db";
import { courseSlotsDto } from "../db/mappers";
import { getEntitlementPlan } from "./scheduler.service";

// TASK-973 (D-159-1) — the plan read carries the course's weekly pattern as `summary.slots`, built by the ONE helper `courseSlotsDto`.
// DB-free: `db.query` is stubbed, in the style of entitlement-plan-branch-task916.test.ts.

const COURSE_ID = "11111111-1111-4111-8111-111111111111";
const VOUCHER_ID = "22222222-2222-4222-8222-222222222222";
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const course = (over: Record<string, unknown> = {}) => ({
  id: COURSE_ID, studentId: "s-1", coStudentId: null, size: 10, usedSessions: 0, priorSessions: 0, leaveUsed: 0, expiryDate: "2027-01-01",
  createdAt: new Date("2026-10-01T00:00:00Z"), source: "SALE", endedAt: null, droppedAt: null, ...over,
});
const voucher = () => ({
  id: VOUCHER_ID, studentId: "s-1", totalHours: 10, usedHours: 2, expiryDate: "2027-06-01", createdAt: new Date("2026-10-01T00:00:00Z"), endedAt: null,
});

function world(o: { course?: any; voucher?: any }) {
  spies.push(spyOn(db.query.coursePackages, "findFirst").mockImplementation((async () => o.course ?? undefined) as any));
  spies.push(spyOn(db.query.vouchers, "findFirst").mockImplementation((async () => o.voucher ?? undefined) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
  spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: "s-1", name: "Alpha", nickname: "Pim" })) as any));
}

describe("getEntitlementPlan — summary.slots", () => {
  test("(a) a 2+ slot course: slots in `ord` order, HH:MM, each with its teacherId", async () => {
    world({
      course: course({
        slots: [
          { ord: 1, weekday: 3, startTime: "17:00:00", teacherId: "t-2" },
          { ord: 0, weekday: 1, startTime: "16:30:00", teacherId: "t-1" },
        ],
      }),
    });
    const plan: any = await getEntitlementPlan(COURSE_ID);
    expect(plan.summary.slots).toEqual([
      { weekday: 1, startTime: "16:30", teacherId: "t-1" },
      { weekday: 3, startTime: "17:00", teacherId: "t-2" },
    ]);
  });
  test("(b) a one-slot course (no rows) → slots === null and the key IS present", async () => {
    for (const slots of [undefined, [], [{ ord: 0, weekday: 1, startTime: "16:00:00", teacherId: "t-1" }]]) {
      world({ course: course({ slots }) });
      const plan: any = await getEntitlementPlan(COURSE_ID);
      expect("slots" in plan.summary).toBe(true);
      expect(plan.summary.slots).toBeNull();
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
  test("(c) the voucher plan has no `slots` key", async () => {
    world({ voucher: voucher() });
    const plan: any = await getEntitlementPlan(VOUCHER_ID);
    expect(plan.kind).toBe("voucher");
    expect("slots" in plan.summary).toBe(false);
  });
  test("the plan's slots are the helper's output, byte for byte", async () => {
    const slots = [{ ord: 0, weekday: 2, startTime: "09:00:00", teacherId: "t-1" }, { ord: 1, weekday: 5, startTime: "10:00:00", teacherId: "t-1" }];
    world({ course: course({ slots }) });
    const plan: any = await getEntitlementPlan(COURSE_ID);
    expect(plan.summary.slots).toEqual(courseSlotsDto({ slots }));
  });
});

describe("by source: one builder", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  test("the plan loads `slots` and calls courseSlotsDto; the mapper has ONE copy of the expression", () => {
    const src = read("./scheduler.service.ts");
    const fn = src.slice(src.indexOf("export async function getEntitlementPlan("), src.indexOf("/**\n * ", src.indexOf("export async function getEntitlementPlan(")));
    expect(fn).toContain("with: { coStudent: true, slots: true }");
    expect((fn.match(/slots: courseSlotsDto\(course\)/g) ?? []).length).toBe(1);
    const mappers = read("../db/mappers.ts");
    expect((mappers.match(/\.sort\(\(a: any, b: any\) => a\.ord - b\.ord\)/g) ?? []).length).toBe(1);
    expect(mappers).toContain("slots: courseSlotsDto(c),");
  });
});
