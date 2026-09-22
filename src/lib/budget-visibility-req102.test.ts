// TASK-426 (`REQ-102`, narrowed to the Freelance ceiling) — ONE key (`action:teachers.budget-view`, the 57th) gates the four
// ceiling-derived figures (`hourlyRate · budgetMinor · remainingMinor · reorderMinor`) at the ONE builder
// (`attachFreelanceBudgets(dtos, viewer)` — the viewer is REQUIRED; null ⇒ masked, fail closed); the booleans (`overLimit ·
// setupIncomplete · limitOverride`) stay because they are the booking rule; a LINKED account is masked regardless of grants
// (the `GET /teachers` leak); the two budget writes need BOTH keys (`RouteAccess.action` may be a list — the guard requires
// every one); the dashboard's near-cap label drops its number without the key (the LINE digest unchanged). No migration
// (49 = 49). 🚫 Nothing else masked.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { BUDGET_FIGURE_FIELDS, BUDGET_VIEW_KEY, canSeeBudget, maskBudget, viewerOf } from "./budget-visibility";
import { ACTION_KEYS, ACTION_REGISTRY, MENU_KEYS } from "./permissions";
import { ROUTE_ACCESS } from "./route-access";
import * as sched from "../services/scheduler.service";
import { getAttention, maskAttentionFigures } from "../services/attention.service";
import * as attentionSvc from "../services/attention.service";
import { DEV_USER } from "../middleware/auth";
import { db } from "../db";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: unknown) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const SCHED = code(src("src/services/scheduler.service.ts"));
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
const setUser = (u: { isSuperAdmin: boolean; grants?: Iterable<string>; teacherId?: string | null }) => {
  (DEV_USER as any).isSuperAdmin = u.isSuperAdmin; (DEV_USER as any).grants = new Set(u.grants ?? []); (DEV_USER as any).teacherId = u.teacherId ?? null;
};
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });
const ALL_BUT_VIEW = [...MENU_KEYS, ...ACTION_KEYS.filter((k) => k !== BUDGET_VIEW_KEY)];
const SUPER = { isSuperAdmin: true, grants: new Set<string>() };
const STAFF = { isSuperAdmin: false, grants: new Set<string>(ALL_BUT_VIEW) };
const STAFF_VIEW = { isSuperAdmin: false, grants: new Set<string>([...ALL_BUT_VIEW, BUDGET_VIEW_KEY]) };
const LINKED_ALL = { isSuperAdmin: true, grants: new Set<string>([...MENU_KEYS, ...ACTION_KEYS]), teacherId: T1 };
const figures = { hourlyRate: 500, budgetMinor: 4000000, remainingMinor: 1500000, reorderMinor: 500000 };
const dto = (): any => ({ id: T1, type: "FREELANCE" as const, ...figures, overLimit: false, setupIncomplete: false, limitOverride: true });

