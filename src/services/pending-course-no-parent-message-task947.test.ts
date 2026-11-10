// TASK-947 (F2) — no parent message while a course is still PENDING; ONE schedule message (with the make-ups) at Confirm Course. The harness below (imports → `world()`) is a COPY of
// `makeup-born-confirmed-task702.test.ts` lines 5–133 (a Team B file extends nobody else's): the REAL writers over an in-memory world; `courseIsConfirmed` is stood in by the predicate's OWN condition.
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
  spies.push(spyOn(sched, "courseIsConfirmed").mockImplementation((async (_tx: any, courseId: string | null) => !courseId || w.bookings.some((b: any) => b.courseId === courseId && b.bookingType === "COURSE_PACKAGE" && ["CONFIRMED", "ATTENDED"].includes(b.status) && b.isMakeup !== true)) as any)); // 🔻 TASK-947 — the predicate, over this world
  spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_tx: any, _t: string, _st: string, after: string) => plus(after, 7)) as any));
  spies.push(spyOn(rental, "inheritCourseRental").mockImplementation((async () => {}) as any));
  (globalThis as any).__w = w;
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (row: any) => { w.outbox.push(row); return { status: "queued" } as any; }) as any) as any);
  w.tx = tx; // for the doors whose entry point TAKES a transaction (a group date's seats)
  return w;
}

import * as familyLink from "../lib/family-link";
import * as ownScope2 from "../lib/own-scope";
import { groupReminders } from "../lib/daily-reminder";
import { quietPendingMakeupParents } from "./jobs.service";

// ───────────────────────── TASK-947 (F2) — no parent message while a course is still PENDING; ONE schedule message at Confirm Course ─────────────────────────
// ขวัญ 2026-11-09: «ยังไม่ส่งการแจ้งเตือนใด ๆ ไปยังผู้ปกครองในสถานะ Pending Course»; owner GO 2026-11-10 «แก้ให้ถูกอ่ะ». REQ-115 stands: a make-up is still born CONFIRMED + badged (even in a pending course); only the PARENT copy waits.
const outboxNow = () => ((globalThis as any).__w.outbox as any[]);
const parents = () => outboxNow().filter((o) => o.recipientType === "parent");
const coaches = () => outboxNow().filter((o) => o.recipientType === "teacher");
const kindsOf2 = (rows: any[]) => rows.map((o) => o.payload?.kind);
const T947 = () => bangkokNow().date;
/** pending: nothing of the course is CONFIRMED / ATTENDED · confirmed: its first session is CONFIRMED · onlyMakeups: the ONLY CONFIRMED row is a make-up (born CONFIRMED) */
const mk947 = (kind: "pending" | "confirmed" | "onlyMakeups") => {
  const t = T947();
  const c = baseCourse("c1", plus(t, 7));
  const rows = [
    row("c1-b1", "c1", plus(t, 7), kind === "confirmed" ? "CONFIRMED" : "PENDING"),
    row("c1-b2", "c1", plus(t, 14), "PENDING"),
    row("c1-b3", "c1", plus(t, 21), "PENDING"),
    row("c1-b4", "c1", plus(t, 28), "PENDING"),
    ...(kind === "onlyMakeups" ? [row("c1-m0", "c1", plus(t, 35), "CONFIRMED", { isMakeup: true })] : []),
  ];
  const w = world([c], rows);
  w.courses[0].expiryDate = plus(c.expiryDate, 90);
  Object.assign(w.courses[0], { startTime: "10:00:00", weekday: 5, studentId: "s1", coStudentId: null, rentalRemovedAt: null }); // what Confirm Course's summary reads off the course
  // the FAITHFUL free-week search (TASK-946): the coach's `coachOff` dates read as taken, a CANCELLED row holds nothing (the 702 world's stand-in ignores `coachOff`)
  spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_tx: any, teacherId: string, startTime: string, after: string, taken: ReadonlySet<string> = new Set()) => {
    let d = plus(after, 7);
    for (let i = 0; i < 20; i++, d = plus(d, 7)) {
      if (taken.has(d)) continue;
      if (w.bookings.some((b: any) => b.teacherId === teacherId && b.date === d && b.startTime === startTime && b.status !== "CANCELLED")) continue;
      return d;
    }
    return d;
  }) as any));
  return w;
};
const STAFF = { channel: "staff" as const, actor: "admin-dong" };
const armFamily = () => {
  spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
  spies.push(spyOn(ownScope2, "teachersOfBooking").mockImplementation((async () => [{ id: T1, lineUserId: "U-coach" }]) as any));
};

