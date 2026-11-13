// 🔻 TASK-971 (REQ-5016 AC4, SPEC-109 §3.3) — the WHOLE-DAY leave, THROUGH the real entry points over the in-memory world of TASK-692's proofs (a fake transaction that rolls back on a throw, a recording outbox):
//   · every live hour of that course on that date becomes SICK_LEAVE in ONE transaction, each through the SAME door a single hour uses;
//   · the quota counts WEEKS (a PATTERN course): a whole day of 2 hours = +1; 2 single-hour leaves in one week = +1, in two weeks = +2; a ONE-slot course is exactly today (+1 each);
//   · ONE leave notice per recipient (the admins once, each coach once), listing every hour; the per-hour notice is byte-identical (no `times`);
//   · only a course row (400 VALIDATION otherwise); a refusal on any hour rolls the whole day back.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as rental from "./rental.service";
import * as lineLib from "../lib/line";
import * as ownScope from "../lib/own-scope";
import { courseExpiry } from "../lib/recurring";
import { bangkokNow } from "../lib/bangkok-time";
import { formatOutboxMessage } from "../lib/line-message";
import * as v from "../validation";

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
    try { where(cols, { and: (...a: any[]) => a, eq: (c: any, v: any) => { hits.push([String(c), v]); return v; }, ne: (c: any, v: any) => { hits.push(["ne:" + String(c), v]); return null; }, notInArray: () => null, inArray: () => null, or: () => null, isNull: () => null, gte: () => null, lte: () => null, lt: () => null, gt: () => null }); } catch {}
    return (k: string) => hits.find((h) => h[0] === k)?.[1];
  };
  const tx: any = {
    query: {
      bookings: {
        findFirst: async ({ where }: any) => { const g = probe(where); const id = g("id"); return withRels(w.bookings.find((b: any) => b.id === id)) ?? null; },
        findMany: async ({ where, orderBy, limit, columns }: any) => {
          const g = probe(where);
          // 🔻 TASK-971 — the week quota's reader: the OTHER charged leave rows of the course (status SICK_LEAVE, leave_charged true, not this row)
          if (columns?.date) return w.bookings.filter((b: any) => b.courseId === g("courseId") && b.status === "SICK_LEAVE" && b.leaveCharged === true && b.id !== g("ne:id")).map((b: any) => ({ date: b.date }));
          // 🔻 TASK-971 — the whole-day act's reader: the LIVE hours of that course on that date, in time order
          if (g("date") && g("courseId")) return w.bookings.filter((b: any) => b.courseId === g("courseId") && b.date === g("date") && ["PENDING", "CONFIRMED", "EXTENDED"].includes(b.status)).sort((x: any, y: any) => (x.startTime < y.startTime ? -1 : 1)).map(withRels);
          let out = g("groupId") ? w.bookings.filter((b: any) => b.groupId === g("groupId") && ["PENDING", "CONFIRMED", "EXTENDED"].includes(b.status))
            : g("courseId") ? w.bookings.filter((b: any) => b.courseId === g("courseId") && b.status !== "CANCELLED")
            : w.bookings.filter((b: any) => b.status !== "CANCELLED");
          if (orderBy) out = [...out].sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
          return (limit ? out.slice(0, limit) : out).map(withRels);
        },
      },
      coursePackages: { findFirst: async ({ where }: any) => { const g = probe(where); return course(g("id")) ?? w.courses[0] ?? null; } },
      teacherLeaveDays: { findFirst: async () => undefined },
      courseSlots: { findMany: async () => w.slots ?? [] }, // 🔻 TASK-971 — a PATTERN course has 2+ rows
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
  spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_tx: any, _t: string, _st: string, after: string) => plus(after, 7)) as any));
  spies.push(spyOn(rental, "inheritCourseRental").mockImplementation((async () => {}) as any));
  (globalThis as any).__w = w;
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (row: any) => { w.outbox.push(row); return { status: "queued" } as any; }) as any) as any);
  w.tx = tx; // for the doors whose entry point TAKES a transaction (a group date's seats)
  return w;
}