describe("🔑 the key (57) — registered, labelled, granted to nobody by default; the two writes double-gated", () => {
  test("57 keys; `action:teachers.budget-view` with TH/EN labels, area teachers", () => {
    expect(ACTION_KEYS.length).toBe(59); // 🔻 TASK-431: + bookings.coach-rate // 🔻 TASK-428: + calendar.other-cancel-all
    expect(ACTION_REGISTRY.find((a) => a.key === BUDGET_VIEW_KEY)).toMatchObject({ labelTh: "ดูงบ/เพดานค่าจ้างครู", labelEn: "View teachers' freelance budget" });
    expect(BUDGET_VIEW_KEY).toBe("action:teachers.budget-view");
  });
  test("`PUT /teachers/:id/budget` and `POST …/budget/topup` require BOTH keys; every other route keeps one; no GET carries the view key (the mask is at the builder, not the door)", () => {
    for (const r of ["PUT /teachers/:id/budget", "POST /teachers/:id/budget/topup"]) expect(ROUTE_ACCESS[r]!.action).toEqual(["action:teachers.budget", "action:teachers.budget-view"]);
    const lists = Object.entries(ROUTE_ACCESS).filter(([, a]) => Array.isArray(a.action)).map(([k]) => k);
    expect(lists.sort()).toEqual(["POST /teachers/:id/budget/topup", "PUT /teachers/:id/budget"]);
    expect(Object.entries(ROUTE_ACCESS).filter(([k, a]) => k.startsWith("GET ") && a.action)).toEqual([]);
    const G = region(code(src("src/middleware/auth.ts")), "export async function accessGuard(", "\n}\n");
    expect(G).toContain("if (!needed.every((a) => hasAction(user, a))) throw ACTION_FORBIDDEN();");
  });
  test("by value through the ROOT app: `teachers.budget` alone ⇒ 403; both ⇒ the service runs; a super admin passes", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    spies.push(spyOn(sched, "setFreelanceBudget").mockImplementation((async (id: string, input: any, viewer: any) => { calls.push([id, input, viewer]); return { id }; }) as any));
    spies.push(spyOn(sched, "topUpFreelanceBudget").mockImplementation((async (id: string, amount: number, viewer: any) => { calls.push([id, amount, viewer]); return { id }; }) as any));
    setUser(STAFF);
    expect((await json("PUT", `/teachers/${T1}/budget`, { monthlyBudgetMinor: 4000000, rateMinor: 50000 })).status).toBe(403);
    expect((await json("POST", `/teachers/${T1}/budget/topup`, { amountMinor: 100000 })).status).toBe(403);
    expect(calls).toEqual([]);
    setUser(STAFF_VIEW);
    expect((await json("PUT", `/teachers/${T1}/budget`, { monthlyBudgetMinor: 4000000, rateMinor: 50000 })).status).toBe(200);
    expect((await json("POST", `/teachers/${T1}/budget/topup`, { amountMinor: 100000 })).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]![2]).toMatchObject({ isSuperAdmin: false, teacherId: null }); // the viewer travels to the service
    expect(calls[0]![2].grants.has(BUDGET_VIEW_KEY)).toBe(true);
    setUser(SUPER);
    expect((await json("PUT", `/teachers/${T1}/budget`, { monthlyBudgetMinor: 4000000, rateMinor: 50000 })).status).toBe(200);
  });
});

