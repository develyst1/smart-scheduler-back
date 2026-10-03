// TASK-608 (REQ-111 C) — an ADMIN records, or lifts, a teacher's leave on their behalf.
//
// 🔑 The claim this file exists for: it is a second CALLER, not a second act. **ONE fork** (`isAdvanceLeave`) decides future-vs-today
// for BOTH doors, from one place — two forks that agree today are two that diverge the first time one is edited.
// ⭐ The teacher IS told when someone else blocks their day. 🚫 The families are NOT: nothing is cancelled (TASK-587's closed defect).
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { Hono } from "hono";
import { ApiException } from "./http";
import { ROUTE_ACCESS, TEACHER_ALLOWED } from "./route-access";
import { signToken } from "./jwt";
import { accessGuard, authMiddleware } from "../middleware/auth";
import * as usersSvc from "../services/user.service";
import { ACTION_KEYS, MENU_KEYS } from "./permissions";
import * as sched from "../services/scheduler.service";
import * as lineLib from "./line";
import { db } from "../db";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from) + from.length));
const S = code(read("src/services/scheduler.service.ts"));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });
const TODAY = "2026-10-01";
const today = () => setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
const T = "11111111-1111-4111-8111-111111111111"; // the teacher whose day it is
const trip = (what: string) => () => { throw new Error(`TASK-608 tripwire: ${what}`); };

/** The leave table in memory + the day's classes; every notice captured. Nothing here can cancel or message a family. */
const arm = (opts: { already?: boolean } = {}) => {
  const rows: any[] = opts.already ? [{ id: "l-0", teacherId: T, date: "2026-10-21", reason: "เดิม", createdBy: "coach" }] : [];
  const sent: any[] = [];
  const listed = [
    { id: "b1", date: "2026-10-21", startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", bookingType: "PRIVATE" },
    { id: "b2", date: "2026-10-21", startTime: "13:00:00", endTime: "14:00:00", status: "PENDING", bookingType: "COURSE_PACKAGE" },
  ];
  spies.push(spyOn(db, "insert").mockImplementation(((t: any) => ({ values: (v: any) => ({ onConflictDoNothing: () => ({ returning: async () => {
    expect(getTableName(t)).toBe("teacher_leave_days");
    if (rows.some((r) => r.teacherId === v.teacherId && r.date === v.date)) return [];
    const row = { id: `l-${rows.length + 1}`, ...v }; rows.push(row); return [row];
  } }) }) })) as any));
  spies.push(spyOn(db, "delete").mockImplementation(((t: any) => ({ where: () => ({ returning: async () => {
    expect(getTableName(t)).toBe("teacher_leave_days");
    const gone = rows.splice(0, rows.length); return gone.map((g) => ({ id: g.id }));
  } }) })) as any));
  spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ orderBy: async () => listed }) }) })) as any));
  spies.push(spyOn(db.query.teacherLeaveDays, "findFirst").mockImplementation((async () => rows[0]) as any));
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: T, nickname: "Ek", lineUserId: "U-ek" })) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { sent.push(o); return { status: "queued" } as any; }) as any));
  // 🚫 the advance branch may not reach the cancel path at all
  spies.push(spyOn(db, "transaction").mockImplementation(trip("the advance act opened a transaction") as any));
  spies.push(spyOn(db, "update").mockImplementation(trip("the advance act updated a row") as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation(trip("the advance act read bookings for the cancel") as any));
  return { rows, sent, listed };
};

