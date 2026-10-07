// TASK-702 (REQ-115, owner-ruled T1) — a make-up is a NORMAL CLASS: born CONFIRMED (through the ONE confirm), told like one, and MARKED by `bookings.is_makeup`. The marker is what the
// plan engine's TRIM, `canInsert`, the history and the front's «ขยายคาบ» badge now ask — the STATUS no longer says "this grew from a leave".
// 🔑 Driven THROUGH the real entry points over the fake transaction of 656/657/692's proofs (it ROLLS BACK on a throw, and so does its outbox). The migration is DB-unreachable here:
// its SQL is pinned BY VALUE; the ROLLBACK itself is @Tanya's local proof (TASK-702 §2f) — said, not hidden.
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
  spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_tx: any, _t: string, _st: string, after: string) => plus(after, 7)) as any));
  spies.push(spyOn(rental, "inheritCourseRental").mockImplementation((async () => {}) as any));
  (globalThis as any).__w = w;
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (row: any) => { w.outbox.push(row); return { status: "queued" } as any; }) as any) as any);
  w.tx = tx; // for the doors whose entry point TAKES a transaction (a group date's seats)
  return w;
}

import { ApiException } from "../lib/http";
import * as teacherLeaveLib from "../lib/teacher-leave";
import * as familyLink from "../lib/family-link";
import { planCourseMoves, canInsert, type PlanSession } from "../lib/course-plan";
import { toBookingDTO } from "../db/mappers";
import { bookingEventKind } from "../lib/course-history";
import {
  MAKEUP_BIRTH_NOTES, MAKEUP_CANCEL_NOTES, MAKEUP_COUNT_READ_SQL, MAKEUP_NOTES_READ_SQL, MAKEUP_NOTE_LEAVE, MAKEUP_NOTE_RECONCILE, MAKEUP_NOTE_TRIMMED, MAKEUP_NOTE_UNDONE,
  makeupPopulationSql, makeupSuspectSql,
} from "../lib/makeup-marker";

const outbox = () => ((globalThis as any).__w.outbox as any[]);
const kinds = (rowsOf = outbox()) => rowsOf.map((o) => `${o.recipientType}:${o.payload?.kind}`);
const landAt = (days: number) => spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_t: any, _s: string, _x: string, after: string) => plus(after, days)) as any));
/** A started 4-session course (b1, b2 delivered; b3, b4 ahead) with ROOM, so the leave is not refused for validity. `ahead` = the status of b3/b4 (PENDING = a course not yet confirmed; CONFIRMED = a confirmed one). */
const course = (ahead: "PENDING" | "CONFIRMED" = "PENDING") => {
  const t = bangkokNow().date;
  const c = baseCourse("c1", plus(t, -14));
  const w = world([c], [row("c1-b1", "c1", plus(t, -14), "ATTENDED"), row("c1-b2", "c1", plus(t, -7), "ATTENDED"), row("c1-b3", "c1", plus(t, 7), ahead), row("c1-b4", "c1", plus(t, 14), ahead)]);
  w.courses[0].expiryDate = plus(c.expiryDate, 90);
  return { c, w };
};
const makeupOf = (w: any, leaveId: string) => w.bookings.find((b: any) => b.isMakeup === true && b.extendedFromId === leaveId);

