// TASK-406 (`REQ-097`, SPEC-083 C-1 + C-2) — the user ↔ teacher LINK (`0044`), OWN SCOPE (one predicate on every
// calendar/bookings read, 404 outside by id), the fail-closed `TEACHER_ALLOWED` route set for a linked account,
// `attend`-only status, the users page's link (409 TEACHER_LINKED), `/me.teacherId`, the OWN LEAVE (`TEACHER_LEAVE`,
// the 4th reason; the FAMILY's NEW notice as a placeholder kind; the other teachers' coach notice). 45 = 45.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { ApiException } from "./http";
import { SCOPE_TEACHER, assertLinked, assertOwnBooking, assertScopedStatusAction, isOwnBooking, isScoped, ownScopeWhere, scopeOf } from "./own-scope";
import { ROUTE_ACCESS, TEACHER_ALLOWED } from "./route-access";
import { ACTION_KEYS, ACTION_REGISTRY, MENU_KEYS } from "./permissions";
import { END_REASONS, isEndReason } from "./course-plan";
import { formatOutboxMessage } from "./line-message";
import { t } from "./line-i18n";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { signToken } from "./jwt";
import { DEV_USER, accessGuard, authMiddleware, toAuthUser } from "../middleware/auth";
import * as usersSvc from "../services/user.service";
import * as sched from "../services/scheduler.service";
import * as checkin from "../services/checkin.service";
import * as v from "../validation";
import { db } from "../db";
import { bookings } from "../db/schema";
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
const SCHED = code(src("src/services/scheduler.service.ts"));
const API = code(src("src/routes/api.ts"));
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", U1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", U2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const thrown = (fn: () => unknown) => { try { fn(); return null; } catch (e: any) { return { status: e.status, code: e.code, message: e.message }; } };
const origSkip = process.env.SKIP_AUTH;
afterAll(() => { if (origSkip === undefined) delete process.env.SKIP_AUTH; else process.env.SKIP_AUTH = origSkip; });

describe("🔴 the migration — 0044, counted, ONE nullable FK column + the partial unique index LAST = the witness (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const sql = readFileSync(resolve(root, "drizzle/0044_user_teacher_link.sql"), "utf8");
  test("45 = 45: `0044_user_teacher_link` is the 45th file, idx 44, the last; 'expects 45' in the header", () => {
    expect(files.length).toBe(45);
    expect(journal.entries.length).toBe(45);
    expect(files[44]).toBe("0044_user_teacher_link.sql");
    expect(journal.entries[44]).toMatchObject({ idx: 44, tag: "0044_user_teacher_link" });
    expect(sql).toContain("`db:verify`\n-- expects 45");
  });
  test("two statements: the NULL FK to teachers ON DELETE RESTRICT, then the partial unique index; the teachers lock named; no enum, no bookings", () => {
    const stmts = sql.split("\n").filter((l) => !l.startsWith("--") && l.trim()).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
    expect(stmts.length).toBe(2);
    expect(stmts[0]).toBe('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "teacher_id" uuid NULL REFERENCES "teachers"("id") ON DELETE RESTRICT');
    expect(stmts[1]).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "users_teacher_id_uq" ON "users" ("teacher_id") WHERE "teacher_id" IS NOT NULL');
    expect(stmts.join(";")).not.toMatch(/CREATE TYPE|ALTER TYPE|'GROUP'|"bookings"|DEFAULT/);
    expect(sql).toContain("SHARE ROW EXCLUSIVE on `teachers`");
    expect(sql).toContain("No lock on any hot table");
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0044_user_teacher_link");
    expect(w).toMatchObject({ tag: "0044_user_teacher_link", probe: { kind: "index", index: "users_teacher_id_uq" }, rerunnable: true });
    const schema = code(src("src/db/schema.ts"));
    const users = region(schema, 'export const users = pgTable(\n  "users",', "\n);");
    expect(users).toContain('teacherId: uuid("teacher_id").references(() => teachers.id, { onDelete: "restrict" }),');
    expect(users).toContain('uniqueIndex("users_teacher_id_uq").on(t.teacherId).where(');
    expect(region(schema, "export const usersRelations = relations(users,", "}));")).toContain("teacher: one(teachers, { fields: [users.teacherId], references: [teachers.id] }),");
  });
});

