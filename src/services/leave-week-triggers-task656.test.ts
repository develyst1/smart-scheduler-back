// TASK-656 §R (REQ-112, the customer's model re-aimed 2026-10-06) — a course's expiry gains ONE WEEK for exactly THREE triggers, and for
// nothing else: T1 an absence declared BEFORE the course starts · T2 a COACH's leave (per class; each seat of a group) · T3 a school cancel
// with the reason `SCHOOL_ISSUE`. An ORDINARY leave — any door, any number — adds NOTHING and is still one make-up.
// ⚠️ This file was `every-leave-adds-a-week-task656.test.ts`: it proved the OPPOSITE rule (a sentence a summary wrote that nothing
// downstream could tell from the customer's own words). Its name stated the wrong rule, so the name changed with it.
//
// 🔴 This file is the task's real proof, and it is deliberately shaped by what went wrong last time: TASK-646 shipped a
//    FUNCTION-level proof for a PATH-level claim ("the expiry stretches") and a path nobody asked about stayed broken.
//    ⇒ every door below is driven THROUGH ITS REAL ENTRY POINT over a fake transaction, and what is asserted is what the
//    DATABASE would end up holding: the expiry date, the expiry-change RECORDS, and the make-up ROWS. Nothing here calls
//    `addLeaveWeek` directly, so a door that forgets to call it fails — which a test of the helper could never see.
// 🔑 Per door, ONE assertion shape: expiry = base + exactly 7 days · exactly ONE expiry-change record (from → to, no actor) ·
//    exactly ONE make-up. Never +14 (a leave AND its re-owe both adding), never 0.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as rental from "./rental.service";
import * as lineLib from "../lib/line";
import * as ownScope from "../lib/own-scope";
import { courseExpiry } from "../lib/recurring";
import { bangkokNow } from "../lib/bangkok-time";
import { readSrc } from "../lib/read-src";
import { LEAVE_WEEK_TRIGGERS } from "../lib/course-plan";
import { weekOfExpiry } from "../lib/leave";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
const KEY: Record<string, string> = { bookings: "bookings", course_packages: "courses" };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const DAY = 24 * 3600 * 1000;
const plus = (d: string, days: number) => new Date(Date.parse(d) + days * DAY).toISOString().slice(0, 10);
const T1 = "t1t1t1t1-t1t1-41t1-81t1-t1t1t1t1t1t1";
const FUTURE = plus(bangkokNow().date, 21); // a course that has NOT started: every session is ahead of today
const SIZE = 4;

type Course = { id: string; size: number; startDate: string; expiryDate: string };
const baseCourse = (id: string, start: string): Course => ({ id, size: SIZE, startDate: start, expiryDate: courseExpiry(start, SIZE) });
const row = (id: string, courseId: string, date: string, status = "PENDING", over: any = {}) => ({
  id, courseId, date, status, startTime: "10:00:00", endTime: "11:00:00", teacherId: T1, studentId: "s1", coStudentId: null,
  subjectId: "sub1", voucherId: null, bookingType: "COURSE_PACKAGE", note: null, plannedAtCreation: false, leaveCharged: null,
  checkinSource: null, checkinChannel: null, checkinActor: null, campWeekDayId: null, extendedFromId: null, groupId: null,
  slotYieldedAt: null, cancelReason: null, ...over,
});
const courseRows = (courseId: string, start: string, delivered = 0) =>
  Array.from({ length: SIZE }, (_, i) => row(`${courseId}-b${i + 1}`, courseId, plus(start, i * 7), i < delivered ? "ATTENDED" : "PENDING"));

