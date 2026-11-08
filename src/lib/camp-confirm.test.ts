import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { boPayment, boRevenueCategory, boRevenueLine } from "../db/bo-revenue";
import { boMovement } from "../db/schema";
import { ApiException } from "./http";
import { CAMP_CATEGORY, campLineKey, confirmCamp, confirmedOnByPackage } from "./camp-confirm";
import { feeFromMovements, feeKeys, revenueLineKeyFor } from "./payment-record";

// TASK-900 (SPEC-099 §11) — Confirm camp. DB-free: a recording fake stands in for the drizzle executor. The real writers (`writeRevenueLine`, `createSalePayment`)
// run on it, so what is proved is the exact rows they would insert and which of them roll back together.

const PKG = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-11-09";
const RECEIVED = "2026-11-03"; // deliberately NOT today
const SALE = [
  { key: `camp-sale:${PKG}`, valueMinor: 1_000_000 },
  { key: `discount:${PKG}`, valueMinor: -50_000 },
]; // net 950,000

type Rec = { op: string; table?: unknown; values?: any; args: any[]; depth: number };
interface World {
  pkg?: any | null;
  student?: any | null;
  movements?: any[];
  existingLine?: boolean;
  lineInsert?: "ok" | "duplicate" | Error;
  paymentInsert?: "ok" | "duplicate" | Error;
  categoryMissing?: boolean;
}
function fake(w: World = {}) {
  const log: Rec[] = [];
  const events: string[] = [];
  let depth = 0;
  const world: Required<Pick<World, "pkg" | "student" | "movements">> & World = { pkg: { id: PKG, studentId: "s-1" }, student: { nickname: "Pim", name: "Alpha" }, movements: SALE, ...w };
  const respond = (r: Rec): unknown => {
    if (r.op === "insert") {
      const how = r.table === boPayment ? world.paymentInsert : world.lineInsert;
      if (how instanceof Error) throw how;
      if (how === "duplicate") return [];
      return [{ id: "row-1", ...r.values }];
    }
    if (r.table === boMovement) return world.movements;
    if (r.table === boRevenueCategory) return world.categoryMissing ? [] : [{ id: "cat-balance-camp" }];
    if (r.table === boRevenueLine) return world.existingLine ? [{ id: "old-line" }] : [];
    return [];
  };
  const mk = (op: string, args: any[], table?: unknown) => {
    const rec: Rec = { op, args, table, depth };
    log.push(rec);
    const p: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (res: any, rej: any) => Promise.resolve().then(() => respond(rec)).then(res, rej);
          return (...a: any[]) => {
            if (prop === "from") rec.table = a[0];
            if (prop === "values") rec.values = a[0];
            if (prop === "where") (rec as any).where = a[0];
            if (prop === "onConflictDoNothing") (rec as any).conflict = a[0];
            return p;
          };
        },
      },
    );
    return p;
  };
  const query = {
    campPackages: { findFirst: async () => world.pkg ?? undefined },
    students: { findFirst: async () => world.student ?? undefined },
  };
  const tx: any = {
    select: (...a: any[]) => mk("select", a),
    insert: (t: unknown) => mk("insert", [t], t),
    execute: (q: unknown) => {
      log.push({ op: "execute", args: [q], depth });
      return Promise.resolve([]);
    },
    query,
    transaction: async (fn: (t: any) => Promise<unknown>) => {
      const level = depth;
      depth += 1;
      events.push(`begin@${level}`);
      try {
        const out = await fn(tx);
        events.push(`commit@${level}`);
        return out;
      } catch (e) {
        events.push(`rollback@${level}`);
        throw e;
      } finally {
        depth -= 1;
      }
    },
  };
  return { d: tx, log, events, inserts: (t: unknown) => log.filter((r) => r.op === "insert" && r.table === t) };
}

let errors: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = [];
  spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
});
afterEach(() => spy.mockRestore());

const run = (w: World = {}, method: "TRANSFER" | "CASH" | "CARD" = "CASH", receivedOn = RECEIVED) => {
  const f = fake(w);
  return { f, p: confirmCamp(PKG, { receivedOn, method }, f.d, TODAY) };
};
const fails = async (p: Promise<unknown>) => {
  const e: any = await p.then(() => null, (x) => x);
  return e;
};