describe("🔴 OWN SCOPE — the link is the scope (fails closed); ONE predicate; 404 outside by id (value + source)", () => {
  test("`isScoped` / `scopeOf`: the link, not a grant; the dev user and every fixture without a link are unscoped", () => {
    expect(isScoped(DEV_USER)).toBe(false); expect(scopeOf(DEV_USER)).toBeNull();
    expect(DEV_USER.teacherId).toBeNull();
    const linked = toAuthUser({ id: U1, username: "coach", displayName: "Coach", isSuperAdmin: false, teacherId: ME }, ["menu:calendar"]);
    expect(isScoped(linked)).toBe(true); expect(scopeOf(linked)).toBe(ME);
    const superLinked = toAuthUser({ id: U2, username: "boss", displayName: "Boss", isSuperAdmin: true, teacherId: ME }); // a super admin with a link is STILL scoped — the link, not the role
    expect(isScoped(superLinked)).toBe(true);
    expect(toAuthUser({ id: U2, username: "x", displayName: "X", isSuperAdmin: false }).teacherId).toBeNull();
  });
  test("the predicate's SQL: `teacher_id = me OR EXISTS (booking_teachers …)` — an EXISTS, never a join", () => {
    const q = db.select({ id: bookings.id }).from(bookings).where(ownScopeWhere(ME)).toSQL();
    expect(q.sql).toMatch(/"bookings"\."teacher_id" = \$1 or exists \(select 1 from "booking_teachers" where \("booking_teachers"\."booking_id" = "bookings"\."id" and "booking_teachers"\."teacher_id" = \$2\)\)/);
    expect(q.sql).not.toMatch(/join/i);
    expect(q.params).toEqual([ME, ME]);
  });
  test("`isOwnBooking` / `assertOwnBooking` by value through a fake exec: mine ⇒ pass; not mine ⇒ 404 (not 403); an unscoped caller never reads", async () => {
    const reads: any[] = [];
    const exec = (rows: any[]) => ({ select: () => ({ from: () => ({ where: (w: any) => { reads.push(w); return { limit: async () => rows }; } }) }) });
    expect(await isOwnBooking(exec([{ id: B1 }]), B1, ME)).toBe(true);
    expect(await isOwnBooking(exec([]), B1, ME)).toBe(false);
    await expect(assertOwnBooking(B1, ME, exec([{ id: B1 }]))).resolves.toBeUndefined();
    const notMine = await assertOwnBooking(B1, ME, exec([])).then(() => null, (e) => ({ status: e.status, code: e.code, message: e.message }));
    expect(notMine).toEqual({ status: 404, code: "NOT_FOUND", message: "ไม่พบคาบเรียน" });
    reads.length = 0;
    await expect(assertOwnBooking(B1, null, exec([]))).resolves.toBeUndefined(); // an admin: no read at all
    expect(reads.length).toBe(0);
  });
  test("by source: every scoped read names the ONE predicate; no read restates `teacherId = me`; the by-id reads and the status write assert it at the route", () => {
    const cal = region(SCHED, "export async function getCalendar(", "export async function getBookings(");
    expect((cal.match(/ownScopeWhere\(scope\)/g) ?? []).length).toBe(2); // the grid + the tray
    expect(cal).toContain(".filter((t) => !scope || t.id === scope)"); // MY column
    expect(cal).toContain('(await weeksForCalendar(range)).filter((w: any) => !scope || (w.teacherIds ?? []).includes(scope))'); // my camp weeks
    const list = region(SCHED, "export async function getBookings(", "export async function getDailyReport(");
    expect(list).toContain("if (scope) conds.push(ownScopeWhere(scope));");
    expect(list).toContain("const cond = conds.length ? and(...conds) : sql`true`;"); // one `cond` ⇒ the page and the count agree
    expect(SCHED).not.toMatch(/eq\(bookings\.teacherId, (scope|me)\)/);
    expect(API).toContain("c.json(await svc.getCalendar(c.req.valid(\"query\"), scopeOf(c.get(\"user\")))),");
    expect(API).toContain("c.json(await svc.getBookings(c.req.valid(\"query\"), scopeOf(c.get(\"user\")))),");
    expect((API.match(/await assertOwnBooking\(c\.req\.param\("id"\), scopeOf\(c\.get\("user"\)\)\);/g) ?? []).length).toBe(3); // status · checkin · posted-sale
    expect(API).toContain("assertScopedStatusAction(c.get(\"user\"), action);");
    // the public QR is mounted BEFORE the auth guard — a token is a token, no scope
    const IDX = code(src("src/index.ts"));
    expect(IDX.indexOf('app.route("/api", publicCheckin);')).toBeLessThan(IDX.indexOf('app.use("/api/*", authMiddleware);'));
  });
});

