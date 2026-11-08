import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { boPayment, boRevenueLine } from "../db/bo-revenue";
import { boMovement } from "../db/schema";
import { courseSaleKeys, voucherLine } from "./booking-sale-amount";
import {
  addInstallment,
  createSalePayment,
  createSalePaymentFromPosted,
  feeFromMovements,
  feeKeys,
  followsRevenueLine,
  installmentsFit,
  listPayments,
  patchPayment,
  paymentTotals,
  revenueLineKeyFor,
} from "./payment-record";

// TASK-875 — the payment record, DB-free. A recording fake stands in for the drizzle executor: it proves WHAT is written, in
// which order, and which rule refuses. It cannot prove the SQL or the unique index — that is the sid run in the DoD.

type Rec = Record<string, any[]> & { _op: string };
function fakeExec(results: unknown[]) {
  const chains: Rec[] = [];
  const executes: unknown[] = [];
  let transactions = 0;
  const next = () => {
    const r = results.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  const chain = (op: string, args: any[]) => {
    const rec = { _op: op, [op]: args } as Rec;
    chains.push(rec);
    const proxy: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (res: any, rej: any) => Promise.resolve().then(next).then(res, rej);
          return (...a: any[]) => {
            rec[prop] = a;
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const exec: any = {
    select: (...a: any[]) => chain("select", a),
    insert: (...a: any[]) => chain("insert", a),
    update: (...a: any[]) => chain("update", a),
    execute: async (q: unknown) => void executes.push(q),
    transaction: async (fn: (tx: any) => Promise<unknown>) => {
      transactions++;
      return fn(exec);
    },
  };
  return {
    exec,
    chains,
    executes,
    transactionCount: () => transactions,
    of: (op: string, table?: unknown) => chains.filter((c) => c._op === op && (table === undefined || c[op]?.[0] === table || c.from?.[0] === table)),
  };
}
const sqlOf = (x: any) => new PgDialect().sqlToQuery(x);

let errors: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = [];
  spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
});
afterEach(() => spy.mockRestore());

const C = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const ROW = (o: Record<string, unknown> = {}) => ({
  id: "p-1",
  refType: "COURSE",
  refId: C,
  n: 1,
  paidOn: "2026-11-08",
  amountMinor: 100000,
  method: "TRANSFER",
  actor: null,
  createdAt: new Date("2026-11-08T03:00:00Z"),
  updatedAt: new Date("2026-11-08T03:00:00Z"),
  ...o,
});
const SALE = (id = C, v = 100000) => ({ key: `course-sale:${id}`, valueMinor: v });
const DISC = (id = C, v = -10000) => ({ key: `discount:${id}`, valueMinor: v });

// ───────────────── the twin: pinned to BB's formats (golden vectors) and to what SB itself writes ─────────────────
describe("the pure rules — the same formats as BB's lib/revenue-ledger.ts", () => {
  test("golden vectors: movement keys and the revenue-line key", () => {
    expect(feeKeys("COURSE", "abc")).toEqual({ sale: "course-sale:abc", discount: "discount:abc" });
    expect(feeKeys("VOUCHER", "abc")).toEqual({ sale: "voucher-sale:abc", discount: "discount:abc" });
    expect(revenueLineKeyFor("COURSE", "abc")).toBe("rl:course:abc");
    expect(revenueLineKeyFor("VOUCHER", "abc")).toBe("rl:voucher:abc");
  });
  test("pinned to what SB's OWN writers use: TASK-864's course keys, voucherLine's key, and createVoucher's sale key", () => {
    expect(courseSaleKeys(C)).toEqual([feeKeys("COURSE", C).sale, feeKeys("COURSE", C).discount]);
    expect(voucherLine({ id: V, hours: 10, who: "x" }, 0)?.idempotencyKey).toBe(revenueLineKeyFor("VOUCHER", V));
    const sched = readFileSync(new URL("../services/scheduler.service.ts", import.meta.url), "utf8");
    expect(sched).toContain("idempotencyKey: `voucher-sale:${result.voucher.id}`");
    expect(sched).toContain("`course-sale:");
  });
  test("fee = sale + discount; null with no sale movement (a discount alone is not a fee)", () => {
    expect(feeFromMovements("COURSE", C, [SALE(), DISC()])).toBe(90000);
    expect(feeFromMovements("COURSE", C, [SALE()])).toBe(100000);
    expect(feeFromMovements("COURSE", C, [DISC()])).toBeNull();
    expect(feeFromMovements("COURSE", C, [])).toBeNull();
    expect(feeFromMovements("COURSE", C, [SALE("other"), DISC("other")])).toBeNull(); // another sale's movements
    expect(feeFromMovements("VOUCHER", V, [{ key: `voucher-sale:${V}`, valueMinor: 50000 }, DISC(V, -5000)])).toBe(45000);
    expect(feeFromMovements("VOUCHER", V, [{ key: `course-sale:${V}`, valueMinor: 50000 }])).toBeNull(); // wrong kind of sale
  });
  test("only row 1's METHOD follows the line", () => {
    expect(followsRevenueLine(1, { method: "CASH" })).toBe(true);
    expect(followsRevenueLine(2, { method: "CASH" })).toBe(false);
    expect(followsRevenueLine(1, { amountMinor: 5 })).toBe(false);
    expect(followsRevenueLine(1, { paidOn: "2026-01-01" })).toBe(false);
    expect(followsRevenueLine(1, {})).toBe(false);
  });
  test("installments fit up to the fee, exactly, and not a satang over", () => {
    expect(installmentsFit(90000, [40000, 50000])).toBe(true);
    expect(installmentsFit(90000, [40000, 50001])).toBe(false);
    expect(installmentsFit(90000, [])).toBe(true);
  });
  test("totals: paid = Σ rows, remaining = fee − paid, null without a fee", () => {
    expect(paymentTotals(90000, [40000, 20000])).toEqual({ feeMinor: 90000, paidMinor: 60000, remainingMinor: 30000 });
    expect(paymentTotals(null, [40000])).toEqual({ feeMinor: null, paidMinor: 40000, remainingMinor: null });
    expect(paymentTotals(90000, [])).toEqual({ feeMinor: 90000, paidMinor: 0, remainingMinor: 90000 });
  });
});

// ─────────────────────────────────────────────── the auto row at the sale ───────────────────────────────────────────────
describe("createSalePayment — the sale's own row 1", () => {
  test("one row: n=1, the net, TRANSFER, the given date, no actor, ON CONFLICT on (ref_type, ref_id, n)", async () => {
    const f = fakeExec([[{ id: "p" }]]);
    expect(await createSalePayment("COURSE", C, 90000, f.exec, "2026-11-08")).toEqual({ ok: true });
    const [ins] = f.of("insert", boPayment);
    expect(ins.values[0]).toEqual({ refType: "COURSE", refId: C, n: 1, paidOn: "2026-11-08", amountMinor: 90000, method: "TRANSFER", actor: null });
    expect(ins.onConflictDoNothing[0].target).toEqual([boPayment.refType, boPayment.refId, boPayment.n]);
  });
  test("the date defaults to the Bangkok calendar date", async () => {
    const f = fakeExec([[{ id: "p" }]]);
    await createSalePayment("VOUCHER", V, 1000, f.exec);
    expect(f.of("insert", boPayment)[0].values[0].paidOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test("a replayed sale: the conflict inserts nothing → a success marked duplicate, no noise", async () => {
    const f = fakeExec([[]]);
    expect(await createSalePayment("COURSE", C, 90000, f.exec, "2026-11-08")).toEqual({ ok: true, skipped: "duplicate" });
    expect(errors).toEqual([]);
  });
  test.each([0, -1, 1.5, Number.NaN])("amount %p is refused before any query, loudly", async (amt) => {
    const f = fakeExec([]);
    expect(await createSalePayment("COURSE", C, amt, f.exec)).toEqual({ ok: false, skipped: "bad-amount" });
    expect(f.chains).toHaveLength(0);
    expect(errors.join("\n")).toContain(`payment:COURSE:${C}`);
  });
  test("a failing insert NEVER throws (the sale is safe) and is logged with the ref", async () => {
    const f = fakeExec([new Error("relation bo.payment does not exist")]);
    expect(await createSalePayment("COURSE", C, 90000, f.exec, "2026-11-08")).toEqual({ ok: false, skipped: "error" });
    expect(errors.join("\n")).toContain("NOT WRITTEN");
    expect(errors.join("\n")).toContain(C);
  });
});

// ───────────────────────────────────────────────────────── GET ─────────────────────────────────────────────────────────
describe("listPayments", () => {
  test("rows by n with the fee, paid and remaining; the DTO has exactly the §8.5 fields", async () => {
    const f = fakeExec([[ROW(), ROW({ id: "p-2", n: 2, amountMinor: 30000 })], [SALE(), DISC()]]);
    const out = await listPayments("COURSE", C, f.exec);
    expect(out).toMatchObject({ feeMinor: 90000, paidMinor: 130000, remainingMinor: -40000 }); // the rows are what the fake says; the math is the pure rule's
    expect(Object.keys(out.payments[0]).sort()).toEqual(["amountMinor", "id", "method", "n", "paidOn", "refId", "refType", "updatedAt"]);
    expect(out.payments[0].updatedAt).toBe("2026-11-08T03:00:00.000Z");
    expect(f.of("select", boPayment)[0].orderBy).toBeDefined();
  });
  test("no fee → feeMinor and remainingMinor are null (the card shows the rows only)", async () => {
    const f = fakeExec([[ROW()], []]);
    expect(await listPayments("COURSE", C, f.exec)).toMatchObject({ feeMinor: null, paidMinor: 100000, remainingMinor: null });
  });
  test("the fee is read from the movement keys of THIS sale only", async () => {
    const f = fakeExec([[], []]);
    await listPayments("VOUCHER", V, f.exec);
    const mv = f.of("select", boMovement)[0];
    const q = sqlOf(mv.where[0]);
    expect(q.params).toEqual([`voucher-sale:${V}`, `discount:${V}`]);
  });
});

// ──────────────────────────────────────────────────── POST (installment) ────────────────────────────────────────────────────
describe("addInstallment", () => {
  const input = { refType: "COURSE" as const, refId: C, paidOn: "2026-11-20", amountMinor: 40000, method: "CASH" as const };

  test("n = max + 1, the actor, all in ONE transaction with the sale's advisory lock taken first", async () => {
    const f = fakeExec([[SALE(), DISC()], [{ n: 1, amountMinor: 40000 }], [ROW({ id: "p-2", n: 2, amountMinor: 40000, method: "CASH" })]]);
    const dto = await addInstallment(input, "staff-7", f.exec);
    expect(f.transactionCount()).toBe(1);
    expect(f.executes).toHaveLength(1);
    expect(sqlOf(f.executes[0]).sql).toContain("pg_advisory_xact_lock");
    expect(sqlOf(f.executes[0]).params).toEqual([`payment:COURSE:${C}`]);
    expect(f.of("insert", boPayment)[0].values[0]).toEqual({ refType: "COURSE", refId: C, n: 2, paidOn: "2026-11-20", amountMinor: 40000, method: "CASH", actor: "staff-7" });
    expect(dto).toMatchObject({ n: 2, amountMinor: 40000, method: "CASH" });
  });
  test("gaps are not refilled: rows 1 and 3 → the next is 4", async () => {
    const f = fakeExec([[SALE()], [{ n: 1, amountMinor: 10000 }, { n: 3, amountMinor: 10000 }], [ROW({ n: 4 })]]);
    await addInstallment(input, null, f.exec);
    expect(f.of("insert", boPayment)[0].values[0].n).toBe(4);
  });
  test("409 NO_FEE with no posted sale movement — and nothing is inserted", async () => {
    const f = fakeExec([[]]);
    const e: any = await addInstallment(input, null, f.exec).catch((x) => x);
    expect([e.status, e.code]).toEqual([409, "NO_FEE"]);
    expect(f.of("insert")).toHaveLength(0);
  });
  test("400 when the rows would exceed the fee by one satang; exactly the fee is fine", async () => {
    const over = fakeExec([[SALE(), DISC()], [{ n: 1, amountMinor: 50001 }]]);
    const e: any = await addInstallment(input, null, over.exec).catch((x) => x);
    expect(e.status).toBe(400);
    expect(over.of("insert")).toHaveLength(0);
    const exact = fakeExec([[SALE(), DISC()], [{ n: 1, amountMinor: 50000 }], [ROW({ n: 2 })]]);
    await addInstallment(input, null, exact.exec);
    expect(exact.of("insert", boPayment)).toHaveLength(1);
  });
  test("a lost race on n (unique violation 23505) is a 409 CONFLICT, any other error passes through", async () => {
    const f = fakeExec([[SALE()], [], Object.assign(new Error("dup"), { code: "23505" })]);
    const e: any = await addInstallment(input, null, f.exec).catch((x) => x);
    expect([e.status, e.code]).toEqual([409, "CONFLICT"]);
    const g = fakeExec([[SALE()], [], new Error("boom")]);
    expect(((await addInstallment(input, null, g.exec).catch((x) => x)) as Error).message).toBe("boom");
  });
  test("a voucher's message says voucher", async () => {
    const f = fakeExec([[{ key: `voucher-sale:${V}`, valueMinor: 100 }], []]);
    const e: any = await addInstallment({ ...input, refType: "VOUCHER", refId: V, amountMinor: 101 }, null, f.exec).catch((x) => x);
    expect(e.message).toContain("voucher");
  });
});

// ──────────────────────────────────────────────────────── PATCH ────────────────────────────────────────────────────────
describe("patchPayment", () => {
  test("404 for an unknown id; nothing is updated", async () => {
    const f = fakeExec([[]]);
    const e: any = await patchPayment("nope", { method: "CASH" }, null, f.exec).catch((x) => x);
    expect(e.status).toBe(404);
    expect(f.of("update")).toHaveLength(0);
  });
  test("404 when the row vanished between the first read and the lock (re-read under the lock)", async () => {
    const f = fakeExec([[ROW()], []]);
    const e: any = await patchPayment("p-1", { method: "CASH" }, null, f.exec).catch((x) => x);
    expect(e.status).toBe(404);
    expect(f.executes).toHaveLength(1);
  });
  test("ROW 1's method: the payment AND the revenue line change in ONE transaction; the line is found by its key", async () => {
    const f = fakeExec([[ROW()], [ROW()], [ROW({ method: "CASH" })], undefined]);
    const dto = await patchPayment("p-1", { method: "CASH" }, "staff-7", f.exec);
    expect(f.transactionCount()).toBe(1);
    expect(dto.method).toBe("CASH");
    const [pay] = f.of("update", boPayment);
    expect(pay.set[0]).toMatchObject({ method: "CASH", actor: "staff-7" });
    expect(pay.set[0].updatedAt).toBeInstanceOf(Date);
    const [line] = f.of("update", boRevenueLine);
    expect(line.set[0]).toEqual({ method: "CASH" });
    expect(sqlOf(line.where[0]).params).toEqual([`rl:course:${C}`]);
  });
  test("an INSTALLMENT's method change never touches the revenue line", async () => {
    const f = fakeExec([[ROW({ n: 2 })], [ROW({ n: 2 })], [ROW({ n: 2, method: "CARD" })]]);
    await patchPayment("p-1", { method: "CARD" }, null, f.exec);
    expect(f.of("update", boRevenueLine)).toHaveLength(0);
  });
  test("row 1's AMOUNT or DATE change (no method) never touches the line either", async () => {
    const amount = fakeExec([[ROW()], [ROW()], [SALE(), DISC()], [], [ROW({ amountMinor: 90000 })]]);
    await patchPayment("p-1", { amountMinor: 90000 }, null, amount.exec);
    expect(amount.of("update", boRevenueLine)).toHaveLength(0);
    const date = fakeExec([[ROW()], [ROW()], [ROW({ paidOn: "2026-11-09" })]]);
    await patchPayment("p-1", { paidOn: "2026-11-09" }, null, date.exec);
    expect(date.of("update", boRevenueLine)).toHaveLength(0);
  });
  test("a VOUCHER's row 1 moves rl:voucher:<id>", async () => {
    const r = ROW({ refType: "VOUCHER", refId: V });
    const f = fakeExec([[r], [r], [{ ...r, method: "CARD" }], undefined]);
    await patchPayment("p-1", { method: "CARD" }, null, f.exec);
    expect(sqlOf(f.of("update", boRevenueLine)[0].where[0]).params).toEqual([`rl:voucher:${V}`]);
  });
  test("§8.9: row 1's AMOUNT is editable (no 400) while the sum stays within the fee", async () => {
    const f = fakeExec([[ROW()], [ROW()], [SALE(), DISC()], [{ amountMinor: 30000 }], [ROW({ amountMinor: 60000 })]]);
    expect((await patchPayment("p-1", { amountMinor: 60000 }, null, f.exec)).amountMinor).toBe(60000);
  });
  test("400 when an edited amount pushes the sum over the fee (the OTHER rows count, the edited row's old amount does not)", async () => {
    const f = fakeExec([[ROW()], [ROW()], [SALE(), DISC()], [{ amountMinor: 30000 }]]);
    const e: any = await patchPayment("p-1", { amountMinor: 60001 }, null, f.exec).catch((x) => x);
    expect(e.status).toBe(400);
    expect(f.of("update")).toHaveLength(0);
    const ok = fakeExec([[ROW()], [ROW()], [SALE(), DISC()], [{ amountMinor: 30000 }], [ROW({ amountMinor: 60000 })]]);
    await patchPayment("p-1", { amountMinor: 60000 }, null, ok.exec);
    expect(ok.of("update", boPayment)).toHaveLength(1);
  });
  test("the 'other rows' query is this sale's rows EXCEPT the edited one (<>), nobody else's", async () => {
    const f = fakeExec([[ROW()], [ROW()], [SALE()], [], [ROW()]]);
    await patchPayment("p-1", { amountMinor: 1 }, null, f.exec);
    const others = f.of("select", boPayment)[2]; // the 1st is the lookup, the 2nd the re-read, the 3rd the others
    const q = sqlOf(others.where[0]);
    expect(q.sql).toContain('"id" <> $3');
    expect(q.params).toEqual(["COURSE", C, "p-1"]);
  });
  test("409 NO_FEE for an amount edit on a sale with no posted fee; a METHOD edit needs no fee", async () => {
    const f = fakeExec([[ROW()], [ROW()], []]);
    const e: any = await patchPayment("p-1", { amountMinor: 5 }, null, f.exec).catch((x) => x);
    expect([e.status, e.code]).toEqual([409, "NO_FEE"]);
    const g = fakeExec([[ROW()], [ROW()], [ROW({ method: "CARD" })], undefined]);
    await patchPayment("p-1", { method: "CARD" }, null, g.exec);
    expect(g.of("select", boMovement)).toHaveLength(0);
  });
  test("only the sent fields are set (plus actor and updatedAt)", async () => {
    const f = fakeExec([[ROW()], [ROW()], [ROW({ paidOn: "2026-12-01" })]]);
    await patchPayment("p-1", { paidOn: "2026-12-01" }, "a", f.exec);
    expect(Object.keys(f.of("update", boPayment)[0].set[0]).sort()).toEqual(["actor", "paidOn", "updatedAt"]);
  });
});

// ─────────────────────────────────── the file never writes anything it should not ───────────────────────────────────
describe("the file's reach", () => {
  const src = readFileSync(new URL("./payment-record.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  test("it never deletes, and it writes only bo.payment and (row 1's method) bo.revenue_line", () => {
    expect(src).not.toMatch(/\.delete\(/);
    expect(src.match(/\.insert\(([A-Za-z]+)\)/g)).toEqual([".insert(boPayment)", ".insert(boPayment)"]);
    expect(src.match(/\.update\(([A-Za-z]+)\)/g)).toEqual([".update(boPayment)", ".update(boRevenueLine)"]);
  });
});

// ───────────────────────────────── the sale paths' call: createSalePaymentFromPosted + the wiring ─────────────────────────────────
describe("createSalePaymentFromPosted — row 1 from the movements the sale POSTED", () => {
  const NOW = { attempts: 3, delayMs: 0 };

  test("amount = sale + discount read from the movements; one row, TRANSFER, n 1", async () => {
    const f = fakeExec([[SALE(), DISC()], [{ id: "p" }]]);
    expect(await createSalePaymentFromPosted("COURSE", C, f.exec, NOW)).toEqual({ ok: true });
    expect(f.of("insert", boPayment)[0].values[0]).toMatchObject({ refType: "COURSE", refId: C, n: 1, amountMinor: 90000, method: "TRANSFER", actor: null });
  });
  test("a voucher reads voucher-sale:<id> (and its discount)", async () => {
    const f = fakeExec([[{ key: `voucher-sale:${V}`, valueMinor: 50000 }, DISC(V, -5000)], [{ id: "p" }]]);
    await createSalePaymentFromPosted("VOUCHER", V, f.exec, NOW);
    expect(f.of("insert", boPayment)[0].values[0]).toMatchObject({ refType: "VOUCHER", refId: V, amountMinor: 45000 });
  });
  test("🔑 it WAITS for a movement that has not landed yet: empty, empty, then posted → the row is written", async () => {
    const f = fakeExec([[], [], [SALE()], [{ id: "p" }]]);
    expect(await createSalePaymentFromPosted("COURSE", C, f.exec, NOW)).toEqual({ ok: true });
    expect(f.of("select", boMovement)).toHaveLength(3);
    expect(f.of("insert", boPayment)[0].values[0].amountMinor).toBe(100000);
  });
  test("it gives up after `attempts` reads, loudly, with NO row and no throw (the API will answer NO_FEE)", async () => {
    const f = fakeExec([[], [], []]);
    expect(await createSalePaymentFromPosted("COURSE", C, f.exec, NOW)).toEqual({ ok: false, skipped: "error" });
    expect(f.of("select", boMovement)).toHaveLength(3);
    expect(f.of("insert")).toHaveLength(0);
    expect(errors.join("\n")).toContain(`payment:COURSE:${C}`);
    expect(errors.join("\n")).toContain("NOT WRITTEN");
  });
  test("a read that THROWS gives up at once (no retry loop on a broken database) and never throws", async () => {
    const f = fakeExec([new Error("connection refused")]);
    expect(await createSalePaymentFromPosted("COURSE", C, f.exec, NOW)).toEqual({ ok: false, skipped: "error" });
    expect(f.of("select", boMovement)).toHaveLength(1);
    expect(errors.join("\n")).toContain("could not read the posted sale");
  });
  test("a replayed sale: the row exists → a success marked duplicate, still one row", async () => {
    const f = fakeExec([[SALE()], []]);
    expect(await createSalePaymentFromPosted("COURSE", C, f.exec, NOW)).toEqual({ ok: true, skipped: "duplicate" });
  });
  test("the waits are real: 3 attempts 30 ms apart take at least two waits (≥ 50 ms) before it gives up", async () => {
    const f = fakeExec([[], [], []]);
    const t0 = Date.now();
    await createSalePaymentFromPosted("COURSE", C, f.exec, { attempts: 3, delayMs: 30 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    const g = fakeExec([[]]);
    const t1 = Date.now();
    await createSalePaymentFromPosted("COURSE", C, g.exec, { attempts: 1, delayMs: 500 });
    expect(Date.now() - t1).toBeLessThan(400); // the last attempt is not followed by a wait
  });
  test("the DEFAULT is patient enough for a recordSale that lands a moment later (6 attempts, 250 ms apart)", async () => {
    const f = fakeExec([[], [SALE()], [{ id: "p" }]]);
    expect(await createSalePaymentFromPosted("COURSE", C, f.exec)).toEqual({ ok: true });
  });
  test("a NEGATIVE net (a discount larger than the sale) writes no row; it is never turned positive", async () => {
    const f = fakeExec([[SALE(C, 1000), DISC(C, -6000)]]);
    expect(await createSalePaymentFromPosted("COURSE", C, f.exec, NOW)).toEqual({ ok: false, skipped: "bad-amount" });
    expect(f.of("insert")).toHaveLength(0);
  });
  test("a fully-discounted sale (net 0) writes no row, loudly (a payment is > 0)", async () => {
    const f = fakeExec([[SALE(C, 100000), DISC(C, -100000)]]);
    expect(await createSalePaymentFromPosted("COURSE", C, f.exec, NOW)).toEqual({ ok: false, skipped: "bad-amount" });
    expect(f.of("insert")).toHaveLength(0);
  });
});

describe("the wiring in the shared files (TASK-875's held hunks)", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const sched = read("../services/scheduler.service.ts");
  const region = (from: string, to: string) => sched.slice(sched.indexOf(from), sched.indexOf(to, sched.indexOf(from)));

  test("createCoursePackage calls it once, AFTER its transaction and beside `void recordSale(` (which is untouched)", () => {
    const fn = region("export async function createCoursePackage(", "// List vouchers for the voucher tab");
    expect((fn.match(/createSalePaymentFromPosted\(/g) ?? []).length).toBe(1);
    expect(fn).toContain('void createSalePaymentFromPosted("COURSE", result.course.id);');
    expect(fn.indexOf("void recordSale(")).toBeGreaterThan(fn.indexOf("db.transaction"));
    expect(fn.indexOf("void recordSale(")).toBeLessThan(fn.indexOf("createSalePaymentFromPosted("));
  });
  test("createVoucher calls it once, after its transaction and its recordSale", () => {
    const fn = region("export async function createVoucher(", "// ───────────────────────── Overbooking a leave slot");
    expect((fn.match(/createSalePaymentFromPosted\(/g) ?? []).length).toBe(1);
    expect(fn).toContain('void createSalePaymentFromPosted("VOUCHER", result.voucher.id);');
    expect(fn.indexOf("void recordSale(")).toBeLessThan(fn.indexOf("createSalePaymentFromPosted("));
  });
  test("it is called nowhere else in the service: one import and exactly two calls (course sale, voucher sale)", () => {
    expect((sched.match(/import \{ createSalePaymentFromPosted \}/g) ?? []).length).toBe(1);
    expect((sched.match(/void createSalePaymentFromPosted\(/g) ?? []).length).toBe(2);
  });
  test("both calls are `void`-ed: neither can fail nor delay the sale", () => {
    for (const m of sched.matchAll(/^\s*(\w+ )?createSalePaymentFromPosted\(/gm)) expect(m[1]).toBe("void ");
  });
  test("index.ts mounts the router at /api/payments, behind the guard, beside the camp line", () => {
    const idx = read("../index.ts");
    expect(idx).toContain('app.route("/api/payments", paymentRoutes);');
    expect(idx.indexOf('app.use("/api/*", accessGuard)')).toBeLessThan(idx.indexOf('app.route("/api/payments"'));
    expect(idx.indexOf('app.route("/api/camp"')).toBeLessThan(idx.indexOf('app.route("/api/payments"'));
  });
  test("🔑 the three routes are MAPPED in route-access (an unmapped route fails closed with 403): read(BOOKINGS) for GET, course-edit for POST / PATCH", async () => {
    const { ROUTE_ACCESS } = await import("./route-access");
    expect(ROUTE_ACCESS["GET /payments"]).toEqual({ menus: ["menu:bookings"] });
    expect(ROUTE_ACCESS["POST /payments"]).toEqual({ menus: ["menu:bookings"], action: "action:bookings.course-edit" });
    expect(ROUTE_ACCESS["PATCH /payments/:id"]).toEqual({ menus: ["menu:bookings"], action: "action:bookings.course-edit" });
    expect(Object.keys(ROUTE_ACCESS).filter((k) => k.includes("/payments"))).toHaveLength(3);
  });
  test("every route the payments router declares has an entry (GET / → GET /payments, PATCH /:id → PATCH /payments/:id)", async () => {
    const { ROUTE_ACCESS } = await import("./route-access");
    const src = read("../routes/payments.ts");
    const declared = [...src.matchAll(/\.(get|post|patch|put|delete)\(\s*"(\/[^"]*)"/g)].map((m) => `${m[1].toUpperCase()} /payments${m[2] === "/" ? "" : m[2]}`);
    expect(declared.sort()).toEqual(["GET /payments", "PATCH /payments/:id", "POST /payments"]);
    for (const k of declared) expect(k in ROUTE_ACCESS).toBe(true);
  });
});