/** The world: bookings + courses in memory, every write recorded. `expiryChanges` is what the audit table would hold. */
function world(courses: Course[], rows: any[]) {
  const w: any = {
    courses: courses.map((c) => ({ ...c, usedSessions: 0, leaveUsed: 0, leaveQuota: null, status: "ACTIVE", adminUnlocked: false, priorSessions: 0, classRateMinor: null, endedAt: null, droppedAt: null })),
    bookings: rows, expiryChanges: [] as any[], inserts: [] as any[],
  };
  const course = (id: string) => w.courses.find((c: any) => c.id === id) ?? null;
  const withRels = (r: any) => r && ({ ...r, course: course(r.courseId), voucher: null, additionalTeachers: [], seats: [], teacher: { id: T1, name: "Bank", nickname: "Bank", lineUserId: null } });
  const probe = (where: any) => {
    const hits: Array<[string, any]> = [];
    const cols = { id: "id", courseId: "courseId", groupId: "groupId", date: "date", status: "status", teacherId: "teacherId", startTime: "startTime", extendedFromId: "extendedFromId", bookingType: "bookingType" };
    try { where(cols, { and: (...a: any[]) => a, eq: (c: any, v: any) => { hits.push([String(c), v]); return v; }, ne: () => null, notInArray: () => null, inArray: () => null, or: () => null, isNull: () => null, gte: () => null, lte: () => null, lt: () => null, gt: () => null }); } catch {}
    return (k: string) => hits.find((h) => h[0] === k)?.[1];
  };
  const tx: any = {
    query: {
      bookings: {
        findFirst: async ({ where }: any) => { const g = probe(where); const id = g("id"); return withRels(w.bookings.find((b: any) => b.id === id)) ?? null; },
        findMany: async ({ where, orderBy, limit }: any) => {
          const g = probe(where);
          let out = g("groupId") ? w.bookings.filter((b: any) => b.groupId === g("groupId") && ["PENDING", "CONFIRMED", "EXTENDED"].includes(b.status))
            : g("courseId") ? w.bookings.filter((b: any) => b.courseId === g("courseId") && b.status !== "CANCELLED")
            : w.bookings.filter((b: any) => b.status !== "CANCELLED");
          if (orderBy) out = [...out].sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
          return (limit ? out.slice(0, limit) : out).map(withRels);
        },
      },
      coursePackages: { findFirst: async ({ where }: any) => { const g = probe(where); return course(g("id")) ?? w.courses[0] ?? null; } },
      teacherLeaveDays: { findFirst: async () => undefined },
      teachers: { findFirst: async () => ({ id: T1, nickname: "Bank", name: "Bank", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: null }), findMany: async () => [] },
      students: { findFirst: async () => ({ id: "s1", nickname: "Mali", name: "Mali", parentId: "p1" }), findMany: async () => [] },
      parents: { findFirst: async () => ({ id: "p1", lineUserId: null }), findMany: async () => [] },
      familyLineLinks: { findMany: async () => [], findFirst: async () => null },
      notificationOutbox: { findFirst: async () => null, findMany: async () => [] },
      appSettings: { findMany: async () => [], findFirst: async () => null },
      jobRuns: { findFirst: async () => null, findMany: async () => [] },
      boItem: { findMany: async () => [] },
      bookingRentals: { findFirst: async () => null, findMany: async () => [] },
      users: { findMany: async () => [] },
    },
    update: (t: any) => ({ set: (set: Record<string, unknown>) => ({ where: (cond: any) => {
      const { sql, params } = dialect.sqlToQuery(cond);
      const conds = [...sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)].map((m) => ({ col: camel(m[2]!), val: params[Number(m[3]) - 1] }));
      const rowsOf = ((w as any)[KEY[getTableName(t)] ?? "__other"] ?? []) as any[];
      const hits = rowsOf.filter((r) => conds.every((c) => r[c.col] === c.val));
      for (const r of hits) for (const [k, v] of Object.entries(set)) {
        if (v && typeof v === "object" && "queryChunks" in (v as object)) {
          const q = dialect.sqlToQuery(v as any).sql;
          // 🔑 the write `addLeaveWeek` actually makes: ONE statement, the DATABASE does the arithmetic
          if (/interval '7 days'/.test(q)) { r[k] = plus(r[k], 7); continue; }
          if (/GREATEST/.test(q)) { r[k] = Math.max(0, (r[k] ?? 0) - 1); continue; }
          r[k] = (r[k] ?? 0) + 1; continue;
        }
        r[k] = v;
      }
      const out = hits.map((r) => ({ id: r.id, to: r.expiryDate }));
      return Object.assign(Promise.resolve(out), { returning: async () => out });
    } }) }),
    insert: (t: any) => ({ values: (v: any) => {
      const table = getTableName(t);
      if (table === "bookings") { const r = { ...row(`x${w.bookings.length + 1}`, v.courseId ?? "c1", v.date, v.status ?? "EXTENDED"), ...v, id: `x${w.bookings.length + 1}` }; w.bookings.push(r); w.inserts.push({ table, v: r }); return Object.assign(Promise.resolve(), { returning: async () => [{ id: r.id }] }); }
      if (table === "course_expiry_changes") w.expiryChanges.push(v);
      w.inserts.push({ table, v });
      return Object.assign(Promise.resolve(), { returning: async () => [{ id: "x" }], onConflictDoNothing: async () => {} });
    } }),
    delete: () => ({ where: async () => {} }),
    // the coach-notice read chains `.limit()` / `.innerJoin()`; it answers nobody here on purpose
    select: () => { const q: any = { from: () => q, where: () => q, limit: async () => [], innerJoin: async () => [] }; return q; },
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => withRels(w.bookings[0])) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => w.bookings.filter((b: any) => b.status !== "CANCELLED").map(withRels)) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async (_e: any, id: string) => ({ id })) as any));
  spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_tx: any, _t: string, _st: string, after: string) => plus(after, 7)) as any));
  spies.push(spyOn(rental, "inheritCourseRental").mockImplementation((async () => {}) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async () => ({ status: "queued" }) as any)) as any);
  w.tx = tx; // for the doors whose entry point TAKES a transaction (a group date's seats)
  return w;
}

/** The ONE assertion every door shares: +7 days exactly · ONE expiry record (no actor) · ONE make-up. */
const expectOneWeek = (w: any, courseId: string, base: string, makeups = 1) => {
  const c = w.courses.find((x: any) => x.id === courseId);
  expect({ expiry: c.expiryDate }).toEqual({ expiry: plus(base, 7) }); // 🔴 not +14, not 0
  const mine = w.expiryChanges.filter((e: any) => e.courseId === courseId);
  expect(mine).toHaveLength(1); // 🔴 exactly ONE record per absence
  expect(mine[0]).toMatchObject({ fromDate: base, toDate: plus(base, 7), actor: null }); // the system moved it
  // 🔑 Counted as ROWS INSERTED for this course, not by `extendedFromId`: a make-up re-owed by a CANCEL (doors 3, 4, 5) has no leave
  // row to point at, so it carries no link — and my first version of this helper counted links and reported zero make-ups for
  // three doors that were each creating one. **A counter that reads a property some correct rows do not have undercounts them.**
  expect(w.inserts.filter((i: any) => i.table === "bookings" && i.v.courseId === courseId)).toHaveLength(makeups);
};
const expectNoWeek = (w: any, courseId: string, base: string, makeups = 1) => {
  const c = w.courses.find((x: any) => x.id === courseId);
  expect({ expiry: c.expiryDate }).toEqual({ expiry: base }); // 🔴 the expiry did NOT move
  expect(w.expiryChanges.filter((e: any) => e.courseId === courseId)).toHaveLength(0); // …and nothing was recorded
  expect(w.inserts.filter((i: any) => i.table === "bookings" && i.v.courseId === courseId)).toHaveLength(makeups); // …but the make-up is still owed
};
const weeksBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / (7 * DAY));
const STARTED = () => plus(bangkokNow().date, -14);