describe("🔑 TASK-608 — ONE fork, two callers: the admin door is a second CALLER, not a second act", () => {
  test("by source: the fork is asked in exactly ONE place, and `reportOwnLeave` is a thin caller of the shared act", () => {
    expect((S.match(/isAdvanceLeave\(/g) ?? []).length).toBe(1); // the ONE comparison in the whole service
    expect(region(S, "export async function reportTeacherLeave(", "\n}\n")).toContain("if (isAdvanceLeave(input.date)) {");
    expect(S).toContain("export const reportOwnLeave = (me: string, input: { date: string; sessionIds?: string[]; reason: string }, actor: string | null) =>\n  reportTeacherLeave(me, input, actor, { onBehalf: false });");
    expect(S).toContain("export const liftOwnLeave = (me: string, date: string) => liftTeacherLeave(me, date, { onBehalf: false });");
    // 🚫 `onBehalf` says WHO acted; it must never reach the fork
    const fork = region(S, "if (isAdvanceLeave(input.date)) {", "const mine = await db.query.bookings.findMany(");
    expect(fork).not.toContain("onBehalf ?");
    expect(S).not.toMatch(/isAdvanceLeave\([^)]*onBehalf/);
  });
  test("by source: BOTH routes reach the SAME two exported functions — no third entry point", () => {
    const API = code(read("src/routes/api.ts"));
    expect(API).toContain("svc.reportTeacherLeave(teacherId, input, actorOf(c), { onBehalf: true })");
    expect(API).toContain("svc.reportOwnLeave(assertLinked(c.get(\"user\")), c.req.valid(\"json\"), actorOf(c))");
    expect(API).toContain('svc.liftTeacherLeave(c.req.valid("param").teacherId, c.req.valid("param").date, { onBehalf: true })');
    expect(API).toContain('svc.liftOwnLeave(assertLinked(c.get("user")), c.req.valid("param").date)');
    expect((API.match(/reportTeacherLeave\(|reportOwnLeave\(/g) ?? []).length).toBe(2); // one door each
  });
});

describe("⭐ TASK-608 — the teacher is told, and ONLY the teacher", () => {
  test("FUTURE, on behalf: the day is recorded, its classes listed, NOTHING cancelled — and ONE notice, to that teacher", async () => {
    today();
    const { rows, sent, listed } = arm();
    const r: any = await sched.reportTeacherLeave(T, { date: "2026-10-21", reason: "อบรม" }, "admin-ploy", { onBehalf: true });
    expect([r.mode, r.cancelled, r.bookingIds, r.familiesNotified, r.teacherNotified]).toEqual(["advance", 0, [], 0, 1]);
    expect(r.bookings).toEqual(listed);
    expect(rows).toEqual([{ id: "l-1", teacherId: T, date: "2026-10-21", reason: "อบรม", createdBy: "admin-ploy" }]);
    // 🔑 the audience, exactly: one row, recipientType `teacher`, that teacher's account — and the payload names the day,
    // the class count and who recorded it.
    expect(sent).toHaveLength(1);
    expect([sent[0].recipientType, sent[0].recipientLineUserId]).toEqual(["teacher", "U-ek"]);
    expect(sent[0].payload).toEqual({ kind: "teacher_leave_recorded", date: "2026-10-21", classes: 2, actor: "admin-ploy" });
    // 🚫 no family, no other coach — asserted by TYPE, not by counting one absent name
    expect(sent.filter((s) => s.recipientType !== "teacher")).toEqual([]);
  });
  test("🚫 the teacher's OWN act notifies NOBODY — they need no notice of their own (TASK-587's pin, intact)", async () => {
    today();
    const { rows, sent } = arm();
    const r: any = await sched.reportOwnLeave(T, { date: "2026-10-21", reason: "ธุระ" }, "coach-ek");
    expect([r.teacherNotified, sent]).toEqual([0, []]);
    expect(rows).toHaveLength(1);
  });
  test("📌 recorded TWICE on behalf: the first record stands and the teacher is NOT told again — the same act twice is not two changes to their week", async () => {
    today();
    const { rows, sent } = arm({ already: true });
    const r: any = await sched.reportTeacherLeave(T, { date: "2026-10-21", reason: "ใหม่" }, "admin-ploy", { onBehalf: true });
    expect([r.alreadyRecorded, r.leave.reason, r.teacherNotified, sent]).toEqual([true, "เดิม", 0, []]);
    expect(rows).toHaveLength(1);
  });
  test("⚖️ the LIFT on behalf notifies too — chosen deliberately: a notice with no counterpart leaves a teacher believing a day is still blocked", async () => {
    today();
    const { rows, sent } = arm({ already: true });
    const r: any = await sched.liftTeacherLeave(T, "2026-10-21", { onBehalf: true });
    expect([r.lifted, r.teacherNotified]).toEqual(["2026-10-21", 1]);
    expect(rows).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ kind: "teacher_leave_lifted", date: "2026-10-21", actor: null });
    expect(sent[0].recipientType).toBe("teacher");
  });
  test("…and the teacher's own lift stays silent (the same asymmetry as the record)", async () => {
    today();
    const { sent } = arm({ already: true });
    expect(await sched.liftOwnLeave(T, "2026-10-21")).toEqual({ lifted: "2026-10-21", teacherNotified: 0 });
    expect(sent).toEqual([]);
  });
  test("an UNLINKED teacher yields a SKIPPED row rather than silence (TASK-152's loud absence)", async () => {
    today();
    const { sent } = arm();
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: T, nickname: "Ek", lineUserId: null })) as any));
    await sched.reportTeacherLeave(T, { date: "2026-10-21", reason: "อบรม" }, "admin-ploy", { onBehalf: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].recipientLineUserId).toBeNull();
  });
});