describe("🔴 the fail-closed route set — a LINKED account with EVERY key reaches the eight and nothing else (root guards, real tokens)", () => {
  const rows: Record<string, any> = {
    [U1]: { id: U1, username: "coach", displayName: "Coach", isSuperAdmin: false, disabledAt: null, teacherId: ME },
    [U2]: { id: U2, username: "admin2", displayName: "Admin", isSuperAdmin: false, disabledAt: null, teacherId: null },
  };
  const app = () => {
    process.env.SKIP_AUTH = "false";
    const a = new Hono();
    a.use("/api/*", authMiddleware);
    a.use("/api/*", accessGuard);
    for (const key of Object.keys(ROUTE_ACCESS)) {
      const [m, p] = key.split(" ") as [string, string];
      (a as any)[m.toLowerCase()]("/api" + p, (c: any) => c.json({ ok: key }));
    }
    a.onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message } }, err.status as any) : c.json({ error: "INTERNAL" }, 500)));
    return a;
  };
  const as = async (id: string) => ({ headers: { authorization: `Bearer ${await signToken({ sub: id, username: rows[id].username, role: "admin", isSuperAdmin: false })}` } });
  const hit = async (id: string, key: string) => {
    const [m, p] = key.split(" ") as [string, string];
    const res = await app().request("/api" + p.replace(/:id/g, B1), { method: m, ...(await as(id)), ...(m !== "GET" && m !== "DELETE" ? { headers: { ...(await as(id)).headers, "content-type": "application/json" }, body: "{}" } : {}) });
    return { status: res.status, body: (await res.json()) as any };
  };
  test("the set is exactly the calendar page's calls; every member is in the access table", () => {
    expect([...TEACHER_ALLOWED].sort()).toEqual(["GET /badges", "GET /bookings", "GET /bookings/:id/checkin", "GET /bookings/:id/posted-sale", "GET /calendar", "GET /teachers", "PATCH /bookings/:id/status", "POST /teachers/me/leave"]);
    for (const k of TEACHER_ALLOWED) expect(ROUTE_ACCESS[k]).toBeDefined();
    expect(ROUTE_ACCESS["POST /teachers/me/leave"]).toEqual({ menus: ["menu:calendar"], action: "action:calendar.teacher-leave" });
    for (const k of TEACHER_ALLOWED) expect(k).not.toMatch(/students|parents|courses|attention|reports/);
  });
  test("with ALL 55 keys the linked user gets 200 on the eight and 403 SCOPE_TEACHER on every other table route; the unlinked user with the same keys reaches all", async () => {
    const spies = [
      spyOn(usersSvc, "findUserById").mockImplementation((async (id: string) => rows[id] ?? null) as any),
      spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async () => [...MENU_KEYS, ...ACTION_KEYS]) as any),
    ];
    try {
      const keys = Object.keys(ROUTE_ACCESS);
      let allowed = 0, refused = 0;
      for (const key of keys) {
        const r = await hit(U1, key);
        if (TEACHER_ALLOWED.has(key)) { expect({ key, status: r.status }).toEqual({ key, status: 200 }); allowed++; }
        else { expect({ key, status: r.status, code: r.body?.error?.code }).toEqual({ key, status: 403, code: "SCOPE_TEACHER" }); refused++; }
      }
      expect(allowed).toBe(8);
      expect(refused).toBe(keys.length - 8);
      expect(refused).toBeGreaterThan(90); // the whole table minus the eight (95 today) — a floor, so a shrunken table cannot pass quietly
      for (const key of ["POST /bookings", "PATCH /bookings/:id", "POST /bookings/:id/pause", "GET /students", "GET /attention"]) expect((await hit(U2, key)).status).toBe(200); // unlinked: untouched
      expect((await hit(U1, "POST /bookings")).body).toEqual({ error: { code: "SCOPE_TEACHER", message: "บัญชีครูทำได้เฉพาะดูตารางตัวเอง เช็คอิน และแจ้งลา" } });
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
  test("the guard's order by source: menu → action → scope; the scope line names the set", () => {
    const G = code(src("src/middleware/auth.ts"));
    const g = region(G, "export async function accessGuard(", "export async function requireSuperAdmin(");
    expect(g.indexOf("throw MENU_FORBIDDEN();")).toBeLessThan(g.indexOf("throw ACTION_FORBIDDEN();"));
    expect(g.indexOf("throw ACTION_FORBIDDEN();")).toBeLessThan(g.indexOf("if (isScoped(user) && !TEACHER_ALLOWED.has(routeKey(c.req.method, path))) throw SCOPE_TEACHER();"));
    // 🔻 TASK-408: the `/users*` + `/roles*` scope refusal sits BEFORE their early exit; `/auth`, `/me`, `/permissions` stay exempt
    expect(g.indexOf("if (/^\\/api\\/(users|roles)(\\/|$)/.test(path) && isScoped(user)) throw SCOPE_TEACHER();")).toBeLessThan(g.indexOf("if (/^\\/api\\/(auth|users|me|permissions|roles)(\\/|$)/.test(path)) return next();"));
  });
  test("🔴 TASK-408 — a LINKED super admin is refused on /users* and /roles* (403 SCOPE_TEACHER) while an unlinked one passes; a linked account still reaches /me and /permissions (real tokens)", async () => {
    const SA_LINKED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", SA_FREE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const rows2: Record<string, any> = {
      [SA_LINKED]: { id: SA_LINKED, username: "bosscoach", displayName: "Boss Coach", isSuperAdmin: true, disabledAt: null, teacherId: ME },
      [SA_FREE]: { id: SA_FREE, username: "boss", displayName: "Boss", isSuperAdmin: true, disabledAt: null, teacherId: null },
      [U1]: rows[U1],
    };
    const spies = [
      spyOn(usersSvc, "findUserById").mockImplementation((async (id: string) => rows2[id] ?? null) as any),
      spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async () => []) as any),
    ];
    try {
      process.env.SKIP_AUTH = "false";
      const a = new Hono();
      a.use("/api/*", authMiddleware);
      a.use("/api/*", accessGuard);
      for (const p of ["/api/users", "/api/roles", "/api/me", "/api/permissions", "/api/auth/logout"]) { a.get(p, (c) => c.json({ ok: p })); a.post(p, (c) => c.json({ ok: p })); }
      a.get("/api/users/:id", (c) => c.json({ ok: "user" }));
      a.onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message } }, err.status as any) : c.json({ error: "INTERNAL" }, 500)));
      const tok = async (id: string) => ({ headers: { authorization: `Bearer ${await signToken({ sub: id, username: rows2[id].username, role: "admin", isSuperAdmin: rows2[id].isSuperAdmin })}` } });
      const st = async (id: string, path: string, method = "GET") => (await a.request(path, { method, ...(await tok(id)) })).status;
      for (const [path, method] of [["/api/users", "GET"], ["/api/users", "POST"], ["/api/users/" + B1, "GET"], ["/api/roles", "GET"], ["/api/roles", "POST"]] as const) {
        expect({ path, method, linked: await st(SA_LINKED, path, method) }).toEqual({ path, method, linked: 403 });
        expect({ path, method, free: await st(SA_FREE, path, method) }).toEqual({ path, method, free: 200 });
      }
      const res = await a.request("/api/users", await tok(SA_LINKED));
      expect(await res.json()).toEqual({ error: { code: "SCOPE_TEACHER", message: "บัญชีครูทำได้เฉพาะดูตารางตัวเอง เช็คอิน และแจ้งลา" } });
      for (const id of [SA_LINKED, U1]) for (const path of ["/api/me", "/api/permissions", "/api/auth/logout"]) expect({ id, path, status: await st(id, path) }).toEqual({ id, path, status: 200 });
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
  test("🔴 TASK-408 — the LOGIN body carries `teacherId` (and `teacherName`) beside menus/actions — the FE's first paint knows the scope", async () => {
    const s1 = spyOn(usersSvc, "authenticate").mockImplementation((async () => ({ id: U1, username: "coach", displayName: "Coach", isSuperAdmin: false, disabledAt: null, createdAt: new Date("2026-09-17T00:00:00.000Z"), roleId: null, teacherId: ME })) as any);
    const s2 = spyOn(usersSvc, "userDTO").mockImplementation((async (row: any) => usersSvc.toUserDTO({ ...row, teacher: { nickname: "ครูเอก" } }, [], null)) as any);
    try {
      const res = await rootApp.fetch(new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "coach", password: "x" }) }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.user).toMatchObject({ id: U1, teacherId: ME, teacherName: "ครูเอก", menus: [], actions: [] });
      expect(Object.keys(body.user)).toEqual(expect.arrayContaining(["teacherId", "teacherName", "menus", "actions", "role"]));
      expect(code(src("src/routes/auth.ts"))).toContain("user: { ...(await userDTO(user)), role }"); // the SAME DTO as the users page — one shape
    } finally { s1.mockRestore(); s2.mockRestore(); }
  });
});