describe("🔴 N1/N3 — a make-up is born CONFIRMED, through the ONE confirm, in BOTH course states", () => {
  for (const ahead of ["PENDING", "CONFIRMED"] as const) {
    test(`door 1 (a leave) on a course whose other sessions are ${ahead}: the make-up is MARKED, CONFIRMED, has \`confirmedAt\` and a check-in token, and the family AND the coach are told (\`booking_confirmed\`)`, async () => {
      const { w } = course(ahead);
      await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
      const m = makeupOf(w, "c1-b3");
      expect(m).toBeDefined();
      expect(m).toMatchObject({ isMakeup: true, status: "CONFIRMED", note: MAKEUP_NOTE_LEAVE });
      expect(m.confirmedAt).toBeInstanceOf(Date); // a confirm's own side effects…
      expect(typeof m.checkinToken).toBe("string"); // …the check-in token
      const told = outbox().filter((o) => o.bookingId === m.id && o.payload?.kind === "booking_confirmed");
      expect(told.map((o) => o.recipientType).sort()).toEqual(["parent", "teacher"]); // the NORMAL confirmed notice, both audiences
      expect(outbox().filter((o) => o.payload?.kind === "makeup_not_confirmed")).toHaveLength(0);
    });
  }
  test("door 2 (the plan editor's Mark absence) — the OTHER make-up writer (the reconcile append) — births the same way", async () => {
    const { w } = course("PENDING");
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b3", planned: true, reason: "ป่วย", override: true });
    const m = w.bookings.find((b: any) => b.isMakeup === true && b.extendedFromId === "c1-b3");
    expect(m).toMatchObject({ isMakeup: true, status: "CONFIRMED", note: MAKEUP_NOTE_RECONCILE });
    expect(outbox().filter((o) => o.bookingId === m.id && o.payload?.kind === "booking_confirmed").map((o) => o.recipientType).sort()).toEqual(["parent", "teacher"]);
  });
  test("the freelance HOLD is asked for as a CONFIRMED draw, and BEFORE the status write (a refusal changes nothing)", async () => {
    const { w } = course("PENDING");
    const seen: Array<[string, string, string]> = [];
    spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (_tx: any, id: string, _t: string, status: string) => {
      seen.push([id, status, w.bookings.find((b: any) => b.id === id)?.status]);
    }) as any));
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    const m = makeupOf(w, "c1-b3");
    const draw = seen.find(([id]) => id === m.id)!;
    expect(draw.slice(0, 2)).toEqual([m.id, "CONFIRMED"]);
    expect(draw[2]).toBe("EXTENDED"); // at the moment of the draw the row was not yet CONFIRMED
  });
});

describe("🔴 N1 fallback (§3b) — when the confirm REFUSES the LEAVE must NOT fail: the make-up stays EXTENDED + marked, and the admins are told once", () => {
  const refuse = (why: ApiException) => spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (_tx: any, id: string) => { if (String(id).startsWith("x")) throw why; }) as any));
  test("the freelance budget is spent ⇒ the leave COMMITS, the make-up is created EXTENDED + marked, ONE admin notice, no `booking_confirmed` for it", async () => {
    const { w } = course("PENDING");
    refuse(new ApiException(409, "INSUFFICIENT_BUDGET", "งบชั่วโมงของครูไม่พอ"));
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false); // does NOT throw
    expect(w.bookings.find((b: any) => b.id === "c1-b3").status).toBe("SICK_LEAVE"); // the leave committed
    const m = makeupOf(w, "c1-b3");
    expect(m).toMatchObject({ isMakeup: true, status: "EXTENDED" }); // exactly as before this task
    expect(m.confirmedAt ?? null).toBeNull();
    const admin = outbox().filter((o) => o.payload?.kind === "makeup_not_confirmed");
    expect(admin).toHaveLength(1);
    expect(admin[0]).toMatchObject({ recipientType: "admin", bookingId: m.id, payload: { reason: "งบชั่วโมงของครูไม่พอ" } });
    expect(outbox().filter((o) => o.bookingId === m.id && o.payload?.kind === "booking_confirmed")).toHaveLength(0);
  });
  test("the coach is on advance leave that day ⇒ the same fallback", async () => {
    const { w } = course("PENDING");
    spies.push(spyOn(teacherLeaveLib, "assertNoCoachOnLeave").mockImplementation((async (_e: any, r: any) => { if (String(r.id).startsWith("x")) throw teacherLeaveLib.TEACHER_ON_LEAVE("Bank", r.date); }) as any));
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    expect(makeupOf(w, "c1-b3")).toMatchObject({ isMakeup: true, status: "EXTENDED" });
    expect(outbox().filter((o) => o.payload?.kind === "makeup_not_confirmed")).toHaveLength(1);
  });
  test("a NON-ApiException is a real fault and PROPAGATES (a half-written confirm is worse than none)", async () => {
    course("PENDING");
    spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (_tx: any, id: string) => { if (String(id).startsWith("x")) throw new Error("db exploded"); }) as any));
    await expect(sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false)).rejects.toThrow("db exploded");
  });
});