const enq = () => ((globalThis as any).__w.outbox as any[]);
const T2 = "t2t2t2t2-t2t2-42t2-82t2-t2t2t2t2t2t2";
/** A STARTED pattern course (2 slots a week) with `hours` live hours on each of the given days. `slots` = how many `course_slots` rows it has (2 = a pattern course, 0 = a one-slot course). */
function patternCourse(days: number[], hoursPerDay: string[] = ["10:00:00", "11:00:00"], slots = 2) {
  const t = bangkokNow().date;
  const start = plus(t, -14);
  const c = baseCourse("c1", start);
  const rows = [row("c1-a1", "c1", plus(t, -14), "ATTENDED")];
  for (const d of days) for (const [i, h] of hoursPerDay.entries()) rows.push(row(`c1-d${d}-h${i}`, "c1", plus(t, d), "PENDING", { startTime: h, endTime: `${String(Number(h.slice(0, 2)) + 1).padStart(2, "0")}:00:00` }));
  const w = world([c], rows);
  w.courses[0].expiryDate = plus(c.expiryDate, 90); // room for every make-up
  w.slots = Array.from({ length: slots }, (_, i) => ({ id: `s${i}` }));
  spies.push(spyOn(console, "error").mockImplementation((() => {}) as any)); // the fake world has no revenue ledger: the confirm's revenue line logs "NOT WRITTEN" (never fails the leave)
  spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1, nickname: "Bank", lineUserId: null }]) as any));
  return { w, t, start };
}
const live = (w: any, date: string) => w.bookings.filter((b: any) => b.date === date && b.courseId === "c1");
const refused = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return { code: e.code, status: e.status, message: String(e?.message ?? e).slice(0, 120) }; } return null; };

describe("🔴 TASK-971 — the whole-day leave: every live hour of the day, in one act", () => {
  test("2 hours that day ⇒ BOTH SICK_LEAVE, 2 make-ups, the quota +1 (one WEEK), the requested row first", async () => {
    const { w, t } = patternCourse([7]);
    const r: any = await sched.recordWholeDayLeave("c1-d7-h0", { reason: "ป่วย", override: true });
    expect(live(w, plus(t, 7)).map((b: any) => b.status)).toEqual(["SICK_LEAVE", "SICK_LEAVE"]);
    expect(w.inserts.filter((i: any) => i.table === "bookings")).toHaveLength(2); // a make-up PER hour
    expect(w.courses[0].leaveUsed).toBe(1);
    expect(r.wholeDay.count).toBe(2);
  });
  test("a day with ONE live hour behaves as a single-hour leave (+1, one make-up)", async () => {
    const { w, t } = patternCourse([7], ["10:00:00"]);
    await sched.recordWholeDayLeave("c1-d7-h0", { reason: "ป่วย", override: true });
    expect([live(w, plus(t, 7))[0].status, w.courses[0].leaveUsed, w.inserts.filter((i: any) => i.table === "bookings").length]).toEqual(["SICK_LEAVE", 1, 1]);
  });
  test("only the LIVE hours of THAT date: another day's rows and an already-cancelled hour are untouched", async () => {
    const { w, t } = patternCourse([7, 9]);
    live(w, plus(t, 7))[1].status = "CANCELLED";
    await sched.recordWholeDayLeave("c1-d7-h0", { reason: "ป่วย", override: true });
    expect(live(w, plus(t, 7)).map((b: any) => b.status)).toEqual(["SICK_LEAVE", "CANCELLED"]);
    expect(live(w, plus(t, 9)).map((b: any) => b.status)).toEqual(["PENDING", "PENDING"]); // the other day is untouched
  });
  test("a refusal on any hour rolls the WHOLE day back (the world is byte-identical)", async () => {
    const { w } = patternCourse([0], ["00:00:00", "01:00:00"]); // today, hours that have already passed ⇒ the advance-notice rule refuses (override off)
    const before = JSON.stringify({ b: w.bookings, c: w.courses, i: w.inserts });
    const e = await refused(sched.recordWholeDayLeave("c1-d0-h0", { reason: "ป่วย", override: false }));
    expect(e?.code).toBe("LEAVE_NOTICE_TOO_LATE");
    expect(JSON.stringify({ b: w.bookings, c: w.courses, i: w.inserts })).toBe(before);
    expect(enq()).toHaveLength(0);
  });
  test("only a COURSE row: a voucher / single / trial booking is 400 VALIDATION and nothing is written", async () => {
    const { w } = patternCourse([7]);
    w.bookings[1].bookingType = "SINGLE_SESSION";
    const before = JSON.stringify(w.bookings);
    expect(await refused(sched.recordWholeDayLeave("c1-d7-h0", { reason: "ป่วย", override: true }))).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(JSON.stringify(w.bookings)).toBe(before);
  });
  test("the request flag: `wholeDay: true` only with `action: sick-leave` (the body is 400 otherwise); absent ⇒ today's body", () => {
    expect(v.updateStatus.safeParse({ action: "sick-leave", wholeDay: true }).success).toBe(true);
    expect(v.updateStatus.safeParse({ action: "cancel", wholeDay: true }).success).toBe(false);
    expect(v.updateStatus.safeParse({ action: "confirm", wholeDay: true }).success).toBe(false);
    expect(v.updateStatus.safeParse({ action: "sick-leave", wholeDay: false }).success).toBe(false); // the flag is `true` or absent
    expect(v.updateStatus.safeParse({ action: "sick-leave" }).success).toBe(true);
  });
});