describe("the key", () => {
  test("a confirmed package owns rl:camp:<packageId>; the fee reads camp-sale:<id> + discount:<id>", () => {
    expect(campLineKey(PKG)).toBe(`rl:camp:${PKG}`);
    expect(revenueLineKeyFor("CAMP", PKG)).toBe(`rl:camp:${PKG}`);
    expect(feeKeys("CAMP", PKG)).toEqual({ sale: `camp-sale:${PKG}`, discount: `discount:${PKG}` });
    expect(feeFromMovements("CAMP", PKG, SALE)).toBe(950_000);
    expect(feeFromMovements("CAMP", PKG, [{ key: `course-sale:${PKG}`, valueMinor: 5 }])).toBeNull(); // a course's sale is not a camp's
  });
  test("pinned to what the camp sale itself posts (camp.service.ts): `camp-sale:${result.id}`", () => {
    const src = readFileSync(new URL("../services/camp.service.ts", import.meta.url), "utf8");
    expect(src).toContain("idempotencyKey: `camp-sale:${result.id}`");
  });
  test("the category is the seeded 'Balance Camp'", () => expect(CAMP_CATEGORY).toBe("Balance Camp"));
});

describe("confirmCamp — the rows", () => {
  test("🔑 the revenue line: key, type COURSE, category Balance Camp, the NET, today (Bangkok), the method, source BOOKING, ref CAMP, branch BRAVO", async () => {
    const { f, p } = run();
    const out = await p;
    const [line] = f.inserts(boRevenueLine);
    expect(line.values).toEqual({
      occurredOn: TODAY,
      branch: "BRAVO",
      type: "COURSE",
      categoryId: "cat-balance-camp",
      productName: "Balance Camp — Pim",
      amountMinor: 950_000,
      method: "CASH",
      source: "BOOKING",
      refType: "CAMP",
      refId: PKG,
      idempotencyKey: `rl:camp:${PKG}`,
      actor: null,
    });
    expect((line as any).conflict).toEqual({ target: boRevenueLine.idempotencyKey });
    expect(out).toEqual({ packageId: PKG, confirmedOn: TODAY, amountMinor: 950_000, method: "CASH" });
  });
  test("🔑 the payment row 1: ref_type CAMP, n 1, paid_on = the DATE RECEIVED, the same net, the same method", async () => {
    const { f, p } = run();
    await p;
    const [pay] = f.inserts(boPayment);
    expect(pay.values).toEqual({ refType: "CAMP", refId: PKG, n: 1, paidOn: RECEIVED, amountMinor: 950_000, method: "CASH", actor: null });
    expect((pay as any).conflict.target).toEqual([boPayment.refType, boPayment.refId, boPayment.n]);
  });
  test("🔑 today vs receivedOn are two different dates: the line counts on TODAY, the payment on the date received", async () => {
    const { f, p } = run({}, "TRANSFER", "2026-10-28");
    const out = await p;
    expect(f.inserts(boRevenueLine)[0].values.occurredOn).toBe(TODAY);
    expect(f.inserts(boPayment)[0].values.paidOn).toBe("2026-10-28");
    expect(out.confirmedOn).toBe(TODAY);
    expect(TODAY).not.toBe("2026-10-28");
  });
  test.each(["TRANSFER", "CASH", "CARD"] as const)("method %s reaches both rows (the line does NOT fall back to TRANSFER)", async (method) => {
    const { f, p } = run({}, method);
    await p;
    expect(f.inserts(boRevenueLine)[0].values.method).toBe(method);
    expect(f.inserts(boPayment)[0].values.method).toBe(method);
  });
  test("the amount is the NET: the sale plus the (negative) discount; with no discount it is the sale", async () => {
    const a = run({ movements: [{ key: `camp-sale:${PKG}`, valueMinor: 400_000 }] });
    expect((await a.p).amountMinor).toBe(400_000);
    expect(a.f.inserts(boPayment)[0].values.amountMinor).toBe(400_000);
  });
  test("no student name ⇒ the product name is just the category; a nickname-less child falls back to the name", async () => {
    const none = run({ student: null });
    await none.p;
    expect(none.f.inserts(boRevenueLine)[0].values.productName).toBe("Balance Camp");
    const named = run({ student: { nickname: null, name: "Alpha" } });
    await named.p;
    expect(named.f.inserts(boRevenueLine)[0].values.productName).toBe("Balance Camp — Alpha");
  });
  test("exactly ONE line and ONE payment, no other insert", async () => {
    const { f, p } = run();
    await p;
    expect(f.log.filter((r) => r.op === "insert").map((r) => r.table)).toEqual([boRevenueLine, boPayment]);
  });
});

