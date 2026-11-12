// TASK-959 (REQ-5013 option B, SPEC-105 §3) — the THREE routes `GET / POST /closed-days` and `DELETE /closed-days/:date`, and the service behind them: exact shapes, codes and messages, and EVERY refusal.
// The service runs over an in-memory world (a fake `db` answering by TABLE); the routes through the ROOT app with the services spied at their boundary; the access guard through the real guards over stub routes.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { db } from "../db";
import { ApiException } from "../lib/http";
import { ROUTE_ACCESS, TEACHER_ALLOWED } from "../lib/route-access";
import { signToken } from "../lib/jwt";
import { accessGuard, authMiddleware, DEV_USER } from "../middleware/auth";
import * as usersSvc from "../services/user.service";
import { ACTION_KEYS, MENU_KEYS } from "../lib/permissions";
import * as closedDay from "../services/closed-day.service";
import { FREE_FORM_PARAMS } from "../middleware/uuid-params";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret-task959"; // hermetic: a test value, never a real one
const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });
const NOW = "2026-11-13T10:00:00+07:00"; // Bangkok Friday 13 Nov 2026
const TODAY = "2026-11-13";

type Row = { id: string; date: string; reason: string; note: string | null; rangeId: string | null; createdBy: string; createdAt: Date; reopenedAt: Date | null; reopenedBy: string | null };
const closedRow = (date: string, o: Partial<Row> = {}): Row => ({ id: `id-${date}`, date, reason: "HOLIDAY", note: null, rangeId: null, createdBy: "admin-dong", createdAt: new Date("2026-11-01T03:00:00Z"), reopenedAt: null, reopenedBy: null, ...o });
const klass = (id: string, date: string, over: any = {}) => ({ id, date, startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", bookingType: "COURSE_PACKAGE", childName: "Mali", childNickname: "Mali", coChildName: null, coChildNickname: null, program: "Freeskate", title: null, inCourse: true, ...over });

/** The world: the closed_days table + the live classes. `select` is answered BY TABLE and by the REAL where-clause's own parameters. */
function world(rows: Row[] = [], classes: any[] = []) {
  const w = { rows, classes, inserted: [] as any[], updates: [] as any[], asked: [] as Array<[string, unknown[]]>, txOpen: 0, txCommitted: 0 };
  const select = () => ({
    from: (t: any) => ({
      where: (cond: any) => {
        const table = getTableName(t);
        const params = dialect.sqlToQuery(cond).params as unknown[];
        w.asked.push([table, params]);
        return {
          orderBy: async () => {
            if (table === "closed_days") {
              const [from, to] = params as string[];
              return w.rows.filter((r) => !r.reopenedAt && r.date >= from! && r.date <= to!).sort((a, b) => (a.date < b.date ? -1 : 1));
            }
            const dates = params.filter((p) => typeof p === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p)) as string[];
            return w.classes.filter((c) => dates.includes(c.date));
          },
        };
      },
    }),
  });
  const tx: any = {
    select,
    insert: (t: any) => ({
      values: (vals: any[]) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const out: any[] = [];
            for (const v of vals) {
              if (w.rows.some((r) => r.date === v.date && !r.reopenedAt)) continue; // the partial unique index
              const r = { id: `id-${v.date}`, createdAt: new Date(), reopenedAt: null, reopenedBy: null, note: null, rangeId: null, ...v };
              w.rows.push(r);
              w.inserted.push(r);
              out.push({ date: v.date });
            }
            return out;
          },
        }),
      }),
    }),
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => { w.txOpen++; const r = await fn(tx); w.txCommitted++; return r; }) as any));
  spies.push(spyOn(db, "select").mockImplementation(select as any));
  spies.push(spyOn(db.query.closedDays, "findFirst").mockImplementation((async (q: any) => {
    const ops = { and: (...a: any[]) => a, eq: (c: any, v: any) => ["eq", c, v], isNull: (c: any) => ["isNull", c] };
    const cols = { date: "date", reopenedAt: "reopenedAt", id: "id" };
    const cond = q.where(cols, ops) as any[];
    const date = cond.find((x) => x[0] === "eq" && x[1] === "date")[2];
    const mustBeOpen = cond.some((x) => x[0] === "isNull" && x[1] === "reopenedAt");
    return w.rows.find((r) => r.date === date && (!mustBeOpen || !r.reopenedAt));
  }) as any));
  spies.push(spyOn(db, "update").mockImplementation(((t: any) => ({
    set: (set: any) => ({
      where: (cond: any) => ({
        returning: async () => {
          const params = dialect.sqlToQuery(cond).params as unknown[];
          const hit = w.rows.find((r) => params.includes(r.id) && !r.reopenedAt);
          if (!hit) return [];
          Object.assign(hit, set);
          w.updates.push({ table: getTableName(t), set });
          return [{ id: hit.id }];
        },
      }),
    }),
  })) as any));
  return w;
}
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof ApiException) return { status: e.status, code: e.code, message: e.message }; throw e; } return null; };