describe("🔴 THE TRIM (§3c) — reads the MARKER, trims the newest-dated LIVE MARKED make-up, and tells the family and the coach", () => {
  const t = () => bangkokNow().date;
  const trimWorld = (extra: any[]) => {
    const c = baseCourse("c1", plus(t(), -14));
    const rows = [row("c1-b1", "c1", plus(t(), -14), "ATTENDED"), row("c1-b2", "c1", plus(t(), -7), "ATTENDED"), row("c1-b3", "c1", plus(t(), 7), "CONFIRMED"), row("c1-b4", "c1", plus(t(), 14), "CONFIRMED"), ...extra];
    const w = world([c], rows);
    spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1, lineUserId: "U-coach" }]) as any));
    spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
    return w;
  };
  test("a CONFIRMED marked make-up is TRIMMED when the plan is over-long: CANCELLED with the trim note, and the family + the coach get the NORMAL cancel notices", async () => {
    const w = trimWorld([row("c1-mk", "c1", plus(t(), 21), "CONFIRMED", { isMakeup: true, extendedFromId: "c1-b3" })]);
    const out = await sched.reconcileCoursePlan(w.tx, "c1");
    expect(out.cancelled).toEqual(["c1-mk"]);
    expect(w.bookings.find((b: any) => b.id === "c1-mk")).toMatchObject({ status: "CANCELLED", note: MAKEUP_NOTE_TRIMMED });
    expect(kinds().sort()).toEqual(["parent:class_cancelled_parent", "teacher:class_cancelled_teacher"]);
  });
  test("NEWEST FIRST: with two marked make-ups and one too many, the later-dated one goes", async () => {
    const w = trimWorld([row("c1-mk1", "c1", plus(t(), 21), "CONFIRMED", { isMakeup: true, extendedFromId: "c1-b3" }), row("c1-mk2", "c1", plus(t(), 28), "CONFIRMED", { isMakeup: true, extendedFromId: "c1-b4" })]);
    w.bookings.find((b: any) => b.id === "c1-b4").status = "ATTENDED"; // …so the plan is exactly ONE over: b1,b2,b4 delivered + b3 + 2 make-ups = 6 > 4 ⇒ two over; keep it ONE over:
    w.bookings.find((b: any) => b.id === "c1-b3").status = "CANCELLED";
    const out = await sched.reconcileCoursePlan(w.tx, "c1");
    expect(out.cancelled).toEqual(["c1-mk2"]);
  });
  test("🔴 an ORDINARY CONFIRMED class is NEVER trimmed — the one thing a marker bug would break — however over-long the plan is", async () => {
    const w = trimWorld([row("c1-b5", "c1", plus(t(), 21), "CONFIRMED"), row("c1-b6", "c1", plus(t(), 28), "CONFIRMED")]); // 6 live, size 4, NO marked make-up
    const before = JSON.stringify(w.bookings);
    const out = await sched.reconcileCoursePlan(w.tx, "c1");
    expect(out.cancelled).toEqual([]);
    expect(JSON.stringify(w.bookings)).toBe(before);
    expect(outbox()).toHaveLength(0);
  });
  test("a LEGACY unconfirmed marked make-up (EXTENDED) is trimmed SILENTLY, byte-identical to before — it was never announced", async () => {
    const w = trimWorld([row("c1-mk", "c1", plus(t(), 21), "EXTENDED", { isMakeup: true, extendedFromId: "c1-b3" })]);
    const out = await sched.reconcileCoursePlan(w.tx, "c1");
    expect(out.cancelled).toEqual(["c1-mk"]);
    expect(outbox()).toHaveLength(0);
  });
  test("the planner by value: PENDING / CONFIRMED / EXTENDED marked make-ups are all trim candidates; an unmarked EXTENDED-status row is NOT (the marker decides, never the status)", () => {
    const S = (id: string, status: string, date: string, isMakeup: boolean): PlanSession => ({ id, status, date, extendedFromId: null, isMakeup, bookingType: "COURSE_PACKAGE" });
    for (const status of ["PENDING", "CONFIRMED", "EXTENDED"]) {
      const plan = planCourseMoves([S("a", "CONFIRMED", "2026-10-01", false), S("m", status, "2026-10-08", true)], 1);
      expect(plan.cancelIds).toEqual(["m"]);
    }
    expect(planCourseMoves([S("a", "CONFIRMED", "2026-10-01", false), S("e", "EXTENDED", "2026-10-08", false)], 1).cancelIds).toEqual([]);
  });
  test("`canInsert` reads the MARKER: a course at size with a CONFIRMED marked make-up can absorb an insert; one with only ordinary classes cannot", () => {
    const S = (id: string, status: string, isMakeup: boolean): PlanSession => ({ id, status, date: "2026-10-01", extendedFromId: null, isMakeup, bookingType: "COURSE_PACKAGE" });
    expect(canInsert([S("a", "CONFIRMED", false), S("m", "CONFIRMED", true)], 2)).toBe(true);
    expect(canInsert([S("a", "CONFIRMED", false), S("b", "CONFIRMED", false)], 2)).toBe(false);
    expect(canInsert([S("a", "CONFIRMED", false), S("e", "EXTENDED", false)], 2)).toBe(false); // an EXTENDED-status row that is not marked is not a make-up
  });
});

