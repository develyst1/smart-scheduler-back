// TASK-710 (REQ-115 FINAL ROUND 1) — a cancelled make-up the re-plan puts back in the SAME slot sends NO second «CONFIRMED SCHEDULE». The replacement is born CONFIRMED inside the re-plan,
// BEFORE the admin-cancel branch can ask TASK-551's decider (`sameSlotReplacement`) whether anything changed — so its confirm notices were already queued. The fix HOLDS them and flushes under the
// SAME decider as the cancel notice: family ⇐ `slot.family`, coach ⇐ `slot.coach`. The replacement is CONFIRMED either way; only the message is held.
// 🔑 Driven through the REAL `updateBookingStatus` + the REAL re-plan over the 702 world (search stand-in: first free week, a CANCELLED row holds nothing).
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
import * as familyLink from "../lib/family-link";

const STAFF = { channel: "staff" as const, actor: "admin-dong" };
const OTHER = "o2o2o2o2-o2o2-42o2-82o2-o2o2o2o2o2o2";
const today = bangkokNow().date;
/** a started 4-session course whose LAST live class is today's (b4): cancelling it leaves the search anchored on b3, whose +7 IS today ⇒ the replacement lands in the SAME slot. */
const lastClassToday = (over: any = {}) => {
  const c = baseCourse("c1", plus(today, -21));
  const w = world([c], [row("c1-b1", "c1", plus(today, -21), "ATTENDED"), row("c1-b2", "c1", plus(today, -14), "ATTENDED"), row("c1-b3", "c1", plus(today, -7), "ATTENDED"), row("c1-b4", "c1", today, "CONFIRMED", over)]);
  w.courses[0].expiryDate = plus(c.expiryDate, 90);
  return w;
};
const replacementOf = (w: any) => w.bookings.find((b: any) => b.id !== "c1-b4" && b.extendedFromId !== undefined && b.status !== "CANCELLED" && b.isMakeup === true);
const outbox = () => ((globalThis as any).__w.outbox as any[]);
const confirms = (id: string) => outbox().filter((o) => o.bookingId === id && o.payload?.kind === "booking_confirmed").map((o) => o.recipientType).sort();
const cancels = () => outbox().filter((o) => /^(class|makeup)_cancelled_(parent|teacher)$/.test(o.payload?.kind ?? "")).map((o) => `${o.recipientType}:${o.payload.kind}`).sort();
const coaches = (byRow: (id: string) => string[]) => spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async (_e: any, id: string) => byRow(id).map((c) => ({ id: c, lineUserId: `U-${c}` }))) as any));
const family = () => spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
const make = () => lastClassToday({ isMakeup: true, extendedFromId: "c1-b3" });

describe("🔴 F — the SAME slot: the replacement is CONFIRMED, and tells NOBODY a second time", () => {
  test("admin cancel (any reason but «ครูลา») of the last live make-up ⇒ replacement CONFIRMED + marked + token, ZERO booking_confirmed rows, ZERO cancel notices (TASK-551 intact)", async () => {
    const w = make(); family(); coaches(() => [T1]);
    await sched.updateBookingStatus("c1-b4", "cancel", "x", false, "ADMIN_ERROR", STAFF);
    const r = replacementOf(w);
    expect(r).toMatchObject({ date: today, status: "CONFIRMED", isMakeup: true });
    expect(r.confirmedAt).toBeInstanceOf(Date);
    expect(typeof r.checkinToken).toBe("string");
    expect(confirms(r.id)).toEqual([]);
    expect(cancels()).toEqual([]);
  });
  test("same date + time but a DIFFERENT coach ⇒ the FAMILY stays silent (their class did not move), the COACH is told (the decider's own split)", async () => {
    const w = make(); family();
    coaches((id) => (id === "c1-b4" ? [OTHER] : [T1]));
    await sched.updateBookingStatus("c1-b4", "cancel", "x", false, "ADMIN_ERROR", STAFF);
    const r = replacementOf(w);
    expect(r).toMatchObject({ date: today, status: "CONFIRMED" });
    expect(confirms(r.id)).toEqual(["teacher"]);
  });
});

describe("🔑 F — every OTHER path still announces", () => {
  test("a DIFFERENT slot («ครูลา» skips the day off ⇒ next week): the cancel AND the new CONFIRMED both go, family and coach", async () => {
    const w = make(); family(); coaches(() => [T1]);
    await sched.updateBookingStatus("c1-b4", "cancel", "ครูลา", false, "TEACHER_LEAVE", STAFF);
    const r = replacementOf(w);
    expect(r.date).toBe(plus(today, 7));
    expect(confirms(r.id)).toEqual(["parent", "teacher"]);
    expect(cancels().length).toBeGreaterThan(0);
  });
  test("an ORDINARY class (not a make-up) cancelled ⇒ never suppressed: the confirm of whatever the re-plan adds is sent as before", async () => {
    const w = lastClassToday({ isMakeup: false }); family(); coaches(() => [T1]);
    await sched.updateBookingStatus("c1-b4", "cancel", "x", false, "ADMIN_ERROR", STAFF);
    const r = w.bookings.find((b: any) => b.id !== "c1-b4" && b.isMakeup === true && b.status !== "CANCELLED");
    expect(confirms(r.id)).toEqual(["parent", "teacher"]);
  });
  test("the plan editor's Mark absence / the leave writer pass nothing to hold ⇒ the make-up's confirm is sent AT BIRTH, as before", async () => {
    const t = bangkokNow().date;
    const c = baseCourse("c1", plus(t, -14));
    const w2 = world([c], [row("c1-b1", "c1", plus(t, -14), "ATTENDED"), row("c1-b2", "c1", plus(t, -7), "ATTENDED"), row("c1-b3", "c1", plus(t, 7), "CONFIRMED"), row("c1-b4", "c1", plus(t, 14), "CONFIRMED")]);
    w2.courses[0].expiryDate = plus(c.expiryDate, 90); family(); coaches(() => [T1]);
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    const m = w2.bookings.find((b: any) => b.isMakeup === true && b.extendedFromId === "c1-b3");
    expect(confirms(m.id)).toEqual(["parent", "teacher"]);
  });
});

describe("🔑 F — by source: held notices are always flushed or silenced by name; only the admin's cancel asks for the hold", () => {
  const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8");
  test("the flush obeys slot.family for the family and slot.coach for the coach, once per held notice", () => {
    expect(S).toContain('for (const n of heldConfirm) if (!(n.audience === "parent" ? slot.family : slot.coach)) await n.send();');
  });
  test("the hold is passed by exactly ONE caller (the admin cancel); both writers' other paths stay immediate", () => {
    expect([...S.matchAll(/holdConfirmNotices: heldConfirm/g)]).toHaveLength(1);
    expect([...S.matchAll(/confirmMakeupAtBirth\(tx, ext\.id\)/g)]).toHaveLength(1); // the leave writer: no hold
    expect(S).toContain("confirmMakeupAtBirth(tx, ext.id, opts.holdConfirmNotices)");
  });
});
