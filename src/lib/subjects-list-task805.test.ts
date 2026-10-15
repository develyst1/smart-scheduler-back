// TASK-805 (REQ-121, live) — `GET /api/subjects`: EVERY ACTIVE program `{ subjects: { id, name, kind }[] }`, by name, so the teacher form can offer a program nobody teaches yet
// (and DUO's Program dropdown fills). Pinned: the answer (an unassigned program, both kinds, the `kind` default), the ACTIVE filter and the by-name order AT THE QUERY (the condition
// handed to the database is rendered and read), the door (`menu:teachers` ONLY — not the booking menus), and that nothing else moved (the save path, /sellable-packages).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { DEV_USER } from "../middleware/auth";
import { db } from "../db";
import { ROUTE_ACCESS } from "./route-access";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const get = (path: string) => rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "GET" }));
const dialect = new PgDialect();

const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
const setUser = (u: { isSuperAdmin: boolean; grants?: Iterable<string> }) => { (DEV_USER as any).isSuperAdmin = u.isSuperAdmin; (DEV_USER as any).grants = new Set(u.grants ?? []); (DEV_USER as any).teacherId = null; };
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });

type Row = { id: string; name: string; kind: string | null; active: boolean };
const ROWS: Row[] = [
  { id: "s-assigned", name: "Piano", kind: "PRIVATE", active: true },
  { id: "s-nobody", name: "Duo Violin", kind: "DUO", active: true }, // assigned to NO teacher — the whole point
  { id: "s-null-kind", name: "Drums", kind: null, active: true }, // a legacy row without a kind ⇒ "PRIVATE" (as /sellable-packages does)
  { id: "s-off", name: "Retired", kind: "PRIVATE", active: false },
];
/** A fake `db.select(...).from().where(cond).orderBy(...)` that applies the REAL condition's meaning is impossible without a DB, so it records what the service handed over. */
function fakeSelect() {
  const seen: { fields?: unknown; where?: unknown; order?: unknown[] } = {};
  const chain: any = {
    from: () => chain,
    where: (w: unknown) => { seen.where = w; return chain; },
    orderBy: (...o: unknown[]) => { seen.order = o; return Promise.resolve(ROWS.filter((r) => r.active).sort((a, b) => a.name.localeCompare(b.name))); },
  };
  spies.push(spyOn(db, "select").mockImplementation(((fields: unknown) => { seen.fields = fields; return chain; }) as any));
  return seen;
}

describe("TASK-805 — GET /api/subjects answers", () => {
  test("every ACTIVE program, by name: the one nobody teaches, both kinds, a null kind as PRIVATE; the inactive one is absent; exactly {id, name, kind}", async () => {
    process.env.SKIP_AUTH = "true";
    setUser({ isSuperAdmin: true });
    fakeSelect();
    const res = await get("/subjects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subjects: [
        { id: "s-null-kind", name: "Drums", kind: "PRIVATE" },
        { id: "s-nobody", name: "Duo Violin", kind: "DUO" },
        { id: "s-assigned", name: "Piano", kind: "PRIVATE" },
      ],
    });
  });

  test("at the QUERY: the condition is `active = true`, the order is by name, only id/name/kind are selected (no teacher join ⇒ an unassigned program is included)", async () => {
    process.env.SKIP_AUTH = "true";
    setUser({ isSuperAdmin: true });
    const seen = fakeSelect();
    await get("/subjects");
    const q = dialect.sqlToQuery(seen.where as any);
    expect(q.sql).toMatch(/"subjects"\."active" = \$1/);
    expect(q.params).toEqual([true]);
    expect(Object.keys(seen.fields as object).sort()).toEqual(["id", "kind", "name"]);
    const ord = dialect.sqlToQuery((seen.order as any[])[0]);
    expect(ord.sql).toMatch(/"subjects"\."name" asc/);
    expect(seen.order).toHaveLength(1);
  });
});

describe("TASK-805 — the door: the Teachers menu ONLY", () => {
  test("ROUTE_ACCESS carries `GET /subjects` = the Teachers menu, no action key, nothing wider", () => {
    expect(ROUTE_ACCESS["GET /subjects"]).toEqual({ menus: ["menu:teachers"] });
  });
  test("by value through the ROOT app: only `menu:teachers` ⇒ 200; without it (booking menus only) ⇒ 403", async () => {
    process.env.SKIP_AUTH = "true";
    fakeSelect();
    setUser({ isSuperAdmin: false, grants: ["menu:teachers"] });
    expect((await get("/subjects")).status).toBe(200);
    setUser({ isSuperAdmin: false, grants: ["menu:calendar", "menu:bookings", "menu:students"] });
    expect((await get("/subjects")).status).toBe(403);
    setUser({ isSuperAdmin: false, grants: [] });
    expect((await get("/subjects")).status).toBe(403);
  });
});

describe("TASK-805 — nothing else moved", () => {
  const SCHED = code(src("src/services/scheduler.service.ts"));
  const API = code(src("src/routes/api.ts"));
  test("one read route, GET only, no body/query validator; the save path and /sellable-packages untouched in shape", () => {
    expect(API).toContain('.get("/subjects", async (c) => c.json(await svc.listSubjects()))');
    expect(API).not.toMatch(/\.(post|patch|put|delete)\("\/subjects/);
    expect(API).toContain('.get("/sellable-packages", async (c) => c.json(await svc.getSellablePackages()))');
    expect(SCHED).toContain("unpricedSubjects: rows");
  });
  test("the contract type is exactly `{ subjects: { id, name, kind }[] }`", () => {
    const C = code(src("src/types/contract.ts"));
    expect(C).toContain('export interface SubjectListItemDTO { id: string; name: string; kind: "PRIVATE" | "DUO" }');
    expect(C).toContain("export interface SubjectListResponse { subjects: SubjectListItemDTO[] }");
  });
});
