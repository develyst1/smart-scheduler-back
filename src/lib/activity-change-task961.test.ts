// 🔻 TASK-961 (REQ-5014 option A, SPEC-106 §§2–5, §8 BE) — change the ACTIVITY of a course's REMAINING classes, or of one 1 HR / 1st Trial.
//   · the PURE planner (`lib/activity-change.ts`): which rows, the difference (her example 100 → 120, 4 of 10 left = 8 ฿), the price rules, every refusal as a CODE;
//   · the revenue hunk (SPEC §4): ONE category-name builder for the writer AND the relabel; the relabel moves the category and NOTHING else; no line / a failure never fails the caller;
//   · the act through a FAKE transaction (real `scheduler.service`): only the remaining rows change; size / expiry / first_teacher_id / usedSessions untouched; the history row; refusals write nothing; the per-session lock still refuses;
//   · the notices, by value (one per person; with and without a coach change); the migration text / witness / journal pins.
// 🚫 It models the database, it does not replace it: the real rows, the real FKs / CHECKs and the rollback are the sid proof (TASK-961 Notes).
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ACTIVITY_REFUSALS, differenceMinor, isActivityRefusal, planCourseActivityChange, priceActivityChange, roundToBaht } from "./activity-change";
import { courseLine, revenueCategoryName, revenueCategoryType, trialOrSingleLine } from "./booking-sale-amount";
import { relabelRevenueLine, writeRevenueLine } from "./revenue-line";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { courseItemRef, listPriceMinor, sessionItemRef, FIRST_TRIAL_MINOR } from "./sale-items";
import { formatOutboxMessage as buildOutboxMessage } from "./line-message";
import { changesCourseSubject } from "./course-subject-lock";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const sched = await import("../services/scheduler.service");
const { db } = await import("../db");
const { ApiException } = await import("./http");