describe("🔴 the ONE mask by VALUE — with · without · a linked account with every key · null (fail closed); the booleans survive; nothing else touched", () => {
  test("`canSeeBudget` / `maskBudget`", () => {
    expect(canSeeBudget(SUPER)).toBe(true);
    expect(canSeeBudget(STAFF)).toBe(false);
    expect(canSeeBudget(STAFF_VIEW)).toBe(true);
    expect(canSeeBudget(LINKED_ALL)).toBe(false); // linked ⇒ never, even a super admin holding every key
    expect(canSeeBudget(null)).toBe(false);
    expect(maskBudget(SUPER, dto())).toEqual(dto());
    expect(maskBudget(STAFF_VIEW, dto())).toEqual(dto());
    for (const v of [STAFF, LINKED_ALL, null]) {
      expect(maskBudget(v, dto())).toEqual({ id: T1, type: "FREELANCE", hourlyRate: null, budgetMinor: null, remainingMinor: null, reorderMinor: null, overLimit: false, setupIncomplete: false, limitOverride: true });
    }
    // the booking rule cannot notice the mask
    expect(maskBudget(STAFF, { ...dto(), overLimit: true, setupIncomplete: true })).toMatchObject({ overLimit: true, setupIncomplete: true, remainingMinor: null });
    // only the four fields, and only when present — a bare DTO shape is untouched
    expect([...BUDGET_FIGURE_FIELDS]).toEqual(["hourlyRate", "budgetMinor", "remainingMinor", "reorderMinor"]);
    expect(maskBudget(STAFF, { id: T1, nickname: "Bank" } as any)).toEqual({ id: T1, nickname: "Bank" });
  });
  test("`viewerOf(c)`: the token's three facts; no user ⇒ null", () => {
    expect(viewerOf({ get: () => ({ isSuperAdmin: false, grants: new Set(["x"]), teacherId: T1, username: "u" }) })).toEqual({ isSuperAdmin: false, grants: new Set(["x"]), teacherId: T1 });
    expect(viewerOf({ get: () => undefined })).toBeNull();
  });
  test("the ONE builder by value (`getTeachers`, fake reads): the figures for a super admin / a keyed staff; nulls for a staff without the key, a linked account, null — the booleans identical in all five", async () => {
    spies.push(spyOn(db.query.teachers, "findMany").mockImplementation((async () => [{ id: T1, name: "Bank", nickname: "Bank", type: "FREELANCE", archived: false, workDays: [1, 2, 3], teacherSubjects: [] }]) as any));
    spies.push(spyOn(db.query.boItem, "findMany").mockImplementation((async () => [{ ownerRef: T1, ceilingQty: 80, remainingQty: 0, unitPriceMinor: 50000, metadata: { reorderQty: 10 } }]) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => null) as any));
    spies.push(spyOn(db.query.appSettings, "findMany").mockImplementation((async () => [{ key: `limit_override:${T1}`, value: true }]) as any));
    const one = async (viewer: any) => (await sched.getTeachers({}, viewer)).groups.flatMap((g: any) => g.teachers ?? g.items ?? g.list ?? [])[0];
    const seen = await one(SUPER);
    expect(seen).toMatchObject({ hourlyRate: 500, budgetMinor: 4000000, remainingMinor: 0, reorderMinor: 500000, overLimit: true, setupIncomplete: false });
    expect(await one(STAFF_VIEW)).toMatchObject({ budgetMinor: 4000000 });
    for (const v of [STAFF, LINKED_ALL, null]) {
      const t = await one(v);
      expect(t).toMatchObject({ hourlyRate: null, budgetMinor: null, remainingMinor: null, reorderMinor: null, overLimit: true, setupIncomplete: false });
    }
  });
  test("🔴 by source: the builder is the ONLY writer of the four fields, takes a REQUIRED viewer, masks every DTO; the three readers thread it; the two bare-DTO returns carry no figures", () => {
    const B = region(SCHED, "async function attachFreelanceBudgets<", "\n}\n");
    expect(B).toContain(">(dtos: T[], viewer: Viewer): Promise<T[]> {");
    expect(B).toContain("maskBudget(viewer, d);");
    for (const f of BUDGET_FIGURE_FIELDS) {
      const writes = SCHED.match(new RegExp(`\\.${f} = `, "g")) ?? [];
      expect({ f, writes: writes.length }).toEqual({ f, writes: 1 }); // once, inside the builder
      expect(B).toContain(`d.${f} = `);
    }
    expect(SCHED).toContain("await attachFreelanceBudgets(teacherDtos, viewer);"); // the calendar
    expect(SCHED).toContain("const dtos = await attachFreelanceBudgets(rows.map(toTeacherDTO), viewer);"); // the list
    expect(SCHED).toContain("const [dto] = await attachFreelanceBudgets([toTeacherDTO(row)], viewer);"); // loadTeacherFull
    expect((SCHED.match(/return loadTeacherFull\((id|teacherId), viewer\);/g) ?? []).length).toBe(6);
    expect((SCHED.match(/attachFreelanceBudgets\(/g) ?? []).length).toBe(3); // the three callers…
    expect((SCHED.match(/attachFreelanceBudgets\([^\n]*, viewer\);/g) ?? []).length).toBe(3); // …each with the viewer
    for (const fn of ["export async function setLimitOverride(", "export async function setTeacherWorkDays("]) {
      expect(region(SCHED, fn, "\n}\n")).not.toMatch(/budgetMinor|remainingMinor|hourlyRate|attachFreelanceBudgets/);
    }
    const API = code(src("src/routes/api.ts"));
    expect((API.match(/viewerOf\(c\)/g) ?? []).length).toBe(20); // 🔻 TASK-441: + the two rate-carrying GROUP-series writers // 🔻 TASK-434: + six more rate-carrying writers // calendar · teachers · create · update · budget · topup · archive · reactivate · attention // 🔻 TASK-431: + the three coach-rate write checks
    expect(API).not.toMatch(/budgetMinor|remainingMinor|hourlyRate/); // no route hand-builds a figure
  });
  test("the leak by value through the ROOT app: `GET /teachers` for a linked token holding all 57 keys ⇒ nulls; an unlinked super admin ⇒ the figures; a staff without the key ⇒ nulls; `GET /calendar` the same", async () => {
    process.env.SKIP_AUTH = "true";
    spies.push(spyOn(db.query.teachers, "findMany").mockImplementation((async () => [{ id: T1, name: "Bank", nickname: "Bank", type: "FREELANCE", archived: false, workDays: [1, 2, 3], teacherSubjects: [] }]) as any));
    spies.push(spyOn(db.query.boItem, "findMany").mockImplementation((async () => [{ ownerRef: T1, ceilingQty: 80, remainingQty: 30, unitPriceMinor: 50000, metadata: {} }]) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => null) as any));
    spies.push(spyOn(db.query.appSettings, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(db.query.campWeeks, "findMany").mockImplementation((async () => []) as any));
    const teacherOf = (body: any) => body.groups.flatMap((g: any) => Object.values(g).find(Array.isArray) ?? [])[0];
    setUser(LINKED_ALL);
    let r = await json("GET", "/teachers");
    expect(r.status).toBe(200);
    expect(teacherOf(await r.json())).toMatchObject({ hourlyRate: null, budgetMinor: null, remainingMinor: null, reorderMinor: null, overLimit: false });
    r = await json("GET", "/calendar?date=2026-10-05&view=day");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).days[0].columns[0].teacher).toMatchObject({ budgetMinor: null, remainingMinor: null, overLimit: false });
    setUser(SUPER);
    expect(teacherOf(await (await json("GET", "/teachers")).json())).toMatchObject({ hourlyRate: 500, budgetMinor: 4000000, remainingMinor: 1500000 });
    expect(((await (await json("GET", "/calendar?date=2026-10-05&view=day")).json()) as any).days[0].columns[0].teacher).toMatchObject({ budgetMinor: 4000000 });
    setUser(STAFF);
    expect(teacherOf(await (await json("GET", "/teachers")).json())).toMatchObject({ hourlyRate: null, budgetMinor: null });
    setUser(STAFF_VIEW);
    expect(teacherOf(await (await json("GET", "/teachers")).json())).toMatchObject({ budgetMinor: 4000000 });
  });
});

