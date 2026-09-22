// TASK-401 (`REQ-095` Stage 3a, SPEC-082) — the Balance CAMP: migration `0042_camp` (three tables, NO expiry by
// structure, the unique index as witness, the `students` lock named), the pure unit/credit/transition rules by value,
// the ONE redeem writer's refusals naming the date, the day cut INSIDE the day-end tx, the sale in the voucher's shape,
// the four sale items, the RBAC keys (13 menus / 54 acts), the nine routes through the ROOT app. 53 = 53.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import {
  CAMP_DAY_STATUSES, CAMP_HALVES, CAMP_KINDS, CAMP_PLANS, CAMP_WEEK_STATUSES, FULL_WEEK_DAYS, MAX_DAILY_DAYS, MAX_WEEK_DAYS,
  assertDayTransition, consumes, creditOf, datesOfWeek, packageUnits, saleQuantity, unitsDelta, unitsPerDay, unitsPerKind,
} from "./camp";
import { CAMP_CARD, SALE_ITEMS, campItemRef, campPriceList, listPriceMinor } from "./sale-items";
import { ACTION_REGISTRY, MENU_KEYS } from "./permissions";
import { ROUTE_ACCESS } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import * as v from "../validation";
import * as camp from "../services/camp.service";
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
const SVC = code(src("src/services/camp.service.ts"));
const S1 = "11111111-1111-4111-8111-111111111111", W1 = "22222222-2222-4222-8222-222222222222", P1 = "33333333-3333-4333-8333-333333333333";
const err = (status: number, codeName: string, message: string) => new ApiException(status, codeName, message);

afterAll(() => { delete process.env.SKIP_AUTH; });

describe("🔴 the migration — 0042, counted, witnessed by the UNIQUE index, no expiry BY STRUCTURE, the `students` lock named (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const sql = readFileSync(resolve(root, "drizzle/0042_camp.sql"), "utf8");
  test("53 = 53: `0042_camp` is the 43rd file, idx 42 (TASK-403 added 0043 after it); the order 0038 → 0042 named in the header", () => {
    expect(files.length).toBe(53);
    expect(journal.entries.length).toBe(53);
    expect(files[42]).toBe("0042_camp.sql");
    expect(journal.entries[42]).toMatchObject({ idx: 42, tag: "0042_camp" });
    expect(sql).toContain("`0038` → `0039` → `0040` → `0041` → THIS");
    expect(sql).toContain("`db:verify` expects 43");
  });
  test("three tables, four indexes, the unique (package, date) index LAST = the witness; no enum, no `bookings`, no hot lock", () => {
    const stmts = sql.split("\n").filter((l) => !l.startsWith("--") && l.trim()).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
    expect(stmts.length).toBe(7);
    expect(stmts.filter((s) => s.startsWith("CREATE TABLE IF NOT EXISTS")).map((s) => s.match(/"(\w+)"/)![1])).toEqual(["camp_weeks", "camp_packages", "camp_days"]);
    expect(stmts.at(-1)).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "camp_days_package_date_uq" ON "camp_days" ("camp_package_id", "date")');
    expect(stmts.join(";")).not.toMatch(/CREATE TYPE|ALTER TYPE|'GROUP'/); // the statements, not the header's TRAP-1 sentence
    expect(sql).not.toContain('"bookings"');
    expect(sql).toContain("SHARE ROW EXCLUSIVE on `students`");
    expect(sql).toContain("No lock on any hot table");
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0042_camp");
    expect(w).toMatchObject({ tag: "0042_camp", probe: { kind: "index", index: "camp_days_package_date_uq" }, rerunnable: true });
    expect(w!.why).toContain("the LAST object");
  });
  test("🚫 NO expiry column on `camp_packages` — by absence in the SQL and in the schema (the owner's 'no expiry' is structural)", () => {
    const pkg = region(sql, 'CREATE TABLE IF NOT EXISTS "camp_packages"', ");");
    expect(pkg).not.toMatch(/expir|valid_until|end_date/i);
    expect(pkg).toMatch(/"total_units"\s+integer NOT NULL/);
    expect(pkg).toMatch(/"used_units"\s+integer NOT NULL DEFAULT 0/);
    for (const col of ["discount_kind", "discount_value", "discount_reason", "discount_actor"]) expect(pkg).toContain(`"${col}"`);
    const schema = region(code(src("src/db/schema.ts")), "export const campPackages = pgTable(", "export const campDays = pgTable(");
    expect(schema).not.toMatch(/expir/i);
    expect(schema).toContain("totalUnits");
    expect(schema).toContain("usedUnits");
    const days = region(sql, 'CREATE TABLE IF NOT EXISTS "camp_days"', ");");
    expect(days).toMatch(/"status"\s+text NOT NULL DEFAULT 'PLANNED'/);
    expect(days).toMatch(/"units"\s+integer NOT NULL/);
  });
});