describe("🔴 AN ORDINARY LEAVE ADDS NOTHING — any door, any number (the customer: «ถ้าลาปกติไม่เพิ่มให้นะคะ»)", () => {
  test("door 1, a STARTED course: expiry byte-identical, NO record, still ONE make-up, still COUNTED", async () => {
    const c = baseCourse("c1", STARTED());
    const w = world([c], courseRows("c1", c.startDate, 2)); // two delivered ⇒ started
    await sched.updateBookingStatus("c1-b4", "sick-leave", "ไม่สบาย", false);
    expectNoWeek(w, "c1", c.expiryDate);
    expect(w.bookings.find((b: any) => b.id === "c1-b4")).toMatchObject({ status: "SICK_LEAVE", plannedAtCreation: false, leaveCharged: true });
    expect(w.courses[0].leaveUsed).toBe(1);
  });

  test("⚠️ THE BOUNDARY — a course whose FIRST class was checked in TODAY is no longer 'not started': an ordinary leave, +0", async () => {
    const today = bangkokNow().date;
    const c = baseCourse("c1", today);
    const w = world([c], courseRows("c1", today, 1));
    await sched.updateBookingStatus("c1-b2", "sick-leave", "ไม่สบาย", false);
    expectNoWeek(w, "c1", c.expiryDate);
    expect(w.bookings.find((b: any) => b.id === "c1-b2")).toMatchObject({ plannedAtCreation: false });
    expect(w.courses[0].leaveUsed).toBe(1);
  });

  test("door 2 (the plan editor), a STARTED course: +0, one make-up, counted", async () => {
    const c = baseCourse("c1", STARTED());
    const w = world([c], courseRows("c1", c.startDate, 2));
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b4", planned: true, reason: "ไม่สบาย", override: true });
    expectNoWeek(w, "c1", c.expiryDate);
    expect(w.bookings.find((b: any) => b.id === "c1-b4")).toMatchObject({ status: "SICK_LEAVE", leaveCharged: true, plannedAtCreation: false });
    expect(w.courses[0].leaveUsed).toBe(1);
  });

  test("🔑 ANY NUMBER — one leave on door 1 and one on door 2 ⇒ two make-ups, two counted, the expiry STILL where it was", async () => {
    const t = bangkokNow().date;
    const c = baseCourse("c1", plus(t, -14));
    const w = world([c], [row("c1-b1", "c1", plus(t, -14), "ATTENDED"), row("c1-b2", "c1", plus(t, -7), "ATTENDED"), row("c1-b3", "c1", plus(t, 7)), row("c1-b4", "c1", plus(t, 14))]);
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b4", planned: true, reason: "ป่วย", override: true });
    expectNoWeek(w, "c1", c.expiryDate, 2);
    expect(w.courses[0].leaveUsed).toBe(2); // …a plain count, which gates nothing
  });

  test("🔴 it NEVER refuses with `LEAVE_LOCKED` — a counter far past the old quota still takes the leave, and `leaveLocked` is always false", async () => {
    const c = baseCourse("c1", STARTED());
    const w = world([c], courseRows("c1", c.startDate, 2));
    w.courses[0].leaveUsed = 9; // the old quota is 1 for a size-4 course
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b4", planned: false, reason: "ป่วย", override: false });
    expect(w.bookings.find((b: any) => b.id === "c1-b4")).toMatchObject({ status: "SICK_LEAVE" });
    const { toCourseSummary } = await import("../lib/leave");
    expect(toCourseSummary({ ...w.courses[0], leaveUsed: 99, adminUnlocked: false }).leaveLocked).toBe(false);
    expect(toCourseSummary({ ...w.courses[0], leaveUsed: 0, adminUnlocked: false }).leaveLocked).toBe(false);
  });
});

