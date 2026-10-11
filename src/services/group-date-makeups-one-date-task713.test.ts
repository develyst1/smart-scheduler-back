// TASK-713 (REQ-115 FINAL ROUND 4) — a cancelled GROUP date's make-ups all go on ONE extra group date: the series runs a week longer, every seat that re-owes is re-seated on it.
// Before: each seat's course appended a STANDALONE class in the coach's weekly slot; a standalone class HOLDS the slot, so the next child's went a week later ⇒ 3 kids = 3 weeks.
// 🔑 Driven through the REAL `updateBookingStatus` (the admin's cancel of a GROUP row) + the REAL re-plan, over the 702 world (search stand-in: first free week; a SEAT holds no slot).
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
    try { where(cols, { and: (...a: any[]) => a, eq: (c: any, v: any) => { hits.push([String(c), v]); return v; }, ne: () => null, notInArray: () => null, inArray: () => null, or: () => null, isNull: () => null, gte: () => null, lte: () => null, lt: () => null, gt: () => null }); } catch {}
    return (k: string) => hits.find((h) => h[0] === k)?.[1];
  };
  const tx: any = {
    query: {
      bookings: {
        findFirst: async ({ where }: any) => { const g = probe(where); const id = g("id"); if (g("groupKey")) return withRels([...w.bookings].filter((b: any) => b.groupKey === g("groupKey") && b.bookingType === "GROUP" && b.status !== "CANCELLED").sort((a: any, b: any) => (a.date < b.date ? -1 : 1))[0]) ?? null; return withRels(w.bookings.find((b: any) => b.id === id)) ?? null; },
        findMany: async ({ where, orderBy, limit }: any) => {
          const g = probe(where);
          let out = g("groupKey") ? w.bookings.filter((b: any) => b.groupKey === g("groupKey") && b.bookingType === "GROUP" && b.status !== "CANCELLED")
            : g("groupId") ? w.bookings.filter((b: any) => b.groupId === g("groupId") && ["PENDING", "CONFIRMED", "EXTENDED"].includes(b.status))
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

describe("🔴 THE REPRODUCTION — 3 seats, ONE date cancelled", () => {
  test("ONE new group row one week after the series' last date; the 3 seats on it, CONFIRMED + marked; ZERO standalone make-ups", async () => {
    const w = groupWorld(); wire();
    await cancelG1();
    const g = newGroupRows(w);
    expect(g.map((r: any) => r.date)).toEqual([plus(today, 21)]); // G3 is the last date (+14) ⇒ +21
    expect(g[0]).toMatchObject({ bookingType: "GROUP", groupKey: "gk1", teacherId: T1, startTime: "10:00", otherTitle: "Skate group", headCount: 6 });
    const m = seatMakeups(w);
    expect(m).toHaveLength(3);
    for (const s of m) expect(s).toMatchObject({ groupId: g[0].id, date: plus(today, 21), status: "CONFIRMED", isMakeup: true, bookingType: "COURSE_PACKAGE" });
    expect(standalone(w)).toEqual([]);
    expect(m.map((s: any) => s.studentId).sort()).toEqual(["sA", "sB", "sC"]);
  });
});

describe("🔑 who is told, how often", () => {
  test("each household ONCE (its seat's confirm), the COACH once for the group date — not once per seat", async () => {
    const w = groupWorld(); wire();
    await cancelG1();
    const g = newGroupRows(w)[0];
    const seatConfirms = seatMakeups(w).flatMap((s: any) => confirms(s.id));
    expect(seatConfirms.map((o: any) => o.recipientType)).toEqual(["parent", "parent", "parent"]); // no teacher row from any seat
    expect(confirms(g.id).map((o) => o.recipientType)).toEqual(["teacher"]); // the coach: ONE confirm, for the group date
  });
});

describe("🔑 which seats are re-seated", () => {
  test("a seat whose course does NOT re-owe gets no seat on the extra date", async () => {
    const w = groupWorld({ owes: { cB: false } }); wire();
    await cancelG1();
    expect(seatMakeups(w).map((s: any) => s.studentId).sort()).toEqual(["sA", "sC"]);
  });
  test("no seat re-owes ⇒ NO extra group date is created at all", async () => {
    const w = groupWorld({ owes: { cA: false, cB: false, cC: false } }); wire();
    await cancelG1();
    expect(newGroupRows(w)).toEqual([]);
  });
});

describe("🔑 dates", () => {
  test("TWO group dates cancelled ⇒ TWO extra dates on consecutive free weeks", async () => {
    const w = groupWorld({ seats: [["cA", "sA"]] }); wire();
    // a second cancelled date: G2 gets its own seat from a second course
    const c2 = baseCourse("cD", plus(today, -14)); w.courses.push({ ...c2, usedSessions: 0, leaveUsed: 0, leaveQuota: null, status: "ACTIVE", adminUnlocked: false, priorSessions: 0, classRateMinor: null, endedAt: null, droppedAt: null, expiryDate: plus(c2.expiryDate, 120) });
    for (let i = 0; i < 3; i++) w.bookings.push(row(`cD-b${i + 1}`, "cD", plus(today, -14 + i * 7), "ATTENDED", { studentId: "sD" }));
    w.bookings.push(row("cD-seat", "cD", plus(today, 7), "CONFIRMED", { studentId: "sD", groupId: "G2", isMakeup: false }));
    await cancelG1();
    await sched.updateBookingStatus("G2", "cancel", "x", false, "ADMIN_ERROR", STAFF);
    expect(newGroupRows(w).map((r: any) => r.date).sort()).toEqual([plus(today, 21), plus(today, 28)]);
    expect(standalone(w)).toEqual([]);
  });
  test("«ครูลา» on the group date: the coach is off TODAY (the cancelled date) — the extra date is still the first free week after the series' last date, never today", async () => {
    const w = groupWorld(); wire();
    await cancelG1("TEACHER_LEAVE");
    expect(newGroupRows(w).map((r: any) => r.date)).toEqual([plus(today, 21)]);
    expect(standalone(w)).toEqual([]);
  });
  test("a coach day-off on the first candidate week is skipped (coachOff reaches the extra-date search)", async () => {
    const w = groupWorld(); wire();
    await sched.cancelSeatsOfGroup(w.tx, "G1", "x", { reseat: true, coachOff: [{ teacherId: T1, date: plus(today, 21) }] });
    expect(newGroupRows(w).map((r: any) => r.date)).toEqual([plus(today, 28)]);
  });
});

describe("⚖️ UNCHANGED — the series CANCEL-ALL keeps the standalone make-ups", () => {
  test("cancelSeatsOfGroup WITHOUT reseat (what the series cancel-all passes) ⇒ standalone make-ups, no extra group date", async () => {
    const w = groupWorld(); wire();
    await sched.cancelSeatsOfGroup(w.tx, "G1", "x", {});
    expect(newGroupRows(w)).toEqual([]);
    expect(standalone(w)).toHaveLength(3);
    expect(standalone(w).map((b: any) => b.date).sort()).toEqual([plus(today, 21), plus(today, 28), plus(today, 35)]); // …on three DIFFERENT weeks — the defect, kept as the cancel-all's unchanged behaviour
  });
});

describe("🔑 a seat make-up behaves like any make-up", () => {
  test("the TRIM reads the marker: an over-long plan cancels a seat make-up (newest-dated live marked) and tells the family", async () => {
    const w = groupWorld(); wire();
    await cancelG1();
    const s = seatMakeups(w).find((m: any) => m.courseId === "cA")!;
    // the course gets a 5th live class ⇒ the plan is one over ⇒ the newest-dated marked make-up goes
    w.bookings.push(row("cA-extra", "cA", plus(today, 28), "CONFIRMED", { studentId: "sA" }));
    const out = await sched.reconcileCoursePlan(w.tx, "cA");
    expect(out.cancelled).toEqual([s.id]);
    expect(w.bookings.find((b: any) => b.id === s.id)).toMatchObject({ status: "CANCELLED" });
  });
});

describe("🔑 by source", () => {
  const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8");
  test("only the group-date doors reseat: the admin's GROUP cancel and the coach's leave; the series cancel-all passes nothing", () => {
    expect(S).toContain("reseat: true");
    expect([...S.matchAll(/reseat: true/g)]).toHaveLength(2);
    expect(readFileSync(resolve(import.meta.dir, "other-series.service.ts"), "utf8")).not.toContain("reseat");
  });
});
