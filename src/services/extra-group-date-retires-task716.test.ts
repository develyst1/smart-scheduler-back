// TASK-716 — TASK-713's extra group date is CANCELLED (and its coach told, with the EXISTING notice) when its LAST seat leaves, by every path; it carries the series' CLOSED stamp; an ORDINARY group
// date emptied is left alone. The extra row is MARKED (`is_makeup` on the GROUP row — no migration); every reader of the marker is named and pinned below.
// 🔑 Same harness as 713's proof: the REAL entry points over the 702 world (search stand-in: first free week; a SEAT holds no slot).
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
import { formatOutboxMessage } from "../lib/line-message";
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
  slotYieldedAt: null, cancelReason: null, isMakeup: status === "EXTENDED" || !!over.extendedFromId, ...over, // 🔻 TASK-702 — a fixture make-up is MARKED, as the backfill would have marked it
});
const courseRows = (courseId: string, start: string, delivered = 0) =>
  Array.from({ length: SIZE }, (_, i) => row(`${courseId}-b${i + 1}`, courseId, plus(start, i * 7), i < delivered ? "ATTENDED" : "PENDING"));

/** The world: bookings + courses in memory, every write recorded. `expiryChanges` is what the audit table would hold. */
function world(courses: Course[], rows: any[]) {
  const w: any = {
    outbox: [] as any[], // 🔻 TASK-702 — what `enqueueLine` was asked to send; ROLLED BACK with the transaction, like the real outbox table
    courses: courses.map((c) => ({ ...c, usedSessions: 0, leaveUsed: 0, leaveQuota: null, status: "ACTIVE", adminUnlocked: false, priorSessions: 0, classRateMinor: null, endedAt: null, droppedAt: null })),
    bookings: rows, expiryChanges: [] as any[], inserts: [] as any[],
  };
  const course = (id: string) => w.courses.find((c: any) => c.id === id) ?? null;
  const withRels = (r: any) => r && ({ ...r, course: course(r.courseId), voucher: null, additionalTeachers: [], seats: [], teacher: { id: T1, name: "Bank", nickname: "Bank", lineUserId: null } });
  const probe = (where: any) => {
    const hits: Array<[string, any]> = [];
    const cols = { id: "id", courseId: "courseId", groupId: "groupId", date: "date", status: "status", teacherId: "teacherId", startTime: "startTime", extendedFromId: "extendedFromId", bookingType: "bookingType", groupKey: "groupKey" };
    try { where(cols, { and: (...a: any[]) => a, eq: (c: any, v: any) => { hits.push([String(c), v]); return v; }, ne: () => null, notInArray: () => null, inArray: () => { hits.push(["__in", true]); return null; }, or: () => null, isNull: () => null, gte: () => null, lte: () => null, lt: () => null, gt: () => null }); } catch {}
    return (k: string) => hits.find((h) => h[0] === k)?.[1];
  };
  const tx: any = {
    query: {
      bookings: {
        findFirst: async ({ where }: any) => { const g = probe(where); const id = g("id"); if (g("groupKey")) return withRels([...w.bookings].filter((b: any) => b.groupKey === g("groupKey") && b.bookingType === "GROUP" && b.status !== "CANCELLED").sort((a: any, b: any) => (a.date < b.date ? -1 : 1))[0]) ?? null; return withRels(w.bookings.find((b: any) => b.id === id)) ?? null; },
        findMany: async ({ where, orderBy, limit }: any) => {
          const g = probe(where);
          let out = g("groupKey") ? w.bookings.filter((b: any) => b.groupKey === g("groupKey") && b.bookingType === "GROUP" && b.status !== "CANCELLED")
            : g("groupId") ? w.bookings.filter((b: any) => b.groupId === g("groupId") && (!g("__in") || ["PENDING", "CONFIRMED", "EXTENDED"].includes(b.status)))
            : g("courseId") ? w.bookings.filter((b: any) => b.courseId === g("courseId") && b.status !== "CANCELLED")
            : w.bookings.filter((b: any) => b.status !== "CANCELLED");
          if (orderBy) out = [...out].sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
          return (limit ? out.slice(0, limit) : out).map(withRels);
        },
      },
      coursePackages: { findFirst: async ({ where }: any) => { const g = probe(where); return course(g("id")) ?? w.courses[0] ?? null; } },
      teacherLeaveDays: { findFirst: async () => undefined },
      teachers: { findFirst: async () => ({ id: T1, nickname: "Bank", name: "Bank", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: null }), findMany: async () => [{ id: T1, nickname: "Bank", lineUserId: "U-coach" }] /* 🔻 TASK-702: the confirm tells the booking's coach */ },
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
      if (table === "bookings") { const r = { ...row(`x${w.bookings.length + 1}`, v.courseId ?? "c1", v.date, v.status ?? "EXTENDED", { isMakeup: false /* 🔻 TASK-702: the marker comes ONLY from the writer under test */ }), ...v, id: `x${w.bookings.length + 1}` }; w.bookings.push(r); w.inserts.push({ table, v: r }); return Object.assign(Promise.resolve(), { returning: async () => [{ id: r.id }] }); }
      if (table === "course_expiry_changes") w.expiryChanges.push(v);
      w.inserts.push({ table, v });
      return Object.assign(Promise.resolve(), { returning: async () => [{ id: "x" }], onConflictDoNothing: async () => {} });
    } }),
    delete: () => ({ where: async () => {} }),
    // the coach-notice read chains `.limit()` / `.innerJoin()`; it answers nobody here on purpose
    select: () => { const q: any = { from: () => q, where: () => q, limit: async () => [], innerJoin: async () => [], then: (res: any) => res([]) /* 🔻 TASK-702: an awaited chain reads as no rows (the confirm reads its coaches) */ }; return q; },
  };
  // 🔻 TASK-692 — a REAL transaction rolls back when its callback throws (the refusal relies on it). The in-memory world did not, so "nothing written" could not be
  // proven: snapshot before, restore on a throw.
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => {
    const snap = { outbox: [...w.outbox], bookings: structuredClone(w.bookings), courses: structuredClone(w.courses), expiryChanges: structuredClone(w.expiryChanges), inserts: structuredClone(w.inserts) };
    try { return await fn(tx); } catch (e) { w.outbox = snap.outbox; w.bookings = snap.bookings; w.courses = snap.courses; w.expiryChanges = snap.expiryChanges; w.inserts = snap.inserts; throw e; }
  }) as any));
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => withRels(w.bookings[0])) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => w.bookings.filter((b: any) => b.status !== "CANCELLED").map(withRels)) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async (_e: any, id: string) => ({ id })) as any));
  spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_tx: any, teacherId: string, startTime: string, after: string, taken: ReadonlySet<string> = new Set()) => {
    let d = plus(after, 7);
    for (let i = 0; i < 20; i++, d = plus(d, 7)) {
      if (taken.has(d)) continue;
      if (w.bookings.some((b: any) => b.teacherId === teacherId && b.date === d && b.startTime === startTime && b.status !== "CANCELLED" && !b.groupId)) continue;
      return d;
    }
    return d;
  }) as any));
  spies.push(spyOn(rental, "inheritCourseRental").mockImplementation((async () => {}) as any));
  (globalThis as any).__w = w;
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (row: any) => { w.outbox.push(row); return { status: "queued" } as any; }) as any) as any);
  w.tx = tx; // for the doors whose entry point TAKES a transaction (a group date's seats)
  return w;
}