describe("POST /closed-days — the service (SPEC-105 §3): one row per day, one transaction, today allowed, a closed day skipped", () => {
  test("a RANGE writes one row per day in ONE transaction with a SHARED range_id; the answer is { created, alreadyClosed, classesOnThem }", async () => {
    setSystemTime(new Date(NOW));
    const w = world([], [klass("b1", "2026-11-20"), klass("b2", "2026-11-20", { startTime: "11:00:00" }), klass("b3", "2026-11-22")]);
    const out = await closedDay.closeDays({ from: "2026-11-20", to: "2026-11-22", reason: "HOLIDAY" }, "admin-dong");
    expect(out).toEqual({ created: ["2026-11-20", "2026-11-21", "2026-11-22"], alreadyClosed: [], classesOnThem: 3 });
    expect(w.txOpen).toBe(1);
    expect(w.txCommitted).toBe(1);
    expect(w.inserted.map((r) => r.date)).toEqual(["2026-11-20", "2026-11-21", "2026-11-22"]);
    expect(new Set(w.inserted.map((r) => r.rangeId)).size).toBe(1);
    expect(w.inserted[0].rangeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(w.inserted.every((r) => r.createdBy === "admin-dong" && r.reason === "HOLIDAY" && r.note === null)).toBe(true);
  });
  test("a SINGLE day has no range_id; `to` defaults to `from`", async () => {
    setSystemTime(new Date(NOW));
    const w = world();
    expect(await closedDay.closeDays({ from: "2026-11-25", reason: "WEATHER" }, "a")).toEqual({ created: ["2026-11-25"], alreadyClosed: [], classesOnThem: 0 });
    expect(w.inserted[0].rangeId).toBeNull();
  });
  test("TODAY is allowed (AC1, unlike leave's future-only rule)", async () => {
    setSystemTime(new Date(NOW));
    world();
    expect((await closedDay.closeDays({ from: TODAY, reason: "VENUE_CLOSED" }, "a")).created).toEqual([TODAY]);
  });
  test("a day ALREADY closed is SKIPPED, not an error: it is reported, the rest are created, the new rows share a range", async () => {
    setSystemTime(new Date(NOW));
    const w = world([closedRow("2026-11-21", { reason: "WEATHER", createdBy: "someone-else" })]);
    const out = await closedDay.closeDays({ from: "2026-11-20", to: "2026-11-22", reason: "HOLIDAY" }, "admin-dong");
    expect(out.created).toEqual(["2026-11-20", "2026-11-22"]);
    expect(out.alreadyClosed).toEqual(["2026-11-21"]);
    expect(w.rows.find((r) => r.date === "2026-11-21")).toMatchObject({ reason: "WEATHER", createdBy: "someone-else" }); // the first record stands
    expect(w.inserted).toHaveLength(2);
    expect(w.inserted[0].rangeId).toBe(w.inserted[1].rangeId);
  });
  test("every day already closed ⇒ 201-shaped nothing new: created [], alreadyClosed [all], classesOnThem 0, no insert", async () => {
    setSystemTime(new Date(NOW));
    const w = world([closedRow("2026-11-21")], [klass("b1", "2026-11-21")]);
    expect(await closedDay.closeDays({ from: "2026-11-21", reason: "HOLIDAY" }, "a")).toEqual({ created: [], alreadyClosed: ["2026-11-21"], classesOnThem: 0 });
    expect(w.inserted).toEqual([]);
  });
  test("a REOPENED day is NOT closed: closing it again creates a NEW open row (the old one stays as history)", async () => {
    setSystemTime(new Date(NOW));
    const w = world([closedRow("2026-11-21", { reopenedAt: new Date("2026-11-10T00:00:00Z"), reopenedBy: "x" })]);
    expect((await closedDay.closeDays({ from: "2026-11-21", reason: "HOLIDAY" }, "a")).created).toEqual(["2026-11-21"]);
    expect(w.rows).toHaveLength(2);
  });
  test("classesOnThem counts the live classes on the CREATED days only (not on an already-closed one)", async () => {
    setSystemTime(new Date(NOW));
    world([closedRow("2026-11-21")], [klass("b1", "2026-11-20"), klass("b2", "2026-11-21"), klass("b3", "2026-11-21")]);
    expect((await closedDay.closeDays({ from: "2026-11-20", to: "2026-11-21", reason: "HOLIDAY" }, "a")).classesOnThem).toBe(1);
  });
  test("OTHER keeps the (trimmed) note; a named reason stores no note even if one is sent? — it stores what was sent, trimmed, or null when empty", async () => {
    setSystemTime(new Date(NOW));
    const w = world();
    await closedDay.closeDays({ from: "2026-11-23", reason: "OTHER", note: "  งานกีฬาสี  " }, "a");
    await closedDay.closeDays({ from: "2026-11-24", reason: "HOLIDAY", note: "   " }, "a");
    expect(w.inserted.map((r) => [r.date, r.note])).toEqual([["2026-11-23", "งานกีฬาสี"], ["2026-11-24", null]]);
  });
  test("the actor is written to created_by; no actor ⇒ 'unknown' (the column is NOT NULL)", async () => {
    setSystemTime(new Date(NOW));
    const w = world();
    await closedDay.closeDays({ from: "2026-11-23", reason: "HOLIDAY" }, null);
    expect(w.inserted[0].createdBy).toBe("unknown");
  });
});

describe("POST /closed-days — EVERY refusal is a 400 { error: { code, message } } and writes NOTHING", () => {
  const cases: Array<[string, any, string]> = [
    ["PAST_DATE", { from: "2026-11-12", reason: "HOLIDAY" }, "PAST_DATE"], // yesterday
    ["PAST_DATE (a range that STARTS in the past)", { from: "2026-11-10", to: "2026-11-20", reason: "HOLIDAY" }, "PAST_DATE"],
    ["NOTE_REQUIRED (OTHER, no note)", { from: "2026-11-20", reason: "OTHER" }, "NOTE_REQUIRED"],
    ["NOTE_REQUIRED (OTHER, blank note)", { from: "2026-11-20", reason: "OTHER", note: "   " }, "NOTE_REQUIRED"],
    ["RANGE_TOO_LONG (32 days)", { from: "2026-11-20", to: "2026-12-21", reason: "HOLIDAY" }, "RANGE_TOO_LONG"],
  ];
  for (const [name, input, code] of cases) {
    test(name, async () => {
      setSystemTime(new Date(NOW));
      const w = world();
      const r = await refusal(closedDay.closeDays(input, "a"));
      expect(r).toMatchObject({ status: 400, code });
      expect(r!.message.length).toBeGreaterThan(5);
      expect(w.inserted).toEqual([]);
      expect(w.txOpen).toBe(0); // refused before a transaction is even opened
    });
  }
  test("the edges: 31 days is IN (RANGE_TOO_LONG at 32), a note on OTHER of one character is IN", async () => {
    setSystemTime(new Date(NOW));
    world();
    expect((await closedDay.closeDays({ from: "2026-11-20", to: "2026-12-20", reason: "OTHER", note: "x" }, "a")).created).toHaveLength(31);
  });
  test("an unknown reason is refused (VALIDATION) even if a caller skips the route's zod", async () => {
    setSystemTime(new Date(NOW));
    world();
    expect(await refusal(closedDay.closeDays({ from: "2026-11-20", reason: "BIRTHDAY" } as any, "a"))).toMatchObject({ status: 400, code: "VALIDATION" });
  });
  test("the order of refusals: PAST_DATE first, then NOTE_REQUIRED, then RANGE_TOO_LONG", async () => {
    setSystemTime(new Date(NOW));
    world();
    expect(await refusal(closedDay.closeDays({ from: "2026-11-01", to: "2026-12-30", reason: "OTHER" }, "a"))).toMatchObject({ code: "PAST_DATE" });
    expect(await refusal(closedDay.closeDays({ from: "2026-11-20", to: "2026-12-30", reason: "OTHER" }, "a"))).toMatchObject({ code: "NOTE_REQUIRED" });
  });
});

describe("DELETE /closed-days/:date — re-open is SOFT: it keeps the row and restores nothing", () => {
  test("sets reopened_at / reopened_by on the OPEN row, keeps it, and answers { date, reopened: true }", async () => {
    setSystemTime(new Date(NOW));
    const w = world([closedRow("2026-11-25")]);
    expect(await closedDay.reopenDay("2026-11-25", "admin-dong")).toEqual({ date: "2026-11-25", reopened: true });
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]!.reopenedAt).toBeInstanceOf(Date);
    expect(w.rows[0]!.reopenedBy).toBe("admin-dong");
    expect(w.updates).toHaveLength(1);
    expect(Object.keys(w.updates[0].set).sort()).toEqual(["reopenedAt", "reopenedBy"]); // nothing else is written: no booking, no message
  });
  test("404 NOT_CLOSED when the day has no OPEN row (never closed, or already re-opened)", async () => {
    setSystemTime(new Date(NOW));
    world([closedRow("2026-11-26", { reopenedAt: new Date("2026-11-11T00:00:00Z") })]);
    expect(await refusal(closedDay.reopenDay("2026-11-26", "a"))).toMatchObject({ status: 404, code: "NOT_CLOSED" });
    expect(await refusal(closedDay.reopenDay("2026-12-31", "a"))).toMatchObject({ status: 404, code: "NOT_CLOSED" });
  });
  test("400 PAST_DATE for a closed day that has already begun (yesterday, even today? no: today is allowed; the day BEFORE today is refused), and nothing is written", async () => {
    setSystemTime(new Date(NOW));
    const w = world([closedRow("2026-11-12"), closedRow(TODAY)]);
    expect(await refusal(closedDay.reopenDay("2026-11-12", "a"))).toMatchObject({ status: 400, code: "PAST_DATE" });
    expect(w.rows[0]!.reopenedAt).toBeNull();
    expect(w.updates).toEqual([]);
    expect((await closedDay.reopenDay(TODAY, "a")).reopened).toBe(true); // today is allowed (it mirrors the close)
  });
  test("a re-open then a new close of the same day is possible (one OPEN row per date, history kept)", async () => {
    setSystemTime(new Date(NOW));
    const w = world([closedRow("2026-11-27")]);
    await closedDay.reopenDay("2026-11-27", "a");
    await closedDay.closeDays({ from: "2026-11-27", reason: "WEATHER" }, "a");
    expect(w.rows.map((r) => [r.reason, !!r.reopenedAt])).toEqual([["HOLIDAY", true], ["WEATHER", false]]);
  });
});

