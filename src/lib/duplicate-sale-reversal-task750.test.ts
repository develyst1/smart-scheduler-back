// 🔻 TASK-750 (REQ-130) — `sale:reverse-duplicates`: the planner by value, then the WHOLE correction against a STATEFUL FAKE LEDGER (like `day-end-double-post-task749.test.ts`) — after the plan is applied the day-end posts
// nothing, a later attendance Undo (`reverseBookingSale`) still reverses the remaining live sale, and a re-attend posts the next generation once. The script is NEVER run against a database: only its function, here.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { DUPLICATE_REVERSAL_REASON, DUPLICATE_SALE_FLOOR, formatDuplicatePlan, formatTarget, planAll, planDuplicateReversals, type BookingLedgerRow, type LedgerRow } from "./duplicate-sale-reversal";
import { discountKey, revKey, revUndoKey } from "./sale-post";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const { liveRevenue, reverseBookingSale } = await import("./sale-post");
const jobs = await import("../services/jobs.service");
const script = await import("../../scripts/reverse-duplicate-sales");

const LIST = 139_000; // ฿1,390.00 (a first trial)
const sale = (id: string, g: number, value = LIST): LedgerRow => ({ idempotencyKey: revKey(id, g), itemId: "item-1", qty: -1, valueMinor: value });
const undone = (id: string, g: number, value = LIST): LedgerRow => ({ idempotencyKey: revUndoKey(id, g), itemId: "item-1", qty: 1, valueMinor: -value });
const disc = (id: string, g: number, value = -31_900): LedgerRow => ({ idempotencyKey: discountKey(id, g), itemId: "item-1", qty: 0, valueMinor: value });
const gens = (rs: Array<{ generation: number }>) => rs.map((r) => r.generation);

describe("🔴 TASK-750 — the planner, by value: reverse the LOWEST live generations, keep the HIGHEST", () => {
  test("2 sales, 0 reversals ⇒ reverse gen 0 ONLY (gen 1 stays live) — and it is exactly what `reverseBookingSale` would write for gen 0", () => {
    const [r, ...rest] = planDuplicateReversals("b1", [sale("b1", 0), sale("b1", 1)]);
    expect(rest).toEqual([]);
    expect(r).toEqual({ bookingId: "b1", generation: 0, itemId: "item-1", qty: 1, valueMinor: -LIST, reason: DUPLICATE_REVERSAL_REASON, refType: "SALE", idempotencyKey: "rev-undo:b1" });
  });
  test("a re-run with 3 sales ⇒ reverse gens 0 + 1; gen 2 stays", () => {
    const p = planDuplicateReversals("b1", [sale("b1", 0), sale("b1", 1), sale("b1", 2)]);
    expect(gens(p)).toEqual([0, 1]);
    expect(p.map((x) => x.idempotencyKey)).toEqual(["rev-undo:b1", "rev-undo:b1#1"]);
  });
  test("a normal undo → re-attend (2 sales + the rev-undo of gen 0) ⇒ NOTHING; 1 sale ⇒ nothing; nothing posted ⇒ nothing", () => {
    expect(planDuplicateReversals("b1", [sale("b1", 0), undone("b1", 0), sale("b1", 1)])).toEqual([]);
    expect(planDuplicateReversals("b1", [sale("b1", 0)])).toEqual([]);
    expect(planDuplicateReversals("b1", [])).toEqual([]);
  });
  test("a duplicate that is ALREADY reversed is not planned again (2 sales + the reversal of gen 0 ⇒ one live)", () => {
    expect(planDuplicateReversals("b1", [sale("b1", 0), sale("b1", 1), undone("b1", 0)])).toEqual([]);
  });
  test("live is judged per generation: sales 0,1,2 with gen 1 already undone ⇒ live [0, 2] ⇒ reverse gen 0 only; an undone HIGHEST ⇒ the highest LIVE is gen 0 ⇒ nothing", () => {
    expect(gens(planDuplicateReversals("b1", [sale("b1", 0), sale("b1", 1), sale("b1", 2), undone("b1", 1)]))).toEqual([0]);
    expect(planDuplicateReversals("b1", [sale("b1", 0), sale("b1", 1), undone("b1", 1)])).toEqual([]);
  });
  test("a gap in the generations is still found (sales gen 0 and gen 2)", () => {
    expect(gens(planDuplicateReversals("b1", [sale("b1", 0), sale("b1", 2)]))).toEqual([0]);
  });
  test("a discount on gen 0 ⇒ the reversal is the NET (1,390 − 319 ⇒ −1,071), not the list price", () => {
    const [r] = planDuplicateReversals("b1", [sale("b1", 0), disc("b1", 0), sale("b1", 1), disc("b1", 1)]);
    expect(r!.valueMinor).toBe(-107_100);
  });
  test("a 100 % discount ⇒ that generation is SKIPPED (a ฿0 row reads as a sale of nothing)", () => {
    expect(planDuplicateReversals("b1", [sale("b1", 0), disc("b1", 0, -LIST), sale("b1", 1)])).toEqual([]);
    expect(gens(planDuplicateReversals("b1", [sale("b1", 0), disc("b1", 0, -LIST), sale("b1", 1), sale("b1", 2)]))).toEqual([1]);
  });
  test("it only looks at ITS booking's keys (another booking's rows do not count)", () => {
    expect(planDuplicateReversals("b1", [sale("b1", 0), sale("b2", 1)])).toEqual([]);
  });
});