describe("🔴 the pure rules by value — one currency (half-day units), the week is FIVE, the credit formula, the transitions", () => {
  test("the code lists (never enums) and the constants Sober confirmed", () => {
    expect(CAMP_KINDS).toEqual(["FULL", "HALF"]);
    expect(CAMP_PLANS).toEqual(["FULL_WEEK", "DAILY"]);
    expect(CAMP_HALVES).toEqual(["AM", "PM", "FULL"]);
    expect(CAMP_DAY_STATUSES).toEqual(["PLANNED", "ATTENDED", "ABSENT", "CANCELLED"]);
    expect(CAMP_WEEK_STATUSES).toEqual(["OPEN", "CLOSED"]);
    expect([FULL_WEEK_DAYS, MAX_WEEK_DAYS, MAX_DAILY_DAYS]).toEqual([5, 7, 30]);
  });
  test("units: a full day 2, a half 1; a FULL week = 10 units, a HALF week = 5; DAILY = days × kind (1..30 else 400)", () => {
    expect(unitsPerDay("FULL")).toBe(2); expect(unitsPerDay("AM")).toBe(1); expect(unitsPerDay("PM")).toBe(1);
    expect(unitsPerKind("FULL")).toBe(2); expect(unitsPerKind("HALF")).toBe(1);
    expect(packageUnits("FULL", "FULL_WEEK")).toBe(10);
    expect(packageUnits("HALF", "FULL_WEEK")).toBe(5);
    expect(packageUnits("FULL", "FULL_WEEK", 99)).toBe(10); // days ignored on a week
    expect(packageUnits("FULL", "DAILY", 3)).toBe(6);
    expect(packageUnits("HALF", "DAILY", 30)).toBe(30);
    for (const bad of [undefined, 0, -1, 31, 1.5]) {
      expect(() => packageUnits("HALF", "DAILY", bad as any)).toThrow(ApiException);
      try { packageUnits("HALF", "DAILY", bad as any); } catch (e: any) { expect(e.status).toBe(400); }
    }
    expect(saleQuantity("FULL_WEEK", 4)).toBe(1);
    expect(saleQuantity("DAILY", 4)).toBe(4);
  });
  test("credit = total − used − planned: a FULL package spends ONE unit on a half day (9 left of 10), PLANNED rows reserve", () => {
    const p = { totalUnits: 10, usedUnits: 0 };
    expect(creditOf(p, 0)).toBe(10);
    expect(creditOf({ ...p, usedUnits: unitsPerDay("AM") }, 0)).toBe(9);
    expect(creditOf({ totalUnits: 10, usedUnits: 4 }, 4)).toBe(2);
    expect(creditOf({ totalUnits: 5, usedUnits: 5 }, 0)).toBe(0);
  });
  test("two statuses, ONE effect: ATTENDED and ABSENT both consume; PLANNED and CANCELLED do not; the delta by value", () => {
    expect(consumes("ATTENDED")).toBe(true); expect(consumes("ABSENT")).toBe(true);
    expect(consumes("PLANNED")).toBe(false); expect(consumes("CANCELLED")).toBe(false);
    expect(unitsDelta("PLANNED", "ATTENDED", 2)).toBe(2);
    expect(unitsDelta("PLANNED", "ABSENT", 1)).toBe(1);
    expect(unitsDelta("PLANNED", "CANCELLED", 2)).toBe(0);
    expect(unitsDelta("ATTENDED", "ABSENT", 2)).toBe(0); // the same-day correction moves nothing
    expect(unitsDelta("ABSENT", "ATTENDED", 2)).toBe(0);
  });
  test("transitions: PLANNED → the three; ATTENDED ↔ ABSENT; the 3b undo to PLANNED (TASK-403); CANCELLED only BEFORE the day; everything else 409", () => {
    const today = "2026-10-05";
    expect(() => assertDayTransition("PLANNED", "ATTENDED", "2026-10-05", today)).not.toThrow();
    expect(() => assertDayTransition("PLANNED", "ABSENT", "2026-10-05", today)).not.toThrow();
    expect(() => assertDayTransition("PLANNED", "CANCELLED", "2026-10-06", today)).not.toThrow();
    expect(() => assertDayTransition("ATTENDED", "ABSENT", "2026-10-05", today)).not.toThrow();
    expect(() => assertDayTransition("ABSENT", "ATTENDED", "2026-10-05", today)).not.toThrow();
    const thrown = (from: string, to: any, date = "2026-10-06") => { try { assertDayTransition(from, to, date, today); return null; } catch (e: any) { return { status: e.status, code: e.code, message: e.message }; } };
    expect(thrown("PLANNED", "CANCELLED", "2026-10-05")).toEqual({ status: 409, code: "CAMP_DAY_STARTED", message: "วันแคมป์เริ่มแล้ว — บันทึกขาดแทน" });
    expect(thrown("PLANNED", "CANCELLED", "2026-10-01")).toMatchObject({ code: "CAMP_DAY_STARTED" });
    expect(thrown("ATTENDED", "CANCELLED")).toMatchObject({ status: 409, code: "CAMP_DAY_TRANSITION" });
    expect(thrown("ABSENT", "CANCELLED")).toMatchObject({ code: "CAMP_DAY_TRANSITION" });
    expect(thrown("CANCELLED", "ATTENDED")).toMatchObject({ code: "CAMP_DAY_TRANSITION" });
    // 🔻 TASK-403 (3b): the UNDO — ATTENDED | ABSENT → PLANNED — is now a transition (its reason is the boundary's); CANCELLED stays final
    expect(() => assertDayTransition("ATTENDED", "PLANNED", "2026-10-05", today)).not.toThrow();
    expect(() => assertDayTransition("ABSENT", "PLANNED", "2026-10-01", today)).not.toThrow();
    expect(thrown("CANCELLED", "PLANNED")).toMatchObject({ code: "CAMP_DAY_TRANSITION" });
    expect(thrown("PLANNED", "PLANNED")).toMatchObject({ code: "CAMP_DAY_TRANSITION" });
  });
  test("datesOfWeek: inclusive, consecutive, capped", () => {
    expect(datesOfWeek("2026-10-05", "2026-10-09")).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(datesOfWeek("2026-10-05", "2026-10-05")).toEqual(["2026-10-05"]);
    expect(datesOfWeek("2026-10-31", "2026-11-01")).toEqual(["2026-10-31", "2026-11-01"]);
    expect(datesOfWeek("2026-10-05", "2026-10-04")).toEqual([]);
  });
});

