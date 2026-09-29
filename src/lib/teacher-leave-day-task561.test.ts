// TASK-561 (REQ-110 item 2) — a teacher's ADVANCE leave blocks the whole day for NEW bookings with that teacher, on EVERY path.
// The owner: bookings already there are LISTED for the admin; nothing moves or cancels automatically; automatically re-planned
// make-ups respect the block too. Sober's ruling: the re-plan SKIPS to the next free week; co-teacher and seats blocked where
// that teacher teaches; a revive / a leave-Undo onto the day refused in words; the camp sync SKIPS + LISTS.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { assertNoCoachOnLeave, leaveFires, teacherLeaveOn } from "./teacher-leave";
import * as ownScope from "./own-scope";
import * as sched from "../services/scheduler.service";
import * as camp from "../services/camp.service";

const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fnBody = (s: string, head: string) => { const a = s.indexOf(head); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf("\n}\n", a)); };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const x of spies.splice(0)) x.mockRestore(); setSystemTime(); });
const TODAY = "2026-09-29";
const today = () => setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));

/** A `where` callback evaluated into { column: value } pairs (the service's own callback, not a canned answer). */
const whereOf = (q: any): Record<string, unknown> => {
  const pairs = [q?.where?.(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => [[c, v]] })].flat(3);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i] as string] = pairs[i + 1];
  return out;
};
/** The recorded leave days, answering THE reader's query. */
const leaveTable = (rows: Array<{ teacherId: string; date: string }>, asked: string[] = []) => ({
  findFirst: async (q: any) => { const w = whereOf(q); asked.push(`${w.teacherId}|${w.date}`); return rows.find((r) => r.teacherId === w.teacherId && r.date === w.date); },
});

describe("🔴 'advance', exactly — the block fires only for a booking dated TODAY or later; history is never refused", () => {
  test("leaveFires: past ⇒ no · today ⇒ yes · future ⇒ yes", () => {
    expect([leaveFires("2026-09-28", TODAY), leaveFires(TODAY, TODAY), leaveFires("2026-10-21", TODAY)]).toEqual([false, true, true]);
  });
  test("THE reader: a past date is answered WITHOUT a read; a recorded future day is found; another teacher's is not", async () => {
    today();
    const asked: string[] = [];
    const exec = { query: { teacherLeaveDays: leaveTable([{ teacherId: "t1", date: "2026-10-21" }, { teacherId: "t1", date: "2026-09-20" }], asked) } };
    expect(await teacherLeaveOn(exec, "t1", "2026-09-20")).toBeNull(); // recorded, but in the past ⇒ never fires
    expect(asked).toEqual([]); // …and not even read
    expect(await teacherLeaveOn(exec, "t1", "2026-10-21")).toMatchObject({ teacherId: "t1" });
    expect(await teacherLeaveOn(exec, "t2", "2026-10-21")).toBeNull();
  });
});