describe("🔑 TASK-608 — the key: NO new one, and `action:calendar.status` is the narrowest that fits", () => {
  test("both admin routes carry the status key and the status door's menus; 🚫 no new key was registered", () => {
    for (const r of ["POST /teacher-leave-days", "DELETE /teacher-leave-days/:teacherId/:date"]) {
      expect({ r, access: ROUTE_ACCESS[r] }).toEqual({ r, access: { menus: ["menu:calendar", "menu:bookings"], action: "action:calendar.status" } });
    }
    // the SAME key and menus the cancel door already carries — this act grants its holder no power they lack
    expect(ROUTE_ACCESS["PATCH /bookings/:id/status"]).toEqual({ menus: ["menu:calendar", "menu:bookings"], action: "action:calendar.status" });
    expect(ACTION_KEYS.filter((k) => /leave/.test(k)).sort()).toEqual(["action:calendar.leave-override", "action:calendar.teacher-leave"]); // no third
  });
  test("🚫 a LINKED teacher cannot use the admin doors — they are not in `TEACHER_ALLOWED` (the sweep 403s them)", () => {
    for (const r of ["POST /teacher-leave-days", "DELETE /teacher-leave-days/:teacherId/:date"]) expect(TEACHER_ALLOWED.has(r)).toBe(false);
    // …and the teacher's own doors still are
    for (const r of ["POST /teachers/me/leave", "DELETE /teachers/me/leave/:date"]) expect(TEACHER_ALLOWED.has(r)).toBe(true);
  });
  test("the admin lift's `:date` is declared free-form, so the uuid guard does not refuse a business date", () => {
    const { FREE_FORM_PARAMS } = require("../middleware/uuid-params");
    expect(FREE_FORM_PARAMS["/api/teacher-leave-days/:teacherId/:date"]).toEqual(["date"]);
  });
});