describe("confirmCamp — the refusals write NOTHING", () => {
  test("🔑 no posted sale ⇒ 409 NO_FEE; a net of zero (fully discounted) too; a discount alone is not a sale", async () => {
    for (const movements of [[], [{ key: `camp-sale:${PKG}`, valueMinor: 100_000 }, { key: `discount:${PKG}`, valueMinor: -100_000 }], [{ key: `discount:${PKG}`, valueMinor: -5_000 }]]) {
      const { f, p } = run({ movements });
      const e = await fails(p);
      expect([e.status, e.code]).toEqual([409, "NO_FEE"]);
      expect(f.log.some((r) => r.op === "insert")).toBe(false);
    }
  });
  test("🔑 already confirmed (the line exists) ⇒ 409 ALREADY_CONFIRMED, before the fee is even read, nothing inserted", async () => {
    const { f, p } = run({ existingLine: true });
    const e = await fails(p);
    expect([e.status, e.code]).toEqual([409, "ALREADY_CONFIRMED"]);
    expect(f.log.some((r) => r.op === "insert")).toBe(false);
    expect(f.log.some((r) => r.table === boMovement)).toBe(false);
  });
  test("a lost race (the line's unique key refuses our insert) ⇒ 409 ALREADY_CONFIRMED and the payment row is NOT written; the transaction rolls back", async () => {
    const { f, p } = run({ lineInsert: "duplicate" });
    const e = await fails(p);
    expect([e.status, e.code]).toEqual([409, "ALREADY_CONFIRMED"]);
    expect(f.inserts(boPayment)).toHaveLength(0);
    expect(f.events.at(-1)).toBe("rollback@0");
  });
  test("an unknown package ⇒ 404 before any lock or write", async () => {
    const { f, p } = run({ pkg: null });
    const e = await fails(p);
    expect([e.status, e.code]).toEqual([404, "NOT_FOUND"]);
    expect(f.log.filter((r) => r.op === "execute" || r.op === "insert")).toHaveLength(0);
  });
  test.each([
    ["a bad date (2026-02-30)", "2026-02-30", "CASH"],
    ["a malformed date", "3/11/2026", "CASH"],
    ["an empty date", "", "CASH"],
    ["an unknown method", RECEIVED, "BARTER"],
    ["a lower-case method", RECEIVED, "cash"],
  ])("%s ⇒ 400 before the database is touched", async (_n, receivedOn, method) => {
    const f = fake();
    const e = await fails(confirmCamp(PKG, { receivedOn, method: method as never }, f.d, TODAY));
    expect([e.status, e.code]).toEqual([400, "VALIDATION"]);
    expect(f.log).toHaveLength(0);
    expect(f.events).toHaveLength(0);
  });
});

describe("confirmCamp — one transaction", () => {
  test("the advisory lock for THIS package is taken first, inside the transaction, before the line is looked for", async () => {
    const { f, p } = run();
    await p;
    const lock = f.log.findIndex((r) => r.op === "execute");
    const lookup = f.log.findIndex((r) => r.table === boRevenueLine && r.op === "select");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(lookup);
    const q = new PgDialect().sqlToQuery(f.log[lock].args[0] as any);
    expect(q.sql).toContain("pg_advisory_xact_lock");
    expect(q.params).toEqual([`camp-confirm:${PKG}`]);
  });
  test("🔑 if the PAYMENT write fails the whole confirm rolls back (and the error is not swallowed): the outer transaction ends in rollback", async () => {
    const { f, p } = run({ paymentInsert: new Error("relation bo.payment does not exist") });
    const e = await fails(p);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain("payment row was not written");
    expect(f.events.at(-1)).toBe("rollback@0");
    expect(f.inserts(boRevenueLine)).toHaveLength(1); // the line WAS attempted inside the same transaction — and is rolled back with it
  });
  test("🔑 if the LINE write fails nothing else is written and the confirm rolls back", async () => {
    const { f, p } = run({ lineInsert: new Error("boom") });
    const e = await fails(p);
    expect(e.message).toContain("revenue line was not written");
    expect(f.inserts(boPayment)).toHaveLength(0);
    expect(f.events.at(-1)).toBe("rollback@0");
  });
  test("both writes happen on the SAME transaction handle (one begin, one commit at the top level)", async () => {
    const { f, p } = run();
    await p;
    expect(f.events.filter((e) => e.endsWith("@0"))).toEqual(["begin@0", "commit@0"]);
  });
  test("a payment row that already exists is not an error (the confirm still completes)", async () => {
    const { p } = run({ paymentInsert: "duplicate" });
    expect((await p).amountMinor).toBe(950_000);
  });
});