import * as familyLink from "../lib/family-link";
const STAFF = { channel: "staff" as const, actor: "admin-dong" };
const OTHER = "o2o2o2o2-o2o2-42o2-82o2-o2o2o2o2o2o2";
const today = bangkokNow().date;
const outbox = () => ((globalThis as any).__w.outbox as any[]);
const SEATS = [["cA", "sA"], ["cB", "sB"], ["cC", "sC"]] as const;
/** A group series (key gk1): rows today (G1, the one cancelled), +7, +14 (the series' current LAST date). 3 seats on G1, each its own started 4-session course that owes ONE session once its seat goes. */
function groupWorld(opts: { seats?: ReadonlyArray<readonly [string, string]>; owes?: Record<string, boolean>; extraDates?: number } = {}) {
  const seats = opts.seats ?? SEATS;
  const mkGroup = (id: string, date: string) => row(id, "", date, "CONFIRMED", { courseId: null, studentId: null, bookingType: "GROUP", groupKey: "gk1", otherTitle: "Skate group", otherKind: "GROUP", headCount: 6, isMakeup: false });
  const rows: any[] = [mkGroup("G1", today), mkGroup("G2", plus(today, 7)), mkGroup("G3", plus(today, 14))];
  const courses: Course[] = [];
  for (const [cid, sid] of seats) {
    const c = baseCourse(cid, plus(today, -21)); courses.push(c);
    const delivered = opts.owes?.[cid] === false ? 4 : 3; // a course whose 4 sessions are all delivered/live elsewhere re-owes nothing
    for (let i = 0; i < delivered; i++) rows.push(row(`${cid}-b${i + 1}`, cid, plus(today, -21 + i * 7), "ATTENDED", { studentId: sid }));
    rows.push(row(`${cid}-seat`, cid, today, "CONFIRMED", { studentId: sid, groupId: "G1", isMakeup: false }));
    if (opts.owes?.[cid] === false) rows.pop(); // (4 delivered ⇒ the seat would be a 5th session: not part of this course's plan)
  }
  const w = world(courses, rows);
  for (const c of w.courses) c.expiryDate = plus(c.expiryDate, 120);
  return w;
}
const seatMakeups = (w: any) => w.bookings.filter((b: any) => b.isMakeup === true && b.bookingType === "COURSE_PACKAGE" && b.status !== "CANCELLED");
const standalone = (w: any) => seatMakeups(w).filter((b: any) => !b.groupId);
const newGroupRows = (w: any) => w.bookings.filter((b: any) => b.bookingType === "GROUP" && !["G1", "G2", "G3"].includes(b.id));
const confirms = (id: string) => outbox().filter((o) => o.bookingId === id && o.payload?.kind === "booking_confirmed");
const wire = () => {
  spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1, lineUserId: "U-coach" }]) as any));
  spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async (_e: any, ids: Array<string | null>) => ids.filter(Boolean).map((i) => `U-${i}`)) as any));
};
const cancelG1 = (reason = "ADMIN_ERROR") => sched.updateBookingStatus("G1", "cancel", "x", false, reason, STAFF);