describe("🔴 TASK-947 — the ONE predicate `courseIsConfirmed` (by value, on a recording fake)", () => {
  // the real function, un-spied: restore the world's stand-in first by calling it through a fresh import of the module's own export is not possible, so these run on a bare fake tx WITHOUT `world()`
  const fakeTx = (hit: boolean) => {
    const asked: any[] = [];
    const ops = {
      and: (...a: any[]) => ["and", ...a], eq: (c: any, v: any) => ["eq", c, v], inArray: (c: any, v: any) => ["in", c, v],
    };
    const cols = { courseId: "courseId", bookingType: "bookingType", status: "status", isMakeup: "isMakeup", id: "id" };
    const tx = { query: { bookings: { findFirst: async (q: any) => { asked.push({ columns: q.columns, where: q.where(cols, ops) }); return hit ? { id: "x" } : undefined; } } } };
    return { tx: tx as any, asked };
  };
  test("no course (a voucher, a single booking) ⇒ confirmed, and NOT ONE query is made", async () => {
    const { tx, asked } = fakeTx(false);
    for (const id of [null, undefined, ""]) expect(await sched.courseIsConfirmed(tx, id as any)).toBe(true);
    expect(asked).toEqual([]);
  });
  test("ONE query: the course's OWN COURSE_PACKAGE rows, CONFIRMED or ATTENDED, that are NOT make-ups", async () => {
    const { tx, asked } = fakeTx(true);
    expect(await sched.courseIsConfirmed(tx, "c1")).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].where).toEqual(["and", ["eq", "courseId", "c1"], ["eq", "bookingType", "COURSE_PACKAGE"], ["in", "status", ["CONFIRMED", "ATTENDED"]], ["eq", "isMakeup", false]]);
  });
  test("no such row ⇒ NOT confirmed (a pending course; a course whose only CONFIRMED rows are make-ups is the same query: the make-ups are excluded by `isMakeup = false`)", async () => {
    const { tx } = fakeTx(false);
    expect(await sched.courseIsConfirmed(tx, "c1")).toBe(false);
  });
  test("`unconfirmedCourseIds`: ONE grouped query for many courses; no ids ⇒ no query; the answer is the ids WITHOUT a confirmed own session", async () => {
    let calls = 0;
    const exec = { select: () => ({ from: () => ({ where: () => ({ groupBy: async () => { calls++; return [{ courseId: "c2" }]; } }) }) }) };
    expect([...(await sched.unconfirmedCourseIds(exec, ["c1", "c2", "c3", "c1", ""]))].sort()).toEqual(["c1", "c3"]);
    expect(calls).toBe(1);
    expect((await sched.unconfirmedCourseIds(exec, [])).size).toBe(0);
    expect(calls).toBe(1);
  });
  test("by source: the payload's make-up filter is the LIVE statuses of a MARKED make-up", () => {
    const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8");
    expect(S).toContain('r.isMakeup === true && (r.status === "CONFIRMED" || r.status === "EXTENDED")');
  });
  test("by source: the predicate's own condition", () => {
    const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8");
    expect(S).toContain('inA(b.status, ["CONFIRMED", "ATTENDED"]), e(b.isMakeup, false)');
    expect(S).toContain('inArray(bookings.status, ["CONFIRMED", "ATTENDED"]), eq(bookings.isMakeup, false)');
  });
});