describe("confirmedOnByPackage — the list's `confirmedOn`", () => {
  const listFake = (rows: { key: string; occurredOn: string }[]) => {
    const seen: any[] = [];
    const d: any = {
      select: (...a: any[]) => {
        const rec: any = { args: a };
        seen.push(rec);
        const p: any = new Proxy({}, { get: (_t, prop: string) => (prop === "then" ? (res: any) => Promise.resolve(rows).then(res) : (...x: any[]) => ((rec[prop] = x), p)) });
        return p;
      },
    };
    return { d, seen };
  };
  test("an empty list asks nothing", async () => {
    const { d, seen } = listFake([]);
    expect((await confirmedOnByPackage([], d)).size).toBe(0);
    expect(seen).toHaveLength(0);
  });
  test("one query for the whole list: a confirmed package maps to its line's occurred_on, an unconfirmed one is absent", async () => {
    const B = "22222222-2222-4222-8222-222222222222";
    const { d, seen } = listFake([{ key: `rl:camp:${PKG}`, occurredOn: "2026-11-09" }]);
    const m = await confirmedOnByPackage([PKG, B], d);
    expect(m.get(PKG)).toBe("2026-11-09");
    expect(m.has(B)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(seen[0].where[0]).params).toEqual([`rl:camp:${PKG}`, `rl:camp:${B}`]);
  });
  test("another package's line (a different key) never confirms this one", async () => {
    const { d } = listFake([{ key: `rl:course:${PKG}`, occurredOn: "2026-11-09" }]);
    expect((await confirmedOnByPackage([PKG], d)).size).toBe(0);
  });
});

