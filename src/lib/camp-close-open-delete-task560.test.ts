// TASK-560 (REQ-110 item 8) — camps: Close / Open, and Delete only when empty. The owner's ruling, complete:
//   Delete ONLY when the camp has NO bookings · otherwise Close = stops NEW bookings only, existing stay · Open re-allows.
// A "camp" is a camp WEEK (`camp_weeks`); a "booking" into it is a `camp_days` row (a child's day on a package).
// 🔑 THE SET of paths that create a booking into a week, derived: `camp_days` has ONE writer, `planDays`, reached from
// exactly TWO routes — `POST /camp/packages` (`createPackage`'s optional first week) and `POST /camp/packages/:id/days`
// (`redeemDays`). A CANCELLED day is final (`assertDayTransition`), so no path revives one. Both routes are driven here.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName, is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as camp from "../services/camp.service";
import * as parentSvc from "../services/parent.service";
import * as sched from "../services/scheduler.service";
import { ROUTE_ACCESS } from "./route-access";

const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

// ───────── a fake transaction over in-memory rows: every WHERE is the service's own, rendered and applied ─────────
const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
type World = { camp_weeks: any[]; camp_days: any[]; camp_week_days: any[]; bookings: any[]; camp_packages: any[]; log: string[]; fkGone?: boolean };
const filterBy = (rows: any[], cond: any) => {
  if (!cond) return rows;
  const { sql, params } = dialect.sqlToQuery(cond);
  const eqs = [...sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)].map((m) => ({ col: camel(m[2]!), vals: [params[Number(m[3]) - 1]] }));
  const ins = [...sql.matchAll(/"(\w+)"\."(\w+)" in \(([^)]*)\)/g)].map((m) => ({ col: camel(m[2]!), vals: m[3]!.split(",").map((p) => params[Number(p.trim().slice(1)) - 1]) }));
  return rows.filter((r) => [...eqs, ...ins].every((c) => c.vals.includes(r[c.col])));
};
const fakeTx = (w: World) => {
  const tbl = (t: any) => getTableName(t) as keyof World;
  return {
    select: (fields?: Record<string, any>) => ({ from: (t: any) => ({ where: (cond: any) => {
      const name = tbl(t);
      const run = async () => {
        w.log.push(`select:${name}`);
        if (fields && Object.values(fields).some((f) => is(f, SQL))) return [{ n: 0 }]; // planDays's planned-units sum
        const rows = filterBy(w[name] as any[], cond);
        return fields ? rows.map((r) => Object.fromEntries(Object.entries(fields).map(([k, col]) => [k, r[camel(col.name)]]))) : rows;
      };
      const p: any = { then: (a: any, b: any) => run().then(a, b), for: (s: string) => { w.log.push(`lock:${name}:${s}`); return run(); } };
      return p;
    } }) }),
    delete: (t: any) => ({ where: async (cond: any) => {
      const name = tbl(t); const gone = new Set(filterBy(w[name] as any[], cond));
      (w as any)[name] = (w[name] as any[]).filter((r) => !gone.has(r)); w.log.push(`delete:${name}:${gone.size}`);
    } }),
    insert: (t: any) => ({ values: (v: any) => {
      const name = tbl(t);
      const done = async () => {
        if (name === "camp_days" && w.fkGone) throw Object.assign(new Error("fk"), { code: "23503" });
        const row = { id: `${name}-${(w[name] as any[]).length + 1}`, ...v }; (w[name] as any[]).push(row); w.log.push(`insert:${name}`); return [row];
      };
      return { then: (a: any, b: any) => done().then(a, b), returning: done };
    } }),
    query: {
      campWeeks: { findFirst: async (q: any) => w.camp_weeks.find((r) => r.id === q.where({ id: "id" }, { eq: (_c: any, v: any) => v })) },
      campPackages: { findFirst: async (q: any) => w.camp_packages.find((r) => r.id === q.where({ id: "id" }, { eq: (_c: any, v: any) => v })) },
    },
  };
};
const run = (w: World) => { spies.push(spyOn(db, "transaction").mockImplementation((async (cb: any) => cb(fakeTx(w))) as any)); return w; };
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return { status: e.status, code: e.code, message: e.message as string }; } return null; };