describe("🔴 TASK-947 — a leave's make-up: still born CONFIRMED + badged; the PARENT copy waits for Confirm Course", () => {
  test("a PENDING course + a leave ⇒ the make-up is MARKED, CONFIRMED, has `confirmedAt` and a token; the COACH is told; the PARENT gets NOTHING", async () => {
    const w = mk947("pending");
    armFamily();
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    const m = w.bookings.find((b: any) => b.isMakeup === true && b.extendedFromId === "c1-b3");
    expect(m).toMatchObject({ isMakeup: true, status: "CONFIRMED" });
    expect(m.confirmedAt).toBeInstanceOf(Date);
    expect(typeof m.checkinToken).toBe("string");
    expect(coaches().filter((o) => o.bookingId === m.id).map((o) => o.payload.kind)).toEqual(["booking_confirmed"]);
    expect(parents()).toEqual([]); // not the make-up's confirm, and no other parent notice either
  });
  test("the same on a CONFIRMED course ⇒ the parent message IS queued (unchanged)", async () => {
    const w = mk947("confirmed");
    armFamily();
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    const m = w.bookings.find((b: any) => b.isMakeup === true && b.extendedFromId === "c1-b3");
    expect(parents().filter((o) => o.bookingId === m.id).map((o) => o.payload.kind)).toEqual(["booking_confirmed"]);
    expect(coaches().filter((o) => o.bookingId === m.id).map((o) => o.payload.kind)).toEqual(["booking_confirmed"]);
  });
  test("a course whose only CONFIRMED row is a MAKE-UP is still NOT confirmed ⇒ the parent is not told", async () => {
    const w = mk947("onlyMakeups");
    armFamily();
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    expect(w.bookings.filter((b: any) => b.isMakeup === true && b.status === "CONFIRMED").length).toBeGreaterThanOrEqual(2);
    expect(parents()).toEqual([]);
  });
  test("the admin cancel of a PENDING course's make-up: its RE-GROWN make-up is confirmed for the coach only, and the cancel notice does not reach the parent", async () => {
    const w = mk947("pending");
    armFamily();
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false); // the leave grows make-up m1 (born CONFIRMED)
    const m1 = w.bookings.find((b: any) => b.isMakeup === true && b.extendedFromId === "c1-b3");
    outboxNow().length = 0;
    await sched.updateBookingStatus(m1.id, "cancel", "x", false, "ADMIN_ERROR", STAFF);
    expect(parents()).toEqual([]); // neither the cancel notice nor the re-grown make-up's confirm
    expect(kindsOf2(coaches())).toContain("booking_confirmed"); // the re-grown make-up: the coach IS told
  });
});

