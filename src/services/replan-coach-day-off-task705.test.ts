// TASK-705 (REQ-115 F2) — a class cancelled BECAUSE THE COACH IS OFF never gets its replacement on that coach's day off. `reconcileCoursePlan` takes `coachOff: {teacherId, date}[]`; the append
// search reads those dates as TAKEN for that coach only. Passed ONLY from: the coach's own leave, its group seats, the admin's cancel with reason TEACHER_LEAVE. Every other caller passes nothing.
// 🔑 The search here is a faithful stand-in of the real one (first free week from the latest live class + 7, a CANCELLED row holds nothing, `alreadyTaken` skipped) — the bug is exactly that the
// first candidate IS the date just cancelled. The real `findFreeExtensionDate` + `alreadyTaken` is the existing, untouched seam.
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
  spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_tx: any, teacherId: string, startTime: string, after: string, taken: ReadonlySet<string> = new Set()) => {
    let d = plus(after, 7);
    for (let i = 0; i < 20; i++, d = plus(d, 7)) {
      if (taken.has(d)) continue;
      if (w.bookings.some((b: any) => b.teacherId === teacherId && b.date === d && b.startTime === startTime && b.status !== "CANCELLED")) continue;
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
import { ApiException } from "../lib/http";
import * as familyLink from "../lib/family-link";
const outbox = () => ((globalThis as any).__w.outbox as any[]);
void ApiException;

const STAFF = { channel: "staff" as const, actor: "admin-dong" };
const OTHER = "o2o2o2o2-o2o2-42o2-82o2-o2o2o2o2o2o2";
const today = bangkokNow().date;
/** a started 4-session course whose LAST live class is today's: b1,b2 delivered, b3 a week ago... laid out so b4 = TODAY is the last live class; cancelling it leaves the search anchored on b3 (+7 = today). */
const lastClassToday = (over: any = {}) => {
  const c = baseCourse("c1", plus(today, -21));
  const w = world([c], [row("c1-b1", "c1", plus(today, -21), "ATTENDED"), row("c1-b2", "c1", plus(today, -14), "ATTENDED"), row("c1-b3", "c1", plus(today, -7), "ATTENDED"), row("c1-b4", "c1", today, "CONFIRMED", over)]);
  w.courses[0].expiryDate = plus(c.expiryDate, 90);
  return w;
};
const replacementOf = (w: any) => w.bookings.find((b: any) => b.isMakeup === true && b.id !== "c1-b4" && b.status !== "CANCELLED");
const askedCoachOff: any[] = [];
const spyReplan = () => { askedCoachOff.length = 0; const real = sched.reconcileCoursePlan; spies.push(spyOn(sched, "reconcileCoursePlan").mockImplementation((async (tx: any, id: string, opts: any = {}) => { askedCoachOff.push(opts.coachOff ?? null); return real(tx, id, opts); }) as any)); };

describe("🔴 F2 — reconcileCoursePlan({ coachOff }): the replacement skips the coach's day off, for THAT coach only", () => {
  test("the BUG shape, unchanged when nothing is passed: the last live class cancelled ⇒ the replacement lands on the SAME date (first free candidate)", async () => {
    const w = lastClassToday();
    w.bookings.find((b: any) => b.id === "c1-b4").status = "CANCELLED";
    const out = await sched.reconcileCoursePlan(w.tx, "c1", { reowedFor: [] });
    expect(out.appended).toHaveLength(1);
    expect(replacementOf(w)!.date).toBe(today);
  });
  test("🔴 coachOff = (the template's coach, that date) ⇒ the replacement lands the NEXT free week, not that date", async () => {
    const w = lastClassToday();
    w.bookings.find((b: any) => b.id === "c1-b4").status = "CANCELLED";
    await sched.reconcileCoursePlan(w.tx, "c1", { reowedFor: [], coachOff: [{ teacherId: T1, date: today }] });
    expect(replacementOf(w)!.date).toBe(plus(today, 7));
  });
  test("🔑 per coach: a DIFFERENT coach being off that date does not block this coach's slot", async () => {
    const w = lastClassToday();
    w.bookings.find((b: any) => b.id === "c1-b4").status = "CANCELLED";
    await sched.reconcileCoursePlan(w.tx, "c1", { reowedFor: [], coachOff: [{ teacherId: OTHER, date: today }] });
    expect(replacementOf(w)!.date).toBe(today);
  });
});

describe("🔴 F2 — which doors pass it (by value, through the real entry points)", () => {
  test("door 3 — the admin's cancel with reason TEACHER_LEAVE: the class's coach + its date are passed ⇒ the replacement lands the next free week and the family is told THAT date", async () => {
    const w = lastClassToday({ isMakeup: true, extendedFromId: "c1-b3" }); // a make-up: its family notice names the new class date
    spyReplan();
    spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1, lineUserId: "U-coach" }]) as any));
    spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
    await sched.updateBookingStatus("c1-b4", "cancel", "ครูลา", false, "TEACHER_LEAVE", STAFF);
    expect(askedCoachOff).toEqual([[{ teacherId: T1, date: today }]]);
    expect(replacementOf(w)!.date).toBe(plus(today, 7));
    const fam = outbox().find((o) => o.recipientType === "parent" && /cancelled_parent/.test(o.payload?.kind ?? ""));
    expect(fam?.payload?.newClassDates).toContain(plus(today, 7)); // (the fake `findMany` ignores the id filter and returns the course rows — what matters: the NEW date is named, and today is not the new class)
    expect(replacementOf(w)!.date).not.toBe(today);
  });
  test("🚫 the admin's cancel with ANY OTHER reason passes NOTHING — TASK-551 stands (the replacement may land in the same slot)", async () => {
    for (const reason of [undefined, "ADMIN_ERROR", "CUSTOMER_CANCELLED"]) {
      const w = lastClassToday();
      spyReplan();
      spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1, lineUserId: "U-coach" }]) as any));
      spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
      await sched.updateBookingStatus("c1-b4", "cancel", "x", false, reason, STAFF);
      expect(askedCoachOff).toEqual([null]);
      expect(replacementOf(w)!.date).toBe(today);
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
});