const WEEK = { id: "w1", name: "Oct Camp", startDate: "2026-10-05", endDate: "2026-10-09", capacity: null, status: "OPEN" };
const world = (over: Partial<World> = {}): World => ({
  camp_weeks: [{ ...WEEK }, { ...WEEK, id: "w2", name: "Other" }],
  camp_days: [], camp_packages: [{ id: "p1", studentId: "s1", totalUnits: 10, usedUnits: 0 }],
  camp_week_days: [{ id: "wd1", campWeekId: "w1" }, { id: "wd2", campWeekId: "w1" }, { id: "wd9", campWeekId: "w2" }],
  bookings: [{ id: "cb1", campWeekDayId: "wd1" }, { id: "cb2", campWeekDayId: "wd2" }, { id: "cb3", campWeekDayId: "wd2" }, { id: "cb9", campWeekDayId: "wd9" }, { id: "b-private", campWeekDayId: null }],
  log: [], ...over,
});
const day = (status: string, weekId = "w1") => ({ id: `d-${status}-${weekId}`, campWeekId: weekId, campPackageId: "p1", date: "2026-10-06", status });

describe("🔴 TASK-560 DELETE — only an EMPTY week, decided by the server AT the act", () => {
  test("empty ⇒ deleted: the week, its day rows and ITS derived coach blocks — nothing of another week, no ordinary booking", async () => {
    const w = run(world());
    expect(await camp.deleteWeek("w1")).toEqual({ deleted: true });
    expect(w.camp_weeks.map((x) => x.id)).toEqual(["w2"]);
    expect(w.camp_week_days.map((x) => x.id)).toEqual(["wd9"]);
    expect(w.bookings.map((x) => x.id)).toEqual(["cb9", "b-private"]);
  });
  test("🔑 the lock comes FIRST, the count second (a count read before the lock is a stale check)", async () => {
    const w = run(world());
    await camp.deleteWeek("w1");
    expect(w.log.filter((x) => x.startsWith("lock:") || x === "select:camp_days")).toEqual(["lock:camp_weeks:update", "select:camp_days"]);
  });
  test("🔑 a booking made while the dialog was open ⇒ REFUSED in words the admin can act on; NOTHING deleted", async () => {
    const w = run(world({ camp_days: [day("PLANNED"), day("CANCELLED")] }));
    const e = await errOf(camp.deleteWeek("w1"));
    expect([e?.status, e?.code]).toEqual([409, "CAMP_WEEK_HAS_BOOKINGS"]);
    expect(e!.message).toContain("Oct Camp");
    expect(e!.message).toContain("1 รายการ และที่ยกเลิกแล้ว 1 รายการ"); // how many, of which kind
    expect(e!.message).toContain('ใช้ "ปิดรับ" แทน'); // what to do instead
    expect([w.camp_weeks.length, w.camp_week_days.length, w.bookings.length]).toEqual([2, 3, 5]);
    expect(w.log.filter((x) => x.startsWith("delete:"))).toEqual([]);
  });
  test("a week whose only days are CANCELLED is NOT empty (history, and the FK is RESTRICT) ⇒ refused", async () => {
    run(world({ camp_days: [day("CANCELLED")] }));
    expect(await errOf(camp.deleteWeek("w1"))).toMatchObject({ code: "CAMP_WEEK_HAS_BOOKINGS" });
  });
  test("another week's days do not block this one; an unknown week ⇒ 404", async () => {
    run(world({ camp_days: [day("PLANNED", "w2")] }));
    expect(await camp.deleteWeek("w1")).toEqual({ deleted: true });
    for (const s of spies.splice(0)) s.mockRestore();
    run(world());
    expect(await errOf(camp.deleteWeek("nope"))).toMatchObject({ status: 404 });
  });
  test("the route takes NO body (no client 'it is empty' to trust) and is gated as open/close are", () => {
    expect(read("src/routes/camp.ts")).toContain('.delete("/weeks/:id", async (c) => c.json(await camp.deleteWeek(c.req.param("id"))))');
    expect(ROUTE_ACCESS["DELETE /camp/weeks/:id"]).toEqual(ROUTE_ACCESS["PATCH /camp/weeks/:id"]);
  });
});