describe("🔴 T1 — an absence DECLARED BEFORE THE COURSE STARTS adds a week (door 1 AND door 2 — ONE rule for one act)", () => {
  test("door 1: +7 exactly, ONE record, ONE make-up — and still FREE and not counted (TASK-609 unchanged)", async () => {
    // 🔑 TASK-646's recompute used to move the expiry on this path; the helper REPLACED it. One act ⇒ one week, never +14.
    const c = baseCourse("c1", FUTURE);
    const w = world([c], courseRows("c1", FUTURE));
    await sched.updateBookingStatus("c1-b1", "sick-leave", "ลาล่วงหน้า", false);
    expectOneWeek(w, "c1", c.expiryDate);
    expect(w.bookings.find((b: any) => b.id === "c1-b1")).toMatchObject({ status: "SICK_LEAVE", plannedAtCreation: true, leaveCharged: false });
    expect(w.courses[0].leaveUsed).toBe(0);
  });

  test("door 2: +7 exactly, ONE record, ONE make-up", async () => {
    const w = world([baseCourse("c1", FUTURE)], courseRows("c1", FUTURE));
    const base = w.courses[0].expiryDate;
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b2", planned: true, reason: "ลาล่วงหน้า", override: true });
    expectOneWeek(w, "c1", base);
  });

  test("🔴 BOTH ADMIN DOORS ANSWER THE SAME — one act, the session button vs the plan editor, leaves the IDENTICAL record", async () => {
    // 🔑 A title is a claim; if the body does not check it, the title is the bug — so the WHOLE record is compared across both doors.
    const snap = (w: any) => ({
      row: w.bookings.find((b: any) => b.id === "c1-b2"), leaveUsed: w.courses[0].leaveUsed, expiry: w.courses[0].expiryDate,
      records: w.expiryChanges.length, makeups: w.inserts.filter((i: any) => i.table === "bookings").length,
    });
    const viaButton = world([baseCourse("c1", FUTURE)], courseRows("c1", FUTURE));
    await sched.updateBookingStatus("c1-b2", "sick-leave", "ลาล่วงหน้า", false);
    const button = snap(viaButton);
    for (const s of spies.splice(0)) s.mockRestore();
    const viaEditor = world([baseCourse("c1", FUTURE)], courseRows("c1", FUTURE));
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b2", planned: true, reason: "ลาล่วงหน้า", override: true });
    const editor = snap(viaEditor);
    expect({ free: editor.row.plannedAtCreation, charged: editor.row.leaveCharged }).toEqual({ free: button.row.plannedAtCreation, charged: button.row.leaveCharged });
    expect(editor.row).toMatchObject({ status: "SICK_LEAVE", plannedAtCreation: true, leaveCharged: false });
    expect(editor.leaveUsed).toBe(button.leaveUsed);
    expect(editor.expiry).toBe(button.expiry);
    expect(editor.expiry).toBe(plus(courseExpiry(FUTURE, SIZE), 7)); // …and that is +7, the same on both
    expect(editor.records).toBe(button.records);
    expect(editor.makeups).toBe(button.makeups);
  });

  test("two declarations in sequence ⇒ +14 TOTAL — one week each, two records, never +28", async () => {
    const c = baseCourse("c1", FUTURE);
    const w = world([c], courseRows("c1", FUTURE));
    await sched.updateBookingStatus("c1-b1", "sick-leave", "ลาล่วงหน้า", false);
    await sched.updateBookingStatus("c1-b2", "sick-leave", "ลาล่วงหน้า", false);
    expect(w.courses[0].expiryDate).toBe(plus(c.expiryDate, 14));
    expect(w.expiryChanges.map((e: any) => [e.fromDate, e.toDate])).toEqual([[c.expiryDate, plus(c.expiryDate, 7)], [plus(c.expiryDate, 7), plus(c.expiryDate, 14)]]);
    expect(w.bookings.filter((b: any) => b.extendedFromId)).toHaveLength(2);
  });

  test("🔑 HER NUMBER — a 4-session course (5 weeks), one absence declared before it starts ⇒ WEEK 6 («6 ค่ะ»)", async () => {
    const c = baseCourse("c1", FUTURE);
    const w = world([c], courseRows("c1", FUTURE));
    expect(weekOfExpiry(FUTURE, c.expiryDate, 0)).toBe(5); // the base: 5 weeks for 4 sessions
    await sched.updateBookingStatus("c1-b1", "sick-leave", "ลาล่วงหน้า", false);
    expect(weekOfExpiry(FUTURE, w.courses[0].expiryDate, 0)).toBe(6);
  });

  test("🔴 …and a declaration followed by an ORDINARY leave later still ⇒ the ordinary one adds nothing", async () => {
    const c = baseCourse("c1", plus(bangkokNow().date, -14));
    const w = world([c], courseRows("c1", c.startDate, 2));
    await sched.updateBookingStatus("c1-b4", "sick-leave", "ป่วย", false); // started ⇒ ordinary
    expectNoWeek(w, "c1", c.expiryDate);
  });
});

describe("🔴 T2 — a COACH's leave adds a week PER CLASS (door 3), and each SEAT's course when it cancels a group", () => {
  const coachLeave = (w: any, today: string) => {
    const todays = w.bookings.filter((b: any) => b.date === today).map((b: any) => ({ ...b, course: w.courses[0], voucher: null, additionalTeachers: [], seats: [] }));
    spies.push(spyOn(ownScope, "assertLinked").mockImplementation((() => T1) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => todays) as any));
    return sched.reportTeacherLeave(T1, { date: today, reason: "ป่วย" }, "admin-dong", { onBehalf: true });
  };
  test("one class that day ⇒ +7, ONE record, ONE make-up", async () => {
    const today = bangkokNow().date;
    const c = baseCourse("c1", today);
    const w = world([c], courseRows("c1", today));
    const out: any = await coachLeave(w, today);
    expect(out.cancelled).toBe(1);
    expectOneWeek(w, "c1", c.expiryDate);
  });
  test("🔑 HER NUMBER — a coach away TWICE (two classes of one course) ⇒ +14 across two records: 13 weeks ⇒ 15", async () => {
    const today = bangkokNow().date;
    const c = baseCourse("c1", today);
    const rows = [row("c1-b1", "c1", today, "PENDING"), row("c1-b2", "c1", today, "PENDING", { startTime: "14:00:00", endTime: "15:00:00" }), row("c1-b3", "c1", plus(today, 7)), row("c1-b4", "c1", plus(today, 14))];
    const w = world([c], rows);
    await coachLeave(w, today);
    expect(w.courses[0].expiryDate).toBe(plus(c.expiryDate, 14));
    expect(w.expiryChanges).toHaveLength(2);
    expect(weeksBetween(today, w.courses[0].expiryDate) - weeksBetween(today, c.expiryDate)).toBe(2);
  });
  test("🔴 a coach's leave that cancels a GROUP date ⇒ +7 on EACH seat's course (two seats, two courses, one record each)", async () => {
    const a = baseCourse("c1", FUTURE), b = baseCourse("c2", FUTURE);
    const rows = [...courseRows("c1", FUTURE).slice(1), ...courseRows("c2", FUTURE).slice(1), row("seat1", "c1", FUTURE, "CONFIRMED", { groupId: "g1" }), row("seat2", "c2", FUTURE, "CONFIRMED", { groupId: "g1" })];
    const w = world([a, b], rows);
    await sched.cancelSeatsOfGroup(w.tx, "g1", "ป่วย", { weekTrigger: "T2_COACH_LEAVE" });
    expect(w.courses.find((c: any) => c.id === "c1").expiryDate).toBe(plus(a.expiryDate, 7));
    expect(w.courses.find((c: any) => c.id === "c2").expiryDate).toBe(plus(b.expiryDate, 7));
    expect(w.expiryChanges.filter((e: any) => e.courseId === "c1")).toHaveLength(1);
    expect(w.expiryChanges.filter((e: any) => e.courseId === "c2")).toHaveLength(1);
  });
});

