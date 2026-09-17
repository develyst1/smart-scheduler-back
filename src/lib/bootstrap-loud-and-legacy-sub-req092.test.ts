// TASK-380 (`REQ-092` Stage 1 field defects, `sid`) — §1 the bootstrap refuses LOUDLY when the env pair breaks
// the password/username rule (on `sid` the pair was 5 chars: silent 400 inside the login, an empty table, hours
// lost) and NEVER logs a credential; §2 a legacy token (`sub = "admin"`, every pre-cutover admin) is a 401 at the
// guard, not a 22P02 → 500 — the claim's shape is checked before the row read; a real DB error is not swallowed.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { authMiddleware, UUID_RE } from "../middleware/auth";
import { ApiException } from "./http";
import { signToken } from "./jwt";
import * as usersSvc from "../services/user.service";
import { readSrc } from "./read-src";

process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("🔑 §1 the bootstrap refuses LOUDLY — the same rules as createUser, checked BEFORE the call", () => {
  const env = { ...process.env };
  afterEach(() => { process.env.BOOTSTRAP_ADMIN_USERNAME = env.BOOTSTRAP_ADMIN_USERNAME; process.env.BOOTSTRAP_ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD; });

  test("the pure refusal: a 5-char password ⇒ PASSWORD_TOO_SHORT (the sid case); an 8-char one ⇒ null; a bad username ⇒ VALIDATION", () => {
    expect(usersSvc.bootstrapEnvRefusal("admin", "admin")).toMatchObject({ status: 400, code: "PASSWORD_TOO_SHORT" });
    expect(usersSvc.bootstrapEnvRefusal("admin", "admin-som")).toBeNull();
    expect(usersSvc.bootstrapEnvRefusal("ad", "admin-som")).toMatchObject({ status: 400, code: "VALIDATION" });
    expect(usersSvc.bootstrapEnvRefusal("Admin", "12345678")).toBeNull(); // normalised before the pattern
    // the boundary IS PASSWORD_MIN — 7 refused, 8 accepted (mutation D of this task drifted the minimum to 6 and passed until this line)
    expect(usersSvc.bootstrapEnvRefusal("admin", "1234567")).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    expect(usersSvc.bootstrapEnvRefusal("admin", "123456")).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    expect(usersSvc.PASSWORD_MIN).toBe(8);
  });

  test("🔴 the sid case end to end: empty table + the 5-char pair ⇒ the login answers 400 PASSWORD_TOO_SHORT, ONE error log line per process, NO insert", async () => {
    process.env.BOOTSTRAP_ADMIN_USERNAME = "admin"; process.env.BOOTSTRAP_ADMIN_PASSWORD = "admin";
    const created: any[] = [];
    const logs: string[] = [];
    const s1 = spyOn(usersSvc, "countUsers").mockImplementation((async () => 0) as any);
    const s2 = spyOn(usersSvc, "createUser").mockImplementation((async (i: any) => { created.push(i); return {} as any; }) as any);
    const s3 = spyOn(console, "error").mockImplementation(((...a: any[]) => { logs.push(a.join(" ")); }) as any);
    try {
      for (let i = 0; i < 3; i++) {
        const e = await usersSvc.bootstrapIfEmpty("admin", "admin").catch((x) => x);
        expect(e).toBeInstanceOf(ApiException);
        expect([e.status, e.code]).toEqual([400, "PASSWORD_TOO_SHORT"]);
      }
      expect(created).toEqual([]);
      const mine = logs.filter((l) => l.includes("[auth] bootstrap REFUSED"));
      expect(mine.length).toBeLessThanOrEqual(1); // once per PROCESS — another test file may have logged it first
      for (const l of logs) expect(l).not.toContain("admin-som"); // and never the value
    } finally { s1.mockRestore(); s2.mockRestore(); s3.mockRestore(); }
  });

  test("an 8-char pair on an empty table ⇒ created, as before", async () => {
    process.env.BOOTSTRAP_ADMIN_USERNAME = "boss"; process.env.BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-pass";
    const created: any[] = [];
    const s1 = spyOn(usersSvc, "countUsers").mockImplementation((async () => 0) as any);
    const s2 = spyOn(usersSvc, "createUser").mockImplementation((async (i: any) => { created.push(i); return {} as any; }) as any);
    const s3 = spyOn(console, "info").mockImplementation((() => {}) as any);
    try {
      expect(await usersSvc.bootstrapIfEmpty("boss", "bootstrap-pass")).toBe(true);
      expect(created).toEqual([{ username: "boss", password: "bootstrap-pass", displayName: "boss", isSuperAdmin: true }]);
    } finally { s1.mockRestore(); s2.mockRestore(); s3.mockRestore(); }
  });

  test("🚫 NO credential in any log line — the negative over the file: no `console.*` argument names a password variable", () => {
    const SVC = code(src("src/services/user.service.ts"));
    const calls = [...SVC.matchAll(/console\.(log|info|warn|error|debug)\(([\s\S]*?)\);/g)].map((m) => m[2]!);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect({ args: args.slice(0, 80), leaks: /envPass|password|passwordHash|input\.password/.test(args) }).toEqual({ args: args.slice(0, 80), leaks: false });
    }
    // and the human's debug lines are gone
    expect(SVC).not.toMatch(/console\.log\('createUser|console\.log\('env |console\.log\('bootstrapIfEmpty/);
    expect(SVC).not.toContain("console.log(");
  });

  test("`.env.example`: the placeholder is EMPTY with the rule beside it", () => {
    const ENV = readFileSync(resolve(root, ".env.example"), "utf8");
    expect(ENV).toMatch(/^BOOTSTRAP_ADMIN_PASSWORD=$/m);
    expect(ENV).toContain("min 8 chars; read only while the users table is empty");
  });
});

describe("🔴 §2 a legacy `sub` is a 401 at the guard, not a 22P02 → 500", () => {
  const KNOWN = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];
  const spy = spyOn(usersSvc, "findUserById").mockImplementation((async (id: string) => {
    calls.push(id);
    if (id === "dbdead00-0000-4000-8000-000000000000") throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    return id === KNOWN ? { id, username: "admin", displayName: "Admin", isSuperAdmin: true, disabledAt: null } : null;
  }) as any);
  afterAll(() => spy.mockRestore());
  const origSkip = process.env.SKIP_AUTH;
  afterAll(() => { if (origSkip === undefined) delete process.env.SKIP_AUTH; else process.env.SKIP_AUTH = origSkip; });

  const app = () => {
    process.env.SKIP_AUTH = "false";
    const a = new Hono();
    a.use("/api/*", authMiddleware);
    a.get("/api/ping", (c) => c.json({ ok: true, username: c.get("user").username }));
    a.onError((err, c) => (err instanceof ApiException ? c.json({ error: err.code, message: err.message }, err.status as any) : c.json({ error: "INTERNAL" }, 500)));
    return a;
  };
  const bearer = async (sub: string) => ({ headers: { authorization: `Bearer ${await signToken({ sub, username: "x", role: "admin", isSuperAdmin: false })}` } });

  test("🔴 the pre-cutover token (`sub = \"admin\"`) ⇒ 401 with the token sentence, and NO query is issued", async () => {
    calls.length = 0;
    const res = await app().request("/api/ping", await bearer("admin"));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).message).toBe("โทเคนไม่ถูกต้องหรือหมดอายุ");
    expect(calls).toEqual([]);
  });

  test("a well-formed UNKNOWN id ⇒ 401 (the row read ran); a well-formed KNOWN id ⇒ through", async () => {
    calls.length = 0;
    const unknown = await app().request("/api/ping", await bearer("99999999-9999-4999-8999-999999999999"));
    expect(unknown.status).toBe(401);
    expect(calls).toEqual(["99999999-9999-4999-8999-999999999999"]);
    const known = await app().request("/api/ping", await bearer(KNOWN));
    expect(known.status).toBe(200);
    expect(((await known.json()) as any).username).toBe("admin");
  });

  test("🚫 a real database error on the read is NOT swallowed into a 401 — it stays a 500", async () => {
    const res = await app().request("/api/ping", await bearer("dbdead00-0000-4000-8000-000000000000"));
    expect(res.status).toBe(500);
  });

  test("the shape check is the uuid pattern, before the read, in the guard (source)", () => {
    expect(UUID_RE.test(KNOWN)).toBe(true);
    for (const bad of ["admin", "dev", "", "not-a-uuid", "11111111111111111111111111111111"]) expect(UUID_RE.test(bad)).toBe(false);
    const MW = code(src("src/middleware/auth.ts"));
    expect(MW.indexOf("if (!UUID_RE.test(sub)) throw new ApiException(401")).toBeLessThan(MW.indexOf("const row = await findUserById(sub);"));
    expect(MW).not.toMatch(/try\s*\{\s*[^}]*findUserById/); // no catch-all around the lookup
  });
});