describe("GET /closed-days — only OPEN rows, ordered by date, each with the live classes still on its date", () => {
  test("the shape: { items: [{ date, reason, note, rangeId, createdBy, createdAt (ISO), bookings: [...] }] }", async () => {
    setSystemTime(new Date(NOW));
    world(
      [closedRow("2026-11-22", { reason: "OTHER", note: "งานกีฬาสี", rangeId: "r1" }), closedRow("2026-11-20"), closedRow("2026-11-21", { reopenedAt: new Date("2026-11-11T00:00:00Z") })],
      [klass("b1", "2026-11-20"), klass("b2", "2026-11-22")],
    );
    const out = await closedDay.listClosedDays({ from: "2026-11-01", to: "2026-11-30" });
    expect(out.items.map((i) => i.date)).toEqual(["2026-11-20", "2026-11-22"]); // the re-opened day is gone; ordered by date
    expect(out.items[0]).toEqual({ date: "2026-11-20", reason: "HOLIDAY", note: null, rangeId: null, createdBy: "admin-dong", createdAt: "2026-11-01T03:00:00.000Z", bookings: [klass("b1", "2026-11-20")] });
    expect(out.items[1]).toMatchObject({ reason: "OTHER", note: "งานกีฬาสี", rangeId: "r1", bookings: [{ id: "b2" }] });
    expect(Object.keys(out.items[0]!).sort()).toEqual(["bookings", "createdAt", "createdBy", "date", "note", "rangeId", "reason"]);
    expect(Object.keys(out.items[0]!.bookings[0]!).sort()).toEqual(["bookingType", "childName", "childNickname", "coChildName", "coChildNickname", "date", "endTime", "id", "inCourse", "program", "startTime", "status", "title"]); // the SAME flat shape as a leave day's classes
  });
  test("the window defaults: from TODAY, 60 days on; an empty window is { items: [] } and reads NO classes", async () => {
    setSystemTime(new Date(NOW));
    const w = world();
    expect(await closedDay.listClosedDays({})).toEqual({ items: [] });
    expect(w.asked[0]).toEqual(["closed_days", [TODAY, "2027-01-12"]]);
    expect(w.asked.filter(([t]) => t === "bookings")).toEqual([]);
  });
  test("the class list is ONE read for all the days (not one per day)", async () => {
    setSystemTime(new Date(NOW));
    const w = world([closedRow("2026-11-20"), closedRow("2026-11-21"), closedRow("2026-11-22")], []);
    await closedDay.listClosedDays({ from: TODAY, to: "2026-11-30" });
    expect(w.asked.filter(([t]) => t === "bookings")).toHaveLength(1);
  });
});

