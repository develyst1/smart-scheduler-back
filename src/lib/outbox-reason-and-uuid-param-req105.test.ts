// TASK-450 (`REQ-105 §7` c+d) — two things the `sid` log could not say:
//   (c) `sent=0 failed=N`, all afternoon. The ROW always stored its reason; the RUN said only a number, so a monthly
//       quota wall and a dead token looked identical from the log. Now LINE's own `message` / `details[].message` is
//       what the row stores AND what the run's summary carries (the first distinct reason, + how many others).
//   (d) `camp_weeks` / `camp_days` queried with the literal string `"undefined"` ⇒ `22P02` from Postgres — a 500 for
//       a malformed request. Now a `:id`-shaped param that is not a uuid is a 400 at the boundary, zero queries.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeLineError } from "./line-client";
import { FREE_FORM_PARAMS, badUuidParams, isUuid } from "../middleware/uuid-params";
import { ROUTE_ACCESS } from "./route-access";
import * as camp from "../services/camp.service";
import { db } from "../db";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: unknown) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const W = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });

describe("🔴 (c) a failed push says WHY — LINE's own words, on the row and in the run summary", () => {
  test("`describeLineError` by value: the quota wall, a bad token, a details[] body, a non-JSON body, an empty body", () => {
    // the shape LINE returns when the free push quota is gone — the sentence this whole task is about
    expect(describeLineError(429, JSON.stringify({ message: "You have reached your monthly limit." })))
      .toBe("LINE push failed 429: You have reached your monthly limit.");
    expect(describeLineError(401, JSON.stringify({ message: "Authentication failed due to the following reason: invalid token." })))
      .toBe("LINE push failed 401: Authentication failed due to the following reason: invalid token.");
    // `details[]` carries the field-level reason — both halves, de-duplicated, one line
    expect(describeLineError(400, JSON.stringify({ message: "The request body has 1 error(s)", details: [{ message: "May not be empty", property: "messages[0].text" }] })))
      .toBe("LINE push failed 400: The request body has 1 error(s) — messages[0].text May not be empty");
    expect(describeLineError(400, JSON.stringify({ message: "same", details: [{ message: "same" }] }))).toBe("LINE push failed 400: same");
    // not JSON ⇒ the raw text, never nothing; empty ⇒ just the status
    expect(describeLineError(502, "<html>Bad Gateway</html>")).toBe("LINE push failed 502: <html>Bad Gateway</html>");
    expect(describeLineError(500, "")).toBe("LINE push failed 500");
    expect(describeLineError(429, "x".repeat(400))).toBe(`LINE push failed 429: ${"x".repeat(300)}`); // still bounded
    expect(code(src("src/lib/line-client.ts"))).toContain("throw new LinePushError(res.status, describeLineError(res.status, body), retryable);");
  });
  test("🔴 the RUN carries the distinct reasons — the quota wall is one line, not an afternoon of counts", () => {
    const S = code(src("src/services/outbox.service.ts"));
    expect(S).toContain("const errors: string[] = [];");
    expect(S).toContain("if (!errors.includes(err.message)) errors.push(err.message);");
    expect(S).toContain("return { sent, failed, retry, errors };");
    // the summary line: `[outbox] sent=0 failed=12 retry=0 — LINE push failed 429: You have reached your monthly limit.`
    expect(S).toContain("`[outbox] sent=${r.sent} failed=${r.failed} retry=${r.retry}${r.errors.length ? ` — ${r.errors[0]}` : \"\"}${r.errors.length > 1 ? ` (+${r.errors.length - 1} other reason${r.errors.length > 2 ? \"s\" : \"\"})` : \"\"}`");
    // …and the row still stores its own reason, as it always did — the diagnosis was never lost, only unreadable
    expect(S).toContain('.set({ status: permanent ? "FAILED" : "PENDING", attempts, error: err.message })');
  });
});