describe("🔴 TASK-750 — planAll: the date floor, the grouping, the listing", () => {
  const row = (bookingId: string, date: string, r: LedgerRow, bookingType = "FIRST_TRIAL"): BookingLedgerRow => ({ ...r, bookingId, date, bookingType });
  const dup = (id: string, date: string, type = "FIRST_TRIAL") => [row(id, date, sale(id, 0), type), row(id, date, sale(id, 1), type)];
  test("the floor is 2026-09-06 (the day a re-posting key became a fresh one): an older booking is never planned", () => {
    expect(DUPLICATE_SALE_FLOOR).toBe("2026-09-06");
    expect(planAll(dup("old", "2026-09-05")).length).toBe(0);
    expect(planAll(dup("on", "2026-09-06")).length).toBe(1);
  });
  test("grouped per booking, oldest first; net = the sum of its reversals; a clean booking is not listed", () => {
    const plans = planAll([...dup("b2", "2026-10-18", "SINGLE_SESSION"), ...dup("b1", "2026-10-18"), ...dup("a0", "2026-10-02"), row("ok", "2026-10-18", sale("ok", 0))]);
    expect(plans.map((p) => [p.bookingId, p.date, p.bookingType, p.netMinor])).toEqual([["a0", "2026-10-02", "FIRST_TRIAL", LIST], ["b1", "2026-10-18", "FIRST_TRIAL", LIST], ["b2", "2026-10-18", "SINGLE_SESSION", LIST]]);
  });
  test("the listing has ids and amounts only (id · date · type · generations · THB), then the count and the total", () => {
    const text = formatDuplicatePlan(planAll([...dup("b1", "2026-10-18"), ...dup("b2", "2026-10-18")]));
    expect(text).toContain("ต้องกลับรายการ 2 การจอง · รวม 2,780.00 บาท");
    expect(text).toContain("b1 · 2026-10-18 · FIRST_TRIAL · รุ่น 0 · 1,390.00 บาท");
    expect(formatDuplicatePlan([])).toContain("ต้องกลับรายการ 0 การจอง · รวม 0.00 บาท");
  });
});

// ───────── the whole correction against a stateful fake ledger ─────────
type Mov = { idempotencyKey: string | null; refId: string | null; itemId: string; qty: number; valueMinor: number; reason: string };
let ledger: Mov[] = [];
const spies: Array<{ mockRestore: () => void }> = [];
const BOOKINGS: Record<string, { date: string; type: string }> = {};
/** A key another writer takes between our read and our write: the insert for it conflicts and writes nothing. */
let raceKey: string | null = null;
/** What the fake server answers to «which database am I»: a name and a host — never a credential. */
const TARGET = { db: "sid_db", host: "10.0.0.5" };