describe("🔴 THE MARKER on the wire — the booking DTO and the history kind", () => {
  const ROW: any = { id: "b1", date: "2026-10-02", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "CONFIRMED", teacher: { id: "t1", nickname: "Ek", name: "Ek" }, student: { id: "s1", name: "A", nickname: "A" }, subject: { id: "x", name: "Free" } };
  test("`isMakeup` is a boolean on the DTO: true when marked, false when not and when absent (never undefined)", () => {
    expect(toBookingDTO({ ...ROW, isMakeup: true }).isMakeup).toBe(true);
    expect(toBookingDTO({ ...ROW, isMakeup: false }).isMakeup).toBe(false);
    expect(toBookingDTO({ ...ROW }).isMakeup).toBe(false);
  });
  test("history: a LIVE marked row is the appended make-up (whatever its status); a delivered / cancelled one keeps its own kind", () => {
    for (const status of ["PENDING", "CONFIRMED", "EXTENDED"]) expect(bookingEventKind({ status, bookingType: "COURSE_PACKAGE", isMakeup: true })).toBe("makeup-appended");
    expect(bookingEventKind({ status: "ATTENDED", bookingType: "COURSE_PACKAGE", isMakeup: true })).toBe("attended");
    expect(bookingEventKind({ status: "CANCELLED", bookingType: "COURSE_PACKAGE", isMakeup: true })).toBe("cancelled");
    expect(bookingEventKind({ status: "CONFIRMED", bookingType: "COURSE_PACKAGE", isMakeup: false })).toBe("scheduled");
  });
});