describe("🔴 the catalogue — four camp items from ONE card, VAT-incl., `revenueKind: CAMP`; the shapes", () => {
  test("11,500 · 5,900 · 2,600 · 1,300 by value; `campItemRef` maps kind × plan; the price list carries units", () => {
    expect(listPriceMinor("camp-full-week")).toBe(1150000);
    expect(listPriceMinor("camp-half-week")).toBe(590000);
    expect(listPriceMinor("camp-full-day")).toBe(260000);
    expect(listPriceMinor("camp-half-day")).toBe(130000);
    expect(campItemRef("FULL", "FULL_WEEK")).toBe("camp-full-week");
    expect(campItemRef("HALF", "FULL_WEEK")).toBe("camp-half-week");
    expect(campItemRef("FULL", "DAILY")).toBe("camp-full-day");
    expect(campItemRef("HALF", "DAILY")).toBe("camp-half-day");
    expect(Object.keys(CAMP_CARD).sort()).toEqual(["camp-full-day", "camp-full-week", "camp-half-day", "camp-half-week"]);
    const camps = SALE_ITEMS.filter((i) => i.externalRef.startsWith("camp-"));
    expect(camps.length).toBe(4);
    for (const i of camps) expect((i.metadata as any).revenueKind).toBe("CAMP");
    expect(campPriceList().map((p) => p.externalRef).sort()).toEqual(["camp-full-day", "camp-full-week", "camp-half-day", "camp-half-week"]);
    const full = campPriceList().find((p) => p.externalRef === "camp-full-week") as any;
    expect(full).toMatchObject({ kind: "FULL", plan: "FULL_WEEK", priceMinor: 1150000 });
  });
  test("validation: a DAILY plan carries `days`, a FULL_WEEK never; 1–7 unique dates on a redeem; PLANNED is not a mark", () => {
    expect(v.createCampPackage.safeParse({ studentId: S1, kind: "FULL", plan: "FULL_WEEK" }).success).toBe(true);
    expect(v.createCampPackage.safeParse({ studentId: S1, kind: "FULL", plan: "FULL_WEEK", days: 3 }).success).toBe(false);
    expect(v.createCampPackage.safeParse({ studentId: S1, kind: "HALF", plan: "DAILY", days: 3 }).success).toBe(true);
    expect(v.createCampPackage.safeParse({ studentId: S1, kind: "HALF", plan: "DAILY" }).success).toBe(false);
    expect(v.createCampPackage.safeParse({ studentId: S1, kind: "HALF", plan: "DAILY", days: 31 }).success).toBe(false);
    expect(v.redeemCampDays.safeParse({ weekId: W1, dates: ["2026-10-05"], half: "AM" }).success).toBe(true);
    expect(v.redeemCampDays.safeParse({ weekId: W1, dates: ["2026-10-05", "2026-10-05"], half: "AM" }).success).toBe(false);
    expect(v.redeemCampDays.safeParse({ weekId: W1, dates: [], half: "AM" }).success).toBe(false);
    expect(v.redeemCampDays.safeParse({ weekId: W1, dates: Array.from({ length: 8 }, (_, i) => `2026-10-0${i + 1}`), half: "FULL" }).success).toBe(false);
    expect(v.markCampDay.safeParse({ status: "PLANNED" }).success).toBe(false);
    expect(v.markCampDay.safeParse({ status: "ABSENT" }).success).toBe(true);
    expect(v.createCampWeek.safeParse({ name: "Camp A", startDate: "2026-10-09", endDate: "2026-10-05" }).success).toBe(false);
    expect(v.createCampWeek.safeParse({ name: "Camp A", startDate: "2026-10-05", endDate: "2026-10-09", capacity: 0 }).success).toBe(false);
    expect(v.updateCampWeek.safeParse({}).success).toBe(false);
  });
});

