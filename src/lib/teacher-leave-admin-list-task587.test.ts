// TASK-587 — the admin can SEE a recorded leave day (the owner: classes already booked are "listed FOR THE ADMIN").
//   (a) BUILT: `GET /teacher-leave-days` — every recorded day in a window, each with its live classes through `leaveDayBookings`
//       (the ONE answer, reused); the calendar's own read key (`menu:calendar`), no new key; a linked teacher is refused.
//   (b) NOT BUILT — a finding, pinned here so it cannot be misremembered: the OLD act (the cancel) told the FAMILIES and the
//       class's OTHER COACHES, and NO ADMIN. So an admin notice is not a restoration of a lost signal; it is a new one (the
//       owner's call). What IS pinned: the advance act tells nobody — no family (nothing was cancelled), no admin (not ruled).
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as sched from "../services/scheduler.service";
import { recordedLeaveDays } from "./teacher-leave";
import { ROUTE_ACCESS, TEACHER_ALLOWED } from "./route-access";
import { db } from "../db";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fnBody = (s: string, head: string) => { const a = s.indexOf(head); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf("\n}\n", a)); };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); delete process.env.SKIP_AUTH; });
const dialect = new PgDialect();

/** An exec whose two reads are told apart by TABLE: the leave days (joined to teachers) and each day's classes. */
const execOf = (days: any[], classes: Record<string, any[]>) => {
  const asked: any[] = [];
  const exec: any = {
    select: () => ({ from: (t: any) => {
      const table = getTableName(t);
      const tail = (cond: any) => ({ orderBy: async () => {
        const params = dialect.sqlToQuery(cond).params;
        asked.push([table, params]);
        if (table === "teacher_leave_days") return days;
        return classes[`${params.find((p: any) => typeof p === "string" && /^\d{4}-/.test(p))}|${params.find((p: any) => days.some((d) => d.teacherId === p))}`] ?? [];
      } });
      return { innerJoin: () => ({ where: tail }), where: tail };
    } }),
  };
  return { exec, asked };
};

describe("🔴 (a) THE ADMIN'S LIST — recorded days in a window, each with its live classes, through THE one answer", () => {
  test("by value: each day carries who, why, who recorded it, and `leaveDayBookings`' own rows for THAT teacher on THAT day", async () => {
    const days = [
      { teacherId: "t1", teacherName: "Ek", date: "2026-10-21", reason: "ธุระ", createdBy: "coach-ek" },
      { teacherId: "t2", teacherName: "Nok", date: "2026-10-22", reason: null, createdBy: "coach-nok" },
    ];
    const c1 = [{ id: "b-1", date: "2026-10-21", startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", bookingType: "PRIVATE" }];
    const { exec, asked } = execOf(days, { "2026-10-21|t1": c1 });
    expect(await recordedLeaveDays(exec, "2026-10-01", "2026-10-31")).toEqual([{ ...days[0], bookings: c1 }, { ...days[1], bookings: [] }]);
    expect(asked[0]).toEqual(["teacher_leave_days", ["2026-10-01", "2026-10-31"]]); // the window, both ends inclusive
    expect(asked.slice(1).map((a) => a[0])).toEqual(["bookings", "bookings"]); // one class read per day — THE list
  });
  test("🚫 no second answer: the list is `leaveDayBookings`, called by name; nothing else in the code reads the leave table", () => {
    const M = code("src/lib/teacher-leave.ts");
    expect(fnBody(M, "export async function recordedLeaveDays(")).toContain("bookings: await leaveDayBookings(exec, d.teacherId, d.date)");
  });
  test("the service's window: from TODAY (Bangkok) to 60 days on, unless the admin names one", async () => {
    setSystemTime(new Date("2026-10-01T10:00:00+07:00"));
    const { exec, asked } = execOf([], {});
    spies.push(spyOn(db, "select").mockImplementation(exec.select));
    await sched.listRecordedLeaveDays({});
    await sched.listRecordedLeaveDays({ from: "2026-11-01", to: "2026-11-07" });
    expect(asked.map((a) => a[1])).toEqual([["2026-10-01", "2026-11-30"], ["2026-11-01", "2026-11-07"]]);
  });
  test("the KEY: the calendar's read key (`menu:calendar`) — the same rows the grid already shows that viewer; no action, no new key; a linked teacher is NOT allowed", () => {
    expect(ROUTE_ACCESS["GET /teacher-leave-days"]).toEqual({ menus: ["menu:calendar"] });
    expect(TEACHER_ALLOWED.has("GET /teacher-leave-days")).toBe(false); // the route sweep (TASK-406's) 403s it for a linked account
  });
  test("through the ROOT app: the list reaches the service with the window; a backwards or >92-day window ⇒ 400", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    spies.push(spyOn(sched, "listRecordedLeaveDays").mockImplementation((async (q: any) => { calls.push(q); return []; }) as any));
    const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
    const get = (qs: string) => app.fetch(new Request(`http://localhost/api/teacher-leave-days${qs}`));
    expect(await (await get("?from=2026-10-01&to=2026-10-31")).json()).toEqual({ items: [] });
    expect((await get("?from=2026-10-31&to=2026-10-01")).status).toBe(400);
    expect((await get("?from=2026-10-01&to=2027-01-15")).status).toBe(400);
    expect((await get("")).status).toBe(200);
    expect(calls).toEqual([{ from: "2026-10-01", to: "2026-10-31" }, {}]);
  });
});

describe("⚖️ (b) the notice — the premise checked, and what is pinned", () => {
  const S = code("src/services/scheduler.service.ts");
  test("🔑 FINDING, by source: the OLD act (today / past) told the FAMILIES and the OTHER COACHES — and NO admin (so no admin signal was lost)", () => {
    const L = fnBody(S, "export async function reportOwnLeave(");
    expect(L).toContain("await sendClassCancelledToOtherTeachers(tx, b as any, { cancelReason: \"TEACHER_LEAVE\", note: input.reason }, me);");
    expect(L).toContain("familiesNotified += await sendClassCancelledToFamilies(tx, b as any, \"TEACHER_LEAVE\", replanned?.appended ?? []);");
    expect(L).not.toMatch(/notifyAdmins|recipientType: "admin"/);
    for (const f of [fnBody(S, "async function sendClassCancelledToOtherTeachers("), fnBody(S, "async function sendClassCancelledToFamilies(")]) expect(f).not.toMatch(/notifyAdmins|"admin"/);
  });
  test("🚫 the ADVANCE act tells NOBODY: no family (a class still going ahead must not read as 'teacher away'), no coach, no admin (not ruled)", () => {
    const L = fnBody(S, "export async function reportOwnLeave(");
    const ADV = L.slice(L.indexOf("if (isAdvanceLeave(input.date)) {"), L.indexOf("const mine = await db.query.bookings.findMany({"));
    expect(ADV).toContain("recordAdvanceLeave(db, me,");
    expect(ADV).not.toMatch(/enqueueLine|notifyAdmins|sendClassCancelled|sendLeaveNotice/);
    expect(code("src/lib/teacher-leave.ts")).not.toMatch(/enqueueLine|notifyAdmins/);
  });
});