describe("🔴 THE MIGRATION `0066` — its SQL pinned by value: the populations (ONE list), the checks, the RAISE, no status write", () => {
  const SQL = readFileSync(resolve(import.meta.dir, "../../drizzle/0066_booking_is_makeup.sql"), "utf8").replace(/\r\n/g, "\n");
  const stmts = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  test("the four notes, BY THEIR BYTES (a constant edited by accident fails here, not on the customer's data)", () => {
    expect([...MAKEUP_BIRTH_NOTES]).toEqual(["คาบขยายอัตโนมัติจากการปรับแผนคอร์ส", "คาบขยายอัตโนมัติจากการลา"]);
    expect([...MAKEUP_CANCEL_NOTES]).toEqual(["ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)", "ยกเลิกคาบขยาย — ย้อนกลับการลา"]);
    expect([MAKEUP_NOTE_RECONCILE, MAKEUP_NOTE_LEAVE, MAKEUP_NOTE_TRIMMED, MAKEUP_NOTE_UNDONE]).toEqual(["คาบขยายอัตโนมัติจากการปรับแผนคอร์ส", "คาบขยายอัตโนมัติจากการลา", "ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)", "ยกเลิกคาบขยาย — ย้อนกลับการลา"]);
  });
  test("the migration's population text IS `makeupPopulationSql()` — the UPDATE and the four checks each carry it VERBATIM (one list, no second copy)", () => {
    const P = makeupPopulationSql();
    expect(stmts.split(P).length - 1).toBe(5); // UPDATE · missed · extra · expected · suspect
    expect(P).toBe(`"status" = 'EXTENDED' OR "extended_from_id" IS NOT NULL OR "note" IN ('คาบขยายอัตโนมัติจากการปรับแผนคอร์ส', 'คาบขยายอัตโนมัติจากการลา') OR ("status" = 'CANCELLED' AND "note" IN ('ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)', 'ยกเลิกคาบขยาย — ย้อนกลับการลา'))`);
  });
  test("the column, the backfill over COURSE_PACKAGE only, the three checks + the suspect check, and the RAISE that rolls the file back", () => {
    expect(stmts).toContain('ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "is_makeup" boolean NOT NULL DEFAULT false;');
    expect(stmts).toMatch(/UPDATE "bookings" SET "is_makeup" = true\s+WHERE "booking_type" = 'COURSE_PACKAGE' AND \(/);
    for (const v of ["missed", "extra", "marked", "expected", "suspect"]) expect(stmts).toContain(`${v} bigint;`);
    expect(stmts).toContain("IF missed <> 0 OR extra <> 0 OR marked <> expected OR suspect <> 0 THEN");
    expect(stmts).toContain("RAISE EXCEPTION 'is_makeup backfill REFUSED — missed=% extra=% marked=% expected=% suspect=%");
    expect(stmts).toContain("missed, extra, marked, expected, suspect;"); // the numbers ride the exception
    expect(stmts).toContain(makeupSuspectSql().replace(/^"booking_type" = 'COURSE_PACKAGE' AND /, "\"booking_type\" = 'COURSE_PACKAGE' AND "));
  });
  test("🚫 NO status is rewritten (a flip cannot issue tokens, holds or notices — forward-only), and it touches no other table", () => {
    expect(stmts).not.toMatch(/SET\s+"status"/);
    expect(stmts).not.toMatch(/\b(INSERT|DELETE|DROP|TRUNCATE)\b/i);
    expect(stmts.match(/ALTER TABLE "(\w+)"/g)).toEqual(['ALTER TABLE "bookings"']);
  });
  test("the owner's reads are GENERATED from the same list (step 0's note read, §2d's counts) — and each carries the four notes", () => {
    for (const n of [...MAKEUP_BIRTH_NOTES, ...MAKEUP_CANCEL_NOTES]) expect(MAKEUP_COUNT_READ_SQL).toContain(n);
    expect(MAKEUP_COUNT_READ_SQL).toContain(makeupPopulationSql());
    expect(MAKEUP_NOTES_READ_SQL).toContain("note LIKE '%ขยาย%'");
    expect(MAKEUP_COUNT_READ_SQL).toMatch(/AS p1,[\s\S]*AS p2,[\s\S]*AS p3,[\s\S]*AS p4,[\s\S]*AS union_/);
  });
  test("journal + witness: registered, the COLUMN is the witness, NOT rerunnable (and why)", async () => {
    const J = JSON.parse(readFileSync(resolve(import.meta.dir, "../../drizzle/meta/_journal.json"), "utf8"));
    expect(J.entries.at(-1)).toMatchObject({ idx: 66, tag: "0066_booking_is_makeup" });
    const { SCHEDULING_WITNESSES } = await import("../lib/migration-witness");
    expect(SCHEDULING_WITNESSES.find((x: any) => x.tag === "0066_booking_is_makeup")).toMatchObject({ probe: { kind: "column", table: "bookings", column: "is_makeup" }, rerunnable: false });
  });
});

describe("🔴 THE CLASSIFICATION (§3c) — every reader of `EXTENDED`, each ONE question, pinned by source: MAKE-UP? ⇒ the MARKER · UNCONFIRMED / ANNOUNCED / LIVE? ⇒ the STATUS", () => {
  const SRC = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8")).replace(/\r\n/g, "\n");
  const CODE = (f: string) => SRC(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const T: Array<[string, string, "MARKER" | "STATUS", string]> = [
    ["src/lib/course-plan.ts", ".filter((s) => s.isMakeup && COURSE_LIVE.has(s.status))", "MARKER", "THE TRIM — newest-dated LIVE MARKED make-up first"],
    ["src/lib/course-plan.ts", "s.isMakeup && COURSE_LIVE.has(s.status)) //", "MARKER", "`canInsert` — is there a make-up to net out?"],
    ["src/lib/course-history.ts", "b.isMakeup === true && (b.status ===", "MARKER", "the history kind `makeup-appended` — is it a make-up?"],
    ["src/services/scheduler.service.ts", "if (row.isMakeup === true) console.info(", "MARKER", "`reowedForOf` — an unlinked MAKE-UP says so"],
    ["src/services/scheduler.service.ts", "(current as any).isMakeup === true ? await sameSlotOfReplan(", "MARKER", "door 4 / TASK-551's same-slot rule — a cancelled MAKE-UP"],
    ["src/services/scheduler.service.ts", "trimmed.isMakeup === true && trimmed.status === \"CONFIRMED\"", "MARKER", "the trim's notice — an announced make-up"],
    ["src/lib/course-plan.ts", 'export const COURSE_LIVE_STATUSES = ["PENDING", "CONFIRMED", "EXTENDED"] as const;', "STATUS", "the LIVE set — is this STATUS still owed / scheduled?"],
    ["src/lib/attention.ts", 'const ORPHAN_LIVE = new Set(["PENDING", "CONFIRMED", "EXTENDED"]);', "STATUS", "attention — is the row LIVE?"],
    ["src/lib/booking-undo.ts", 'if (m.status !== "EXTENDED" && m.status !== "CONFIRMED" && m.status !== "PENDING") throw conflict("UNDO_MAKEUP_STATE"', "STATUS", "the Undo — a make-up in an undoable STATE"],
    ["src/lib/bulk-confirm.ts", 'if (booking.status === "PENDING" || booking.status === "EXTENDED") return { proceed: true };', "STATUS", "bulk confirm — is it UNCONFIRMED?"],
    ["src/lib/freelance-budget.ts", 'const FREELANCE_CONSUMING_STATUSES = new Set(["CONFIRMED", "ATTENDED", "EXTENDED"]);', "STATUS", "the hold — does this STATUS consume an hour?"],
    ["src/services/scheduler.service.ts", 'if (current.status !== "CONFIRMED" && current.status !== "EXTENDED") return null;', "STATUS", "the cancel notices (coach · family) — was it ANNOUNCED / held?"],
    ["src/services/scheduler.service.ts", 'if (before.status !== "CONFIRMED" && before.status !== "EXTENDED") return;', "STATUS", "the move notice — was it ANNOUNCED / held?"],
    ["src/services/scheduler.service.ts", 'const PAUSABLE_STATUSES = new Set(["PENDING", "CONFIRMED", "EXTENDED"]);', "STATUS", "pause — may this STATUS be paused?"],
    ["src/services/undo.service.ts", '(makeup.status === "EXTENDED" || makeup.status === "CONFIRMED")', "STATUS", "the Undo's coach notice — was it HELD (announced)?"],
  ];
  for (const [file, needle, kind, why] of T) {
    test(`${kind.padEnd(6)} · ${file} · ${why}`, () => {
      expect(CODE(file)).toContain(needle);
    });
  }
  test("the table is not a count: no OTHER production reader asks `status === \"EXTENDED\"` as a MAKE-UP question — every remaining mention is in the table or a comment", () => {
    const hits: string[] = [];
    for (const f of ["src/lib/course-plan.ts", "src/lib/course-history.ts", "src/lib/attention.ts", "src/lib/booking-undo.ts", "src/lib/bulk-confirm.ts", "src/lib/freelance-budget.ts", "src/services/scheduler.service.ts", "src/services/undo.service.ts"]) {
      CODE(f).split("\n").forEach((l) => { if (/status\s*[!=]==\s*"EXTENDED"|"EXTENDED"\]/.test(l) && !/isMakeup/.test(l)) hits.push(`${f}: ${l.trim().slice(0, 100)}`); });
    }
    // every hit must be one of the STATUS rows above (+ the writers' own insert `status: "EXTENDED"` is not a comparison)
    const allowed = T.filter((r) => r[2] === "STATUS").map((r) => r[1].slice(0, 40));
    for (const h of hits) expect({ h, ok: allowed.some((a) => h.includes(a.slice(0, 25))) || /status === "EXTENDED"\)?\s*\{?$|case "EXTENDED"|\.status !== "EXTENDED"/.test(h) }).toMatchObject({ ok: true });
  });
});

describe("📋 §3d — the admins' fallback notice (DRAFT, owner approval pending): both languages, no raw placeholder", () => {
  const m = (lang: "TH" | "EN") => formatOutboxMessage({ kind: "makeup_not_confirmed", reason: "งบชั่วโมงของครูไม่พอ" } as any, { studentName: "Mali", date: "2026-11-25" } as any, lang);
  test("TH / EN", () => {
    expect(m("TH")).toBe("🔔 คาบชดเชยของ Mali วันที่ 25-11-2026 ยังไม่ได้ยืนยัน (งบชั่วโมงของครูไม่พอ) — กรุณายืนยันคาบนี้");
    expect(m("EN")).toBe("🔔 Make-up for Mali on 25-11-2026 is NOT confirmed (งบชั่วโมงของครูไม่พอ) — please confirm it.");
    for (const lang of ["TH", "EN"] as const) expect(formatOutboxMessage({ kind: "makeup_not_confirmed" } as any, {}, lang)).not.toMatch(/[{}]/);
  });
  test("marked DRAFT beside the key", () => {
    expect(readFileSync(resolve(import.meta.dir, "../lib/line-i18n.ts"), "utf8")).toMatch(/TASK-702 \(REQ-115\) — the ADMINS are told[\s\S]*📋 DRAFT: owner approval pending/);
  });
});
