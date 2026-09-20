// TASK-414 (`REQ-099`) — the People page's birthday filter: the pure helper by VALUE through `toSQL` (the three
// shapes), the month table (12 → 2 includes 12, 1, 2; excludes 3 and 11), the wrap sort key, the validator's two 400s,
// `birthDate` in the select and the DTO, the composition WITH the suspended/archived terms (never replacing them),
// the route through the ROOT app. No migration (47 = 47), no key.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { and, sql } from "drizzle-orm";
import { birthMonthOrder, birthMonthWhere, monthInRange, noDobWhere, withBirthdayFilter, wrapSortKey } from "./birth-month";
import * as v from "../validation";
import * as parent from "../services/parent.service";
import { db } from "../db";
import { students } from "../db/schema";
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
const q = (w: any, order?: any[]) => { let b: any = db.select({ id: students.id }).from(students).where(w); if (order) b = b.orderBy(...order); return b.toSQL(); };
afterAll(() => { delete process.env.SKIP_AUTH; });

describe("🔴 the helper by VALUE — the three SQL shapes, the month table, the wrap sort key", () => {
  test("`from <= to` ⇒ BETWEEN; `from > to` ⇒ `>= from OR <= to`; `noDob` ⇒ IS NULL", () => {
    const a = q(birthMonthWhere(3, 5));
    expect(a.sql).toMatch(/extract\(month from "students"\."birth_date"\) between \$1 and \$2/);
    expect(a.params).toEqual([3, 5]);
    const b = q(birthMonthWhere(11, 2));
    expect(b.sql).toMatch(/\(extract\(month from "students"\."birth_date"\) >= \$1 or extract\(month from "students"\."birth_date"\) <= \$2\)/);
    expect(b.params).toEqual([11, 2]);
    const c = q(birthMonthWhere(6, 6));
    expect(c.sql).toMatch(/between \$1 and \$2/); expect(c.params).toEqual([6, 6]);
    expect(q(noDobWhere()).sql).toMatch(/"students"\."birth_date" is null/);
  });
  test("the month table: 12 → 2 includes 12, 1, 2 and excludes 3 and 11; 3 → 5 the plain way; 6 → 6 one month; 1 → 12 every month", () => {
    const inRange = (from: number, to: number) => Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => monthInRange(m, from, to));
    expect(inRange(12, 2)).toEqual([1, 2, 12]);
    expect(inRange(11, 2)).toEqual([1, 2, 11, 12]);
    expect(inRange(3, 5)).toEqual([3, 4, 5]);
    expect(inRange(6, 6)).toEqual([6]);
    expect(inRange(1, 12)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(monthInRange(3, 12, 2)).toBe(false); expect(monthInRange(11, 12, 2)).toBe(false);
  });
  test("the wrap sort key `(month - from + 12) % 12`: a 11 → 2 range lists Nov, Dec, Jan, Feb in that order; the ORDER BY carries the key, the day, the name", () => {
    expect([11, 12, 1, 2].map((m) => wrapSortKey(m, 11))).toEqual([0, 1, 2, 3]);
    expect([3, 4, 5].map((m) => wrapSortKey(m, 3))).toEqual([0, 1, 2]);
    expect(wrapSortKey(1, 1)).toBe(0); expect(wrapSortKey(12, 1)).toBe(11);
    const o = q(birthMonthWhere(11, 2), birthMonthOrder(11));
    expect(o.sql).toMatch(/order by \(\(extract\(month from "students"\."birth_date"\) - \$3 \+ 12\) % 12\) asc, extract\(day from "students"\."birth_date"\) asc, "students"\."name" asc/);
    expect(o.params).toEqual([11, 2, 11]);
  });
  test("`withBirthdayFilter` COMPOSES with the base (never replaces it): noDob wins over a range; nothing set ⇒ the base untouched", () => {
    const base = and(sql`true`, sql`"students"."archived_at" is null`)!;
    expect(q(withBirthdayFilter(base, {})).sql).toBe(q(base).sql);
    const ranged = q(withBirthdayFilter(base, { birthMonthFrom: 3, birthMonthTo: 5 }));
    expect(ranged.sql).toMatch(/archived_at" is null.*between \$1 and \$2/s);
    const nod = q(withBirthdayFilter(base, { noDob: true, birthMonthFrom: 3, birthMonthTo: 5 }));
    expect(nod.sql).toMatch(/archived_at" is null.*"birth_date" is null/s);
    expect(nod.sql).not.toContain("between");
  });
});

describe("🔴 the validator's two 400s; `birthDate` in the select and the DTO; the composition by source; the route", () => {
  test("both-or-neither months (1..12 ints); `noDob` and a range contradict; the old keys unchanged", () => {
    expect(v.studentsQuery.safeParse({ birthMonthFrom: "11", birthMonthTo: "2" }).success).toBe(true);
    expect(v.studentsQuery.parse({ birthMonthFrom: "11", birthMonthTo: "2" })).toMatchObject({ birthMonthFrom: 11, birthMonthTo: 2, noDob: false, archived: false, limit: 50 });
    expect(v.studentsQuery.safeParse({ birthMonthFrom: "11" }).success).toBe(false);
    expect(v.studentsQuery.safeParse({ birthMonthTo: "2" }).success).toBe(false);
    expect(v.studentsQuery.safeParse({ birthMonthFrom: "0", birthMonthTo: "2" }).success).toBe(false);
    expect(v.studentsQuery.safeParse({ birthMonthFrom: "1", birthMonthTo: "13" }).success).toBe(false);
    expect(v.studentsQuery.safeParse({ birthMonthFrom: "1.5", birthMonthTo: "3" }).success).toBe(false);
    expect(v.studentsQuery.safeParse({ noDob: "true", birthMonthFrom: "1", birthMonthTo: "3" }).success).toBe(false);
    expect(v.studentsQuery.parse({ noDob: "true" })).toMatchObject({ noDob: true });
    expect(v.studentsQuery.parse({}).noDob).toBe(false);
    expect(v.studentsQuery.parse({ archived: "true", noDob: "true" })).toMatchObject({ archived: true, noDob: true }); // the restore view may chase DOBs too
  });
  test("by source: the select carries `birthDate`, the DTO returns it (ISO | null), the where is `withBirthdayFilter(baseWhere, …)` OVER the suspended + archived terms, the order switches only on a range", () => {
    const S = region(code(src("src/services/parent.service.ts")), "export async function searchStudents(", "\n}\n");
    expect(S).toContain("birthDate: students.birthDate,");
    expect(S).toContain("birthDate: r.birthDate ?? null,");
    expect(S).toContain("archived ? isNotNull(students.archivedAt) : isNull(students.archivedAt),"); // REQ-093 untouched
    expect(S).toContain("const baseWhere = excluded.length ? and(searchWhere, notInArray(students.id, excluded))! : searchWhere!;"); // TASK-058 untouched
    expect(S).toContain(".where(withBirthdayFilter(baseWhere, birthday))");
    expect(S).toContain("const ranged = birthday.birthMonthFrom !== undefined && birthday.birthMonthTo !== undefined && !birthday.noDob;");
    expect(S).toContain(".orderBy(...(ranged ? birthMonthOrder(birthday.birthMonthFrom!) : [asc(students.name)]))");
    expect(S).toContain(".limit(Math.min(limit, 200));");
    expect(S).not.toMatch(/extract\(|birth_date/); // the SQL lives in the helper, not here
    expect(code(src("src/routes/api.ts"))).toContain("parent.searchStudents(q, limit, archived, { birthMonthFrom, birthMonthTo, noDob })");
    expect(readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).length).toBe(47); // no migration
  });
  test("through the ROOT app (service spied): the range reaches the service; a lone month ⇒ 400 before the service; the contradiction ⇒ 400", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(parent, "searchStudents").mockImplementation((async (...a: any[]) => { calls.push(a); return []; }) as any);
    try {
      const get = (qs: string) => rootApp.fetch(new Request(`http://localhost/api/students${qs}`));
      expect((await get("?birthMonthFrom=11&birthMonthTo=2")).status).toBe(200);
      expect(calls.at(-1)).toEqual([undefined, 50, false, { birthMonthFrom: 11, birthMonthTo: 2, noDob: false }]);
      expect((await get("?noDob=true&q=a")).status).toBe(200);
      expect(calls.at(-1)).toEqual(["a", 50, false, { birthMonthFrom: undefined, birthMonthTo: undefined, noDob: true }]);
      expect(calls.length).toBe(2);
      expect((await get("?birthMonthFrom=11")).status).toBe(400);
      expect((await get("?noDob=true&birthMonthFrom=1&birthMonthTo=2")).status).toBe(400);
      expect(calls.length).toBe(2);
    } finally { s.mockRestore(); }
  });
});