function world() {
  ledger = [];
  raceKey = null;
  for (const k of Object.keys(BOOKINGS)) delete BOOKINGS[k];
  const item = { id: "item-1", active: true, unitPriceMinor: LIST, externalSource: "smart-scheduler", externalRef: "first-trial" };
  const col = (name: string) => ({ __col: name });
  const ops = { eq: (c: any, v: unknown) => (r: any) => r[c.__col] === v, and: (...p: Array<(r: any) => boolean>) => (r: any) => p.every((f) => f(r)) };
  const proxy = new Proxy({}, { get: (_t, k: string) => col(k) });
  const answer = (cond: any) => {
    const params = (new PgDialect().sqlToQuery(cond).params as unknown[]).map(String);
    const hit = (k: string) => params.some((p) => (p.endsWith("%") ? k.startsWith(p.slice(0, -1)) : k === p));
    const rows = ledger.filter((r) => r.idempotencyKey && hit(r.idempotencyKey)).map((r) => ({ ...r, key: r.idempotencyKey }));
    return Object.assign(Promise.resolve(rows), { limit: async (n: number) => rows.slice(0, n) });
  };
  const dup = (k: string | null) => k && ledger.some((r) => r.idempotencyKey === k);
  spies.push(
    spyOn(db.query.boItem, "findFirst").mockImplementation((async () => item) as any),
    spyOn(db.query.boMovement, "findFirst").mockImplementation((async (q: any) => ledger.find(q.where(proxy, ops))) as any),
    spyOn(db, "insert").mockImplementation((() => ({
      values: async (v: Mov) => { if (dup(v.idempotencyKey ?? null)) throw Object.assign(new Error("dup"), { code: "23505" }); ledger.push({ ...v, idempotencyKey: v.idempotencyKey ?? null, refId: v.refId ?? null }); },
    })) as any),
    spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: (cond: any) => answer(cond) }) })) as any),
  );
  /** The executor the script's function takes: a transaction that ROLLS BACK when its callback throws. */
  const exec = {
    transaction: async (fn: (tx: any) => Promise<void>) => {
      const snapshot = ledger.map((r) => ({ ...r }));
      const tx = {
        execute: async () => [{ db: TARGET.db, host: TARGET.host }], // `select current_database(), inet_server_addr()`
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: async () =>
                ledger
                  .filter((r) => r.idempotencyKey && /^(rev:|rev-undo:|discount:)/.test(r.idempotencyKey) && r.refId && BOOKINGS[r.refId])
                  .map((r) => ({ key: r.idempotencyKey, itemId: r.itemId, qty: r.qty, valueMinor: r.valueMinor, bookingId: r.refId, date: BOOKINGS[r.refId!]!.date, bookingType: BOOKINGS[r.refId!]!.type })),
            }),
          }),
        }),
        insert: () => ({
          values: (v: Mov) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                if (dup(v.idempotencyKey ?? null) || v.idempotencyKey === raceKey) return [];
                ledger.push({ ...v, idempotencyKey: v.idempotencyKey ?? null, refId: v.refId ?? null });
                return [{ id: `m${ledger.length}` }];
              },
            }),
          }),
        }),
      };
      try { await fn(tx); } catch (e) { ledger.splice(0, ledger.length, ...snapshot); throw e; }
    },
  };
  return exec;
}
const seed = (id: string, date: string, rows: LedgerRow[]) => {
  BOOKINGS[id] = { date, type: "FIRST_TRIAL" };
  for (const r of rows) ledger.push({ ...r, refId: id, reason: "SALE" });
};
const keysOf = (id: string) => ledger.filter((r) => r.refId === id).map((r) => r.idempotencyKey);
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
const quiet = () => {};

