import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../db";
import { getEntitlementPlan } from "./scheduler.service";

// TASK-916 — `getEntitlementPlan` returns `summary.branch` (BRAVO | OTHER) on BOTH plan kinds, read from the course / voucher row (F1, TASK-889).
// DB-free: `db.query` is stubbed. Nothing else in the plan moves (a by-value pin on the course summary's other keys and the voucher summary's).

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
const voucher = (over: Record<string, unknown> = {}) => ({
  id: VOUCHER_ID, studentId: "s-1", totalHours: 10, usedHours: 2, expiryDate: "2027-06-01", createdAt: new Date("2026-10-01T00:00:00Z"), endedAt: null, ...over,
});

function world(o: { course?: any; voucher?: any }) {
  spies.push(spyOn(db.query.coursePackages, "findFirst").mockImplementation((async () => o.course ?? undefined) as any));
  spies.push(spyOn(db.query.vouchers, "findFirst").mockImplementation((async () => o.voucher ?? undefined) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
  spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: "s-1", name: "Alpha", nickname: "Pim" })) as any));
}

describe("getEntitlementPlan — summary.branch on a COURSE plan", () => {
  test.each(["BRAVO", "OTHER"] as const)("a %s course reads %s on plan.summary.branch", async (branch) => {
    world({ course: course({ branch }) });
    const plan: any = await getEntitlementPlan(COURSE_ID);
    expect(plan.kind).toBe("course");
    expect(plan.summary.branch).toBe(branch);
  });
  test("a course row with no branch (or junk) reads BRAVO, the column's default — never undefined", async () => {
    for (const branch of [undefined, null, "", "MOON"]) {
      world({ course: course({ branch }) });
      expect(((await getEntitlementPlan(COURSE_ID)) as any).summary.branch).toBe("BRAVO");
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
  test("🔑 nothing else in the course plan moved: the summary still carries the owed count, kind and the course's own fields", async () => {
    world({ course: course({ branch: "OTHER" }) });
    const plan: any = await getEntitlementPlan(COURSE_ID);
    expect(plan.summary).toMatchObject({ kind: "course", size: 10, branch: "OTHER" });
    expect(typeof plan.summary.owedCount).toBe("number");
    expect("branch" in plan).toBe(false); // the field is on the SUMMARY only, not on the plan itself
  });
});

describe("getEntitlementPlan — summary.branch on a VOUCHER plan", () => {
  test.each(["BRAVO", "OTHER"] as const)("a %s voucher reads %s on plan.summary.branch", async (branch) => {
    world({ voucher: voucher({ branch }) });
    const plan: any = await getEntitlementPlan(VOUCHER_ID);
    expect(plan.kind).toBe("voucher");
    expect(plan.summary.branch).toBe(branch);
  });
  test("a voucher row with no branch reads BRAVO", async () => {
    world({ voucher: voucher() });
    expect(((await getEntitlementPlan(VOUCHER_ID)) as any).summary.branch).toBe("BRAVO");
  });
  test("🔑 the voucher summary's other keys are exactly as before, plus branch", async () => {
    world({ voucher: voucher({ branch: "OTHER" }) });
    const s = ((await getEntitlementPlan(VOUCHER_ID)) as any).summary;
    expect(Object.keys(s).sort()).toEqual(["branch", "expiryDate", "hoursAvailable", "hoursRemaining", "hoursReserved", "kind", "totalHours", "usedHours"]);
    expect([s.totalHours, s.usedHours, s.hoursRemaining, s.branch]).toEqual([10, 2, 8, "OTHER"]);
  });
});

describe("the two lines, by source", () => {
  const src = readFileSync(new URL("./scheduler.service.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const fn = src.slice(src.indexOf("export async function getEntitlementPlan("), src.indexOf("/**\n * ", src.indexOf("export async function getEntitlementPlan(")));
  test("exactly one `branch: branchOf(` for the course and one for the voucher, each from its own row", () => {
    expect((fn.match(/branch: branchOf\(/g) ?? []).length).toBe(2);
    expect(fn).toContain("branch: branchOf(course.branch)");
    expect(fn).toContain("branch: branchOf(voucher.branch)");
  });
});