describe("🔴 TASK-971 — the quota in WEEKS through the real doors", () => {
  test("PATTERN course: 2 single-hour leaves in ONE week ⇒ +1; in TWO weeks ⇒ +2", async () => {
    const a = patternCourse([7, 9], ["10:00:00"]); // both days fall in one course week (start = 14 days ago ⇒ weeks of 7)
    await sched.updateBookingStatus("c1-d7-h0", "sick-leave", "ป่วย", true);
    await sched.updateBookingStatus("c1-d9-h0", "sick-leave", "ป่วย", true);
    expect(a.w.courses[0].leaveUsed).toBe(1);
    spies.splice(0).forEach((s) => s.mockRestore());
    const b = patternCourse([7, 14], ["10:00:00"]); // a week apart
    await sched.updateBookingStatus("c1-d7-h0", "sick-leave", "ป่วย", true);
    await sched.updateBookingStatus("c1-d14-h0", "sick-leave", "ป่วย", true);
    expect(b.w.courses[0].leaveUsed).toBe(2);
  });
  test("a ONE-slot course (no `course_slots`) is exactly today: every charged leave is +1, even two in one week", async () => {
    const a = patternCourse([7, 9], ["10:00:00"], 0);
    await sched.updateBookingStatus("c1-d7-h0", "sick-leave", "ป่วย", true);
    await sched.updateBookingStatus("c1-d9-h0", "sick-leave", "ป่วย", true);
    expect(a.w.courses[0].leaveUsed).toBe(2);
  });
});

describe("📣 TASK-971 — ONE notice per recipient for a whole-day leave", () => {
  const leaveNotices = () => enq().map((o: any) => o).filter((o) => o?.payload?.kind === "leave_notice");
  test("the admins ONCE and each coach ONCE, both listing every hour; the per-hour leave stays one notice per row with NO `times`", async () => {
    const a = patternCourse([7]);
    await sched.recordWholeDayLeave("c1-d7-h0", { reason: "ป่วย", override: true });
    const n = leaveNotices();
    expect(n.map((o) => o.recipientType).sort()).toEqual(["admin", "teacher"]); // one admin message, one for the ONE coach — not 2 + 2
    for (const o of n) expect(o.payload.times).toEqual(["10:00-11:00", "11:00-12:00"]);
    spies.splice(0).forEach((s) => s.mockRestore());
    const b = patternCourse([7]);
    await sched.updateBookingStatus("c1-d7-h0", "sick-leave", "ป่วย", true);
    const single = leaveNotices();
    expect(single.length).toBeGreaterThan(0);
    for (const o of single) expect(o.payload).not.toHaveProperty("times"); // the per-hour notice is byte-identical
    expect(a.w).toBeDefined();
    expect(b.w).toBeDefined();
  });
  test("the words: the SAME notice, its `Time` lists every hour of the day (and one hour prints as before)", () => {
    const base = { kind: "leave_notice", bookingId: "b1", studentName: "Mali", bookingType: "COURSE_PACKAGE", size: 10, via: "staff" };
    const ctx: any = { date: "2026-11-20", startTime: "10:00", endTime: "11:00", studentName: "Mali" };
    const one = formatOutboxMessage(base as any, ctx, "EN", "teacher");
    const day = formatOutboxMessage({ ...base, times: ["10:00-11:00", "11:00-12:00"] } as any, ctx, "EN", "teacher");
    expect(one).toContain("10:00-11:00");
    expect(day).toContain("10:00-11:00, 11:00-12:00");
    expect(day.replace("10:00-11:00, 11:00-12:00", "10:00-11:00")).toBe(one); // nothing else differs
  });
});