describe("the file's reach", () => {
  const src = readFileSync(new URL("./camp-confirm.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  test("it reuses the two writers: it inserts nothing itself, deletes nothing, and uses no raw SQL but the advisory lock", () => {
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(src).toContain("writeRevenueLine(");
    expect(src).toContain("createSalePayment(");
    expect((src.match(/sql`/g) ?? []).length).toBe(1);
  });
  test("a camp confirm sends no LINE message", () => {
    expect(src).not.toMatch(/enqueueLine|notify|outbox/i);
  });
});

// ───────────────────────────────── the shared hunks (TASK-900, claim granted 2026-11-09) ─────────────────────────────────
describe("the route, the access table and the list (the shared files)", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

  test("🔑 route-access: POST /camp/packages/:id/confirm = act(menu:camp, action:camp.sell), the same right as selling; no new key", async () => {
    const { ROUTE_ACCESS } = await import("./route-access");
    expect(ROUTE_ACCESS["POST /camp/packages/:id/confirm"]).toEqual({ menus: ["menu:camp"], action: "action:camp.sell" });
    expect(ROUTE_ACCESS["POST /camp/packages/:id/confirm"]).toEqual(ROUTE_ACCESS["POST /camp/packages"]);
  });
  test("camp.ts has exactly one confirm route, validated for receivedOn and method, calling confirmCamp", () => {
    const src = read("../routes/camp.ts");
    expect((src.match(/\.post\("\/packages\/:id\/confirm"/g) ?? []).length).toBe(1);
    expect(src).toContain('zValidator("json", confirmCampBody)');
    expect(src).toContain("confirmCamp(c.req.param(\"id\"), c.req.valid(\"json\"))");
    expect(src).toContain('method: z.enum(["TRANSFER", "CASH", "CARD"])');
  });
  test("the confirm route refuses a bad body with 400 VALIDATION before anything is read (the DB is never reached)", async () => {
    const { campRoutes } = await import("../routes/camp");
    const post = (body: unknown) =>
      campRoutes.request(`/packages/${PKG}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [{}, { receivedOn: "2026-11-03" }, { method: "CASH" }, { receivedOn: "3/11/2026", method: "CASH" }, { receivedOn: "2026-11-03", method: "BARTER" }, { receivedOn: 20261103, method: "CASH" }]) {
      const r = await post(body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe("VALIDATION");
    }
  });
  test("🔑 the route end to end, DB-free (db.transaction handed the recording fake): 200 { packageId, confirmedOn, amountMinor, method }; a repeat is 409", async () => {
    const { db } = await import("../db");
    const { campRoutes } = await import("../routes/camp");
    const f1 = fake();
    const sp = spyOn(db, "transaction").mockImplementation(((fn: any) => fn(f1.d)) as any);
    try {
      const r = await campRoutes.request(`/packages/${PKG}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receivedOn: RECEIVED, method: "CARD" }) });
      expect(r.status).toBe(200);
      const body: any = await r.json();
      expect(Object.keys(body).sort()).toEqual(["amountMinor", "confirmedOn", "method", "packageId"]);
      expect([body.packageId, body.amountMinor, body.method]).toEqual([PKG, 950_000, "CARD"]);
      expect(body.confirmedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/); // today (Bangkok) of the machine running the test
      expect(f1.inserts(boPayment)[0].values.paidOn).toBe(RECEIVED);
      // a package that already has its line: the route answers 409 ALREADY_CONFIRMED
      const f2 = fake({ existingLine: true });
      sp.mockImplementation(((fn: any) => fn(f2.d)) as any);
      const { Hono } = await import("hono");
      const { errorEnvelope } = await import("./http");
      const wrapped = new Hono();
      wrapped.onError((err, c) => {
        const { status, body } = errorEnvelope(err);
        return c.json(body, status as 400);
      });
      wrapped.route("/camp", campRoutes);
      const again = await wrapped.request(`/camp/packages/${PKG}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receivedOn: RECEIVED, method: "CARD" }) });
      expect([again.status, ((await again.json()) as any).error.code]).toEqual([409, "ALREADY_CONFIRMED"]);
    } finally {
      sp.mockRestore();
    }
  });
  test("the single-package answers (sale, redeem, scans) carry NO confirmedOn rather than a false null: packageDTO is untouched", () => {
    const src = read("../services/camp.service.ts");
    const fn = src.slice(src.indexOf("async function packageDTO("), src.indexOf("export async function listPackages("));
    expect(fn).not.toContain("confirmedOn");
    expect(fn).toContain("return toPackageDTO(p, days);");
    expect(src).toContain("...(opts.confirmedOn !== undefined ? { confirmedOn: opts.confirmedOn } : {})");
  });
  test("the list asks the ledger ONCE for all its packages", () => {
    const src = read("../services/camp.service.ts");
    const fn = src.slice(src.indexOf("export async function listPackages("), src.indexOf("/**\n * The SALE"));
    expect((fn.match(/confirmedOnByPackage\(/g) ?? []).length).toBe(1);
    expect(fn).toContain("confirmedOnByPackage(ids)");
  });
});

describe("GET /camp/packages — `confirmedOn` in the list, on the REAL listPackages (db stubbed)", () => {
  const { db } = require("../db") as typeof import("../db");
  const spies: ReturnType<typeof spyOn>[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });
  const PKG2 = "22222222-2222-4222-8222-222222222222";
  const pkg = (id: string, at: string) => ({ id, studentId: "s1", kind: "FULL", plan: "FULL_WEEK", totalUnits: 10, usedUnits: 0, createdAt: new Date(at) });
  const world = (rows: { key: string; occurredOn: string }[]) => {
    const asked: any[] = [];
    spies.push(spyOn(db.query.campPackages, "findMany").mockImplementation((async () => [pkg(PKG, "2026-10-02T00:00:00Z"), pkg(PKG2, "2026-10-01T00:00:00Z")]) as any));
    spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => []) as any));
    spies.push(
      spyOn(db, "select").mockImplementation(((...a: any[]) => {
        asked.push(a);
        return { from: () => ({ where: async () => rows }) };
      }) as any),
    );
    return asked;
  };

  test("🔑 a confirmed package carries its line's date, an unconfirmed one carries null; ONE ledger query for the whole list", async () => {
    const asked = world([{ key: `rl:camp:${PKG}`, occurredOn: "2026-11-09" }]);
    const { listPackages } = await import("../services/camp.service");
    const { packages } = await listPackages("s1");
    expect(packages.map((p: any) => [p.id, p.confirmedOn])).toEqual([[PKG, "2026-11-09"], [PKG2, null]]);
    expect(asked).toHaveLength(1);
  });
  test("an empty student list asks nothing of the ledger and returns []", async () => {
    const asked = world([]);
    spies.push(spyOn(db.query.campPackages, "findMany").mockImplementation((async () => []) as any));
    const { listPackages } = await import("../services/camp.service");
    expect((await listPackages("s1")).packages).toEqual([]);
    expect(asked).toHaveLength(0);
  });
  test("the other fields of the package DTO are untouched by it (only `confirmedOn` was added)", async () => {
    world([]);
    const { listPackages } = await import("../services/camp.service");
    const p: any = (await listPackages("s1")).packages[0];
    const { confirmedOn, ...rest } = p;
    expect(confirmedOn).toBeNull();
    expect(Object.keys(rest).sort()).toEqual(["createdAt", "createdBy", "credit", "days", "discount", "id", "kind", "note", "plan", "plannedUnits", "saleId", "studentId", "totalUnits", "usedUnits"]);
  });
});