describe("🔴 (d) a malformed `:id` is a 400 at the boundary — zero queries, never a 22P02", () => {
  test("`badUuidParams` by value: which params must be uuids, and which deliberately need not be", () => {
    expect(badUuidParams("/api/camp/weeks/:id/days", `/api/camp/weeks/${W}/days`)).toEqual([]);
    expect(badUuidParams("/api/camp/weeks/:id/days", "/api/camp/weeks/undefined/days")).toEqual(["id"]); // THE defect
    expect(badUuidParams("/api/camp/weeks/:id/days", "/api/camp/weeks/null/days")).toEqual(["id"]);
    expect(badUuidParams("/api/camp/weeks/:id/days", "/api/camp/weeks//days")).toEqual(["id"]);
    expect(badUuidParams("/api/camp/days/:id/checkin", "/api/camp/days/undefined/checkin")).toEqual(["id"]);
    // `:teacherId`-shaped names are ids too; `:key` (a SETTINGS key) and `:date` are not
    expect(badUuidParams("/api/other-series/:key/teachers/:teacherId", `/api/other-series/${W}/teachers/nope`)).toEqual(["teacherId"]);
    expect(badUuidParams("/api/settings/:key", "/api/settings/camp_reminder_enabled")).toEqual([]);
    expect(badUuidParams("/api/camp/weeks/:id/days/:date", `/api/camp/weeks/${W}/days/2026-10-05`)).toEqual([]);
    // 🔻 TASK-463 — no longer by NAME: a series `:key` IS a uuid (DEF-2), only the settings route's `:key` is not
    expect(badUuidParams("/api/other-series/:key", "/api/other-series/undefined")).toEqual(["key"]);
    expect(FREE_FORM_PARAMS["/api/settings/:key"]).toEqual(["key"]);
    expect(FREE_FORM_PARAMS["/api/camp/weeks/:id/days/:date"]).toEqual(["date"]);
    expect(isUuid(W)).toBe(true);
    expect(isUuid(W.toUpperCase())).toBe(true);
    expect(isUuid("undefined")).toBe(false);
    expect(isUuid(`${W}x`)).toBe(false);
    // the API's own param census: every `:id` / `:…Id` in the route table is a uuid, `:key` and `:date` are the only others
    const names = [...new Set(Object.keys(ROUTE_ACCESS).flatMap((k) => k.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1))))].sort();
    expect(names).toEqual(["date", "id", "key", "teacherId"]);
  });
  test("🔴 through the ROOT app: `/camp/weeks/undefined/days` ⇒ 400 with the envelope and the service never runs", async () => {
    process.env.SKIP_AUTH = "true";
    const weekDays = spyOn(camp, "weekDays").mockImplementation((async () => ({ week: {}, days: [] })) as any);
    const query = spyOn(db.query.campWeeks, "findFirst").mockImplementation((async () => undefined) as any);
    spies.push(weekDays, query);
    const res = await json("GET", "/camp/weeks/undefined/days");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringContaining("id") } });
    expect(weekDays).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled(); // ⇒ no `22P02` from Postgres, because Postgres was never asked
    // the same route with a real uuid still reaches the service
    expect((await json("GET", `/camp/weeks/${W}/days`)).status).toBe(200);
    expect(weekDays).toHaveBeenCalledTimes(1);
  });
  test("every camp door with an `:id` refuses the same way; `:date` and a valid id are untouched", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: string[] = [];
    for (const [name, ret] of [["weekDays", { week: {}, days: [] }], ["updateWeekDay", { day: {} }], ["markDay", { package: {} }], ["getDayCheckinQr", { token: "t" }], ["redeemDays", { package: {} }]] as const) {
      spies.push(spyOn(camp, name as any).mockImplementation((async () => { calls.push(name); return ret; }) as any));
    }
    const bad: Array<[string, string, unknown?]> = [
      ["GET", "/camp/weeks/undefined/days"],
      ["PATCH", "/camp/weeks/undefined/days/2026-10-05", { teacherIds: [] }],
      ["PATCH", "/camp/days/undefined", { status: "ATTENDED" }],
      ["GET", "/camp/days/undefined/checkin"],
      ["POST", "/camp/packages/undefined/days", { weekId: W, dates: ["2026-10-05"], half: "FULL" }],
    ];
    for (const [m, p, b] of bad) {
      expect({ p, status: (await json(m, p, b)).status }).toEqual({ p, status: 400 });
    }
    expect(calls).toEqual([]); // not one service call, not one query
    expect((await json("PATCH", `/camp/weeks/${W}/days/2026-10-05`, { teacherIds: [] })).status).toBe(200);
    expect(calls).toEqual(["updateWeekDay"]); // …and a real id still goes through, `:date` untouched
  });
  test("by source: ONE middleware, mounted AFTER the access guard (a 403 stays a 403), and it reads the matched pattern", () => {
    const IDX = code(src("src/index.ts"));
    expect(IDX).toContain('app.use("/api/*", uuidParamGuard);'); // 🔻 TASK-451: GLOBAL — every route, not just camp
    expect(IDX.indexOf('app.use("/api/*", accessGuard)')).toBeLessThan(IDX.indexOf('app.use("/api/*", uuidParamGuard)'));
    const G = code(src("src/middleware/uuid-params.ts"));
    expect(G).toContain("const handler = [...c.req.matchedRoutes].reverse().find((r) => !r.path.endsWith(\"*\") && r.method !== \"ALL\");");
    expect(G).toContain("if (bad.length) throw badRequest(");
    expect(G).not.toMatch(/\bdb\b|query\(/); // it decides from the request alone — nothing is read to refuse
  });
});