describe("the ROOT app: exact status codes and shapes, and the zod shape errors", () => {
  const rootApp = async () => (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
  const call = async (method: string, path: string, body?: unknown) => {
    process.env.SKIP_AUTH = "true";
    const app = await rootApp();
    const res = await app.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  test("POST → 201 with the service's answer, and the signed-in admin as the actor", async () => {
    const seen: any[] = [];
    spies.push(spyOn(closedDay, "closeDays").mockImplementation((async (input: any, actor: any) => { seen.push([input, actor]); return { created: ["2026-11-20"], alreadyClosed: [], classesOnThem: 2 }; }) as any));
    const r = await call("POST", "/closed-days", { from: "2026-11-20", reason: "HOLIDAY" });
    expect(r).toEqual({ status: 201, body: { created: ["2026-11-20"], alreadyClosed: [], classesOnThem: 2 } });
    expect(seen).toEqual([[{ from: "2026-11-20", reason: "HOLIDAY" }, DEV_USER.username]]);
  });
  test("a service refusal reaches the client as { error: { code, message } } with ITS status (the three 400s that fire before any read; 404 NOT_CLOSED and the re-open PAST_DATE are pinned by value above)", async () => {
    for (const [method, path, body, status, code] of [
      ["POST", "/closed-days", { from: "2026-11-01", reason: "HOLIDAY" }, 400, "PAST_DATE"],
      ["POST", "/closed-days", { from: "2026-11-20", reason: "OTHER" }, 400, "NOTE_REQUIRED"],
      ["POST", "/closed-days", { from: "2026-11-20", to: "2026-12-30", reason: "HOLIDAY" }, 400, "RANGE_TOO_LONG"],
    ] as const) {
      setSystemTime(new Date(NOW));
      const r = await call(method, path, body);
      expect({ status: r.status, code: r.body.error?.code, hasMessage: typeof r.body.error?.message === "string" }).toEqual({ status, code, hasMessage: true });
    }
  });
  test("DELETE → 200 { date, reopened: true }, the admin as the actor, the date from the path", async () => {
    const seen: any[] = [];
    spies.push(spyOn(closedDay, "reopenDay").mockImplementation((async (date: string, actor: any) => { seen.push([date, actor]); return { date, reopened: true }; }) as any));
    expect(await call("DELETE", "/closed-days/2026-11-20")).toEqual({ status: 200, body: { date: "2026-11-20", reopened: true } });
    expect(seen).toEqual([["2026-11-20", DEV_USER.username]]);
  });
  test("GET → 200 { items } and passes from / to through", async () => {
    const seen: any[] = [];
    spies.push(spyOn(closedDay, "listClosedDays").mockImplementation((async (q: any) => { seen.push(q); return { items: [] }; }) as any));
    expect(await call("GET", "/closed-days?from=2026-11-01&to=2026-11-30")).toEqual({ status: 200, body: { items: [] } });
    expect(await call("GET", "/closed-days")).toEqual({ status: 200, body: { items: [] } });
    expect(seen).toEqual([{ from: "2026-11-01", to: "2026-11-30" }, {}]);
  });
  test("shape errors are the generic 400 VALIDATION and the service is NEVER called", async () => {
    const calls: string[] = [];
    spies.push(spyOn(closedDay, "closeDays").mockImplementation((async () => { calls.push("close"); return {}; }) as any));
    spies.push(spyOn(closedDay, "listClosedDays").mockImplementation((async () => { calls.push("list"); return { items: [] }; }) as any));
    spies.push(spyOn(closedDay, "reopenDay").mockImplementation((async () => { calls.push("reopen"); return {}; }) as any));
    const bad: Array<[string, string, unknown?]> = [
      ["POST", "/closed-days", {}],
      ["POST", "/closed-days", { from: "20-11-2026", reason: "HOLIDAY" }],
      ["POST", "/closed-days", { from: "2026-11-20", reason: "BIRTHDAY" }],
      ["POST", "/closed-days", { from: "2026-11-20", to: "2026-11-10", reason: "HOLIDAY" }], // to before from
      ["POST", "/closed-days", { from: "2026-11-20", reason: "OTHER", note: "x".repeat(301) }],
      ["GET", "/closed-days?from=2026-11-30&to=2026-11-01"],
      ["GET", "/closed-days?from=2026-01-01&to=2026-04-01"], // > 62 days
      ["GET", "/closed-days?from=yesterday"],
      ["DELETE", "/closed-days/not-a-date"],
    ];
    for (const [m, p, b] of bad) {
      const r = await call(m, p, b);
      expect({ call: `${m} ${p}`, status: r.status, code: r.body.error?.code }).toEqual({ call: `${m} ${p}`, status: 400, code: "VALIDATION" });
    }
    expect(calls).toEqual([]);
    // the edges that ARE valid: a 62-day window and a 300-character note
    expect((await call("GET", "/closed-days?from=2026-11-01&to=2026-12-03")).status).toBe(200);
    expect((await call("POST", "/closed-days", { from: "2026-11-20", reason: "OTHER", note: "x".repeat(300) })).status).toBe(201);
  });
});

describe("ACCESS — the admin's keys; a linked TEACHER is refused (not in TEACHER_ALLOWED)", () => {
  test("the three routes are in the table with the SAME keys as the leave door: no new key", () => {
    expect(ROUTE_ACCESS["GET /closed-days"]).toEqual({ menus: ["menu:calendar"] });
    expect(ROUTE_ACCESS["POST /closed-days"]).toEqual(ROUTE_ACCESS["POST /teacher-leave-days"]);
    expect(ROUTE_ACCESS["DELETE /closed-days/:date"]).toEqual(ROUTE_ACCESS["POST /teacher-leave-days"]);
    expect((ROUTE_ACCESS["POST /closed-days"] as any).action).toBe("action:calendar.status");
    for (const r of ["GET /closed-days", "POST /closed-days", "DELETE /closed-days/:date"]) expect(TEACHER_ALLOWED.has(r)).toBe(false);
  });
  test("the `:date` is declared free-form so the uuid guard does not refuse a business date", () => {
    expect(FREE_FORM_PARAMS["/api/closed-days/:date"]).toEqual(["date"]);
  });
  test("through the REAL guards: a LINKED coach holding every key gets 403 SCOPE_TEACHER on all three, an unlinked admin with the keys passes", async () => {
    const U = "99999999-9999-4999-8999-999999999999";
    const linked = { id: U, username: "coach", displayName: "Coach", isSuperAdmin: false, disabledAt: null, teacherId: "88888888-8888-4888-8888-888888888888" };
    const unlinked = { ...linked, teacherId: null };
    const build = () => {
      process.env.SKIP_AUTH = "false";
      const a = new Hono();
      a.use("/api/*", authMiddleware);
      a.use("/api/*", accessGuard);
      for (const key of Object.keys(ROUTE_ACCESS)) {
        const [m, p] = key.split(" ") as [string, string];
        (a as any)[m.toLowerCase()]("/api" + p, (c: any) => c.json({ ok: key }));
      }
      a.onError((e, c) => (e instanceof ApiException ? c.json({ error: { code: e.code } }, e.status as any) : c.json({ error: { code: "INTERNAL" } }, 500)));
      return a;
    };
    const token = await signToken({ sub: U, username: "coach", role: "admin", isSuperAdmin: false });
    for (const [row, expectStatus, expectCode] of [[linked, 403, "SCOPE_TEACHER"], [unlinked, 200, undefined]] as const) {
      const restore = [spyOn(usersSvc, "findUserById").mockImplementation((async () => row) as any), spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async () => [...MENU_KEYS, ...ACTION_KEYS]) as any)];
      try {
        const app = build();
        for (const [method, path] of [["GET", "/closed-days"], ["POST", "/closed-days"], ["DELETE", "/closed-days/2026-11-20"]] as const) {
          const res = await app.request("/api" + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
          expect({ call: `${method} ${path}`, status: res.status, code: ((await res.json()) as any).error?.code }).toEqual({ call: `${method} ${path}`, status: expectStatus, code: expectCode });
        }
      } finally {
        for (const s of restore) s.mockRestore();
        delete process.env.SKIP_AUTH;
      }
    }
  });
  test("a user WITHOUT the calendar keys is refused on all three (403), not just the teacher", async () => {
    const U = "77777777-7777-4777-8777-777777777777";
    const row = { id: U, username: "nokeys", displayName: "N", isSuperAdmin: false, disabledAt: null, teacherId: null };
    const restore = [spyOn(usersSvc, "findUserById").mockImplementation((async () => row) as any), spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async () => ["menu:stock"]) as any)];
    try {
      process.env.SKIP_AUTH = "false";
      const a = new Hono();
      a.use("/api/*", authMiddleware);
      a.use("/api/*", accessGuard);
      for (const key of Object.keys(ROUTE_ACCESS)) { const [m, p] = key.split(" ") as [string, string]; (a as any)[m.toLowerCase()]("/api" + p, (c: any) => c.json({ ok: key })); }
      a.onError((e, c) => (e instanceof ApiException ? c.json({ error: { code: e.code } }, e.status as any) : c.json({ error: { code: "INTERNAL" } }, 500)));
      const token = await signToken({ sub: U, username: "nokeys", role: "admin", isSuperAdmin: false });
      for (const [method, path] of [["GET", "/closed-days"], ["POST", "/closed-days"], ["DELETE", "/closed-days/2026-11-20"]] as const) {
        const res = await a.request("/api" + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(res.status).toBe(403);
      }
    } finally {
      for (const s of restore) s.mockRestore();
      delete process.env.SKIP_AUTH;
    }
  });
});