describe("🔴 the service (source) — ONE redeem writer, the 409s name the date, the sale in the VOUCHER's shape, the cut inside the tx", () => {
  test("`planDays` is the only inserter of camp_days; its refusals in order: 404 → CLOSED → outside → FULL → NO_CREDIT → TAKEN (23505)", () => {
    expect((SVC.match(/tx\.insert\(campDays\)/g) ?? []).length).toBe(1);
    const F = region(SVC, "export async function planDays(", "export async function redeemDays(");
    expect(F).toContain('throw notFound("ไม่พบแพ็กเกจแคมป์")');
    expect(F).toContain('throw notFound("ไม่พบสัปดาห์แคมป์")');
    expect(F).toContain('if (w.status !== "OPEN") throw conflict("CAMP_WEEK_CLOSED", `สัปดาห์ ${w.name} ปิดรับแล้ว`);');
    expect(F).toContain("if (!weekDates.has(date)) throw badRequest(`วันที่ ${date} ไม่อยู่ในสัปดาห์ ${w.name}`);");
    expect(F).toContain('if (taken >= w.capacity) throw conflict("CAMP_FULL", `วันที่ ${date} เต็ม (${taken}/${w.capacity})`);');
    expect(F).toContain('if (units > credit) throw conflict("CAMP_NO_CREDIT", `วันที่ ${date} เครดิตไม่พอ (เหลือ ${credit} หน่วย)`);');
    expect(F).toContain('if (String(e?.code ?? e?.cause?.code) === "23505") throw conflict("CAMP_DAY_TAKEN", `วันที่ ${date} มีวันแคมป์อยู่แล้ว`);');
    expect(F).toContain("let credit = creditOf(p, Number(plannedRow?.n ?? 0));");
    expect(F).toContain("credit -= units;");
    for (const k of ["CAMP_WEEK_CLOSED", "CAMP_FULL", "CAMP_NO_CREDIT", "CAMP_DAY_TAKEN"]) expect(F.indexOf(k)).toBeGreaterThan(-1);
    expect(F.indexOf("CAMP_WEEK_CLOSED")).toBeLessThan(F.indexOf("CAMP_FULL"));
    expect(F.indexOf("CAMP_FULL")).toBeLessThan(F.indexOf("CAMP_NO_CREDIT"));
    expect(F.indexOf("CAMP_NO_CREDIT")).toBeLessThan(F.indexOf("CAMP_DAY_TAKEN"));
    // both entries go through the ONE writer, both behind the two guards
    const R = region(SVC, "export async function redeemDays(", "export async function markDay(");
    expect(R).toContain("await assertStudentActive(tx, p.studentId);");
    expect(R).toContain("await assertHouseholdNotSuspended(tx, p.studentId);");
    expect(R).toContain("planDays(tx, packageId, input, actor)");
    expect((SVC.match(/planDays\(tx, /g) ?? []).length).toBe(2); // the sale's firstWeek + the redeem
  });
  test("the sale: discount validated against the line total BEFORE the write, the rows in the tx, `recordSale` ONCE after it on an idempotency key; no expiry written", () => {
    const C = region(SVC, "export async function createPackage(", "export async function planDays(");
    expect(C).toContain("const discount = validateSaleDiscount(input.discount, (listPriceMinor(ref) ?? CAMP_CARD[ref].priceMinor) * qty, input.actor ?? null);");
    expect(C).toContain("await assertStudentActive(tx, input.studentId);");
    expect(C).toContain("await assertHouseholdNotSuspended(tx, input.studentId);");
    expect(C).toContain("void recordSale(ref, qty, { refId: result.id, idempotencyKey: `camp-sale:${result.id}`, discount: discount ?? undefined })");
    expect(C.indexOf("validateSaleDiscount")).toBeLessThan(C.indexOf("db.transaction"));
    expect(C.indexOf("void recordSale")).toBeGreaterThan(C.lastIndexOf("planDays(tx,"));
    expect((SVC.match(/recordSale\(/g) ?? []).length).toBe(1);
    expect(C).not.toMatch(/expir/i);
    // 🔻 TASK-403: the camp DAY's check-in token has an expiry (the session QR's pattern) — the PACKAGE still has none
    expect(SVC.replace(/checkinTokenExpiresAt|campTokenExpiry|expiresAt/g, "")).not.toMatch(/expir/i);
    expect(code(src("src/routes/camp.ts"))).toContain('assertMayDiscount(body.discount, c.get("user"));');
  });
  test("`markDay` = the transition rule + the delta on the package; `cutCampDays` runs INSIDE the day-end tx by START (date <= runDate) and reports its count", () => {
    const M = region(SVC, "export async function markDay(", "export async function cutCampDays(");
    expect(M).toContain("assertDayTransition(d.status, status, d.date, today);");
    expect(M).toContain("const delta = unitsDelta(d.status, status, d.units);");
    const K = region(SVC, "export async function cutCampDays(", "export async function weeksForCalendar(");
    expect(K).toContain('eq(campDays.status, "PLANNED"), lte(campDays.date, runDate)');
    expect(K).toContain('set({ status: "ATTENDED", markedBy: "end-of-day"');
    expect(K).toContain("usedUnits: sql`${campPackages.usedUnits} + ${d.units}`");
    expect(K).toContain("return due.length;");
    expect(SVC).not.toContain("recordRevenue"); // 🚫 no per-day revenue — the sale posted once
    const J = code(src("src/services/jobs.service.ts"));
    const tx = region(J, "const marked = await db.transaction(", "return { autoAttended");
    expect(tx).toContain("const campDaysAutoAttended = await cutCampDays(tx, runDate);");
    expect(J).toContain("return { autoAttended: due.length, coursesAutoAttended, vouchersAutoAttended, campDaysAutoAttended, campDeductionsNotified };"); // 🔻 TASK-443: + the day-end camp_deduction pass
    expect(J).not.toContain('"EXTENDED"'); // REQ-094 byte-freeze still holds
    expect(code(src("src/services/scheduler.service.ts"))).toContain("campWeeks: campWeeksInRange,");
  });
});

describe("🔑 RBAC — `menu:camp` after Badges (13), four `action:camp.*` (54), ten rows in the access table (TASK-403 added the QR)", () => {
  test("keys by value", () => {
    expect(MENU_KEYS.length).toBe(13);
    expect(MENU_KEYS[MENU_KEYS.indexOf("menu:badges") + 1]).toBe("menu:camp");
    expect(ACTION_REGISTRY.length).toBe(59); // 🔻 TASK-431: + bookings.coach-rate // 🔻 TASK-428: + calendar.other-cancel-all // 🔻 TASK-426: + teachers.budget-view // TASK-411: + people.parent-archive // TASK-406: + calendar.teacher-leave
    const keys: string[] = ACTION_REGISTRY.map((a) => a.key);
    for (const k of ["action:camp.week-open", "action:camp.sell", "action:camp.redeem", "action:camp.day-mark"]) expect(keys).toContain(k);
    expect(ACTION_REGISTRY.find((a) => a.key === "action:camp.sell")).toMatchObject({ labelTh: "ขายแคมป์", labelEn: "Sell a camp package" });
  });
  test("the access table: every read on `menu:camp` (packages also on `menu:people`), every write on its own act", () => {
    const A = ROUTE_ACCESS as Record<string, { menus: readonly string[]; action?: string }>;
    expect(A["GET /camp/prices"]).toEqual({ menus: ["menu:camp"] });
    expect(A["GET /camp/weeks"]).toEqual({ menus: ["menu:camp"] });
    expect(A["GET /camp/weeks/:id/days"]).toEqual({ menus: ["menu:camp"] });
    expect(A["GET /camp/packages"]).toEqual({ menus: ["menu:camp", "menu:people"] });
    expect(A["POST /camp/weeks"]).toEqual({ menus: ["menu:camp"], action: "action:camp.week-open" });
    expect(A["PATCH /camp/weeks/:id"]).toEqual({ menus: ["menu:camp"], action: "action:camp.week-open" });
    expect(A["POST /camp/packages"]).toEqual({ menus: ["menu:camp"], action: "action:camp.sell" });
    expect(A["POST /camp/packages/:id/days"]).toEqual({ menus: ["menu:camp"], action: "action:camp.redeem" });
    expect(A["PATCH /camp/days/:id"]).toEqual({ menus: ["menu:camp"], action: "action:camp.day-mark" });
    expect(A["GET /camp/days/:id/checkin"]).toEqual({ menus: ["menu:camp"] }); // TASK-403
    expect(A["PATCH /camp/weeks/:id/days/:date"]).toEqual({ menus: ["menu:camp"], action: "action:camp.week-open" }); // TASK-418
    expect(Object.keys(A).filter((k) => k.includes("/camp/")).length).toBe(11); // TASK-403: +1 (the QR); TASK-418: +1 (the per-day swap)
    expect(code(src("src/index.ts"))).toContain('app.route("/api/camp", campRoutes);');
  });
});

describe("🔴 the routes through the ROOT app — prices without a service, the sale 201, the redeem's 409s pass through by value", () => {
  test("GET /api/camp/prices ⇒ the four items", async () => {
    process.env.SKIP_AUTH = "true";
    const r = await rootApp.fetch(new Request("http://localhost/api/camp/prices"));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).items.map((i: any) => i.externalRef).sort()).toEqual(["camp-full-day", "camp-full-week", "camp-half-day", "camp-half-week"]);
  });
  test("POST /api/camp/packages ⇒ 201; a DAILY without `days` ⇒ 400 before the service", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(camp, "createPackage").mockImplementation((async (input: any) => { calls.push(input); return { id: P1, studentId: input.studentId, kind: input.kind, plan: input.plan, totalUnits: 10, usedUnits: 0 }; }) as any);
    try {
      const post = (body: any) => rootApp.fetch(new Request("http://localhost/api/camp/packages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const ok = await post({ studentId: S1, kind: "FULL", plan: "FULL_WEEK", firstWeek: { weekId: W1, dates: ["2026-10-05"], half: "FULL" } });
      expect(ok.status).toBe(201);
      expect(await ok.json()).toMatchObject({ id: P1, totalUnits: 10 });
      expect(calls.at(-1)).toMatchObject({ studentId: S1, kind: "FULL", plan: "FULL_WEEK", firstWeek: { weekId: W1 } });
      expect((await post({ studentId: S1, kind: "HALF", plan: "DAILY" })).status).toBe(400);
      expect(calls.length).toBe(1);
    } finally { s.mockRestore(); }
  });
  test("POST /api/camp/packages/:id/days ⇒ 201 { planned }; CAMP_FULL / CAMP_NO_CREDIT / CAMP_WEEK_CLOSED envelopes; PATCH /days/:id CAMP_DAY_STARTED", async () => {
    process.env.SKIP_AUTH = "true";
    const s = spyOn(camp, "redeemDays").mockImplementation((async (_id: string, input: any) => {
      if (input.dates[0] === "2026-10-06") throw err(409, "CAMP_FULL", "วันที่ 2026-10-06 เต็ม (8/8)");
      if (input.dates[0] === "2026-10-07") throw err(409, "CAMP_NO_CREDIT", "วันที่ 2026-10-07 เครดิตไม่พอ (เหลือ 1 หน่วย)");
      if (input.weekId === "00000000-0000-4000-8000-000000000409") throw err(409, "CAMP_WEEK_CLOSED", "สัปดาห์ Camp A ปิดรับแล้ว");
      return { planned: input.dates.length };
    }) as any);
    const m = spyOn(camp, "markDay").mockImplementation((async () => { throw err(409, "CAMP_DAY_STARTED", "วันแคมป์เริ่มแล้ว — บันทึกขาดแทน"); }) as any);
    try {
      const post = (body: any) => rootApp.fetch(new Request(`http://localhost/api/camp/packages/${P1}/days`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const ok = await post({ weekId: W1, dates: ["2026-10-05", "2026-10-08"], half: "AM" });
      expect(ok.status).toBe(201);
      expect(await ok.json()).toEqual({ planned: 2 });
      const full = await post({ weekId: W1, dates: ["2026-10-06"], half: "FULL" });
      expect(full.status).toBe(409);
      expect(await full.json()).toEqual({ error: { code: "CAMP_FULL", message: "วันที่ 2026-10-06 เต็ม (8/8)" } });
      const nc = await post({ weekId: W1, dates: ["2026-10-07"], half: "FULL" });
      expect(await nc.json()).toEqual({ error: { code: "CAMP_NO_CREDIT", message: "วันที่ 2026-10-07 เครดิตไม่พอ (เหลือ 1 หน่วย)" } });
      const closed = await post({ weekId: "00000000-0000-4000-8000-000000000409", dates: ["2026-10-05"], half: "AM" });
      expect(await closed.json()).toEqual({ error: { code: "CAMP_WEEK_CLOSED", message: "สัปดาห์ Camp A ปิดรับแล้ว" } });
      const mark = await rootApp.fetch(new Request(`http://localhost/api/camp/days/${P1}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "CANCELLED" }) }));
      expect(mark.status).toBe(409);
      expect(await mark.json()).toEqual({ error: { code: "CAMP_DAY_STARTED", message: "วันแคมป์เริ่มแล้ว — บันทึกขาดแทน" } });
    } finally { s.mockRestore(); m.mockRestore(); }
  });
});
