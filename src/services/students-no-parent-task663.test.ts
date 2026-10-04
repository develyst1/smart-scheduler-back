// TASK-663 (TASK-644 piece B) — `GET /students?noParent=true` lists ONLY the children with no household, so the ones an IMPORT
// may create are findable. The default list is byte-identical to before (pinned against the expression it used to be).
// No database: the WHERE is pinned through drizzle `.toSQL()`, the route through the root app with the service spied.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { and, isNull, sql } from "drizzle-orm";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const parentSvc = await import("./parent.service");
const { studentListWhere } = parentSvc;
const { studentsQuery } = await import("../validation");
const { db } = await import("../db");
const { students } = await import("../db/schema");

const whereOf = (cond: ReturnType<typeof studentListWhere>) => {
  const { sql: s, params } = db.select({ id: students.id }).from(students).where(cond).toSQL();
  return { where: s.slice(s.indexOf(" where ")), params };
};

describe("TASK-663 — the student list's WHERE, pinned through `.toSQL()`", () => {
  const TODAY = ' where (true and "students"."archived_at" is null)';
  test("🔴 absent ⇒ byte-identical to the list as it was (the old expression, rebuilt here, and its literal SQL)", () => {
    const before = whereOf(and(sql`true`, isNull(students.archivedAt))); // what searchStudents built before TASK-663
    expect(whereOf(studentListWhere(undefined, false))).toEqual(before);
    expect(before).toEqual({ where: TODAY, params: [] });
  });
  test("🔴 `false` ⇒ the same bytes", () => {
    expect(whereOf(studentListWhere(undefined, false, false))).toEqual({ where: TODAY, params: [] });
  });
  test("`true` ⇒ exactly ONE more condition: `parent_id is null`", () => {
    expect(whereOf(studentListWhere(undefined, false, true))).toEqual({
      where: ' where (true and "students"."archived_at" is null and "students"."parent_id" is null)', params: [],
    });
  });
  test("composes with `archived=true` (the archived no-household children)", () => {
    expect(whereOf(studentListWhere(undefined, true, true)).where).toBe(' where (true and "students"."archived_at" is not null and "students"."parent_id" is null)');
  });
  test("composes with `q` (the search still narrows)", () => {
    expect(whereOf(studentListWhere("Ari", false, true))).toEqual({
      where: ' where (("students"."name" ilike $1 or "students"."nickname" ilike $2) and "students"."archived_at" is null and "students"."parent_id" is null)',
      params: ["%Ari%", "%Ari%"],
    });
  });
});

describe("TASK-663 — the validator", () => {
  test("`true` / `false` / absent ⇒ true / false / false", () => {
    expect(studentsQuery.parse({ noParent: "true" }).noParent).toBe(true);
    expect(studentsQuery.parse({ noParent: "false" }).noParent).toBe(false);
    expect(studentsQuery.parse({}).noParent).toBe(false);
  });
  test("junk is refused", () => {
    for (const junk of ["yes", "1", "TRUE", ""]) expect(studentsQuery.safeParse({ noParent: junk }).success).toBe(false);
  });
});

describe("TASK-663 — GET /api/students passes `noParent` through (root app, service spied)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });
  test("`?noParent=true` ⇒ 5th argument true; no param ⇒ false; the other arguments unchanged", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: unknown[][] = [];
    spies.push(spyOn(parentSvc, "searchStudents").mockImplementation((async (...a: unknown[]) => { calls.push(a); return []; }) as any));
    const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
    expect((await app.fetch(new Request("http://localhost/api/students?noParent=true&q=Ari"))).status).toBe(200);
    expect(calls.at(-1)!.slice(0, 3)).toEqual(["Ari", 50, false]);
    expect(calls.at(-1)![4]).toBe(true);
    expect((await app.fetch(new Request("http://localhost/api/students"))).status).toBe(200);
    expect(calls.at(-1)![4]).toBe(false);
  });
});
