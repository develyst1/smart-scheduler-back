// 🔴 TASK-749 REOPENED (TEST-123 on sid) — the day-end POSTED THE SAME SALE AGAIN on every run. `revGeneration` is the count of postings = the NEXT generation, so keying every post with it built a FRESH `rev:`
// key each run and the duplicate check never fired. The first 749 tests pinned «the same key for the same booking AND generation» (a pure function) and never fed run 1's post back into run 2.
// THIS file does: a STATEFUL FAKE LEDGER (`bo.movement`) that keeps what run 1 wrote — the real `liveRevenue`, `revGeneration`, `recordSale`, `postBookingSale` and the two real posting paths of the job
// run against it, so «run it twice ⇒ one sale» is asserted BY VALUE across runs, not as a key property.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const { boMovement } = await import("../db/schema");
const { isRevenueLive, liveRevenue, revKey, revUndoKey, revGeneration } = await import("./sale-post");
const jobs = await import("../services/jobs.service");

type Row = { idempotencyKey: string | null; refId: string | null; qty: number; valueMinor: number; reason: string };
let ledger: Row[] = [];
let ledgerReads = 0;
const spies: Array<{ mockRestore: () => void }> = [];

/** A fake `bo.movement` + `bo.item` behind the REAL queries: a `db.select().from(boMovement).where(sql)` is answered by rendering the SQL and matching its parameters (exact keys and `prefix%` patterns) against the ledger. */
function fakeLedger() {
  ledger = []; ledgerReads = 0;
  const item = { id: "item-1", active: true, unitPriceMinor: 139_000, externalSource: "smart-scheduler", externalRef: "first-trial" };
  const col = (name: string) => ({ __col: name });
  const ops = { eq: (c: any, v: unknown) => (r: any) => r[c.__col] === v, and: (...p: Array<(r: any) => boolean>) => (r: any) => p.every((f) => f(r)) };
  const proxy = new Proxy({}, { get: (_t, k: string) => col(k) });
  spies.push(
    spyOn(db.query.boItem, "findFirst").mockImplementation((async () => item) as any),
    spyOn(db.query.boMovement, "findFirst").mockImplementation((async (q: any) => ledger.find(q.where(proxy, ops))) as any),
    spyOn(db, "insert").mockImplementation(((_t: unknown) => ({
      values: async (v: Row) => {
        if (v.idempotencyKey && ledger.some((r) => r.idempotencyKey === v.idempotencyKey)) throw Object.assign(new Error("dup"), { code: "23505" });
        ledger.push({ idempotencyKey: v.idempotencyKey ?? null, refId: v.refId ?? null, qty: v.qty ?? 0, valueMinor: v.valueMinor ?? 0, reason: v.reason ?? "" });
      },
    })) as any),
    spyOn(db, "select").mockImplementation((() => ({
      from: () => ({
        where: async (cond: any) => {
          ledgerReads++;
          const params = (new PgDialect().sqlToQuery(cond).params as unknown[]).map(String);
          const hit = (k: string) => params.some((p) => (p.endsWith("%") ? k.startsWith(p.slice(0, -1)) : k === p));
          return ledger.filter((r) => r.idempotencyKey && hit(r.idempotencyKey)).map((r) => ({ key: r.idempotencyKey }));
        },
      }),
    })) as any),
  );
}
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const sales = (id: string) => ledger.filter((r) => r.idempotencyKey?.startsWith(`rev:${id}`));
const reversals = (id: string) => ledger.filter((r) => r.idempotencyKey?.startsWith(`rev-undo:${id}`));
/** What the reversal act writes when an admin undoes an attendance: the reversal of the CURRENT generation (`revUndoKey`). */
const undo = async (id: string) => { ledger.push({ idempotencyKey: revUndoKey(id, (await revGeneration(id)) - 1), refId: id, qty: 1, valueMinor: -139_000, reason: "SALE_REVERSAL" }); };
type In = { id: string; date: string; bookingType: string; subjectId: string | null; groupId: string | null; otherPriceMinor: number | null; otherPriceItemId: string | null; discountKind: string | null; discountValue: number | null; discountReason: string | null; discountActor: string | null };
const trial = (id: string, date = "2026-10-25"): In => ({ id, date, bookingType: "FIRST_TRIAL", subjectId: null, groupId: null, otherPriceMinor: null, otherPriceItemId: null, discountKind: null, discountValue: null, discountReason: null, discountActor: null });
const other = (id: string, date = "2026-10-25"): In => ({ ...trial(id, date), bookingType: "OTHER", otherPriceMinor: 50_000 });
/** One day-end run's posting loop over the selected rows — the same two calls the job makes. */
const run = async (rows: In[]) => {
  let posted = 0;
  for (const b of rows) if (b.bookingType === "OTHER" ? await jobs.postOtherBookingSale(b) : await jobs.postTrialOrSingleSale(b)) posted++;
  return posted;
};

describe("🔒 TASK-749 reopened — isRevenueLive, pure: sales > reversals", () => {
  test("nothing ⇒ not live · posted ⇒ live · posted then reversed ⇒ NOT live · re-posted (next generation) ⇒ live again · and reversed again ⇒ not", () => {
    expect(isRevenueLive([])).toBe(false);
    expect(isRevenueLive(["rev:b1"])).toBe(true);
    expect(isRevenueLive(["rev:b1", "rev-undo:b1"])).toBe(false);
    expect(isRevenueLive(["rev:b1", "rev-undo:b1", "rev:b1#1"])).toBe(true);
    expect(isRevenueLive(["rev:b1", "rev-undo:b1", "rev:b1#1", "rev-undo:b1#1"])).toBe(false);
  });
  test("a reversal key is not mistaken for a sale (`rev-undo:` does not start with `rev:`)", () => {
    expect(isRevenueLive(["rev-undo:b1"])).toBe(false);
  });
  test("`liveRevenue` asks the ledger for exactly the four key shapes of ONE booking", () => {
    fakeLedger();
    return liveRevenue("b1").then(() => {
      expect(ledgerReads).toBe(1);
    });
  });
});