import { toBookingDTO } from "../db/mappers";

/** 713's scenario, run: cancel G1 (3 seats) ⇒ ONE extra date E with 3 seat make-ups. Returns the world and E. */
async function withExtraDate(opts: Parameters<typeof groupWorld>[0] = {}) {
  const w = groupWorld(opts); wire();
  await cancelG1();
  const E = newGroupRows(w)[0];
  return { w, E };
}
const seatsOn = (w: any, E: any) => w.bookings.filter((b: any) => b.groupId === E.id && b.status !== "CANCELLED");
const row_ = (w: any, id: string) => w.bookings.find((b: any) => b.id === id);
const coachCancels = (id: string) => outbox().filter((o) => o.bookingId === id && o.payload?.kind === "class_cancelled_teacher");
const familyAbout = (id: string) => outbox().filter((o) => o.bookingId === id && o.recipientType === "parent");
/** cancel one seat make-up THROUGH the admin's cancel (the real status change). It re-owes, so the course appends a standalone make-up — the seat itself is gone. */
const cancelSeat = (id: string) => sched.updateBookingStatus(id, "cancel", "x", false, undefined, STAFF);

describe("🔴 THE REPRODUCTION — the extra date outlives its last seat", () => {
  test("3 seats on the extra date, ALL cancelled ⇒ the extra GROUP row is CANCELLED, the coach is told ONCE, no family is told about the GROUP row", async () => {
    const { w, E } = await withExtraDate();
    const holds: Array<[string, string]> = [];
    spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (_t: any, id: string, _tid: string, st: string) => { holds.push([id, st]); }) as any));
    expect(E).toMatchObject({ status: "CONFIRMED", isMakeup: true });
    const seats = seatsOn(w, E);
    expect(seats).toHaveLength(3);
    await cancelSeat(seats[0].id);
    await cancelSeat(seats[1].id);
    expect(row_(w, E.id).status).toBe("CONFIRMED"); // 2 of 3 gone ⇒ the date stays
    expect(coachCancels(E.id)).toEqual([]);
    await cancelSeat(seats[2].id);
    expect(row_(w, E.id).status).toBe("CANCELLED"); // …the LAST one went
    expect(holds.filter(([id]) => id === E.id)).toEqual([[E.id, "CANCELLED"]]); // the freelance hour is released
    expect(coachCancels(E.id).map((o) => o.payload.kind)).toEqual(["class_cancelled_teacher"]); // the existing notice, once
    expect(coachCancels(E.id)[0].payload).toMatchObject({ cancelReason: null, note: null }); // today's words only — no reason line
    expect(familyAbout(E.id).filter((o) => /cancelled/.test(o.payload.kind))).toEqual([]); // nobody told about the GROUP row
  });
});