describe("🔴 T3 — a class the SCHOOL cancels with «ปัญหาจากทางเรา» (`SCHOOL_ISSUE`) adds a week; every OTHER reason adds none", () => {
  test("door 4 with SCHOOL_ISSUE ⇒ +7 exactly, ONE record, ONE make-up, the code stored on the row", async () => {
    const w = world([baseCourse("c1", FUTURE)], courseRows("c1", FUTURE));
    const base = w.courses[0].expiryDate;
    await sched.updateBookingStatus("c1-b2", "cancel", "โรงเรียนปิด", false, "SCHOOL_ISSUE");
    expectOneWeek(w, "c1", base);
    expect(w.bookings.find((b: any) => b.id === "c1-b2")).toMatchObject({ status: "CANCELLED", cancelReason: "SCHOOL_ISSUE" });
  });

  for (const code of ["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR", "TEACHER_LEAVE"]) {
    test(`door 4 with ${code} ⇒ +0 — the class is re-owed, the expiry does not move, and the code is NOT stored (a course cancel stays byte-identical)`, async () => {
      const w = world([baseCourse("c1", FUTURE)], courseRows("c1", FUTURE));
      const base = w.courses[0].expiryDate;
      await sched.updateBookingStatus("c1-b2", "cancel", "ยกเลิก", false, code);
      expectNoWeek(w, "c1", base);
      expect(w.bookings.find((b: any) => b.id === "c1-b2")).toMatchObject({ status: "CANCELLED", cancelReason: null });
    });
  }

  test("door 4 with NO reason code ⇒ +0 (and the free-text note is never read as one: «ปัญหาจากทางเรา» typed as a note earns nothing)", async () => {
    const w = world([baseCourse("c1", FUTURE)], courseRows("c1", FUTURE));
    const base = w.courses[0].expiryDate;
    await sched.updateBookingStatus("c1-b2", "cancel", "ปัญหาจากทางเรา", false);
    expectNoWeek(w, "c1", base);
  });

  test("⚠️ cancelling a MIS-MARKED ATTENDED row: +0 unless the reason is «our side» — and with it, +7 (STATED, @Sober's re-aim)", async () => {
    for (const [code, weeks] of [[undefined, 0], ["ADMIN_ERROR", 0], ["SCHOOL_ISSUE", 1]] as const) {
      for (const s of spies.splice(0)) s.mockRestore();
      const c = baseCourse("c1", STARTED());
      const w = world([c], courseRows("c1", c.startDate, 2));
      await sched.updateBookingStatus("c1-b2", "cancel", "เช็คอินผิด", false, code);
      expect({ code, weeks: weeksBetween(c.expiryDate, w.courses[0].expiryDate) }).toEqual({ code, weeks });
    }
  });

  test("⚠️ cancelling a MAKE-UP: +0 for any ordinary reason; with «our side» a week ONLY if the class was really lost (TASK-551's same-slot case earns none)", async () => {
    const make = () => {
      const c = baseCourse("c1", FUTURE);
      const rows = [...courseRows("c1", FUTURE).slice(0, 3), row("c1-b4", "c1", plus(FUTURE, 21), "SICK_LEAVE"), row("c1-mk", "c1", plus(FUTURE, 28), "EXTENDED", { extendedFromId: "c1-b4" })];
      return { c, w: world([c], rows) };
    };
    const a = make();
    await sched.updateBookingStatus("c1-mk", "cancel", "ยกเลิก", false, "CUSTOMER_CANCELLED");
    expect(a.w.courses[0].expiryDate).toBe(a.c.expiryDate); // a cancelled make-up under another reason ⇒ +0
    for (const x of spies.splice(0)) x.mockRestore();
    // 🔴 THE SAME SLOT: the re-plan puts the make-up back at the SAME date and time (this fake searches `after + 7`, which lands exactly
    // where the cancelled one was) — nobody lost a class, so even «our side» earns nothing (TASK-551's owner ruling, pinned as asked)
    const b = make();
    await sched.updateBookingStatus("c1-mk", "cancel", "โรงเรียนปิด", false, "SCHOOL_ISSUE");
    expect(b.w.courses[0].expiryDate).toBe(b.c.expiryDate);
    for (const x of spies.splice(0)) x.mockRestore();
    // …and a DIFFERENT slot (the search lands two weeks on) — a class WAS lost ⇒ one week
    const d = make();
    spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_t: any, _s: string, _x: string, after: string) => plus(after, 14)) as any));
    await sched.updateBookingStatus("c1-mk", "cancel", "โรงเรียนปิด", false, "SCHOOL_ISSUE");
    expect(weeksBetween(d.c.expiryDate, d.w.courses[0].expiryDate)).toBe(1);
  });

  test("door 5 — a group date cancelled with SCHOOL_ISSUE: each SEAT's course +7, one record each — never one course +14 and the other +0", async () => {
    const a = baseCourse("c1", FUTURE), b = baseCourse("c2", FUTURE);
    const rows = [...courseRows("c1", FUTURE).slice(1), ...courseRows("c2", FUTURE).slice(1), row("seat1", "c1", FUTURE, "CONFIRMED", { groupId: "g1" }), row("seat2", "c2", FUTURE, "CONFIRMED", { groupId: "g1" })];
    const w = world([a, b], rows);
    await sched.cancelSeatsOfGroup(w.tx, "g1", "ยกเลิกกลุ่ม", { weekTrigger: "T3_SCHOOL_ISSUE" });
    for (const [id, c] of [["c1", a], ["c2", b]] as const) {
      expect(w.courses.find((x: any) => x.id === id).expiryDate).toBe(plus(c.expiryDate, 7));
      expect(w.expiryChanges.filter((e: any) => e.courseId === id)).toHaveLength(1);
    }
  });

  test("door 5 — a group date cancelled for ANY OTHER reason (no trigger passed) ⇒ every seat +0, make-ups still re-owed", async () => {
    const a = baseCourse("c1", FUTURE), b = baseCourse("c2", FUTURE);
    const rows = [...courseRows("c1", FUTURE).slice(1), ...courseRows("c2", FUTURE).slice(1), row("seat1", "c1", FUTURE, "CONFIRMED", { groupId: "g1" }), row("seat2", "c2", FUTURE, "CONFIRMED", { groupId: "g1" })];
    const w = world([a, b], rows);
    await sched.cancelSeatsOfGroup(w.tx, "g1", "ยกเลิกกลุ่ม");
    expect(w.courses.map((c: any) => c.expiryDate)).toEqual([a.expiryDate, b.expiryDate]);
    expect(w.expiryChanges).toHaveLength(0);
  });
});