describe("🔴 Seam A — `assertTeacherBookable`, the ONE availability gate every insert / move / swap / co-teacher door calls", () => {
  const exec = (leave: Array<{ teacherId: string; date: string }>) => ({
    query: { teachers: { findFirst: async () => ({ id: "t1", nickname: "Ek", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" }) }, teacherLeaveDays: leaveTable(leave) },
  });
  test("a teacher on an advance leave that day ⇒ 409 TEACHER_ON_LEAVE, naming who, which day, what to do", async () => {
    today();
    const e: any = await sched.assertTeacherBookable(exec([{ teacherId: "t1", date: "2026-10-21" }]), "t1", "2026-10-21").catch((x) => x);
    expect([e.status, e.code]).toEqual([409, "TEACHER_ON_LEAVE"]);
    expect(e.message).toBe("ครูEk ลาวันที่ 2026-10-21 — เพิ่มคาบกับครูวันนี้ไม่ได้ กรุณาเลือกครูอื่นหรือวันอื่น"); // 📋 DRAFT (owner's copy batch)
  });
  test("🚫 the SAME teacher on another day, or a back-dated write onto a past leave day, passes", async () => {
    today();
    await expect(sched.assertTeacherBookable(exec([{ teacherId: "t1", date: "2026-10-21" }]), "t1", "2026-10-22")).resolves.toMatchObject({ id: "t1" });
    await expect(sched.assertTeacherBookable(exec([{ teacherId: "t1", date: "2026-09-01" }]), "t1", "2026-09-01")).resolves.toMatchObject({ id: "t1" }); // an import of history
  });
});

describe("🔴 Seam B — the automatic make-up SKIPS the leave day to the next free week (never refused: §12)", () => {
  const exec = (leave: Array<{ teacherId: string; date: string }>) => ({ query: { teacherLeaveDays: leaveTable(leave), bookings: { findFirst: async () => undefined } } });
  test("the leave week is passed over exactly like a taken slot; another teacher's leave changes nothing", async () => {
    today();
    expect(await sched.findFreeExtensionDate(exec([{ teacherId: "t1", date: "2026-10-08" }]), "t1", "10:00:00", "2026-10-01")).toBe("2026-10-15");
    expect(await sched.findFreeExtensionDate(exec([{ teacherId: "t9", date: "2026-10-08" }]), "t1", "10:00:00", "2026-10-01")).toBe("2026-10-08");
    expect(await sched.findFreeExtensionDate(exec([{ teacherId: "t1", date: "2026-10-08" }, { teacherId: "t1", date: "2026-10-15" }]), "t1", "10:00:00", "2026-10-01")).toBe("2026-10-22");
  });
});

describe("🔴 a class put back WITHOUT an insert (revive · leave-Undo · a seat joining an existing group) — every coach who TEACHES it", () => {
  test("a coach of the class on leave ⇒ refused; none on leave ⇒ passes", async () => {
    today();
    spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: "t1", lineUserId: null }, { id: "t2", lineUserId: null }]) as any));
    const exec = (leave: any[]) => ({ query: { teacherLeaveDays: leaveTable(leave), teachers: { findFirst: async (q: any) => ({ nickname: whereOf(q).id === "t2" ? "Nok" : "Ek" }) } } });
    const e: any = await assertNoCoachOnLeave(exec([{ teacherId: "t2", date: "2026-10-21" }]), { id: "g1", date: "2026-10-21" }).catch((x) => x);
    expect([e.code, e.message.startsWith("ครูNok ลาวันที่ 2026-10-21")]).toEqual(["TEACHER_ON_LEAVE", true]); // the CO-teacher
    await expect(assertNoCoachOnLeave(exec([{ teacherId: "t3", date: "2026-10-21" }]), { id: "g1", date: "2026-10-21" })).resolves.toBeUndefined(); // someone else's leave
  });
});

describe("🔴 the camp sync — SKIP + LIST: the on-leave coach gets no new block, keeps an existing one, and is named", () => {
  const run = (leave: Array<{ teacherId: string; date: string }>) => {
    const log: string[] = [];
    const tx: any = {
      query: {
        campWeekDays: { findFirst: async () => ({ id: "wd1", date: "2026-10-06", startTime: "10:00:00", endTime: "12:00:00", week: { status: "OPEN", name: "Oct" } }) },
        campWeekDayTeachers: { findMany: async () => [{ teacherId: "t1", startTime: null, endTime: null, rateMinor: 0 }, { teacherId: "t2", startTime: null, endTime: null, rateMinor: 0 }] },
        teacherLeaveDays: leaveTable(leave),
        teachers: { findMany: async () => [] },
      },
      select: () => ({ from: () => ({ where: async () => [{ id: "old-t1", teacherId: "t1", startTime: "10:00:00" }] }) }), // t1 ALREADY holds 10:00
      delete: (t: any) => ({ where: async () => { log.push(`delete:${getTableName(t)}`); } }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };
    spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, i: any) => { log.push(`insert:${i.teacherId}|${i.startTime}`); return `new-${log.length}`; }) as any));
    return { tx, log };
  };
  test("t1 on leave: t2's blocks are made, t1 gets NOTHING new, t1's existing 10:00 block is NOT deleted, and t1 is listed", async () => {
    today();
    const { tx, log } = run([{ teacherId: "t1", date: "2026-10-06" }]);
    const r = await camp.syncCampDayRows(tx, "wd1");
    expect(r).toEqual({ inserted: 2, deleted: 0, onLeave: ["t1"] });
    expect(log.sort()).toEqual(["insert:t2|10:00", "insert:t2|11:00"]);
  });
  test("no leave ⇒ the sync is what it was (t1 gains 11:00; nobody listed)", async () => {
    today();
    const { tx, log } = run([]);
    expect(await camp.syncCampDayRows(tx, "wd1")).toEqual({ inserted: 3, deleted: 0, onLeave: [] });
    expect(log.sort()).toEqual(["insert:t1|11:00", "insert:t2|10:00", "insert:t2|11:00"]);
  });
});

