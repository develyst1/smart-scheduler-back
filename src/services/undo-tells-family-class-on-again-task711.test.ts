// TASK-711 (REQ-115 FINAL ROUND item 2) — after an Undo of a LEAVE the FAMILY is told the class is ON AGAIN (the owner reversed TASK-508's «never the family»). The words are the owner's, verbatim (COPY-REVIEW-2026-09-29.md:592):
// TH «✅ มีคาบเรียนตามเดิม:» + the family's field block (NO Coach line) + «Note : ยกเลิกการลาแล้ว เรียนคาบนี้ตามปกติค่ะ» · EN «✅ CLASS ON AGAIN:» + the block + «Note : Leave cancelled. This class goes ahead as scheduled.»
// 🔑 The REAL entry points (`updateBookingStatus` → `undoBooking`) over the 713 world; the renderer by string equality.
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
    try { where(cols, { and: (...a: any[]) => a, eq: (c: any, v: any) => { hits.push([String(c), v]); return v; }, ne: () => null, notInArray: () => { hits.push(["__notin", true]); return null; }, inArray: () => { hits.push(["__in", true]); return null; }, or: () => null, isNull: () => null, gte: () => null, lte: () => null, lt: () => null, gt: () => null }); } catch {}
    return (k: string) => hits.find((h) => h[0] === k)?.[1];
  };
  const tx: any = {
    query: {
      bookings: {
        findFirst: async ({ where }: any) => { const g = probe(where); const id = g("id"); if (g("__notin") && g("teacherId") && g("date") && g("startTime")) return withRels(w.bookings.find((b: any) => b.teacherId === g("teacherId") && b.date === g("date") && String(b.startTime).slice(0, 5) === String(g("startTime")).slice(0, 5) && !b.groupId && !["CANCELLED", "SICK_LEAVE", "NO_SHOW", "PAUSED"].includes(b.status))) ?? null; if (g("groupKey")) return withRels([...w.bookings].filter((b: any) => b.groupKey === g("groupKey") && b.bookingType === "GROUP" && b.status !== "CANCELLED").sort((a: any, b: any) => (a.date < b.date ? -1 : 1))[0]) ?? null; return withRels(w.bookings.find((b: any) => b.id === id)) ?? null; },
        findMany: async ({ where, orderBy, limit }: any) => {
          const g = probe(where);
          let out = g("extendedFromId") ? w.bookings.filter((b: any) => b.extendedFromId === g("extendedFromId"))
            : g("groupKey") ? w.bookings.filter((b: any) => b.groupKey === g("groupKey") && b.bookingType === "GROUP" && b.status !== "CANCELLED")
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


import * as teacherLeaveLib from "../lib/teacher-leave";
import { ApiException } from "../lib/http";

import { undoBooking, previewUndo } from "./undo.service";
const extraDate = async (opts: Parameters<typeof groupWorld>[0] = { seats: [["cA", "sA"]] }) => {
  const w = groupWorld(opts); wire();
  await cancelG1();
  return { w, E: newGroupRows(w)[0] };
};
const seatOn = (w: any, E: any) => w.bookings.find((b: any) => b.groupId === E.id && b.isMakeup === true);
const coachOnAgain = (id: string) => outbox().filter((o) => o.bookingId === id && o.payload?.kind === "class_on_again_teacher");
/** TEST-093's three calls: the 1-seat series' cancelled date made an extra date E; a leave on that seat retires E. Returns the world, E and the seat. */
async function retired() {
  const { w, E } = await extraDate();
  const seat = seatOn(w, E);
  await sched.updateBookingStatus(seat.id, "sick-leave", "ป่วย", true);
  expect(row_(w, E.id).status).toBe("CANCELLED"); // 716: retired
  return { w, E, seat };
}
const holds = (w: any) => { const h: Array<[string, string]> = []; spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (_t: any, id: string, _tid: string, st: string) => { h.push([id, st]); }) as any)); void w; return h; };
const undo = (id: string) => undoBooking(id, { actor: "admin-dong", reason: "wrong child" });



const onAgainRows = (id: string, from = 0) => outbox().slice(from).filter((o) => o.bookingId === id && o.payload?.kind === "class_on_again_parent");
const rowOf = (w: any, id: string) => w.bookings.find((b: any) => b.id === id);
/** A plain 4-session COURSE (no group): 3 taught, the 4th (cZ-b4) ahead. `duo` adds the second child. */
function plainWorld(duo = false) {
  const w = groupWorld({ seats: [["cA", "sA"]] }); wire();
  const c = baseCourse("cZ", plus(today, -21));
  w.courses.push({ ...c, usedSessions: 0, leaveUsed: 0, leaveQuota: null, status: "ACTIVE", adminUnlocked: false, priorSessions: 0, classRateMinor: null, endedAt: null, droppedAt: null, expiryDate: plus(c.expiryDate, 120) });
  for (let i = 0; i < 3; i++) w.bookings.push(row(`cZ-b${i + 1}`, "cZ", plus(today, -21 + i * 7), "ATTENDED", { studentId: "sZ", coStudentId: duo ? "sZ2" : null, startTime: "12:00:00" })); // 12:00 — the group series holds 10:00 with the same coach
  w.bookings.push(row("cZ-b4", "cZ", plus(today, 7), "CONFIRMED", { studentId: "sZ", coStudentId: duo ? "sZ2" : null, startTime: "12:00:00" }));
  return w;
}
/** leave on cZ-b4, then Undo it; returns the outbox index where the UNDO's rows start */
async function leaveThenUndo(w: any) {
  await sched.updateBookingStatus("cZ-b4", "sick-leave", "ป่วย", true);
  const n0 = outbox().length;
  await undoBooking("cZ-b4", { actor: "admin-dong", reason: "wrong child" });
  return n0;
}

describe("🔴 THE REPRODUCTION — a leave Undo today tells the coach and the family NOTHING", () => {
  test("Undo of a leave ⇒ the family's household gets ONE class_on_again_parent for the class (before the build: 0); the coach's message is unchanged", async () => {
    const w = plainWorld();
    const n0 = await leaveThenUndo(w);
    expect(rowOf(w, "cZ-b4").status).toBe("CONFIRMED");
    const fam = onAgainRows("cZ-b4", n0);
    expect(fam).toHaveLength(1);
    expect(fam[0]).toMatchObject({ recipientType: "parent", recipientLineUserId: "U-sZ", payload: { kind: "class_on_again_parent", bookingId: "cZ-b4", bookingType: "COURSE_PACKAGE", size: 4 } });
    // the coach's message: byte-identical to TASK-508's
    expect(outbox().slice(n0).filter((o) => o.bookingId === "cZ-b4" && o.recipientType === "teacher").map((o) => o.payload)).toEqual([{ kind: "class_on_again_teacher", bookingId: "cZ-b4", bookingType: "COURSE_PACKAGE", size: 4 }]);
  });
});

describe("📖 the words — the owner's, verbatim, by string equality", () => {
  const CTX = { studentName: "มะขิด", subject: "Freeskate", date: "2026-10-30", startTime: "10:00", endTime: "11:00", coach: "Ek" };
  const P = { kind: "class_on_again_parent", bookingId: "b", bookingType: "COURSE_PACKAGE", size: 4 } as any;
  const BLOCK = ["Student : มะขิด", "Program : Freeskate 4 HR", "Date : 30-10-2026", "Time : 10:00-11:00"];
  test("TH", () => {
    expect(formatOutboxMessage(P, CTX as any, "TH", "parent").split("\n")).toEqual(["✅ มีคาบเรียนตามเดิม:", ...BLOCK, "Note : ยกเลิกการลาแล้ว เรียนคาบนี้ตามปกติค่ะ"]);
  });
  test("EN", () => {
    expect(formatOutboxMessage(P, CTX as any, "EN", "parent").split("\n")).toEqual(["✅ CLASS ON AGAIN:", ...BLOCK, "Note : Leave cancelled. This class goes ahead as scheduled."]);
  });
  test("no Coach line, no Reason line — the approved text has neither", () => {
    for (const lang of ["TH", "EN"] as const) expect(formatOutboxMessage(P, CTX as any, lang, "parent")).not.toMatch(/Coach|Reason|เหตุผล/);
  });
});

describe("🔑 who is told", () => {
  test("a DUO course (two households) ⇒ two rows, one per household", async () => {
    const w = plainWorld(true);
    const n0 = await leaveThenUndo(w);
    expect(onAgainRows("cZ-b4", n0).map((o) => o.recipientLineUserId).sort()).toEqual(["U-sZ", "U-sZ2"]);
  });
  test("an UNLINKED household ⇒ ONE row with no recipient (the SKIPPED row, as every family notice)", async () => {
    const w = plainWorld();
    spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => []) as any));
    const n0 = await leaveThenUndo(w);
    const fam = onAgainRows("cZ-b4", n0);
    expect(fam).toHaveLength(1);
    expect(fam[0].recipientLineUserId).toBeNull();
  });
  test("the ORDER a family sees after one Undo: the make-up's cancel (TASK-704, born CONFIRMED) THEN «class on again»", async () => {
    const w = plainWorld();
    const n0 = await leaveThenUndo(w);
    const kinds = outbox().slice(n0).filter((o) => o.recipientType === "parent").map((o) => o.payload.kind);
    expect(kinds).toEqual(["makeup_cancelled_parent", "class_on_again_parent"]);
  });
});