describe("🔑 every path that takes a seat out", () => {
  test("the TRIM: an over-long plan trims each seat make-up ⇒ after the last, the date retires", async () => {
    const { w, E } = await withExtraDate();
    for (const c of ["cA", "cB", "cC"]) w.bookings.push(row(`${c}-extra`, c, plus(today, 28), "CONFIRMED", { studentId: `s${c.slice(1)}` }));
    await sched.reconcileCoursePlan(w.tx, "cA");
    await sched.reconcileCoursePlan(w.tx, "cB");
    expect(row_(w, E.id).status).toBe("CONFIRMED");
    await sched.reconcileCoursePlan(w.tx, "cC");
    expect(seatsOn(w, E)).toEqual([]);
    expect(row_(w, E.id).status).toBe("CANCELLED");
    expect(coachCancels(E.id)).toHaveLength(1);
  });
  test("the plan editor's MARK ABSENCE on the last seat", async () => {
    const { w, E } = await withExtraDate({ seats: [["cA", "sA"]] });
    const seat = seatsOn(w, E)[0];
    await sched.applyPlanChange("cA", { kind: "mark-absence", bookingId: seat.id, planned: true, reason: "ป่วย", override: true });
    expect(row_(w, seat.id).status).toBe("SICK_LEAVE");
    expect(row_(w, E.id).status).toBe("CANCELLED");
  });
  test("a seat's own LEAVE (sick-leave through updateBookingStatus) on the last seat", async () => {
    const { w, E } = await withExtraDate({ seats: [["cA", "sA"]] });
    const seat = seatsOn(w, E)[0];
    await sched.updateBookingStatus(seat.id, "sick-leave", "ป่วย", true);
    expect(row_(w, seat.id).status).toBe("SICK_LEAVE");
    expect(row_(w, E.id).status).toBe("CANCELLED");
  });
  test("a TAUGHT seat keeps the date: an ATTENDED seat is not 'gone' (the class happened)", async () => {
    const { w, E } = await withExtraDate({ seats: [["cA", "sA"], ["cB", "sB"]] });
    const [a, b] = seatsOn(w, E);
    row_(w, a.id).status = "ATTENDED";
    await cancelSeat(b.id);
    expect(row_(w, E.id).status).toBe("CONFIRMED");
  });
});

describe("🚫 what must NOT retire", () => {
  test("an ORDINARY group date emptied stays as it is (unmarked)", async () => {
    const w = groupWorld({ seats: [["cA", "sA"]] }); wire();
    await cancelSeat("cA-seat"); // G1's only seat leaves — G1 is an ordinary, unmarked group row
    expect(row_(w, "G1")).toMatchObject({ status: "CONFIRMED", isMakeup: false });
  });
  test("the helper is idempotent and refuses anything that is not a live MARKED group row", async () => {
    const { w, E } = await withExtraDate({ seats: [["cA", "sA"]] });
    expect(await sched.retireEmptyExtraGroupDate(w.tx, null)).toBe(false);
    expect(await sched.retireEmptyExtraGroupDate(w.tx, "G2")).toBe(false); // unmarked
    expect(await sched.retireEmptyExtraGroupDate(w.tx, E.id)).toBe(false); // still has a seat
    await cancelSeat(seatsOn(w, E)[0].id);
    expect(row_(w, E.id).status).toBe("CANCELLED");
    const n = coachCancels(E.id).length;
    expect(await sched.retireEmptyExtraGroupDate(w.tx, E.id)).toBe(false); // already retired
    expect(coachCancels(E.id)).toHaveLength(n);
  });
});