const root = resolve(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
afterEach(() => setSystemTime());

// ───────────────────────────── the pure planner ─────────────────────────────
const row = (id: string, date: string, status = "CONFIRMED", o: Record<string, unknown> = {}) => ({ id, date, startTime: "10:00:00", status, teacherId: "T1", groupId: null, ...o });
const TODAY = "2026-11-13";

describe("🔴 TASK-961 — the difference (SPEC §2.1): max(0, round_to_whole_baht((new − old) × remaining ÷ size))", () => {
  test("her example: 100 → 120 for 10 classes, 4 left ⇒ 800 satang (8 ฿)", () => {
    expect(differenceMinor(10000, 12000, 4, 10)).toBe(800);
  });
  test("cheaper ⇒ 0 (no refund), equal ⇒ 0", () => {
    expect(differenceMinor(12000, 10000, 4, 10)).toBe(0);
    expect(differenceMinor(10000, 10000, 4, 10)).toBe(0);
  });
  test("rounds to a WHOLE baht, half up: 7.5 ฿ → 8 ฿, 7.4 ฿ → 7 ฿", () => {
    expect(differenceMinor(0, 750, 1, 1)).toBe(800); // 7.50 ฿
    expect(differenceMinor(0, 740, 1, 1)).toBe(700);
    expect(roundToBaht(49)).toBe(0);
    expect(roundToBaht(50)).toBe(100);
  });
  test("by the real card: bike-skate 10 → onewheel 10, 4 left = (1 190 000 − 979 000) × 4 ÷ 10 = 84 400 satang", () => {
    expect(differenceMinor(listPriceMinor(courseItemRef("bike-skate", 10))!, listPriceMinor(courseItemRef("onewheel", 10))!, 4, 10)).toBe(84400);
  });
});

describe("🔴 TASK-961 — the price rules (SPEC §2.1 table)", () => {
  const base = { oldCardMinor: 979000, newCardMinor: 1190000, remaining: 4, size: 10, isAct: true };
  test("card price present ⇒ CARD, the difference computed", () => {
    expect(priceActivityChange(base)).toEqual({ oldPriceMinor: 979000, newPriceMinor: 1190000, priceSource: "CARD", differenceMinor: 84400 });
  });
  test("a typed price when the card HAS one ⇒ 400 MANUAL_PRICE_NOT_ALLOWED", () => {
    expect(priceActivityChange({ ...base, manualPriceBaht: 5000 })).toMatchObject({ refused: true, status: 400, code: "MANUAL_PRICE_NOT_ALLOWED" });
  });
  test("no card price + none typed ⇒ 400 MANUAL_PRICE_REQUIRED on the ACT, and a PREVIEW answers nulls (no difference)", () => {
    const noCard = { ...base, newCardMinor: undefined };
    expect(priceActivityChange(noCard)).toMatchObject({ refused: true, status: 400, code: "MANUAL_PRICE_REQUIRED" });
    expect(priceActivityChange({ ...noCard, isAct: false })).toEqual({ oldPriceMinor: 979000, newPriceMinor: null, priceSource: null, differenceMinor: null });
  });
  test("no card price + a typed price ⇒ MANUAL, newPrice = baht × 100, the difference from it", () => {
    expect(priceActivityChange({ ...base, newCardMinor: undefined, manualPriceBaht: 12000 })).toEqual({ oldPriceMinor: 979000, newPriceMinor: 1200000, priceSource: "MANUAL", differenceMinor: differenceMinor(979000, 1200000, 4, 10) });
  });
  test("the range: an integer in 1..100 000 — 0, 100 001, 12.5, NaN are 400 MANUAL_PRICE_RANGE (checked before the 'not allowed' rule)", () => {
    for (const bad of [0, -5, 100001, 12.5, Number.NaN]) expect(priceActivityChange({ ...base, newCardMinor: undefined, manualPriceBaht: bad })).toMatchObject({ refused: true, status: 400, code: "MANUAL_PRICE_RANGE" });
    for (const ok of [1, 100000]) expect(priceActivityChange({ ...base, newCardMinor: undefined, manualPriceBaht: ok })).toMatchObject({ priceSource: "MANUAL" });
    expect(priceActivityChange({ ...base, manualPriceBaht: 0 })).toMatchObject({ code: "MANUAL_PRICE_RANGE" });
  });
  test("a Trial is one flat price: the difference is ALWAYS 0", () => {
    expect(priceActivityChange({ oldCardMinor: FIRST_TRIAL_MINOR, newCardMinor: FIRST_TRIAL_MINOR, remaining: 1, size: 1, isAct: true, flat: true })).toMatchObject({ priceSource: "CARD", differenceMinor: 0 });
  });
  test("the OLD activity is not on the card ⇒ 409 OLD_PRICE_NOT_ON_CARD (no invented price)", () => {
    expect(priceActivityChange({ ...base, oldCardMinor: undefined })).toMatchObject({ refused: true, status: 409, code: "OLD_PRICE_NOT_ON_CARD" });
  });
});

describe("🔴 TASK-961 — the rows (SPEC §2.1): only the REMAINING live classes change; every refusal is a code", () => {
  const rows = [
    row("a1", "2026-11-05", "ATTENDED"), row("a2", "2026-11-12", "ATTENDED"), // attended: never touched
    row("t0", TODAY, "ATTENDED"), // today but ALREADY attended (R1): excluded
    row("f1", TODAY, "CONFIRMED"), row("f2", "2026-11-20", "PENDING"), row("f3", "2026-11-27", "EXTENDED"), // today-or-later and live
    row("c1", "2026-12-04", "CANCELLED"), row("l1", "2026-12-11", "SICK_LEAVE"), row("n1", "2026-12-18", "NO_SHOW"), // not live
    row("p1", "2026-10-30", "CONFIRMED"), // in the past, still "live" in the table: never touched
  ];
  const input = { currentSubjectId: "BIKE", subjectId: "ONEW" };
  test("remaining = the live rows dated today or later, in date order; attended / cancelled / leave / past rows are out", () => {
    const p = planCourseActivityChange(rows, input, TODAY);
    expect(isActivityRefusal(p)).toBe(false);
    if (isActivityRefusal(p)) return;
    expect(p.rows.map((r) => r.id)).toEqual(["f1", "f2", "f3"]);
    expect([p.remaining, p.firstDate, p.lastDate]).toEqual([3, TODAY, "2026-11-27"]);
  });
  test("teacherChanged only when a remaining row is on ANOTHER coach than the one asked for", () => {
    expect((planCourseActivityChange(rows, { ...input, teacherId: "T1" }, TODAY) as any).teacherChanged).toBe(false);
    expect((planCourseActivityChange(rows, { ...input, teacherId: "T2" }, TODAY) as any).teacherChanged).toBe(true);
    expect((planCourseActivityChange(rows, input, TODAY) as any).teacherChanged).toBe(false);
  });
  test("SAME_ACTIVITY (400) · NO_REMAINING_CLASSES (409) · GROUP_COURSE (409, any remaining row in a group class)", () => {
    expect(planCourseActivityChange(rows, { currentSubjectId: "ONEW", subjectId: "ONEW" }, TODAY)).toMatchObject({ refused: true, status: 400, code: "SAME_ACTIVITY" });
    expect(planCourseActivityChange(rows.filter((r) => r.status === "ATTENDED"), input, TODAY)).toMatchObject({ refused: true, status: 409, code: "NO_REMAINING_CLASSES" });
    expect(planCourseActivityChange([...rows, row("g1", "2026-12-25", "CONFIRMED", { groupId: "G" })], input, TODAY)).toMatchObject({ refused: true, status: 409, code: "GROUP_COURSE" });
    expect(planCourseActivityChange([row("g0", "2026-10-01", "CONFIRMED", { groupId: "G" }), row("f1", TODAY)], input, TODAY)).not.toHaveProperty("refused"); // a group row in the PAST is not "remaining"
  });
  test("every refusal carries a Thai message (no English / no empty)", () => {
    for (const [code, r] of Object.entries(ACTIVITY_REFUSALS)) expect({ code, thai: /[฀-๿]/.test(r.message) }).toEqual({ code, thai: true });
  });
});

// ───────────────────────────── the revenue hunk (SPEC §4) ─────────────────────────────
describe("💰 TASK-961 — ONE category-name builder; the relabel moves the category and nothing else", () => {
  test("the builder: COURSE «<subject> · Private|Duo» · 1 HR «<subject> · 1 HR» (COURSE) · Trial «1st Trial (<subject>)» (TRIAL)", () => {
    expect(revenueCategoryName("COURSE", "Bike")).toBe("Bike · Private");
    expect(revenueCategoryName("COURSE", "Bike", true)).toBe("Bike · Duo");
    expect(revenueCategoryName("SINGLE_SESSION", "Bike")).toBe("Bike · 1 HR");
    expect(revenueCategoryName("FIRST_TRIAL", "Bike")).toBe("1st Trial (Bike)");
    expect([revenueCategoryType("COURSE"), revenueCategoryType("SINGLE_SESSION"), revenueCategoryType("FIRST_TRIAL")]).toEqual(["COURSE", "COURSE", "TRIAL"]);
  });
  test("THE writer and the relabel produce the SAME name for the same subject and duo flag (one builder, no second)", () => {
    for (const duo of [false, true]) expect(courseLine({ id: "c1", subjectName: "Bike", duo, who: null }, 100000)!.categoryName).toBe(revenueCategoryName("COURSE", "Bike", duo));
    const facts = (bookingType: string) => ({ id: "b1", bookingType, subjectName: "Bike", who: null, discountKind: null, discountValue: null, discountReason: null, discountActor: null });
    expect(trialOrSingleLine(facts("FIRST_TRIAL") as any, "bike-skate")!.categoryName).toBe(revenueCategoryName("FIRST_TRIAL", "Bike"));
    expect(trialOrSingleLine(facts("SINGLE_SESSION") as any, "bike-skate")!.categoryName).toBe(revenueCategoryName("SINGLE_SESSION", "Bike"));
    expect(trialOrSingleLine(facts("FIRST_TRIAL") as any, "bike-skate")!.type).toBe(revenueCategoryType("FIRST_TRIAL"));
    // by source: neither the writer nor the relabel builds a name of its own
    const B = read("src/lib/booking-sale-amount.ts");
    expect(B.match(/ · \$\{duo \? "Duo" : "Private"\}/g)).toHaveLength(1);
    expect(B.match(/1st Trial \(\$\{subject\}\)/g)).toHaveLength(1);
    expect(read("src/lib/revenue-line.ts")).not.toMatch(/Private|1st Trial|· 1 HR/);
  });
  /** A recording executor for the relabel: the category lookup answers `cat` (or nothing), the UPDATE answers the lines it hit. */
  const recorder = (o: { category?: boolean; lines?: number; fail?: boolean } = {}) => {
    const log: Array<{ op: string; table: string; set?: any }> = [];
    const exec: any = {
      select: () => { const c: any = { from: () => c, where: () => c, limit: async () => (o.category === false ? [] : [{ id: "cat" }]), then: (r: any) => r(o.category === false ? [{ next: 0 }] : [{ id: "cat" }]) }; return c; },
      insert: (t: any) => ({ values: (v: any) => { log.push({ op: "insert", table: getTableName(t), set: v }); return { onConflictDoNothing: async () => undefined }; } }),
      update: (t: any) => ({ set: (v: any) => ({ where: () => ({ returning: async () => { if (o.fail) throw new Error("boom"); log.push({ op: "update", table: getTableName(t), set: v }); return Array.from({ length: o.lines ?? 1 }, () => ({ id: "l" })); } }) }) }),
      transaction: async (fn: any) => fn(exec),
    };
    return { exec, log };
  };
  test("it UPDATEs ONLY `category_id` of the keyed line (amount, month, product_name, occurred_on, payment all stay) and says true", async () => {
    const { exec, log } = recorder();
    expect(await relabelRevenueLine(exec, "rl:course:c1", { type: "COURSE", categoryName: "Bike · Private" })).toBe(true);
    const u = log.filter((l) => l.op === "update");
    expect(u).toHaveLength(1);
    expect(u[0]!.table).toBe("revenue_line");
    expect(Object.keys(u[0]!.set)).toEqual(["categoryId"]);
  });
  test("the category is found OR CREATED exactly as the writer does (a new name inserts one `revenue_category`)", async () => {
    const { exec, log } = recorder({ category: false });
    // the lookup finds nothing, the insert runs, the re-read finds it (the fake answers the second read through `then`)
    let reads = 0;
    exec.select = () => { const c: any = { from: () => c, where: () => c, limit: async () => (++reads === 1 ? [] : [{ id: "cat" }]), then: (r: any) => r([{ next: 3 }]) }; return c; };
    expect(await relabelRevenueLine(exec, "rl:course:c1", { type: "COURSE", categoryName: "New · Private" })).toBe(true);
    expect(log.filter((l) => l.op === "insert").map((l) => [l.table, l.set.name, l.set.type, l.set.sortOrder])).toEqual([["revenue_category", "New · Private", "COURSE", 3]]);
  });
  test("NO line yet (an unposted sale / an unconfirmed booking) ⇒ false, nothing breaks", async () => {
    expect(await relabelRevenueLine(recorder({ lines: 0 }).exec, "rl:booking:b1", { type: "COURSE", categoryName: "Bike · 1 HR" })).toBe(false);
  });
  test("a failure is LOGGED and never fails the caller (false)", async () => {
    const orig = console.error;
    const seen: string[] = [];
    console.error = (...a: unknown[]) => { seen.push(String(a[0])); };
    try { expect(await relabelRevenueLine(recorder({ fail: true }).exec, "rl:course:c1", { type: "COURSE", categoryName: "Bike · Private" })).toBe(false); } finally { console.error = orig; }
    expect(seen.join()).toContain("NOT RELABELLED — rl:course:c1");
  });
  test("`writeRevenueLine` still finds-or-creates through the SAME helper (the extraction moved the lookup, not its order)", () => {
    const R = read("src/lib/revenue-line.ts");
    expect(R.match(/ensureCategory\(/g)).toHaveLength(3); // the definition + the writer + the relabel
    expect(typeof writeRevenueLine).toBe("function");
  });
  test("`courseLine`'s subject comes from `course_packages.subject_id` (`writeCourseLine` reads `course.subjectId`), never `bookings[0]` (SPEC §4 check)", () => {
    const R = read("src/lib/revenue-line.ts");
    expect(R).toContain("const subject = course.subjectId ? await sp.query.subjects.findFirst({ where: (s: any, { eq: e }: any) => e(s.id, course.subjectId) }) : null;");
    expect(R).not.toMatch(/bookings\[0\]/);
  });
});

// ───────────────────────────── the act, through a fake transaction ─────────────────────────────
const BIKE = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1", ONEW = "0e0e0e0e-0e0e-40e0-80e0-0e0e0e0e0e0e", BALP = "ba1ba1ba-1ba1-41ba-81ba-1ba11ba11ba1", NOGRP = "9090909a-9090-4090-8090-909090909090", OFF = "0ff0ff0f-f0ff-40f0-80f0-ff0ff0ff0ff0";
const T1 = "7171717a-7171-4171-8171-717171717171", T2 = "7272727b-7272-4272-8272-727272727272";
const SUBJECTS: Record<string, any> = {
  [BIKE]: { id: BIKE, name: "Bike", active: true, priceGroup: "bike-skate" }, [ONEW]: { id: ONEW, name: "Onewheel", active: true, priceGroup: "onewheel" },
  [BALP]: { id: BALP, name: "Balance", active: true, priceGroup: "balance-private" }, [NOGRP]: { id: NOGRP, name: "NoGroup", active: true, priceGroup: null }, [OFF]: { id: OFF, name: "Off", active: false, priceGroup: "bike-skate" },
};
type World = { course?: any; rows?: any[]; booking?: any; linked?: boolean; line?: boolean; clash?: boolean };
const COURSE = (o: Record<string, unknown> = {}) => ({ id: "c1", subjectId: BIKE, size: 10, studentId: "s1", coStudentId: null, endedAt: null, droppedAt: null, expiryDate: "2027-03-01", usedSessions: 2, leaveUsed: 0, firstTeacherId: T1, ...o });
const CROW = (id: string, date: string, status: string, o: Record<string, unknown> = {}) => ({ id, courseId: "c1", bookingType: "COURSE_PACKAGE", date, startTime: "10:00:00", endTime: "11:00:00", status, teacherId: T1, subjectId: BIKE, groupId: null, ...o });
const ROWS = () => [CROW("a1", "2026-11-05", "ATTENDED"), CROW("a2", "2026-11-12", "ATTENDED"), CROW("f1", "2026-11-20", "CONFIRMED"), CROW("f2", "2026-11-27", "CONFIRMED"), CROW("f3", "2026-12-04", "PENDING"), CROW("f4", "2026-12-11", "EXTENDED")];
const idOf = (q: any) => q.where({}, { eq: (_c: unknown, v: unknown) => v, and: (...a: unknown[]) => a });

function fakeTx(w: World) {
  const writes: Array<{ op: string; table: string; v?: any; ids?: unknown }> = [];
  const thenable = (value: unknown, extra: Record<string, unknown> = {}) => ({ ...extra, then: (r: any) => r(value) });
  const tx: any = {
    query: {
      coursePackages: { findFirst: async () => w.course },
      bookings: { findMany: async () => w.rows ?? [], findFirst: async () => w.booking },
      subjects: { findFirst: async (q: any) => SUBJECTS[idOf(q) as string] },
      teachers: { findFirst: async (q: any) => ({ id: idOf(q), nickname: idOf(q) === T1 ? "Ek" : "Fon", lineUserId: null, isSystem: false, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" }) },
      students: { findMany: async () => [{ id: "s1", parentId: "p1" }] },
      parents: { findMany: async () => (w.linked ? [{ id: "p1", lineUserId: "U-parent" }] : []) },
    },
    select: () => { const c: any = { from: (t: any) => { c.t = getTableName(t); return c; }, where: () => c, limit: async () => [{ id: "cat" }], then: (r: any) => r(c.t === "revenue_category" ? [{ id: "cat" }] : []) }; return c; },
    insert: (t: any) => ({ values: (v: any) => { writes.push({ op: "insert", table: getTableName(t), v }); return thenable(undefined, { returning: async () => [{ id: "chg1" }], onConflictDoNothing: async () => undefined }); } }),
    update: (t: any) => ({ set: (v: any) => ({ where: (cond: any) => { writes.push({ op: "update", table: getTableName(t), v, ids: cond }); return thenable(undefined, { returning: async () => (w.line === false ? [] : [{ id: "l" }]) }); } }) }),
    transaction: async (fn: any) => fn(tx),
  };
  return { tx, writes };
}
const run = async (w: World, fn: (id: string) => Promise<unknown>) => {
  setSystemTime(new Date(`${TODAY}T03:00:00Z`));
  const { tx, writes } = fakeTx(w);
  const prev = (db as any).transaction;
  (db as any).transaction = async (f: any) => f(tx);
  try { return { out: await fn("c1"), writes, err: null as any }; } catch (e) { return { out: null, writes, err: e }; } finally { (db as any).transaction = prev; }
};
const refusal = (e: any) => (e instanceof ApiException ? { status: e.status, code: e.code } : e);
const subjectWrites = (writes: Array<{ op: string; table: string; v?: any; ids?: unknown }>) => writes.filter((x) => x.op === "update" && x.table === "bookings");

describe("🔴 TASK-961 — the act: only the remaining rows change; the course keeps its size, expiry, first coach and used sessions", () => {
  test("2 attended + 4 remaining: ONE bookings update (the 4 remaining ids, `subjectId` only), the course's `subject_id` only, the history row, the relabel", async () => {
    const r = await run({ course: COURSE(), rows: ROWS() }, (id) => sched.changeCourseActivity(id, { subjectId: ONEW }, "admin"));
    expect(r.err).toBeNull();
    expect(r.out).toMatchObject({ remaining: 4, firstDate: "2026-11-20", lastDate: "2026-12-11", teacherChanged: false, from: { subjectId: BIKE, subjectName: "Bike" }, to: { subjectId: ONEW, subjectName: "Onewheel" }, oldPriceMinor: 979000, newPriceMinor: 1190000, priceSource: "CARD", differenceMinor: 84400, changeId: "chg1" });
    const b = subjectWrites(r.writes);
    expect(b).toHaveLength(1); // one statement for the four rows (a SQL `inArray`), never one per attended row
    expect(Object.keys(b[0]!.v)).toEqual(["subjectId"]); // the date, time, status, coach and rates of a row are never touched
    expect(b[0]!.v.subjectId).toBe(ONEW);
    expect([...new PgDialect().sqlToQuery(b[0]!.ids as any).params].sort()).toEqual(["f1", "f2", "f3", "f4"]); // exactly the remaining ids — the two attended rows are not in the statement
    const c = r.writes.filter((x) => x.table === "course_packages");
    expect(c).toHaveLength(1);
    expect(Object.keys(c[0]!.v)).toEqual(["subjectId"]); // NOT size / expiry / usedSessions / leaveUsed / first_teacher_id (and no coach record: the coach did not change)
  });
  test("the history row carries both subjects, remaining / size, both prices + the source, the difference, the actor — and the relabel outcome", async () => {
    const r = await run({ course: COURSE(), rows: ROWS() }, (id) => sched.changeCourseActivity(id, { subjectId: ONEW }, "admin"));
    const h = r.writes.find((x) => x.op === "insert" && x.table === "activity_changes")!;
    expect(h.v).toEqual({ courseId: "c1", fromSubjectId: BIKE, toSubjectId: ONEW, fromTeacherId: null, toTeacherId: null, remaining: 4, size: 10, oldPriceMinor: 979000, newPriceMinor: 1190000, priceSource: "CARD", differenceMinor: 84400, actor: "admin" });
    const rel = r.writes.find((x) => x.op === "update" && x.table === "activity_changes");
    expect(rel!.v).toEqual({ revenueRelabelled: true });
    const line = r.writes.find((x) => x.op === "update" && x.table === "revenue_line")!;
    expect(Object.keys(line.v)).toEqual(["categoryId"]);
  });
  test("no revenue line yet ⇒ `revenue_relabelled` stays false (no second update of the history row)", async () => {
    const r = await run({ course: COURSE(), rows: ROWS(), line: false }, (id) => sched.changeCourseActivity(id, { subjectId: ONEW }, "admin"));
    expect(r.err).toBeNull();
    expect(r.writes.filter((x) => x.op === "update" && x.table === "activity_changes")).toHaveLength(0);
  });
  test("a typed price when the card has none (size 4: bike-skate → balance-private): MANUAL, the history keeps the source", async () => {
    const r = await run({ course: COURSE({ size: 4 }), rows: ROWS().slice(0, 5) }, (id) => sched.changeCourseActivity(id, { subjectId: BALP, manualPriceBaht: 6000 }, "admin"));
    expect(r.err).toBeNull();
    expect(r.out).toMatchObject({ newPriceMinor: 600000, priceSource: "MANUAL", differenceMinor: differenceMinor(479000, 600000, 3, 4) });
    expect(r.writes.find((x) => x.op === "insert" && x.table === "activity_changes")!.v).toMatchObject({ priceSource: "MANUAL", newPriceMinor: 600000 });
  });
  test("the refusals, each with ZERO writes: SAME_ACTIVITY · NO_REMAINING_CLASSES · GROUP_COURSE · MANUAL_PRICE_REQUIRED · MANUAL_PRICE_NOT_ALLOWED · MANUAL_PRICE_RANGE · COURSE_ENDED · COURSE_DROPPED", async () => {
    const cases: Array<[string, World, any, { status: number; code: string }]> = [
      ["same", { course: COURSE(), rows: ROWS() }, { subjectId: BIKE }, { status: 400, code: "SAME_ACTIVITY" }],
      ["none left", { course: COURSE(), rows: ROWS().slice(0, 2) }, { subjectId: ONEW }, { status: 409, code: "NO_REMAINING_CLASSES" }],
      ["group", { course: COURSE(), rows: [...ROWS(), CROW("g", "2026-12-18", "CONFIRMED", { groupId: "G" })] }, { subjectId: ONEW }, { status: 409, code: "GROUP_COURSE" }],
      ["price required", { course: COURSE({ size: 4 }), rows: ROWS().slice(0, 5) }, { subjectId: BALP }, { status: 400, code: "MANUAL_PRICE_REQUIRED" }],
      ["price not allowed", { course: COURSE(), rows: ROWS() }, { subjectId: ONEW, manualPriceBaht: 5000 }, { status: 400, code: "MANUAL_PRICE_NOT_ALLOWED" }],
      ["price range", { course: COURSE({ size: 4 }), rows: ROWS().slice(0, 5) }, { subjectId: BALP, manualPriceBaht: 0 }, { status: 400, code: "MANUAL_PRICE_RANGE" }],
      ["ended", { course: COURSE({ endedAt: new Date("2026-11-01T03:00:00Z") }), rows: ROWS() }, { subjectId: ONEW }, { status: 409, code: "COURSE_ENDED" }],
      ["paused", { course: COURSE({ droppedAt: new Date("2026-11-01T03:00:00Z") }), rows: ROWS() }, { subjectId: ONEW }, { status: 409, code: "COURSE_DROPPED" }],
    ];
    for (const [name, w, input, want] of cases) {
      const r = await run(w, (id) => sched.changeCourseActivity(id, input, "admin"));
      expect({ name, ...refusal(r.err), writes: r.writes.length }).toEqual({ name, ...want, writes: 0 });
    }
  });
  test("an unknown / inactive target subject is refused before anything is written", async () => {
    for (const subjectId of ["ffffffff-ffff-4fff-8fff-ffffffffffff", OFF]) {
      const r = await run({ course: COURSE(), rows: ROWS() }, (id) => sched.changeCourseActivity(id, { subjectId }, "admin"));
      expect({ subjectId, status: refusal(r.err).status ?? 0, writes: r.writes.length }).toMatchObject({ subjectId, writes: 0 });
      expect(r.err).not.toBeNull();
    }
  });
  test("the PREVIEW is the act run in a transaction that always rolls back: the same numbers, `changeId` absent, nothing needs the price to be typed", async () => {
    const act = await run({ course: COURSE(), rows: ROWS() }, (id) => sched.changeCourseActivity(id, { subjectId: ONEW }, "admin"));
    const prev = await run({ course: COURSE(), rows: ROWS() }, (id) => sched.previewCourseActivity(id, { subjectId: ONEW }));
    expect(prev.err).toBeNull();
    const { changeId: _c, ...actNoId } = act.out as any;
    expect(prev.out).toEqual(actNoId);
    expect(prev.writes.some((x) => x.table === "activity_changes" && x.op === "insert")).toBe(false); // no history row from a preview
    const noPrice = await run({ course: COURSE({ size: 4 }), rows: ROWS().slice(0, 5) }, (id) => sched.previewCourseActivity(id, { subjectId: BALP }));
    expect(noPrice.out).toMatchObject({ newPriceMinor: null, priceSource: null, differenceMinor: null, remaining: 3 }); // a preview that still needs the typed price answers, it does not refuse
  });
});

describe("🔴 TASK-961 — 1 HR / 1st Trial (SPEC §2.2)", () => {
  const B = (o: Record<string, unknown> = {}) => ({ id: "b1", bookingType: "SINGLE_SESSION", status: "CONFIRMED", date: "2026-11-20", startTime: "10:00:00", endTime: "11:00:00", teacherId: T1, subjectId: BIKE, subject: SUBJECTS[BIKE], studentId: "s1", coStudentId: null, groupId: null, ...o });
  const go = (b: any, input: any = { subjectId: ONEW }) => run({ booking: b }, () => sched.changeBookingActivity("b1", input, "admin"));
  test("a CONFIRMED 1 HR: the row's subject, the history (remaining 1, size 1), the difference = max(0, new 1 h − old 1 h), the line relabelled", async () => {
    const r = await go(B());
    expect(r.err).toBeNull();
    expect(r.out).toMatchObject({ remaining: 1, firstDate: "2026-11-20", lastDate: "2026-11-20", teacherChanged: false, oldPriceMinor: listPriceMinor(sessionItemRef("bike-skate")), newPriceMinor: listPriceMinor(sessionItemRef("onewheel")), differenceMinor: listPriceMinor(sessionItemRef("onewheel"))! - listPriceMinor(sessionItemRef("bike-skate"))!, priceSource: "CARD" });
    expect(subjectWrites(r.writes).map((x) => Object.keys(x.v))).toEqual([["subjectId"]]);
    expect(r.writes.find((x) => x.table === "activity_changes" && x.op === "insert")!.v).toMatchObject({ bookingId: "b1", remaining: 1, size: 1 });
    expect(r.writes.some((x) => x.table === "revenue_line")).toBe(true);
  });
  test("a PENDING one: no line yet (relabel false), and the confirm writes it with the new subject", async () => {
    const r = await run({ booking: B({ status: "PENDING" }), line: false }, () => sched.changeBookingActivity("b1", { subjectId: ONEW }, "admin"));
    expect(r.err).toBeNull();
    expect(r.writes.filter((x) => x.op === "update" && x.table === "activity_changes")).toHaveLength(0);
  });
  test("a 1st Trial: the difference is ALWAYS 0 (one flat price both sides)", async () => {
    const r = await go(B({ bookingType: "FIRST_TRIAL" }));
    expect(r.out).toMatchObject({ oldPriceMinor: FIRST_TRIAL_MINOR, newPriceMinor: FIRST_TRIAL_MINOR, differenceMinor: 0 });
  });
  test("cheaper ⇒ 0 (no refund)", async () => {
    const r = await go(B({ subjectId: ONEW, subject: SUBJECTS[ONEW] }), { subjectId: BIKE });
    expect(r.out).toMatchObject({ differenceMinor: 0 });
  });
  test("the refusals: NOT_SINGLE_OR_TRIAL · ALREADY_DELIVERED · NOT_LIVE_BOOKING · NO_PRICE_GROUP · SAME_ACTIVITY — each with ZERO writes", async () => {
    const cases: Array<[string, any, any, { status: number; code: string }]> = [
      ["course row", B({ bookingType: "COURSE_PACKAGE" }), { subjectId: ONEW }, { status: 409, code: "NOT_SINGLE_OR_TRIAL" }],
      ["attended", B({ status: "ATTENDED" }), { subjectId: ONEW }, { status: 409, code: "ALREADY_DELIVERED" }],
      ["cancelled", B({ status: "CANCELLED" }), { subjectId: ONEW }, { status: 409, code: "NOT_LIVE_BOOKING" }],
      ["no price group", B(), { subjectId: NOGRP }, { status: 409, code: "NO_PRICE_GROUP" }],
      ["same", B(), { subjectId: BIKE }, { status: 400, code: "SAME_ACTIVITY" }],
    ];
    for (const [name, b, input, want] of cases) {
      const r = await go(b, input);
      expect({ name, ...refusal(r.err), writes: r.writes.length }).toEqual({ name, ...want, writes: 0 });
    }
  });
});

// ───────────────────────────── the lock stays; the routes; the notices ─────────────────────────────
describe("🔒 TASK-961 — the per-session lock still refuses; the act is its OWN function with no flag on the shared path", () => {
  test("`changesCourseSubject` still refuses a course session's subject change (COURSE_SUBJECT_LOCKED path) and is NOT called by the activity acts", () => {
    expect(changesCourseSubject({ courseId: "c1", subjectId: BIKE } as any, ONEW)).toBe(true);
    const S = read("src/services/scheduler.service.ts");
    const acts = S.slice(S.indexOf("async function runCourseActivityChange("), S.indexOf("// ─────────── TASK-439 (REQ-103, SPEC-089 B)"));
    expect(acts).not.toContain("changesCourseSubject");
    expect(S.match(/changesCourseSubject\(/g)!.length).toBeGreaterThanOrEqual(2); // the per-session edit + the plan editor keep calling it
    expect(read("src/lib/course-subject-lock.ts")).toContain("COURSE_SUBJECT_LOCKED");
  });
  test("four routes, validated, behind the SAME gates (course = change-teacher-time's; booking = PATCH /bookings/:id's)", () => {
    const A = read("src/routes/api.ts"), RA = read("src/lib/route-access.ts"), V = read("src/validation.ts");
    for (const p of ['"/courses/:id/change-activity/preview", zValidator("json", v.changeCourseActivity)', '"/courses/:id/change-activity", zValidator("json", v.changeCourseActivity)', '"/bookings/:id/change-activity/preview", zValidator("json", v.changeBookingActivity)', '"/bookings/:id/change-activity", zValidator("json", v.changeBookingActivity)']) expect(A).toContain(p);
    expect(RA).toContain('"POST /courses/:id/change-activity": act(BOOKINGS, "action:bookings.course-plan")');
    expect(RA).toContain('"POST /bookings/:id/change-activity": act(CAL_BOOK, "action:calendar.booking-edit")');
    expect(RA).toContain('"POST /courses/:id/change-activity/preview": act(BOOKINGS, "action:bookings.course-plan")');
    expect(RA).toContain('"POST /bookings/:id/change-activity/preview": act(CAL_BOOK, "action:calendar.booking-edit")');
    expect(V).toContain("export const changeCourseActivity = z.object({ subjectId: ID, teacherId: ID.optional(), manualPriceBaht: z.number().optional() });");
    expect(V).toContain("export const changeBookingActivity = z.object({ subjectId: ID, teacherId: ID.optional() });"); // NO typed price on a 1 HR / Trial
  });
});

describe("📣 TASK-961 — the notices (SPEC §5): ONE message per person per act", () => {
  const rowsOf = (n: number, teacher = T1) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, date: `2026-11-${20 + i}`, startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", teacherId: teacher }));
  const notify = async (a: Partial<Parameters<typeof sched.sendActivityChangedNotices>[1]> & { linked?: boolean }) => {
    const { tx, writes } = fakeTx({ linked: a.linked });
    await sched.sendActivityChangedNotices(tx, { studentIds: ["s1", null], firstRowId: "r0", fromName: "Bike", toName: "Onewheel", firstDate: "2026-11-20", remaining: 4, rows: rowsOf(4), ...a });
    return writes.filter((w) => w.table === "notification_outbox").map((w) => w.v);
  };
  test("coach UNCHANGED: the family gets ONE `activity_changed`, the coach gets ONE `activity_changed` (four rows, one coach ⇒ one message)", async () => {
    const out = await notify({});
    expect(out.map((o) => [o.recipientType, o.payload.kind])).toEqual([["parent", "activity_changed"], ["teacher", "activity_changed"]]);
    expect(out[0]!.payload).toMatchObject({ from: "Bike", to: "Onewheel", firstDate: "2026-11-20", remaining: 4 });
  });
  test("a LINKED household: one row per linked account (here one) — and an unlinked family still leaves ONE skipped row", async () => {
    const linked = await notify({ linked: true });
    expect(linked.filter((o) => o.recipientType === "parent").map((o) => o.status)).toEqual(["PENDING"]);
    expect((await notify({ linked: false })).filter((o) => o.recipientType === "parent").map((o) => o.status)).toEqual(["SKIPPED"]);
  });
  test("two DIFFERENT coaches on the remaining rows (no coach change): each is told ONCE", async () => {
    const out = await notify({ rows: [...rowsOf(2, T1), ...rowsOf(2, T2).map((r, i) => ({ ...r, id: `x${i}` }))] });
    expect(out.filter((o) => o.recipientType === "teacher")).toHaveLength(2);
  });
  test("coach CHANGED: the family one `activity_changed`; the old coach `teacher_unassigned`, the new coach `teacher_assigned` WITH `subjectName` — and NOBODY gets `activity_changed` as a coach", async () => {
    const out = await notify({ newTeacherId: T2 });
    expect(out.map((o) => [o.recipientType, o.payload.kind])).toEqual([["parent", "activity_changed"], ["teacher", "teacher_unassigned"], ["teacher", "teacher_assigned"]]);
    expect(out[2]!.payload.subjectName).toBe("Onewheel");
    expect(out[1]!.payload).not.toHaveProperty("subjectName");
  });
  test("the rendering: ONE Thai sentence (SA-proposed wording), dd-mm-yyyy (no ISO date leaks), EN too; a payload with a hole falls back, never a half sentence", () => {
    const p: any = { kind: "activity_changed", from: "Bike", to: "Onewheel", firstDate: "2026-11-20", remaining: 4 }; // the SPEC's payload names (`from` / `to` are subject NAMES here; the move notices' `from` / `to` are slots)
    const th = buildOutboxMessage(p, {} as any, "TH", "parent");
    expect(th).toBe("เปลี่ยนกิจกรรมจาก Bike เป็น Onewheel ตั้งแต่คาบวันที่ 20-11-2026 (4 คาบ)");
    expect(buildOutboxMessage(p, {} as any, "EN", "parent")).toContain("from Bike to Onewheel");
    expect(th).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(buildOutboxMessage({ ...p, to: undefined }, {} as any, "TH", "parent")).not.toContain("undefined");
    expect(buildOutboxMessage({ ...p, remaining: 0 }, {} as any, "TH", "parent")).not.toContain("0 คาบ");
  });
  test("`teacher_assigned` prints the payload's `subjectName` (the activity the new coach takes over); absent ⇒ the booking's own, as before", () => {
    const base = { kind: "teacher_assigned", bookingId: "b1", sessions: [{ date: "2026-11-20", startTime: "10:00", endTime: "11:00" }] };
    expect(buildOutboxMessage({ ...base, subjectName: "Onewheel" }, { studentName: "Mali", subject: "Bike" } as any, "EN", "teacher")).toContain("Subject: Onewheel");
    expect(buildOutboxMessage(base, { studentName: "Mali", subject: "Bike" } as any, "EN", "teacher")).toContain("Subject: Bike");
  });
});

// ───────────────────────────── the migration ─────────────────────────────
describe("🔒 TASK-961 — migration 0079: the text, the journal, the witness, the schema", () => {
  const MIG = read("drizzle/0079_activity_changes.sql");
  const stmts = MIG.split("--> statement-breakpoint").map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  test("three statements: the table (SPEC §3 columns, both FKs CASCADE, the XOR CHECK), then the two indexes — additive only", () => {
    expect(stmts).toHaveLength(3);
    const T = stmts[0]!;
    expect(T).toMatch(/^CREATE TABLE IF NOT EXISTS "activity_changes"/);
    for (const col of ["course_id", "booking_id", "from_subject_id", "to_subject_id", "from_teacher_id", "to_teacher_id", "remaining", "size", "old_price_minor", "new_price_minor", "price_source", "difference_minor", "revenue_relabelled", "actor", "created_at"]) expect(T).toContain(`"${col}"`);
    expect(T).toContain('"course_id" uuid REFERENCES "course_packages"("id") ON DELETE CASCADE');
    expect(T).toContain('"booking_id" uuid REFERENCES "bookings"("id") ON DELETE CASCADE');
    expect(T).toContain(`CHECK ("price_source" IN ('CARD','MANUAL'))`);
    expect(T).toContain('CHECK (("course_id" IS NULL) <> ("booking_id" IS NULL))');
    expect(stmts[1]).toBe('CREATE INDEX IF NOT EXISTS "activity_changes_course_idx" ON "activity_changes" ("course_id");');
    expect(stmts[2]).toBe('CREATE INDEX IF NOT EXISTS "activity_changes_booking_idx" ON "activity_changes" ("booking_id");');
    expect(MIG).not.toMatch(/DROP |DELETE FROM|TRUNCATE|ALTER TABLE/i);
  });
  test("the journal: idx 79, the tag, a `when` UNIQUE and not above its successors (" + "🔻 TASK-965: 0080 follows)", () => {
    const j = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const last = j.entries.find((e) => e.idx === 79)!; // 🔻 TASK-965: 0080 now follows it
    expect(last).toMatchObject({ idx: 79, tag: "0079_activity_changes" });
    const whens = j.entries.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);
    expect(last.when).toBe(Math.max(...j.entries.filter((e) => e.idx <= 79).map((e) => e.when))); // 🔻 TASK-965: 0080 follows it
  });
  test("the witness is the TABLE", () => {
    expect(SCHEDULING_WITNESSES.find((x) => x.tag === "0079_activity_changes")).toMatchObject({ probe: { kind: "table", table: "activity_changes" }, rerunnable: true });
  });
  test("the schema declares the table with the SAME column names (the seam to the back office: renaming one is a SPEC change)", () => {
    const S = read("src/db/schema.ts");
    for (const c of ['courseId: uuid("course_id")', 'bookingId: uuid("booking_id")', 'fromSubjectId: uuid("from_subject_id")', 'toSubjectId: uuid("to_subject_id")', 'fromTeacherId: uuid("from_teacher_id")', 'toTeacherId: uuid("to_teacher_id")', 'remaining: integer("remaining")', 'size: integer("size")', 'oldPriceMinor: integer("old_price_minor")', 'newPriceMinor: integer("new_price_minor")', 'priceSource: text("price_source")', 'differenceMinor: integer("difference_minor")', 'revenueRelabelled: boolean("revenue_relabelled")', 'actor: text("actor")']) expect(S).toContain(c);
  });
});