describe("🔴 ONE ACT, ONE DECISION — acting twice on the SAME row never earns a second week or a second count", () => {
  test("door 2: re-marking a row that is ALREADY an absence adds nothing and does NOT convert a charged leave to free", async () => {
    const c = baseCourse("c1", STARTED());
    const w = world([c], courseRows("c1", c.startDate, 2));
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b4", planned: true, reason: "ไม่สบาย", override: true });
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b4", planned: true, reason: "ไม่สบาย อีกครั้ง", override: true });
    expectNoWeek(w, "c1", c.expiryDate);
    expect(w.courses[0].leaveUsed).toBe(1); // counted ONCE
    expect(w.bookings.find((b: any) => b.id === "c1-b4")).toMatchObject({ status: "SICK_LEAVE", leaveCharged: true }); // still charged, not flipped
  });

  test("door 2: re-marking a PRE-START declaration earns the week ONCE, not per click", async () => {
    const w = world([baseCourse("c1", FUTURE)], courseRows("c1", FUTURE));
    const base = w.courses[0].expiryDate;
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b2", planned: true, reason: "ลาล่วงหน้า", override: true });
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b2", planned: true, reason: "ลาล่วงหน้า อีกครั้ง", override: true });
    expectOneWeek(w, "c1", base);
  });

  test("…and on a NOT-STARTED course a re-mark of a CHARGED leave does not become FREE", async () => {
    const w = world([baseCourse("c1", FUTURE)], courseRows("c1", FUTURE));
    const r = w.bookings.find((b: any) => b.id === "c1-b2");
    Object.assign(r, { status: "SICK_LEAVE", leaveCharged: true, plannedAtCreation: false });
    w.courses[0].leaveUsed = 1;
    const base = w.courses[0].expiryDate;
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b2", planned: true, reason: "อีกครั้ง", override: true });
    expect(r).toMatchObject({ leaveCharged: true, plannedAtCreation: false });
    expect(w.courses[0].expiryDate).toBe(base);
  });

  test("door 1 declared twice and door 4 cancelled twice (SCHOOL_ISSUE) on one row each: a no-op the second time — never a second week", async () => {
    const w = world([baseCourse("c1", FUTURE)], courseRows("c1", FUTURE));
    const base = w.courses[0].expiryDate;
    await sched.updateBookingStatus("c1-b2", "sick-leave", "ลาล่วงหน้า", false);
    expect(w.courses[0].expiryDate).toBe(plus(base, 7));
    await sched.updateBookingStatus("c1-b2", "sick-leave", "ลาอีก", false).catch(() => {});
    expect(w.courses[0].expiryDate).toBe(plus(base, 7)); // 🔴 not +14
    await sched.updateBookingStatus("c1-b3", "cancel", "ปิด", false, "SCHOOL_ISSUE");
    expect(w.courses[0].expiryDate).toBe(plus(base, 14)); // a DIFFERENT row, a real school cancel ⇒ +7 more
    await sched.updateBookingStatus("c1-b3", "cancel", "ปิดอีก", false, "SCHOOL_ISSUE").catch(() => {});
    expect(w.courses[0].expiryDate).toBe(plus(base, 14)); // 🔴 cancelling the SAME row again adds nothing
  });
});

describe("🔴 RULING 3 — a make-up past the expiry is CREATED, and the expiry is NEVER silently stretched to fit it", () => {
  test("by value: the admin moves the expiry EARLIER by hand, then one more declared absence ⇒ the make-up lands PAST it, and the expiry is ONLY +7 from the moved date", async () => {
    const c = baseCourse("c1", FUTURE);
    const w = world([c], courseRows("c1", FUTURE));
    const lastSession = plus(FUTURE, 21);
    w.courses[0].expiryDate = lastSession;
    spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_t: any, _s: string, _x: string, after: string) => plus(after, 21)) as any));
    await sched.updateBookingStatus("c1-b1", "sick-leave", "ลาล่วงหน้า", false);
    const makeup = w.bookings.find((b: any) => b.extendedFromId);
    expect(makeup).toBeDefined(); // 🔑 CREATED — never held, never refused
    expect(w.courses[0].expiryDate).toBe(plus(lastSession, 7));
    expect(makeup.date > w.courses[0].expiryDate).toBe(true);
    expect(w.courses[0].expiryDate).not.toBe(makeup.date);
  });
  test("…and an ORDINARY leave whose make-up lands past the expiry moves it by NOTHING — the admin is told (TASK-657), the system does not stretch", async () => {
    const c = baseCourse("c1", STARTED());
    const w = world([c], courseRows("c1", c.startDate, 2));
    spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_t: any, _s: string, _x: string, after: string) => plus(after, 28)) as any));
    await sched.updateBookingStatus("c1-b4", "sick-leave", "ป่วย", false);
    const makeup = w.bookings.find((b: any) => b.extendedFromId);
    expect(makeup).toBeDefined();
    expect(makeup.date > w.courses[0].expiryDate).toBe(true);
    expect(w.courses[0].expiryDate).toBe(c.expiryDate);
  });
});