describe("🔑 a CLOSED series: the extra row carries the stamp", () => {
  test("the series is closed (group_closed_at on its rows) ⇒ the extra row gets the SAME timestamp; an open series ⇒ none", async () => {
    const stamp = new Date("2026-10-01T00:00:00Z");
    const closed = groupWorld({ seats: [["cA", "sA"]] });
    for (const b of closed.bookings) if (b.bookingType === "GROUP") b.groupClosedAt = stamp;
    wire();
    await cancelG1();
    expect(newGroupRows(closed)[0].groupClosedAt).toEqual(stamp);
    for (const s of spies.splice(0)) s.mockRestore();
    const open = groupWorld({ seats: [["cA", "sA"]] }); wire();
    await cancelG1();
    expect(newGroupRows(open)[0].groupClosedAt ?? null).toBeNull();
  });
});

describe("🔑 the marker on a GROUP row breaks no reader", () => {
  test("the extra row is MARKED and the DTO says so (the front's badge reads it); the seats are marked as before", async () => {
    const { w, E } = await withExtraDate({ seats: [["cA", "sA"]] });
    expect(toBookingDTO({ ...E, student: null, teacher: { id: T1, name: "Bank", nickname: "Bank" } } as any).isMakeup).toBe(true);
    expect(seatsOn(w, E).every((s: any) => s.isMakeup === true)).toBe(true);
  });
  test("the plan engine never sees a GROUP row: a marked extra date is not trimmed, counted or inserted into any course (the re-plan loads COURSE_PACKAGE rows by courseId)", async () => {
    const { w, E } = await withExtraDate({ seats: [["cA", "sA"]] });
    const out = await sched.reconcileCoursePlan(w.tx, "cA");
    expect(out.cancelled).toEqual([]);
    expect(row_(w, E.id).status).toBe("CONFIRMED");
  });
  test("the admin cancelling the EXTRA GROUP ROW itself: the seats' families get the make-up wording (no 'a class was added'), the coach is told, nothing is re-booked", async () => {
    const { w, E } = await withExtraDate({ seats: [["cA", "sA"]] });
    await sched.updateBookingStatus(E.id, "cancel", "x", false, "ADMIN_ERROR", STAFF);
    expect(row_(w, E.id).status).toBe("CANCELLED");
    expect(familyAbout(E.id).map((o) => o.payload.kind)).toEqual(["makeup_cancelled_parent"]);
  });
  test("by source: the history is course-scoped and the trim reads PlanSessions of COURSE_PACKAGE rows — neither can reach a GROUP row", () => {
    const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8");
    expect(S).toContain('and(eq(b.courseId, courseId), eq(b.bookingType, "COURSE_PACKAGE"))'); // the re-plan's read
  });
});

describe("🔑 by source — every seat-leaving path calls the ONE helper", () => {
  const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8");
  const U = readFileSync(resolve(import.meta.dir, "undo.service.ts"), "utf8");
  test("the trim · the admin cancel / sick-leave · Mark absence · course END · course PAUSE · the Undo", () => {
    expect(S).toContain("if (trimmed?.groupId) await retireEmptyExtraGroupDate(tx, trimmed.groupId);");
    expect(S).toContain('if ((current as any).groupId && (action === "cancel" || action === "sick-leave")) await retireEmptyExtraGroupDate(tx, (current as any).groupId);');
    expect(S).toContain("if (b.groupId) await retireEmptyExtraGroupDate(tx, b.groupId); // 🔻 TASK-716 — the absent seat");
    expect(S).toContain("if ((b as any).groupId) await retireEmptyExtraGroupDate(tx, (b as any).groupId);");
    expect(S).toContain("if (b.groupId) await retireEmptyExtraGroupDate(tx, b.groupId); // 🔻 TASK-716 — a paused course");
    expect(U).toContain("if ((makeup as any)?.groupId) await retireEmptyExtraGroupDate(tx, (makeup as any).groupId);");
  });
});