describe("🔴 TASK-947 — the other parent notices of a PENDING course, by value", () => {
  const spyConfirmed = (v: boolean) => spies.push(spyOn(sched, "courseIsConfirmed").mockImplementation((async () => v) as any));
  const fake = () => {
    const rows: any[] = [];
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (row: any) => { rows.push(row); return { status: "queued" } as any; }) as any) as any);
    spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
    return { rows, tx: { query: { bookings: { findMany: async () => [] } } } as any };
  };
  const cur = { id: "m1", status: "CONFIRMED", isMakeup: true, courseId: "c1", studentId: "s1", coStudentId: null, bookingType: "COURSE_PACKAGE", course: { size: 4 }, voucher: null };
  test("undo-leave notice: a PENDING course ⇒ 0 parent messages (null); a confirmed one ⇒ `class_on_again_parent` as before", async () => {
    const a = fake(); spyConfirmed(false);
    expect(await sched.sendClassOnAgainToFamilies(a.tx, cur as any)).toBeNull();
    expect(a.rows).toEqual([]);
    dropAll();
    const b = fake(); spyConfirmed(true);
    expect(await sched.sendClassOnAgainToFamilies(b.tx, cur as any)).toEqual(["U-mum"]);
    expect(b.rows.map((r) => r.payload.kind)).toEqual(["class_on_again_parent"]);
  });
  test("a MAKE-UP's cancel notice: PENDING course ⇒ nothing for the family; confirmed ⇒ `makeup_cancelled_parent` as before; a REGULAR confirmed row's cancel is never gated", async () => {
    const a = fake(); spyConfirmed(false);
    expect(await sched.classCancelledFamilyAccounts(a.tx, cur as any, null, [])).toBeNull();
    expect(a.rows).toEqual([]);
    const reg = { ...cur, isMakeup: false, status: "CONFIRMED" };
    expect(await sched.classCancelledFamilyAccounts(a.tx, reg as any, null, [])).toEqual(["U-mum"]); // a confirmed regular row ⇒ the course is confirmed by definition: never reaches the predicate's "false" case in real life; gated ONLY for make-ups
    dropAll();
    const b = fake(); spyConfirmed(true);
    expect(await sched.classCancelledFamilyAccounts(b.tx, cur as any, null, [])).toEqual(["U-mum"]);
    expect(b.rows.map((r) => r.payload.kind)).toEqual(["makeup_cancelled_parent"]);
  });
  test("a MAKE-UP's move notice (through the real `moveBooking`): PENDING course ⇒ the coach IS told, the parent is NOT; confirmed ⇒ both", async () => {
    for (const confirmed of [false, true]) {
      const outbox: any[] = [];
      const row0: any = { id: "B1", status: "CONFIRMED", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", teacherId: "t1", studentId: "s1", coStudentId: null, courseId: "c1", voucherId: null, bookingType: "COURSE_PACKAGE", groupId: null, note: "n", campWeekDayId: null, isMakeup: true };
      const tx: any = {
        query: { bookings: { findFirst: async () => ({ ...row0, course: { size: 4 }, voucher: null }), findMany: async () => [] } },
        update: (t: any) => ({ set: (v: any) => ({ where: async () => { if (getTableName(t) === "bookings") Object.assign(row0, v); } }) }),
        insert: (t: any) => ({ values: async (v: any) => { outbox.push(v); } }),
      };
      spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => ({ ...row0 })) as any));
      spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
      spies.push(spyOn(sched, "assertBookingCourseWritable").mockImplementation((async () => {}) as any));
      spies.push(spyOn(sched, "assertTeacherBookable").mockImplementation((async () => {}) as any));
      spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
      spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async () => ({ id: "B1" })) as any));
      spies.push(spyOn(ownScope2, "teachersOfBooking").mockImplementation((async () => [{ id: "t1", lineUserId: "U-ek" }]) as any));
      spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mom"]) as any));
      spyConfirmed(confirmed);
      await sched.moveBooking("B1", { date: "2026-10-12" });
      expect(outbox.map((o) => o.payload.kind).sort()).toEqual(confirmed ? ["class_moved_parent", "class_moved_teacher"] : ["class_moved_teacher"]);
      dropAll();
    }
  });
  test("the expiry-change notice (through the real `updateCourseExpiry`): PENDING course ⇒ no parent row (the write itself still happens); confirmed ⇒ the notice, as before", async () => {
    for (const confirmed of [false, true]) {
      const course = { id: "c1", studentId: "s1", coStudentId: null, size: 6, expiryDate: "2026-12-02", endedAt: null, droppedAt: null };
      const w: any = { course: { ...course }, outbox: [] as any[], changes: [] as any[] };
      const tx: any = {
        query: { coursePackages: { findFirst: async () => w.course }, bookings: { findFirst: async () => ({ id: "b1", courseId: "c1", bookingType: "COURSE_PACKAGE" }) } },
        update: () => ({ set: (set: any) => ({ where: async () => { Object.assign(w.course, set); } }) }),
        insert: () => ({ values: async (v: any) => { w.changes.push(v); } }),
      };
      spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
      spies.push(spyOn(db.query.coursePackages, "findFirst").mockImplementation((async () => ({ ...w.course, student: { id: "s1", name: "Mali", nickname: "Mali" } })) as any));
      spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
      spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
      spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (row: any) => { w.outbox.push(row); return { status: "queued" } as any; }) as any) as any);
      spyConfirmed(confirmed);
      await sched.updateCourseExpiry("c1", { expiryDate: "2026-12-16" }, "admin-dong");
      expect(w.course.expiryDate).toBe("2026-12-16"); // the edit is NOT gated
      expect(w.changes).toHaveLength(1); // the audit row is not either
      expect(w.outbox.map((o: any) => o.payload.kind)).toEqual(confirmed ? ["course_expiry_changed"] : []);
      dropAll();
    }
  });
});
const dropAll = () => { for (const s of spies.splice(0)) s.mockRestore(); };