describe("🔑 EVERY path, derived — the set is closed by source, and there is ONE definition", () => {
  const files = (dir: string): string[] => readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(`${dir}/${d.name}`) : d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [`${dir}/${d.name}`] : []);
  const all = [...files("src"), ...files("scripts")].map((f) => [f, read(f)] as const);
  const S = read("src/services/scheduler.service.ts");
  test("booking rows are created in exactly four places: the ONE inserter, the two make-up writers, and the dev seed", () => {
    const sites = all.flatMap(([f, s]) => [...s.matchAll(/\.insert\(bookings\)/g)].map(() => f));
    expect(sites.sort()).toEqual(["src/db/seed.ts", "src/services/scheduler.service.ts", "src/services/scheduler.service.ts", "src/services/scheduler.service.ts"]);
    expect(fnBody(S, "export async function insertBooking(")).toContain("await assertTeacherBookable(exec, input.teacherId, input.date);"); // Seam A
    for (const head of ["export async function reconcileCoursePlan(", "export async function updateBookingStatus("]) {
      const body = fnBody(S, head);
      expect(body.indexOf("findFreeExtensionDate(")).toBeGreaterThan(-1); // Seam B, before its direct insert
      expect(body.indexOf("findFreeExtensionDate(")).toBeLessThan(body.indexOf(".insert(bookings)"));
    }
  });
  test("both seams read THE reader; the non-insert doors call the class check; nothing else defines 'on leave'", () => {
    expect(code(fnBody(S, "export async function assertTeacherBookable("))).toContain("if (await teacherLeaveOn(exec, teacher.id, date)) throw TEACHER_ON_LEAVE(teacher.nickname, date);");
    expect(code(fnBody(S, "export async function findFreeExtensionDate("))).toContain("if (await teacherLeaveOn(exec, teacherId, d)) return true;");
    expect(code(S)).toContain("if (REVIVING.has(action)) await assertNoCoachOnLeave(tx, current);");
    expect(code(fnBody(S, "async function seatOnGroup("))).toContain("await assertNoCoachOnLeave(tx, { id: row.id, date });");
    expect(code(read("src/services/undo.service.ts"))).toContain("await assertNoCoachOnLeave(tx, row);");
    expect(code(read("src/services/camp.service.ts"))).toContain("if (await teacherLeaveOn(tx, c.teacherId, d.date)) onLeave.push(c.teacherId);");
    const declares = new Set(["src/db/schema.ts", "src/lib/migration-witness.ts"]); // the table's declaration and its migration probe — not readers
    const readers = all.filter(([f, s]) => !declares.has(f) && /teacherLeaveDays|teacher_leave_days/.test(code(s))).map(([f]) => f);
    expect(readers).toEqual(["src/lib/teacher-leave.ts"]); // 🚫 no second definition
  });
  test("🚫 nothing here cancels or moves: the leave module writes nothing, and `reportOwnLeave` is untouched (the owner's question)", () => {
    expect(code(read("src/lib/teacher-leave.ts"))).not.toMatch(/\.(insert|update|delete)\(/);
    expect(fnBody(S, "export async function reportOwnLeave(")).not.toMatch(/teacherLeave|TEACHER_ON_LEAVE/);
  });
});

describe("📋 the LIST the owner asked for — that teacher's LIVE classes that day, primary OR additional, class rows only; a read", () => {
  test("the query, rendered: the date, live statuses only, no seat rows, THE 'whose class' predicate (primary or booking_teachers), by start time", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const { leaveDayBookings } = await import("./teacher-leave");
    let where: any, order: any;
    const exec = { select: () => ({ from: () => ({ where: (w: any) => { where = w; return { orderBy: async (o: any) => { order = o; return []; } }; } }) }) };
    expect(await leaveDayBookings(exec, "t1", "2026-10-21")).toEqual([]);
    const q = new PgDialect().sqlToQuery(where);
    expect(q.sql).toContain('"bookings"."date" = $1');
    expect(q.sql).toContain('"bookings"."group_id" is null');
    expect(q.sql).toMatch(/"bookings"\."status" in \(\$\d+, \$\d+, \$\d+\)/);
    expect(q.sql).toContain('"bookings"."teacher_id" = $');
    expect(q.sql).toContain('"booking_teachers"."teacher_id" = $');
    expect(q.params).toEqual(expect.arrayContaining(["2026-10-21", "PENDING", "CONFIRMED", "EXTENDED", "t1"]));
    expect(q.params).not.toContain("CANCELLED");
    expect(order.name).toBe("start_time"); // ordered by start time (a column, not SQL)
  });
});