describe("🔴 TASK-750 — the script's function against a stateful fake ledger", () => {
  test("the DRY RUN lists the plan and writes NOTHING (the transaction is rolled back)", async () => {
    const exec = world();
    seed("b1", "2026-10-18", [sale("b1", 0), sale("b1", 1)]);
    const before = JSON.stringify(ledger);
    const lines: string[] = [];
    const r = await script.reverseDuplicates(exec, false, (l) => lines.push(l));
    expect(r.rolledBack).toBe(true);
    expect(r.plans).toHaveLength(1);
    expect(r.written).toBe(0);
    expect(JSON.stringify(ledger)).toBe(before);
    expect(lines.join("\n")).toContain("b1 · 2026-10-18 · FIRST_TRIAL · รุ่น 0 · 1,390.00 บาท");
  });
  test("`--commit` writes the reversal of the LOWEST live generation; a SECOND `--commit` writes 0 (idempotent)", async () => {
    const exec = world();
    seed("b1", "2026-10-18", [sale("b1", 0), sale("b1", 1)]);
    const first = await script.reverseDuplicates(exec, true, quiet);
    expect(first.written).toBe(1);
    expect(keysOf("b1")).toEqual(["rev:b1", "rev:b1#1", "rev-undo:b1"]);
    const rev = ledger.find((r) => r.idempotencyKey === "rev-undo:b1")!;
    expect(rev).toMatchObject({ itemId: "item-1", qty: 1, valueMinor: -LIST, reason: DUPLICATE_REVERSAL_REASON, refId: "b1" });
    const second = await script.reverseDuplicates(exec, true, quiet);
    expect([second.plans.length, second.written]).toEqual([0, 0]);
    expect(ledger.filter((r) => r.refId === "b1")).toHaveLength(3);
  });
  test("a reversal that LOSES a race (another writer took its key; ON CONFLICT DO NOTHING writes nothing) is not counted as written — and does not break the run", async () => {
    const exec = world();
    seed("b1", "2026-10-18", [sale("b1", 0), sale("b1", 1)]);
    raceKey = "rev-undo:b1";
    const r = await script.reverseDuplicates(exec, true, quiet);
    expect([r.plans.length, r.written]).toEqual([1, 0]);
  });
  test("🔴 TASK-750 reopened — the TARGET is printed FIRST, before the plan, in a dry run AND a commit; it names the database and the host and nothing else", async () => {
    const exec = world();
    seed("b1", "2026-10-18", [sale("b1", 0), sale("b1", 1)]);
    for (const commit of [false, true]) {
      const lines: string[] = [];
      await script.reverseDuplicates(exec, commit, (l) => lines.push(l));
      expect(lines[0]).toBe("เป้าหมาย: sid_db @ 10.0.0.5");
      expect(lines[0]).toBe(formatTarget({ database: "sid_db", host: "10.0.0.5" }));
      expect(lines.findIndex((l) => l.includes("ต้องกลับรายการ"))).toBeGreaterThan(0); // the plan comes AFTER the target
    }
  });
  test("the output leaks no user, password or URL: not the DATABASE_URL in the environment, nor any piece of it", async () => {
    const exec = world();
    seed("b1", "2026-10-18", [sale("b1", 0), sale("b1", 1)]);
    const lines: string[] = [];
    await script.reverseDuplicates(exec, false, (l) => lines.push(l));
    const out = lines.join("\n");
    const url = new URL(process.env.DATABASE_URL!);
    expect(out).not.toContain(process.env.DATABASE_URL!);
    expect(out).not.toContain(`${url.username}:${url.password}@`); // the credential pair, whatever its length
    for (const piece of [url.username, url.password, "postgres://", "postgresql://"]) if (piece.length >= 3) expect(out).not.toContain(piece); // (a 1-2 character fixture would match ordinary text)
  });
  test("the target is read FROM THE SERVER (current_database / inet_server_addr), never from the environment: the script does not print any env value", async () => {
    const t = await Bun.file(new URL("../../scripts/reverse-duplicate-sales.ts", import.meta.url)).text();
    expect(t).toContain("current_database()");
    expect(t).toContain("inet_server_addr()");
    expect(t.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/process\.env\.(?!NODE_ENV)/);
  });
  test("🔴 the run doc: runs from the owner's LOCAL checkout with the two `--env-file` commands, says to read the target line before `--commit`, matches the dry run's total to SQL 2 — and holds no env value", async () => {
    const d = await Bun.file(new URL("../../docs/RUN-reverse-duplicate-sales.md", import.meta.url)).text();
    expect(d).toContain("bun --env-file=.env.sid run sale:reverse-duplicates");
    expect(d).toContain("bun --env-file=.env.uat run sale:reverse-duplicates");
    expect(d).toContain("-- --commit");
    expect(d).toContain("เครื่อง local");
    expect(d).toContain("เป้าหมาย: <ชื่อฐานข้อมูล> @ <โฮสต์>");
    expect(d).toContain("SQL 2");
    expect(d).toContain("ไฟล์ `.env` ปกติอาจชี้ไปที่ฐานข้อมูลไหนก็ได้ — ใส่ `--env-file` ทุกครั้ง และอ่านบรรทัด `เป้าหมาย:` ก่อนเสมอ"); // the doc does not state what `.env` points at
    expect(d).not.toContain("ระบบจริงของลูกค้า");
    expect(d).not.toMatch(/postgres(ql)?:\/\/|(DATABASE_URL|PASSWORD|SECRET|TOKEN|LIFF_ID)\s*=/i);
  });
  test("it is APPEND-ONLY: the original movements are untouched, and a booking dated before the floor is left alone", async () => {
    const exec = world();
    seed("new", "2026-10-18", [sale("new", 0), sale("new", 1)]);
    seed("old", "2026-08-01", [sale("old", 0), sale("old", 1)]);
    const originals = JSON.stringify(ledger);
    await script.reverseDuplicates(exec, true, quiet);
    expect(JSON.stringify(ledger.slice(0, 4))).toBe(originals);
    expect(keysOf("old")).toEqual(["rev:old", "rev:old#1"]);
  });
  test("🔴 AFTER the plan is applied: exactly ONE live ⇒ the next day-end posts nothing; THEN an attendance Undo reverses the remaining live sale; THEN a re-attend posts the next generation once", async () => {
    const exec = world();
    seed("b1", "2026-10-18", [sale("b1", 0), sale("b1", 1)]);
    await script.reverseDuplicates(exec, true, quiet);
    expect(await liveRevenue("b1")).toBe(true);
    const trial = { id: "b1", date: "2026-10-18", bookingType: "FIRST_TRIAL", subjectId: null, groupId: null, otherPriceMinor: null, otherPriceItemId: null, discountKind: null, discountValue: null, discountReason: null, discountActor: null };
    expect(await jobs.postTrialOrSingleSale(trial)).toBe(false); // the day-end: live ⇒ nothing
    expect(keysOf("b1")).toEqual(["rev:b1", "rev:b1#1", "rev-undo:b1"]);
    // an attendance Undo reverses `postedGeneration` = the HIGHEST (gen 1) — still there because the plan kept it
    expect((await reverseBookingSale("b1")).ok).toBe(true);
    expect(keysOf("b1")).toContain("rev-undo:b1#1");
    expect(await liveRevenue("b1")).toBe(false);
    // the re-attend: the NEXT generation, once
    expect(await jobs.postTrialOrSingleSale(trial)).toBe(true);
    expect(await jobs.postTrialOrSingleSale(trial)).toBe(false);
    expect(ledger.filter((r) => r.idempotencyKey?.startsWith("rev:b1")).map((r) => r.idempotencyKey)).toEqual(["rev:b1", "rev:b1#1", "rev:b1#2"]);
  });
  test("a 100 % discounted duplicate writes no ฿0 row; a net reversal carries the discount; the sale and the discount rows of the booking are left whole", async () => {
    const exec = world();
    seed("b1", "2026-10-18", [sale("b1", 0), disc("b1", 0), sale("b1", 1), disc("b1", 1)]);
    seed("b2", "2026-10-18", [sale("b2", 0), disc("b2", 0, -LIST), sale("b2", 1)]);
    const r = await script.reverseDuplicates(exec, true, quiet);
    expect(r.written).toBe(1);
    expect(ledger.find((x) => x.idempotencyKey === "rev-undo:b1")!.valueMinor).toBe(-107_100);
    expect(ledger.some((x) => x.idempotencyKey === "rev-undo:b2")).toBe(false);
  });
  test("the console shows ids and amounts only (no names are read): the select asks for no name column", () => {
    const src = Bun.file(new URL("../../scripts/reverse-duplicate-sales.ts", import.meta.url));
    return src.text().then((t) => expect(t).not.toMatch(/students|parents|nickname|\.name\b/));
  });
});