describe("🔴 the attention line — the dashboard drops the number without the key; the digest unchanged; 🚫 nothing else masked; no migration", () => {
  test("`maskAttentionFigures` by value: `figureless` swapped in without the key, stripped either way; other checks untouched", () => {
    const checks: any[] = [
      { key: "freelance_near_cap", titleKey: "att_freelance_near_cap", count: 1, items: [{ id: T1, label: "Bank · เหลือ 3 ชม.", figureless: "Bank · ใกล้เต็มเพดาน" }] },
      { key: "incomplete_students", titleKey: "x", count: 1, items: [{ id: "s", label: "Ploy" }] },
    ];
    expect(maskAttentionFigures(STAFF, checks) as any[]).toEqual([
      { key: "freelance_near_cap", titleKey: "att_freelance_near_cap", count: 1, items: [{ id: T1, label: "Bank · ใกล้เต็มเพดาน" }] },
      { key: "incomplete_students", titleKey: "x", count: 1, items: [{ id: "s", label: "Ploy" }] },
    ]);
    expect(maskAttentionFigures(SUPER, checks)[0]!.items).toEqual([{ id: T1, label: "Bank · เหลือ 3 ชม." }]);
    expect(maskAttentionFigures(null, checks)[0]!.items[0]!.label).toBe("Bank · ใกล้เต็มเพดาน");
  });
  test("`getAttention(viewer)` applies it; the check emits both labels; the digest job never calls the mask (source)", async () => {
    spies.push(spyOn(attentionSvc, "runAttentionChecks").mockImplementation((async () => ({ checks: [{ key: "freelance_near_cap", titleKey: "t", count: 1, items: [{ id: T1, label: "Bank · เหลือ 3 ชม.", figureless: "Bank · ใกล้เต็มเพดาน" }] }] })) as any));
    spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) })) as any));
    const A = code(src("src/lib/attention.ts"));
    expect(A).toContain("label: `${f.nickname} · เหลือ ${f.remainingQty} ชม.`, figureless: `${f.nickname} · ใกล้เต็มเพดาน`");
    const S = code(src("src/services/attention.service.ts"));
    expect(region(S, "export async function getAttention(", "\n}\n")).toContain("checks: maskAttentionFigures(viewer, checks)");
    expect((S.match(/maskAttentionFigures\(/g) ?? []).length).toBe(2); // the definition + getAttention; the digest path never
    expect(code(src("src/routes/api.ts"))).toContain("attention.getAttention(viewerOf(c))");
  });
  test("🚫 nothing else masked: the mask file names only the four fields; `rate{}`, `other.teacherRates`, `classRateMinor`, sale-items, reports untouched (by absence)", () => {
    const M = code(src("src/lib/budget-visibility.ts"));
    expect(M).not.toMatch(/classRateMinor|teacherRates|priceMinor|listPrice|recordSale|rate:/);
    expect(M).toContain('export const BUDGET_FIGURE_FIELDS = ["hourlyRate", "budgetMinor", "remainingMinor", "reorderMinor"] as const;');
    for (const f of ["src/db/mappers.ts", "src/lib/coach-rate.ts", "src/lib/sale-items.ts", "src/services/som-report.service.ts"]) expect(code(src(f))).not.toMatch(/maskBudget|budget-visibility/);
    expect(readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).length).toBe(53);
  });
});