describe("🚫 nothing is sent when nothing happened", () => {
  test("a REFUSED Undo (the coach's slot was taken meanwhile) ⇒ no family message", async () => {
    const w = plainWorld();
    await sched.updateBookingStatus("cZ-b4", "sick-leave", "ป่วย", true);
    w.bookings.push(row("squatter", "", plus(today, 7), "CONFIRMED", { courseId: null, studentId: "sA", startTime: "12:00:00", bookingType: "SINGLE_SESSION", isMakeup: false }));
    const n0 = outbox().length;
    await expect(undoBooking("cZ-b4", { actor: "a", reason: null })).rejects.toMatchObject({ code: "UNDO_SLOT_TAKEN" });
    expect(onAgainRows("cZ-b4", n0)).toEqual([]);
  });
  test("by source: the family call sits in the LEAVE branch after the plan check, never in the check-in branch (a check-in Undo sends nothing new)", () => {
    const U = readFileSync(resolve(import.meta.dir, "undo.service.ts"), "utf8").replace(/\r\n/g, "\n");
    const call = U.indexOf("await sendClassOnAgainToFamilies(tx,");
    expect(call).toBeGreaterThan(U.indexOf("throw UNDO_PLAN_WOULD_CHANGE()"));
    expect(call).toBeLessThan(U.indexOf("await revertAttendance(tx, row);")); // before the check-in branch's own write
    expect(U.slice(call, U.indexOf("await revertAttendance(tx, row);"))).toContain("} else {");
    expect([...U.matchAll(/sendClassOnAgainToFamilies\(/g)]).toHaveLength(1);
  });
});