describe("🔴 `attend` only, the leave for a LINKED account only, the users page's link, `/me.teacherId` (value + root app)", () => {
  test("`assertScopedStatusAction`: a linked user may `attend`; confirm / sick-leave / cancel ⇒ 403 SCOPE_TEACHER; an admin anything", () => {
    const linked = { teacherId: ME }, admin = { teacherId: null };
    expect(() => assertScopedStatusAction(linked, "attend")).not.toThrow();
    for (const a of ["confirm", "sick-leave", "cancel"]) expect(thrown(() => assertScopedStatusAction(linked, a))).toMatchObject({ status: 403, code: "SCOPE_TEACHER" });
    for (const a of ["confirm", "attend", "sick-leave", "cancel"]) expect(() => assertScopedStatusAction(admin, a)).not.toThrow();
    expect(assertLinked(linked)).toBe(ME);
    expect(thrown(() => assertLinked(admin))).toMatchObject({ status: 403, code: "SCOPE_TEACHER" });
    expect(SCOPE_TEACHER().message).toBe("บัญชีครูทำได้เฉพาะดูตารางตัวเอง เช็คอิน และแจ้งลา");
  });
  test("the users page: `teacherId` on create/update (nullable), `teacherName` on the DTO, `409 TEACHER_LINKED` from the service before the index; the key is the 55th", () => {
    expect(v.createUser.safeParse({ username: "coach", password: "longenough1", displayName: "Coach", teacherId: ME }).success).toBe(true);
    expect(v.updateUser.safeParse({ teacherId: null }).success).toBe(true);
    expect(v.updateUser.safeParse({ teacherId: "nope" }).success).toBe(false);
    const dto = usersSvc.toUserDTO({ id: U1, username: "coach", displayName: "Coach", isSuperAdmin: false, disabledAt: null, createdAt: new Date(), teacherId: ME, teacher: { nickname: "ครูเอก", name: "Ek" } });
    expect(dto).toMatchObject({ teacherId: ME, teacherName: "ครูเอก" });
    expect(usersSvc.toUserDTO({ id: U2, username: "a", displayName: "A", isSuperAdmin: true, disabledAt: null, createdAt: new Date() })).toMatchObject({ teacherId: null, teacherName: null });
    const S = code(src("src/services/user.service.ts"));
    expect(S).toContain('if (taken) throw conflict("TEACHER_LINKED", "ครูคนนี้มีบัญชีแล้ว");');
    expect(S).toContain("if (input.teacherId) await assertTeacherFree(input.teacherId, null);");
    expect(S).toContain("if (input.teacherId) await assertTeacherFree(input.teacherId, id);");
    expect(S).toContain("patch.teacherId = input.teacherId;");
    expect(ACTION_KEYS.length).toBe(55);
    expect(ACTION_REGISTRY.find((a) => a.key === "action:calendar.teacher-leave")).toMatchObject({ labelTh: "แจ้งลาสอน (ครู)", labelEn: "Report own teaching leave" });
    expect(code(src("src/routes/me.ts"))).toContain("teacherId: u.teacherId }");
  });
  test("through the ROOT app (dev user, unscoped): `PATCH /bookings/:id/status` cancel still reaches the service; `POST /teachers/me/leave` ⇒ 403 for an unlinked account before the service", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s1 = spyOn(sched, "updateBookingStatus").mockImplementation((async (...a: any[]) => { calls.push(a); return { booking: { id: a[0] } }; }) as any);
    const s2 = spyOn(sched, "reportOwnLeave").mockImplementation((async () => ({ cancelled: 0, bookingIds: [], familiesNotified: 0 })) as any);
    try {
      const r = await rootApp.fetch(new Request(`http://localhost/api/bookings/${B1}/status`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", reasonCode: "TEACHER_LEAVE", reason: "ลา" }) }));
      expect(r.status).toBe(200);
      expect(calls.at(-1)![1]).toBe("cancel");
      const leave = await rootApp.fetch(new Request("http://localhost/api/teachers/me/leave", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: "2026-10-05", reason: "ป่วย" }) }));
      expect(leave.status).toBe(403);
      expect(await leave.json()).toEqual({ error: { code: "SCOPE_TEACHER", message: "บัญชีครูทำได้เฉพาะดูตารางตัวเอง เช็คอิน และแจ้งลา" } });
      expect(s2).not.toHaveBeenCalled();
      const bad = await rootApp.fetch(new Request("http://localhost/api/teachers/me/leave", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: "2026-10-05", reason: "ab" }) }));
      expect(bad.status).toBe(400); // the body shape first
    } finally { s1.mockRestore(); s2.mockRestore(); }
  });
});