describe("🔴 TASK-560 CLOSE / OPEN — every path that creates a booking into a week, driven", () => {
  const guards = () => {
    spies.push(spyOn(parentSvc, "assertStudentActive").mockImplementation((async () => {}) as any));
    spies.push(spyOn(sched, "assertHouseholdNotSuspended").mockImplementation((async () => {}) as any));
  };
  const input = { weekId: "w1", dates: ["2026-10-06"], half: "FULL" as const };
  const paths: Array<[string, () => Promise<unknown>]> = [
    ["POST /camp/packages/:id/days (redeemDays)", () => camp.redeemDays("p1", input, "admin")],
    ["POST /camp/packages with a first week (createPackage)", () => camp.createPackage({ studentId: "s1", kind: "FULL", plan: "DAILY", days: 5, firstWeek: input, actor: "admin" } as any)],
  ];
  for (const [name, call] of paths) {
    test(`CLOSED ⇒ ${name} refused, nothing written`, async () => {
      const w = run(world({ camp_weeks: [{ ...WEEK, status: "CLOSED" }] })); guards();
      expect(await errOf(call())).toMatchObject({ status: 409, code: "CAMP_WEEK_CLOSED" });
      expect(w.camp_days).toEqual([]);
    });
  }
  test("OPEN (again) ⇒ the same request plans the day", async () => {
    const w = run(world()); guards();
    spies.push(spyOn(db.query.campPackages, "findFirst").mockImplementation((async () => ({ id: "p1", studentId: "s1", totalUnits: 10, usedUnits: 0, days: [] })) as any)); // the DTO read after the tx
    await camp.redeemDays("p1", input, "admin").catch(() => {});
    expect(w.camp_days.map((d) => [d.campWeekId, d.date])).toEqual([["w1", "2026-10-06"]]);
  });
  test("close changes NOTHING existing: the status flip does not touch `camp_days` (the source of every child's booking)", () => {
    const U = read("src/services/camp.service.ts");
    const upd = U.slice(U.indexOf("export async function updateWeek("), U.indexOf("export async function deleteWeek("));
    expect(upd).not.toMatch(/campDays\b/);
  });
  test("🔑 the set is COMPLETE: ONE writer of `camp_days`, reached from exactly two callers", () => {
    const srcFiles = (dir: string): string[] => readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? srcFiles(`${dir}/${d.name}`) : d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [`${dir}/${d.name}`] : []);
    const all = [...srcFiles("src"), ...srcFiles("scripts")].map((f) => [f, read(f)] as const);
    expect(all.filter(([, s]) => /insert\(campDays\)|insert into "?camp_days/i.test(s)).map(([f]) => f)).toEqual(["src/services/camp.service.ts"]);
    const U = read("src/services/camp.service.ts");
    expect(U.match(/insert\(campDays\)/g)!.length).toBe(1);
    expect(U.slice(U.indexOf("export async function planDays("), U.indexOf("export async function redeemDays("))).toContain("insert(campDays)");
    expect([...U.matchAll(/\bplanDays\(tx, /g)].length).toBe(2); // the calls: createPackage + redeemDays (not the definition)
    expect(all.filter(([f, s]) => f !== "src/services/camp.service.ts" && /\bplanDays\(/.test(s))).toEqual([]);
  });
  test("the race's other side: a booking whose week was deleted under it ⇒ an actionable refusal, not a raw FK error", async () => {
    run(world({ fkGone: true })); guards();
    const e = await errOf(camp.redeemDays("p1", input, "admin"));
    expect([e?.status, e?.code]).toEqual([409, "CAMP_WEEK_DELETED"]);
    expect(e!.message).toContain("ถูกลบไปแล้ว");
  });
});