describe("🔴 TASK-947 — Confirm Course: the parent gets the WHOLE schedule, ONCE, including the make-ups that grew while it was pending", () => {
  test("after a pending-period make-up ⇒ EXACTLY ONE parent message (`course_confirmed`) listing the make-up's date; the coach gets the same one; no `booking_confirmed` for the parent", async () => {
    const w = mk947("pending");
    armFamily();
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    const m = w.bookings.find((b: any) => b.isMakeup === true && b.extendedFromId === "c1-b3");
    expect(parents()).toEqual([]); // silent while pending
    spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
    outboxNow().length = 0;
    const out = await sched.confirmCourse("c1");
    expect(out.confirmed).toBeGreaterThan(0);
    expect(parents().map((o) => o.payload.kind)).toEqual(["course_confirmed"]); // ONE message
    expect(parents()[0].payload.makeupDates).toEqual([m.date]);
    expect(coaches().filter((o) => o.payload?.kind === "course_confirmed")).toHaveLength(1);
    expect(kindsOf2(outboxNow()).filter((k) => k === "booking_confirmed")).toEqual([]); // no per-session confirm on top
  });
  test("a course with NO make-up ⇒ the payload has no `makeupDates` key at all (byte-identical to before)", async () => {
    mk947("pending");
    armFamily();
    await sched.confirmCourse("c1");
    expect(parents()).toHaveLength(1);
    expect("makeupDates" in parents()[0].payload).toBe(false);
  });
  test("make-ups are the LIVE ones only (CONFIRMED / EXTENDED): a CANCELLED, an ATTENDED (delivered) and a SICK_LEAVE make-up are not listed; dates are sorted", async () => {
    const w = mk947("pending");
    const t = T947();
    w.bookings.push(row("c1-m2", "c1", plus(t, 42), "CONFIRMED", { isMakeup: true }), row("c1-m1", "c1", plus(t, 35), "EXTENDED", { isMakeup: true }), row("c1-mx", "c1", plus(t, 49), "CANCELLED", { isMakeup: true }), row("c1-ma", "c1", plus(t, 3), "ATTENDED", { isMakeup: true }), row("c1-ms", "c1", plus(t, 56), "SICK_LEAVE", { isMakeup: true }));
    armFamily();
    await sched.confirmCourse("c1");
    expect(parents()[0].payload.makeupDates).toEqual([plus(t, 35), plus(t, 42)]);
  });
});

describe("🔴 TASK-947 — the message: ONE «ขยายคาบ» line only when there are make-ups", () => {
  const P = { kind: "course_confirmed", courseId: "c1", studentName: "Mali", subject: "Freeskate", bookingType: "COURSE_PACKAGE", size: 4, expiryDate: "2027-01-31", coach: "Bank", startDate: "2026-11-20", weekday: 5, startTime: "10:00", endTime: "11:00", plannedLeaveDates: [], note: null, rental: null };
  const lines = (p: any, lang: "TH" | "EN", who: "parent" | "teacher") => formatOutboxMessage(p, {} as any, lang, who).split("\n");
  test("TH «ขยายคาบ» / EN «Extended», dd-mm-yyyy, comma-joined, for both audiences", () => {
    const p = { ...P, makeupDates: ["2026-12-04", "2026-12-18"] };
    for (const who of ["parent", "teacher"] as const) {
      expect(lines(p, "TH", who)).toContain("ขยายคาบ : 04-12-2026, 18-12-2026");
      expect(lines(p, "EN", who)).toContain("Extended : 04-12-2026, 18-12-2026");
    }
  });
  test("no make-ups (absent or empty) ⇒ NO such line, and the message is byte-identical to the one without the key", () => {
    const base = formatOutboxMessage(P, {} as any, "EN", "parent");
    expect(formatOutboxMessage({ ...P, makeupDates: [] }, {} as any, "EN", "parent")).toBe(base);
    expect(base).not.toContain("Extended");
    expect(base).not.toContain("ขยายคาบ");
  });
  test("the line is the LAST one (after Remark / Rental), so every existing line keeps its place", () => {
    const withIt = lines({ ...P, note: "แพ้ถั่ว", rental: "Rent 200", makeupDates: ["2026-12-04"] }, "EN", "parent").filter(Boolean);
    expect(withIt[withIt.length - 1]).toBe("Extended : 04-12-2026");
    expect(withIt.findIndex((l) => l.startsWith("Remark"))).toBeLessThan(withIt.findIndex((l) => l.startsWith("Extended")));
  });
});