describe("🔴 F2 — door 1: a coach's OWN same-day leave", () => {
  test("cancels the last live class ⇒ the replacement lands the NEXT free week, never today; the coach is the pair passed", async () => {
    const w = lastClassToday({ isMakeup: true, extendedFromId: "c1-b3" });
    spyReplan();
    spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1, lineUserId: "U-coach" }]) as any));
    spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
    const out = await sched.reportTeacherLeave(T1, { date: today, sessionIds: ["c1-b4"], reason: "ป่วย" }, null, { onBehalf: false });
    expect(out.cancelled).toBe(1);
    expect(askedCoachOff).toEqual([[{ teacherId: T1, date: today }]]);
    expect(replacementOf(w)!.date).toBe(plus(today, 7));
  });
});

describe("🔴 F2 §2 — the GROUP doors: the row's coaches × its date go to the seats, only for TEACHER_LEAVE", () => {
  test("by value: coachOffOfRow = every coach of the row (primary + additional) × the row's date", async () => {
    spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1 }, { id: OTHER }]) as any));
    expect(await sched.coachOffOfRow({}, { id: "g1", date: today })).toEqual([{ teacherId: T1, date: today }, { teacherId: OTHER, date: today }]);
  });
  test("by source: the admin's GROUP-row cancel and the series cancel-all pass it ONLY for the raw reason TEACHER_LEAVE (SCHOOL_ISSUE keeps its trigger, every other reason passes nothing)", () => {
    const A = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8");
    const O = readFileSync(resolve(import.meta.dir, "other-series.service.ts"), "utf8");
    expect(A).toContain('...(reasonCode === "TEACHER_LEAVE" ? { coachOff: await coachOffOfRow(tx, current) } : {})');
    expect(A).toContain('...(enumReason === SCHOOL_ISSUE ? { weekTrigger: "T3_SCHOOL_ISSUE" as const } : {})');
    expect(O).toContain('...(input.reasonCode === "TEACHER_LEAVE" ? { coachOff: await coachOffOfRow(tx, r) } : {})');
    expect(O).toContain('...(input.reasonCode === SCHOOL_ISSUE ? { weekTrigger: "T3_SCHOOL_ISSUE" as const } : {})');
    expect([...(A + O).matchAll(/coachOffOfRow\(tx, /g)]).toHaveLength(2);
  });
});

describe("🔴 F2 — by source: the option cannot leak", () => {
  const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8");
  test("the coach's own leave passes (that coach, that date) to the re-plan AND to its group seats", () => {
    expect(S).toContain('const coachOff: CoachOff[] = [{ teacherId: me, date: input.date }];');
    expect(S).toContain('{ weekTrigger: "T2_COACH_LEAVE", coachOff }');
    expect(S).toContain("reowedFor: reowedForOf(b as any), coachOff }");
  });
  test("the admin cancel passes it ONLY for the raw reason TEACHER_LEAVE; the other callers (plan editor, Undo, creation, the SCHOOL_ISSUE / series seats) pass nothing", () => {
    expect(S).toContain('reasonCode === "TEACHER_LEAVE"');
    const calls = [...S.matchAll(/reconcileCoursePlan\(tx, [^;\n]*/g)].map((m) => m[0]).filter((c) => c.includes("coachOff"));
    expect(calls).toHaveLength(3); // the leave · the seats' own call · the admin cancel — nothing else
    expect(readFileSync(resolve(import.meta.dir, "undo.service.ts"), "utf8")).not.toContain("coachOff");
  });
  test("the append search merges it into the dates already taken — per template coach", () => {
    expect(S).toContain("(opts.coachOff ?? []).filter((c) => c.teacherId === template.teacherId)");
    expect(S).toContain("findFreeExtensionDate(tx, template.teacherId, template.startTime, fromDate, coachOffDates)");
  });
});