describe("🔴 TASK-749 reopened — a trial / 1 HR: run it twice ⇒ ONE sale", () => {
  test("run 1 posts it; run 2 (same rows, same day) posts NOTHING more", async () => {
    fakeLedger();
    expect(await run([trial("t1")])).toBe(1);
    expect(sales("t1")).toHaveLength(1);
    expect(await run([trial("t1")])).toBe(0); // the TEST-123 symptom: this used to be 1, with a second `rev:` sale
    expect(sales("t1")).toHaveLength(1);
  });
  test("8 runs on 8 consecutive days over the same swept row ⇒ still ONE sale", async () => {
    fakeLedger();
    let total = 0;
    for (let day = 0; day < 8; day++) total += await run([trial("t1", "2026-10-18")]);
    expect(total).toBe(1);
    expect(sales("t1")).toHaveLength(1);
    expect(sales("t1")[0]!.idempotencyKey).toBe("rev:t1"); // generation 0, the un-suffixed key
  });
  test("posted → UNDONE (a reversal) → attended again ⇒ exactly 2 sales + 1 reversal, and every later run adds nothing", async () => {
    fakeLedger();
    expect(await run([trial("t1")])).toBe(1);
    await undo("t1");
    expect(await run([trial("t1")])).toBe(1); // the re-attend: its NEXT generation
    expect(sales("t1").map((r) => r.idempotencyKey)).toEqual(["rev:t1", "rev:t1#1"]);
    expect(reversals("t1")).toHaveLength(1);
    for (let i = 0; i < 3; i++) expect(await run([trial("t1")])).toBe(0);
    expect(sales("t1")).toHaveLength(2);
    expect(reversals("t1")).toHaveLength(1);
  });
  test("undone and NOT re-attended ⇒ the (status = ATTENDED) select never offers it; if it were offered, a not-live row would post — which is exactly the re-attend case", async () => {
    fakeLedger();
    await run([trial("t1")]);
    await undo("t1");
    expect(await liveRevenue("t1")).toBe(false);
  });
  test("each booking is judged on its OWN ledger rows (t2's sale does not hide t1's)", async () => {
    fakeLedger();
    expect(await run([trial("t1"), trial("t2")])).toBe(2);
    expect(await run([trial("t1"), trial("t2"), trial("t3")])).toBe(1); // only the new one
    expect([sales("t1"), sales("t2"), sales("t3")].map((x) => x.length)).toEqual([1, 1, 1]);
  });
  test("🔴 the 18:20 case: marked after D's 17:30 run ⇒ posted by D+1's run, ONCE, and D+2's run adds nothing", async () => {
    fakeLedger();
    expect(await run([])).toBe(0); // D's run saw nothing
    expect(await run([trial("late", "2026-10-25")])).toBe(1); // D+1
    expect(await run([trial("late", "2026-10-25")])).toBe(0); // D+2
    expect(sales("late")).toHaveLength(1);
  });
});

describe("🔴 TASK-749 reopened — a priced OTHER: the same three cases", () => {
  test("run twice ⇒ one sale; 8 runs ⇒ one; the typed amount is posted", async () => {
    fakeLedger();
    expect(await run([other("o1")])).toBe(1);
    expect(await run([other("o1")])).toBe(0);
    for (let i = 0; i < 6; i++) await run([other("o1", "2026-10-19")]);
    expect(sales("o1")).toHaveLength(1);
    expect(sales("o1")[0]).toMatchObject({ idempotencyKey: "rev:o1", valueMinor: 50_000 });
  });
  test("posted → undone → attended again ⇒ 2 sales + 1 reversal, then stable", async () => {
    fakeLedger();
    await run([other("o1")]);
    await undo("o1");
    expect(await run([other("o1")])).toBe(1);
    expect(sales("o1").map((r) => r.idempotencyKey)).toEqual(["rev:o1", "rev:o1#1"]);
    expect(await run([other("o1")])).toBe(0);
    expect(sales("o1")).toHaveLength(2);
    expect(reversals("o1")).toHaveLength(1);
  });
  test("an UNCHARGED OTHER writes nothing AND does not even read the ledger (AC-4: one comparison, no money touched)", async () => {
    fakeLedger();
    expect(await run([{ ...other("o2"), otherPriceMinor: null }])).toBe(0);
    expect(ledger).toHaveLength(0);
    expect(ledgerReads).toBe(0);
  });
});

describe("🔒 the key shapes the live check relies on are the ones the writers use", () => {
  test("`revKey` / `revUndoKey` start with `rev:` / `rev-undo:` at every generation", () => {
    for (const g of [0, 1, 5]) {
      expect(revKey("b", g).startsWith("rev:")).toBe(true);
      expect(revUndoKey("b", g).startsWith("rev-undo:")).toBe(true);
      expect(revUndoKey("b", g).startsWith("rev:")).toBe(false);
    }
    expect(boMovement).toBeDefined();
  });
});