describe("🔴 TASK-947 — the day-before reminder: a PENDING course's make-up has no PARENT entry (the coach's entry stays)", () => {
  const day = "2026-12-01";
  const make = (over: any = {}): any => ({
    id: "m1", date: day, startTime: "10:00:00", status: "CONFIRMED", teacherId: "t1", teacher: { id: "t1", lineUserId: "U-coach" }, additionalTeachers: [], studentId: "s1", courseId: "c1", isMakeup: true,
    student: { id: "s1", parentId: "p1", nickname: "Mali" }, coStudent: null, ...over,
  });
  const toToday = (r: any): any => ({
    id: r.id, date: r.date, startTime: r.startTime, status: r.status, teacherId: r.teacherId, teacherLineUserId: r.teacher.lineUserId, additionalTeachers: [],
    studentId: r.studentId, studentName: "Mali", parentId: r.student?.parentId ?? null, coParentId: r.coStudent?.parentId ?? null, coParentLineUserIds: [],
    parentLineUserId: r.student?.parentId ? "U-mum" : null, parentLineUserIds: r.student?.parentId ? ["U-mum"] : [], subjectName: "Freeskate",
  });
  test("the make-up of a pending course: only the TEACHER group is built; a confirmed course's make-up (and every non-make-up row) keeps both", () => {
    const quiet = quietPendingMakeupParents([make()], new Set(["c1"]));
    expect(groupReminders(quiet.map(toToday)).map((g) => g.recipientType)).toEqual(["teacher"]);
    const loud = quietPendingMakeupParents([make()], new Set<string>());
    expect(groupReminders(loud.map(toToday)).map((g) => g.recipientType).sort()).toEqual(["parent", "teacher"]);
    const regular = make({ isMakeup: false });
    expect(groupReminders(quietPendingMakeupParents([regular], new Set(["c1"])).map(toToday)).map((g) => g.recipientType).sort()).toEqual(["parent", "teacher"]);
  });
  test("both households of a DUO make-up are quiet; rows of other courses and non-make-ups are returned AS THEY CAME (same objects)", () => {
    const duo = make({ coStudent: { id: "s2", parentId: "p2" } });
    const other = make({ id: "m2", courseId: "c9" });
    const [a, b] = quietPendingMakeupParents([duo, other], new Set(["c1"]));
    expect(a.student.parentId).toBeNull();
    expect(a.coStudent.parentId).toBeNull();
    expect(b).toBe(other);
    expect(duo.student.parentId).toBe("p1"); // the input is not mutated
  });
  test("by source: the job asks ONE batched query for the day's make-up courses and feeds the grouper the quiet rows", () => {
    const J = readFileSync(resolve(import.meta.dir, "jobs.service.ts"), "utf8");
    expect(J).toContain("unconfirmedCourseIds(db, rows.filter((r: any) => r.isMakeup === true && r.courseId).map((r: any) => r.courseId as string))");
    expect(J).toContain("const remindRows = quietPendingMakeupParents(rows, pendingCourseIds);");
    expect(J).toContain("remindRows.map((r: any) => ({");
  });
});