describe("🔴 the OWN LEAVE — `TEACHER_LEAVE` the 4th reason; the family's NEW notice (placeholder by form); the other teachers told, never me (value + source)", () => {
  test("the reason set: four, the validator reads the SAME set (no copy), the label TH `ครูลา` / EN `Teacher leave`", () => {
    expect([...END_REASONS]).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR", "TEACHER_LEAVE"]);
    expect(isEndReason("TEACHER_LEAVE")).toBe(true);
    expect(v.updateStatus.safeParse({ action: "cancel", reasonCode: "TEACHER_LEAVE" }).success).toBe(true);
    expect(v.updateStatus.safeParse({ action: "cancel", reasonCode: "SOMETHING" }).success).toBe(false);
    expect(code(src("src/validation.ts"))).toContain("reasonCode: z.enum(END_REASONS).optional(),");
    expect(code(src("src/validation.ts"))).not.toContain('z.enum(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR"])');
    expect(t("ob_reason_TEACHER_LEAVE", "TH")).toBe("ครูลา");
    expect(t("ob_reason_TEACHER_LEAVE", "EN")).toBe("Teacher leave");
    // the admin's REASON_ENUM_REQUIRED is untouched — a course session's admin cancel still needs no code
    expect(SCHED).toContain('const REASON_ENUM_REQUIRED = new Set(["SINGLE_SESSION", "VOUCHER", "FIRST_TRIAL", "OTHER", "GROUP"]);');
  });
  test("the leave's validation and the service by source: my LIVE rows that date (or the named subset, 404 otherwise), ATTENDED ⇒ 409 SESSION_DELIVERED before any write, ONE tx, the cancel's shape", () => {
    expect(v.teacherLeave.safeParse({ date: "2026-10-05", reason: "ป่วย" }).success).toBe(true);
    expect(v.teacherLeave.safeParse({ date: "2026-10-05", sessionIds: [B1], reason: "ป่วยกะทันหัน" }).success).toBe(true);
    expect(v.teacherLeave.safeParse({ date: "2026-10-05", sessionIds: [], reason: "ป่วย" }).success).toBe(false);
    expect(v.teacherLeave.safeParse({ date: "05/10/2026", reason: "ป่วย" }).success).toBe(false);
    const L = region(SCHED, "export async function reportOwnLeave(", "async function sendCourseDroppedToTeachers(");
    expect(L).toContain('a(e(b.date, input.date), nul(b.groupId), inA(b.status, [...COURSE_LIVE_STATUSES, "ATTENDED"]), ownScopeWhere(me))');
    expect(L).toContain('if (wanted) for (const id of wanted) if (!mine.some((b) => b.id === id)) throw notFound("ไม่พบคาบเรียน");');
    expect(L).toContain('if (delivered) throw conflict("SESSION_DELIVERED", `คาบ ${hhmm(delivered.startTime)} สอนไปแล้ว — แจ้งลาไม่ได้`);');
    expect(L.indexOf("SESSION_DELIVERED")).toBeLessThan(L.indexOf("db.transaction(")); // pre-checked, nothing written
    expect((L.match(/db\.transaction\(/g) ?? []).length).toBe(1);
    expect(L).toContain('if (b.bookingType === "GROUP") await cancelSeatsOfGroup(tx, b.id, input.reason);');
    expect(L).toContain('set({ status: "CANCELLED", note: input.reason, cancelReason: "TEACHER_LEAVE" })');
    expect(L).toContain("if (b.courseId) await reconcileCoursePlan(tx, b.courseId);");
    expect(L).toContain('await sendClassCancelledToOtherTeachers(tx, b as any, { cancelReason: "TEACHER_LEAVE", note: input.reason }, me);');
    expect(L).toContain('kind: "class_cancelled_parent"');
    expect(L).toContain("await enqueueParentCopies(tx, await parentLineUserIds(tx, sid), { bookingId: b.id, payload });");
    expect(L).toContain('if (b.status === "CONFIRMED") {'); // a PENDING session was never announced
    expect(L).not.toMatch(/sendClassCancelledToTeacher\(|cutoff|cut-off|noticeHours/); // never the single-coach notice (me); no cut-off
    expect(L).toContain("return { cancelled: live.length, bookingIds: live.map((b) => b.id), familiesNotified };");
    // the other teachers: minus me, CONFIRMED only
    const O = region(SCHED, "async function sendClassCancelledToOtherTeachers(", "export async function reportOwnLeave(");
    expect(O).toContain('if (current.status !== "CONFIRMED") return 0;');
    expect(O).toContain(".filter((x): x is string => !!x && x !== me)");
    expect(O).toContain('kind: "class_cancelled_teacher"');
    // the route: literal before the param routes (TASK-029), the linked assertion inline
    expect(API.indexOf('.post("/teachers/me/leave"')).toBeLessThan(API.indexOf('.get("/teachers", zValidator("query", v.teachersQuery)'));
    expect(API).toContain('c.json(await svc.reportOwnLeave(assertLinked(c.get("user")), c.req.valid("json"), actorOf(c))),');
    // 🚫 the admin's cancel is still coach-only (the owner's call): the family kind has ONE producer
    expect((SCHED.match(/class_cancelled_parent/g) ?? []).length).toBe(1);
    expect(region(SCHED, '} else if (action === "cancel") {', '} else if (action === "sick-leave"')).not.toContain("enqueueParentCopies");
  });
  test("📖 the family notice by FORM (PLACEHOLDER `cl_title` — the words are the owner's): the coach's block for a parent, the reason line `ครูลา`, both languages", () => {
    const payload = { kind: "class_cancelled_parent", bookingId: B1, bookingType: "COURSE_PACKAGE", size: 10, cancelReason: "TEACHER_LEAVE", note: "ป่วย" };
    const ctx = { studentName: "น้องเอ", subject: "Freeskate", date: "2026-10-05", startTime: "10:00", endTime: "11:00", coach: "ครูเอก" } as any;
    const th = formatOutboxMessage(payload as any, ctx, "TH", "parent");
    const en = formatOutboxMessage(payload as any, ctx, "EN", "parent");
    for (const m of [th, en]) { expect(m).toContain("น้องเอ"); expect(m).toContain("05-10-2026"); expect(m).toContain("10:00-11:00"); expect(m).not.toMatch(/[{}]/); expect(m).toBe(m.trimEnd()); expect(m).not.toContain("2026-10-05"); }
    expect(th).toContain("ครูลา");
    expect(en).toContain("Teacher leave");
    expect(th.split("\n")[0]).toBe(t("cl_title", "TH"));
    expect(src("src/lib/line-i18n.ts")).toContain("PLACEHOLDER — MINE, and the owner has NOT seen it.** The FAMILY's cancel notice");
    // the coach's own message is untouched by the new kind
    const coach = formatOutboxMessage({ ...payload, kind: "class_cancelled_teacher" } as any, ctx, "TH", "teacher");
    expect(coach.split("\n")[0]).toBe(t("ob_class_cancelled_title", "TH"));
    expect(coach).toContain("ครูลา");
  });
  test("through the ROOT app (service spied): the linked user's leave reaches the service with `me`; the 409 envelope passes by value", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(sched, "reportOwnLeave").mockImplementation((async (me: string, input: any) => {
      calls.push([me, input]);
      if (input.date === "2026-10-04") throw new ApiException(409, "SESSION_DELIVERED", "คาบ 10:00 สอนไปแล้ว — แจ้งลาไม่ได้");
      return { cancelled: 2, bookingIds: [B1, U1], familiesNotified: 2 };
    }) as any);
    // a linked DEV user for this test only (the route asserts the link, the guard is skipped under SKIP_AUTH)
    const saved = DEV_USER.teacherId; (DEV_USER as any).teacherId = ME;
    try {
      const post = (body: any) => rootApp.fetch(new Request("http://localhost/api/teachers/me/leave", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const ok = await post({ date: "2026-10-05", reason: "ป่วย" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ cancelled: 2, bookingIds: [B1, U1], familiesNotified: 2 });
      expect(calls.at(-1)![0]).toBe(ME);
      const gone = await post({ date: "2026-10-04", reason: "ป่วย" });
      expect(gone.status).toBe(409);
      expect(await gone.json()).toEqual({ error: { code: "SESSION_DELIVERED", message: "คาบ 10:00 สอนไปแล้ว — แจ้งลาไม่ได้" } });
      // a linked user: `cancel` on the status route is refused at the route, the service untouched
      const st = spyOn(sched, "updateBookingStatus").mockImplementation((async () => ({})) as any);
      try {
        const r = await rootApp.fetch(new Request(`http://localhost/api/bookings/${B1}/status`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", reasonCode: "ADMIN_ERROR" }) }));
        expect(r.status).toBe(403);
        expect(((await r.json()) as any).error.code).toBe("SCOPE_TEACHER");
        expect(st).not.toHaveBeenCalled();
      } finally { st.mockRestore(); }
    } finally { (DEV_USER as any).teacherId = saved; s.mockRestore(); }
  });
  test("the check-in QR read for a linked user goes through `assertOwnBooking` before the service (source); the public scan has no user at all", () => {
    expect(region(API, '.get("/bookings/:id/checkin"', ".get(\"/bookings/:id/posted-sale\"")).toContain('await assertOwnBooking(c.req.param("id"), scopeOf(c.get("user")));');
    expect(code(src("src/services/checkin.service.ts"))).not.toMatch(/scopeOf|ownScope|teacherId === /);
    void checkin;
  });
});