describe("🔴 FORWARD-ONLY — an existing course's expiry moves ONLY when a NEW trigger fires on it", () => {
  test("a course with past leaves and no new trigger ⇒ expiry byte-identical, and READING it does not move it", async () => {
    const c = baseCourse("c1", plus(bangkokNow().date, -28));
    const rows = [row("c1-b1", "c1", c.startDate, "ATTENDED"), row("c1-b2", "c1", plus(c.startDate, 7), "SICK_LEAVE", { leaveCharged: true }), row("c1-b3", "c1", plus(c.startDate, 14), "ATTENDED"), row("c1-b4", "c1", plus(c.startDate, 21), "PENDING"), row("c1-mk", "c1", plus(c.startDate, 28), "EXTENDED", { extendedFromId: "c1-b2" })];
    const w = world([c], rows);
    const before = w.courses[0].expiryDate;
    const { toCourseSummary } = await import("../lib/leave");
    toCourseSummary(w.courses[0]);
    toCourseSummary(w.courses[0], bangkokNow().date);
    expect(w.courses[0].expiryDate).toBe(before);
    expect(w.expiryChanges).toEqual([]);
  });
});

describe("🔑 THE LIST IS A LIST — three triggers, pinned BY VALUE; the call sites pinned against it (not against a 'whose fault' predicate)", () => {
  const SRC = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, f), "utf8")).replace(/\r\n/g, "\n");
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const SCHED = SRC("scheduler.service.ts");
  const lineOf = (s: string, needle: string) => s.slice(0, s.indexOf(needle)).split("\n").length;

  test("🔴 EXACTLY THREE triggers, by name — a fourth (or a predicate that replaces the list) fails here", () => {
    expect([...LEAVE_WEEK_TRIGGERS]).toEqual(["T1_PRE_START_DECLARATION", "T2_COACH_LEAVE", "T3_SCHOOL_ISSUE"]);
    expect(LEAVE_WEEK_TRIGGERS).toHaveLength(3);
    // the helper accepts ONLY a member of the list — a string reason cannot be passed
    expect(code(SCHED)).toMatch(/export async function addLeaveWeek\(\s*tx: any,\s*courseId: string,\s*trigger: LeaveWeekTrigger,/);
    // 🚫 and no "whose fault" predicate exists to derive the answer from
    expect(code(SCHED)).not.toMatch(/whoseFault|familyChose|isFamilyChoice|schoolFault/i);
  });

  test("🔴 `addLeaveWeek` is CALLED exactly FIVE times, each with ITS trigger — the table, by name, and the list is complete", () => {
    const calls = [...code(SCHED).matchAll(/await addLeaveWeek\(tx, [^,]+, ([^)]+)\)/g)].map((m) => m[1]!);
    expect(calls.sort()).toEqual(['"T1_PRE_START_DECLARATION"', '"T1_PRE_START_DECLARATION"', '"T2_COACH_LEAVE"', '"T3_SCHOOL_ISSUE"', "opts.weekTrigger"]);
    // every literal passed is a member of the list (so each of the three is reachable and none is invented)
    for (const c of calls) if (c.startsWith('"')) expect(LEAVE_WEEK_TRIGGERS as readonly string[]).toContain(c.slice(1, -1));
    for (const t of LEAVE_WEEK_TRIGGERS) expect(calls.some((c) => c === `"${t}"`)).toBe(true);
    for (const f of ["undo.service.ts", "other-series.service.ts", "camp.service.ts", "line-webhook.service.ts"]) {
      if (!existsSyncSafe(resolve(import.meta.dir, f))) continue;
      expect({ f, calls: (code(SRC(f)).match(/addLeaveWeek\(/g) ?? []).length }).toEqual({ f, calls: 0 });
    }
  });

  test("🔴 the ORDINARY-leave paths do not call the helper: door 1's call is gated on `declaredFree`, door 2's on `declaredFree` (never on `becomesAbsence`)", () => {
    const C = code(SCHED);
    expect(C).toContain('if (declaredFree && current.courseId) await addLeaveWeek(tx, current.courseId, "T1_PRE_START_DECLARATION");');
    expect(C).toContain('if (declaredFree) await addLeaveWeek(tx, courseId, "T1_PRE_START_DECLARATION");');
    expect(C).not.toMatch(/if \(becomesAbsence\) await addLeaveWeek/);
  });

  test("🔴 door 4 reads the REASON CODE — and only `SCHOOL_ISSUE` earns (never the free-text note)", () => {
    const C = code(SCHED);
    const at = C.indexOf('await addLeaveWeek(tx, current.courseId, "T3_SCHOOL_ISSUE")');
    const gate = C.slice(C.lastIndexOf("if (current.courseId && reasonCode", at), at);
    expect(gate).toContain("reasonCode === SCHOOL_ISSUE");
    expect(gate).not.toMatch(/cancelReason\b|\bnote\b|reason\?/); // the free-text note is never read
  });

  test("🔴 `cancelSeatsOfGroup` takes its trigger from its CALLER — the three callers, each by name", () => {
    const callers = [
      ...[...code(SCHED).matchAll(/await cancelSeatsOfGroup\(tx, [^\n]*/g)].map((m) => `scheduler.service.ts · ${m[0]}`),
      ...[...code(SRC("other-series.service.ts")).matchAll(/await cancelSeatsOfGroup\(tx, [^\n]*/g)].map((m) => `other-series.service.ts · ${m[0]}`),
    ].sort();
    expect(callers).toHaveLength(3);
    expect(callers[0]).toContain('other-series.service.ts · await cancelSeatsOfGroup(tx, r.id, input.note?.trim() || null, input.reasonCode === SCHOOL_ISSUE ? { weekTrigger: "T3_SCHOOL_ISSUE" } : {})');
    expect(callers[1]).toContain('scheduler.service.ts · await cancelSeatsOfGroup(tx, b.id, input.reason, { weekTrigger: "T2_COACH_LEAVE" })');
    expect(callers[2]).toContain('scheduler.service.ts · await cancelSeatsOfGroup(tx, current.id, cancelReason ?? null, enumReason === SCHOOL_ISSUE ? { weekTrigger: "T3_SCHOOL_ISSUE" } : {})');
  });

  test("🔑 the customer's own words are IN the code beside the list (quoted, not paraphrased)", () => {
    const PLAN = SRC("../lib/course-plan.ts");
    expect(PLAN).toContain("ถ้าลาปกติไม่เพิ่มให้นะคะ");
    expect(PLAN).toContain("ปัญหาจากทางเรา");
  });

  test("🔴 the writers of `coursePackages.expiryDate` are an EXACT LIST, BY FUNCTION NAME — a new place fails with a name, not a count", () => {
    // 🔑 Derived from the source, not typed: for every `update/insert(coursePackages)` statement that names `expiryDate`, the
    // function it sits in. ⚠️ SIX now (it was SEVEN until TASK-657 §R deleted the Undo's expiry restore — `undoBooking` left this list; the Undo's file is still READ here, so a restore that comes back fails with a name):
    //   · `importCoursePackage` is a SECOND birth path (an imported mid-way course has its expiry set at birth, FIX-007);
    //   · the task's "plan apply" is really `resumeCourse` — `applyPlanChange` never writes the expiry (it calls the helper).
    // Both birth paths and the resume only SET an expiry from the course's own facts; none ADDS a week to an existing one — which
    // is what keeps ruling 1 (forward-only) true.
    const enclosing = (s: string, at: number) => {
      const head = s.slice(0, at).split("\n");
      for (let i = head.length - 1; i >= 0; i--) {
        const m = head[i]!.match(/^(?:export )?async function (\w+)\(/);
        if (m) return m[1]!;
      }
      return "?";
    };
    const writers = (file: string, raw: string) => {
      const c = code(raw);
      const out: string[] = [];
      for (const m of c.matchAll(/\.(update|insert)\(coursePackages\)/g)) {
        const stmt = c.slice(m.index!, m.index! + 900).split(/\.where\(|\.returning\(|;\n/)[0]!;
        if (/expiryDate/.test(stmt)) out.push(`${file} · ${enclosing(c, m.index!)} · ${m[1]}`);
      }
      return out;
    };
    const all = [...writers("scheduler.service.ts", SCHED), ...writers("undo.service.ts", SRC("undo.service.ts"))].sort();
    expect(all).toEqual([
      "scheduler.service.ts · addLeaveWeek · update", // the ONE leave writer
      "scheduler.service.ts · changeCourseStart · update", // the admin's start-date move
      "scheduler.service.ts · createCoursePackage · insert", // at birth
      "scheduler.service.ts · importCoursePackage · insert", // at birth — the SECOND birth path
      "scheduler.service.ts · resumeCourse · update", // a re-plan on resume
      "scheduler.service.ts · updateCourseExpiry · update", // the admin's own edit
    ]);
  });

  test("🔴 the helper is the ONLY call to `recordExpiryChange` with a LITERAL `actor: null` — so 'actor NULL, +7' in the history IS 'a leave added a week'", () => {
    const calls = [...code(SCHED).matchAll(/await recordExpiryChange\(tx, \{[^}]*\}\)/g)].map((m) => m[0]);
    const literalNull = calls.filter((c) => /actor: null\b/.test(c));
    expect(literalNull).toHaveLength(1);
    expect(literalNull[0]).toContain("courseId, from, to, actor: null"); // …and it is the helper's own
    expect(code(SRC("undo.service.ts"))).not.toMatch(/actor: null/); // the Undo carries the caller's actor, never none
  });

  test("⚠️ ONE honest limit on that pin, stated rather than hidden: `changeCourseStart` writes `actor ?? null`", () => {
    // 📌 `actorOf` returns null when there is no authenticated user (dev / SKIP_AUTH only — a production token always has a
    // username). So in production the claim holds BY THE AUTH LAYER, not by construction in this code: a start-date change
    // with no user could write actor NULL, and a one-week move would then look like a leave. Pinned as what it IS.
    expect(code(SCHED)).toContain("actor: actor ?? null });");
    expect(code(SRC("../lib/leave.ts"))).not.toContain("addLeaveWeek"); // the helper lives in ONE place
  });

  test("the helper's arithmetic is ONE statement, and the week is the SAME 7 days `courseBornCeiling` states — one rule, one spelling here", () => {
    const FN = code(SCHED).slice(code(SCHED).indexOf("export async function addLeaveWeek("));
    expect(FN.slice(0, 900)).toContain("interval '7 days'");
    expect(FN.slice(0, 900)).not.toMatch(/findFirst|read-then-write/); // no read before the write — that is the race
  });

  test("🚫 every door's comment says the TRUE number — 'DOOR n of 5' — and none says 6 (a wrong count in a comment is the same fault as in a pin)", () => {
    const doors = [...SCHED.matchAll(/TASK-656 — DOOR (\d) of (\d)/g)].map((m) => [m[1], m[2]]);
    expect(doors.length).toBe(5);
    for (const [, of] of doors) expect(of).toBe("5");
  });
});

function existsSyncSafe(p: string): boolean {
  try { readFileSync(p); return true; } catch { return false; }
}