describe("🔴 TASK-608 §3 — the admin's doors must not SHADOW the coach's own, proven THROUGH THE GUARD", () => {
  // 🔑 Why through the guard and never off `TEACHER_ALLOWED`: that set is keyed by the string the GUARD COMPUTES from
  // `c.req.matchedRoutes`, not by the string written in the router. Reading the table would have agreed with itself while a linked
  // coach was being refused on their own door — which is exactly what happened when the admin act hung off `/teachers/:id/leave`.
  // 📌 The mechanism: Hono dispatches to the FIRST matching route; `accessGuard` reads the LAST. A wildcard sibling of a literal is
  // therefore resolved from both ends at once. 🚫 Re-ordering only moves the break from the guard to the handler.
  const U = "99999999-9999-4999-8999-999999999999";
  const row = { id: U, username: "coach", displayName: "Coach", isSuperAdmin: false, disabledAt: null, teacherId: "88888888-8888-4888-8888-888888888888" };
  const app = () => {
    process.env.SKIP_AUTH = "false";
    const a = new Hono();
    a.use("/api/*", authMiddleware);
    a.use("/api/*", accessGuard);
    // every route in the table, as a STUB: only the two guards run, so a verdict here is the GUARD's and nothing else.
    for (const key of Object.keys(ROUTE_ACCESS)) {
      const [m, p] = key.split(" ") as [string, string];
      (a as any)[m.toLowerCase()]("/api" + p, (c: any) => c.json({ ok: key }));
    }
    a.onError((e, c) => (e instanceof ApiException ? c.json({ error: { code: e.code } }, e.status as any) : c.json({ error: { code: "INTERNAL" } }, 500)));
    return a;
  };
  test("a LINKED coach with every key still reaches their OWN three doors, and is refused on the admin's two", async () => {
    const restore = [spyOn(usersSvc, "findUserById").mockImplementation((async () => row) as any), spyOn(usersSvc, "effectiveGrantKeys").mockImplementation((async () => [...MENU_KEYS, ...ACTION_KEYS]) as any)];
    try {
      const built = app();
      const token = await signToken({ sub: U, username: "coach", role: "admin", isSuperAdmin: false });
      const hit = async (method: string, path: string) => {
        const res = await built.request("/api" + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }) });
        return { call: `${method} ${path}`, status: res.status, code: ((await res.json()) as any).error?.code };
      };
      // 🔑 the coach's OWN doors — the feature that was silently revoked, and is LIVE on uat
      for (const [m, p] of [["POST", "/teachers/me/leave"], ["GET", "/teachers/me/leave"], ["DELETE", "/teachers/me/leave/2026-10-21"]] as const) {
        expect(await hit(m, p)).toEqual({ call: `${m} ${p}`, status: 200, code: undefined });
      }
      // …and the admin's doors stay closed to them
      for (const [m, p] of [["POST", "/teacher-leave-days"], ["DELETE", `/teacher-leave-days/${row.teacherId}/2026-10-21`]] as const) {
        expect(await hit(m, p)).toEqual({ call: `${m} ${p}`, status: 403, code: "SCOPE_TEACHER" });
      }
    } finally {
      for (const s of restore) s.mockRestore();
      delete process.env.SKIP_AUTH;
    }
  });
  test("🚫 by source: no route hangs a WILDCARD sibling under `/teachers/` beside the literal `me` doors", () => {
    const paths = Object.keys(ROUTE_ACCESS).map((k) => k.slice(k.indexOf(" ") + 1));
    const literals = paths.filter((p) => p.startsWith("/teachers/me/"));
    expect(literals.length).toBeGreaterThan(0);
    // 🔑 a SHADOW is segment-by-segment, with `:param` matching anything — not merely "the same number of segments", which would
    // flag `/teachers/:id/budget` (it matches no `me` path: `budget` ≠ `leave`).
    const shadows = (p: string, l: string) => {
      const a = p.split("/"), b = l.split("/");
      return a.length === b.length && a.every((seg, i) => seg === b[i] || seg.startsWith(":"));
    };
    // a literal never shadows itself, so the literals are not candidates — only the wildcard routes beside them are
    const shadowing = [...new Set(paths.filter((p) => !literals.includes(p) && literals.some((l) => shadows(p, l))))];
    expect(shadowing).toEqual([]);
    // …and the check can SEE a shadow: the path this task originally shipped would be caught by it.
    expect(literals.some((l) => shadows("/teachers/:id/leave", l))).toBe(true);
  });
});