describe("the migration + schema, by source", () => {
  test("0077 is ADDITIVE: a NEW table, the CHECK on the four reasons, ONE partial unique index (open rows only) LAST = the witness; no existing table is touched", () => {
    const sql = read("drizzle/0077_closed_days.sql");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "closed_days"');
    expect(sql).toContain("CHECK (\"reason\" IN ('HOLIDAY','VENUE_CLOSED','WEATHER','OTHER'))");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "closed_days_open_date_uq" ON "closed_days" ("date") WHERE "reopened_at" IS NULL;');
    expect(sql.lastIndexOf("CREATE UNIQUE INDEX")).toBeGreaterThan(sql.lastIndexOf("CREATE TABLE"));
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/ALTER TABLE "(?!closed_days)|DROP TABLE|DELETE FROM|UPDATE "/);
    for (const col of ["id", "date", "reason", "note", "range_id", "created_by", "created_at", "reopened_at", "reopened_by"]) expect(sql).toContain(`"${col}"`);
    expect(sql).toContain('"note" text,'); // nullable
    expect(sql).toContain('"reopened_at" timestamp with time zone,'); // nullable: NULL = open
  });
  test("the journal: entry 77, tag 0077_closed_days, `when` UNIQUE and the highest (drizzle skips a migration whose `when` is not above the ledger's newest, silently)", () => {
    const j = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const whens = j.entries.map((e) => e.when);
    const last = j.entries[77]!; // 🔻 TASK-942: 0078 landed after it, so 0077 is entry 77 but no longer the LAST — its `when` is still unique and sits right before 0078's
    expect(last).toMatchObject({ idx: 77, tag: "0077_closed_days" });
    expect(new Set(whens).size).toBe(whens.length); // UNIQUE across the whole journal
    expect(last.when).toBe(j.entries[76]!.when + 1);
    expect(j.entries[78]).toMatchObject({ idx: 78, tag: "0078_slot_exempt_park_blocks", when: last.when + 1 });
    expect([...whens].sort((a, b) => a - b)).toEqual(whens); // ascending
  });
  test("the schema declares the table, the unique index and the CHECK the SQL creates; the reasons are the SAME four as the route's zod enum", () => {
    const sch = read("src/db/schema.ts");
    expect(sch).toContain('export const closedDays = pgTable(\n  "closed_days",');
    expect(sch).toContain('uniqueIndex("closed_days_open_date_uq").on(t.date).where(sql`${t.reopenedAt} is null`)');
    expect(sch).toContain("closed_days_reason_ck");
    const v = read("src/validation.ts");
    expect(v).toContain('reason: z.enum(["HOLIDAY", "VENUE_CLOSED", "WEATHER", "OTHER"])');
    return import("../lib/closed-day").then((m) => expect([...m.CLOSED_REASONS]).toEqual(["HOLIDAY", "VENUE_CLOSED", "WEATHER", "OTHER"]));
  });
  test("the witness probes the LAST object of the file", async () => {
    const { SCHEDULING_WITNESSES } = await import("../lib/migration-witness");
    const w = SCHEDULING_WITNESSES.find((x: any) => x.tag === "0077_closed_days")!;
    expect(w.probe).toEqual({ kind: "index", index: "closed_days_open_date_uq" });
    expect(w.rerunnable).toBe(true);
  });
  test("the real `db` exposes `query.closedDays` (the reader asks it): a missing relation would silently disable the block", () => {
    expect(db.query.closedDays).toBeDefined();
    expect(typeof db.query.closedDays.findFirst).toBe("function");
  });
});
