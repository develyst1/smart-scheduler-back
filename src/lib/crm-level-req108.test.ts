// TASK-498 — `crm_points` moves by `sql`, and `crm_level` is the ladder applied to THAT SAME statement's new total. Pinned by value:
// a fake `exec` EVALUATES the rendered SQL of both SETs against an old row — as Postgres does, both SETs see the same old row —
// for a grid of (old points, delta). So "the level never disagrees with the points" and "the points arithmetic is unchanged" are
// checked on what the code actually sends, not on what it looks like.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { CRM_LEVELS, CRM_POINT_RULES, levelCaseSql, levelFromPoints } from "./crm";
import { awardCrmPoints } from "./line-admin";

const dialect = new PgDialect();
const root = resolve(import.meta.dir, "..", "..");

/** Evaluate the SQL this code sends, over ONE old row: the points column, `GREATEST(x + $n, 0)`, and the CASE ladder. */
const evalSql = (text: string, params: unknown[], old: number): number => {
  let t = text.replace(/GREATEST\("students"\."crm_points" \+ \$(\d+), 0\)/g, (_m, n) => String(Math.max(old + Number(params[Number(n) - 1]), 0)));
  t = t.replace(/"students"\."crm_points"/g, String(old)); // a bare column = the OLD value (what a stale expression would see)
  if (/^-?\d+$/.test(t)) return Number(t);
  const m = t.match(/^CASE (.*) ELSE (\d+) END$/);
  if (!m) throw new Error(`unhandled SQL: ${text}`);
  for (const w of m[1]!.matchAll(/WHEN (-?\d+) >= (\d+) THEN (\d+)/g)) if (Number(w[1]) >= Number(w[2])) return Number(w[3]);
  return Number(m[2]);
};
/** A fake executor: NO read is allowed; the one UPDATE is evaluated against `old` and its RETURNING answered from that. */
const fakeExec = (old: number | null) => {
  const seen: { sets?: Record<string, unknown>; reads: number } = { reads: 0 };
  const exec = {
    query: { students: { findFirst: async () => { seen.reads++; return old == null ? undefined : { crmPoints: old }; } } },
    update: () => ({ set: (sets: Record<string, any>) => ({ where: () => ({ returning: async () => {
      seen.sets = sets;
      if (old == null) return [];
      const p = dialect.sqlToQuery(sets.crmPoints), l = dialect.sqlToQuery(sets.crmLevel);
      return [{ points: evalSql(p.sql, p.params, old), level: evalSql(l.sql, l.params, old) }];
    } }) }) }),
  };
  return { exec, seen };
};

describe("§1 — the rules this must NOT change (by value)", () => {
  test("the awards and the ladder, exactly as before", () => {
    expect(CRM_POINT_RULES).toEqual({ ON_TIME_CHECKIN: 10, PROPER_SICK_LEAVE: 5 });
    expect(CRM_LEVELS.map((l) => [l.level, l.minPoints])).toEqual([[1, 0], [2, 30], [3, 80], [4, 150], [5, 300]]);
  });
  test("🔑 the level IS a pure function of the total — `levelFromPoints`, over a constant ladder", () => {
    expect([0, 29, 30, 79, 80, 149, 150, 299, 300, 10_000].map((p) => levelFromPoints(p).level)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
});

describe("🔴 ONE statement — points by `sql`, the level from that SAME total", () => {
  test("the CASE is the same ladder, highest rung first, numbers inlined (so the column gets an integer, not text)", () => {
    const { sql: text, params } = dialect.sqlToQuery(levelCaseSql(sql`P`));
    expect(text).toBe("CASE WHEN P >= 300 THEN 5 WHEN P >= 150 THEN 4 WHEN P >= 80 THEN 3 WHEN P >= 30 THEN 2 WHEN P >= 0 THEN 1 ELSE 1 END");
    expect(params).toEqual([]);
    for (let p = 0; p <= 400; p++) expect(evalSql(text.replace(/P/g, String(p)), [], 0)).toBe(levelFromPoints(p).level);
  });
  test("🔑 by value over a grid: points = max(old + delta, 0) exactly as before, and the stored level ALWAYS matches the stored points", async () => {
    for (const old of [0, 5, 25, 29, 30, 75, 145, 150, 295, 299, 300, 1000]) {
      for (const delta of [CRM_POINT_RULES.ON_TIME_CHECKIN, CRM_POINT_RULES.PROPER_SICK_LEAVE, 1, -3, -100]) {
        const { exec } = fakeExec(old);
        const out = await awardCrmPoints("s1", delta, exec);
        expect({ old, delta, out }).toEqual({ old, delta, out: { points: Math.max(0, old + delta), level: levelFromPoints(Math.max(0, old + delta)).level } });
      }
    }
  });
  test("NO read before the write (a read-then-write loses points), and the answer comes from RETURNING", async () => {
    const { exec, seen } = fakeExec(29);
    expect(await awardCrmPoints("s1", 1, exec)).toEqual({ points: 30, level: 2 });
    expect(seen.reads).toBe(0);
    const p = dialect.sqlToQuery(seen.sets!.crmPoints as any).sql, l = dialect.sqlToQuery(seen.sets!.crmLevel as any).sql;
    expect(p).toBe('GREATEST("students"."crm_points" + $1, 0)');
    expect(l.startsWith('CASE WHEN GREATEST("students"."crm_points" + $1, 0) >= 300 THEN 5')).toBe(true); // the NEW total, not the column
  });
  test("an unknown student ⇒ null, as before · a zero award ⇒ null and NO write at all", async () => {
    expect(await awardCrmPoints("nobody", 10, fakeExec(null).exec)).toBeNull();
    const z = fakeExec(40);
    expect(await awardCrmPoints("s1", 0, z.exec)).toBeNull();
    expect(z.seen.sets).toBeUndefined();
  });
  test("by source: `applyPoints` (the read-then-add) is gone; the function is one UPDATE … RETURNING", () => {
    const LA = readFileSync(resolve(root, "src/lib/line-admin.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const fn = LA.slice(LA.indexOf("export async function awardCrmPoints("), LA.indexOf("\n}\n", LA.indexOf("export async function awardCrmPoints(")));
    expect(fn).not.toMatch(/findFirst|applyPoints|crmPoints \?\? 0/);
    expect(fn).toContain(".set({ crmPoints: total, crmLevel: levelCaseSql(total) })");
    expect(readFileSync(resolve(root, "src/lib/crm.ts"), "utf8")).not.toContain("export function applyPoints");
  });
});
