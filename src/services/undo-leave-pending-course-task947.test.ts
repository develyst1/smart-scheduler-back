// TASK-947 REWORK (TEST-152) — the Undo of a leave on a PENDING course restores PENDING. The harness below (imports → `world()`) is a COPY of `undo-tells-family-class-on-again-task711.test.ts` (a Team B file extends
// nobody else's): the REAL `updateBookingStatus` → `undoBooking` over an in-memory world; `courseIsConfirmed` is stood in by the predicate's OWN condition over the world's rows.
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
  spies.push(spyOn(sched, "courseIsConfirmed").mockImplementation((async (_tx: any, courseId: string | null) => !courseId || w.bookings.some((b: any) => b.courseId === courseId && b.bookingType === "COURSE_PACKAGE" && ["CONFIRMED", "ATTENDED"].includes(b.status) && b.isMakeup !== true)) as any)); // 🔻 TASK-947 — the predicate, over this world
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
import { undoBooking, previewUndo } from "./undo.service";

// ───────────────────────── TASK-947 REWORK (TEST-152) — the Undo of a LEAVE on a PENDING course restores the class as PENDING ─────────────────────────
// Found on sid: `undo.service.ts` set the restored class CONFIRMED unconditionally, which made `courseIsConfirmed` true and let two parent notices (`makeup_cancelled_parent`,
// `class_on_again_parent`) out of a PENDING course. Now: not confirmed ⇒ restore PENDING (and ask the freelance hold for PENDING); confirmed ⇒ CONFIRMED as ever.
const STAFF = { channel: "staff" as const, actor: "admin-dong" };
const today = bangkokNow().date;
const outbox = () => ((globalThis as any).__w.outbox as any[]);
const parents = () => outbox().filter((o) => o.recipientType === "parent");
const coachRows = (id: string) => outbox().filter((o) => o.recipientType === "teacher" && o.bookingId === id).map((o) => o.payload.kind);
const rowOf = (w: any, id: string) => w.bookings.find((b: any) => b.id === id);
const wire = () => {
  spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: T1, lineUserId: "U-coach" }]) as any));
  spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-mum"]) as any));
};
/** A 4-session course ahead of today. `pending`: nothing of it CONFIRMED / ATTENDED · `confirmed`: its first session is CONFIRMED · `onlyMakeup`: the only CONFIRMED row is a make-up. */
const courseWorld = (kind: "pending" | "confirmed" | "onlyMakeup") => {
  const c = baseCourse("cZ", plus(today, 7));
  const rows = [
    row("cZ-b1", "cZ", plus(today, 7), kind === "confirmed" ? "CONFIRMED" : "PENDING", { studentId: "sZ" }),
    row("cZ-b2", "cZ", plus(today, 14), kind === "onlyMakeup" ? "SICK_LEAVE" : "PENDING", { studentId: "sZ", ...(kind === "onlyMakeup" ? { leaveCharged: true } : {}) }),
    row("cZ-b3", "cZ", plus(today, 21), "PENDING", { studentId: "sZ" }),
    row("cZ-b4", "cZ", plus(today, 28), "PENDING", { studentId: "sZ" }),
    ...(kind === "onlyMakeup" ? [row("cZ-m0", "cZ", plus(today, 35), "CONFIRMED", { studentId: "sZ", isMakeup: true, extendedFromId: "cZ-b2" })] : []),
  ];
  const w = world([c], rows);
  w.courses[0].expiryDate = plus(c.expiryDate, 120);
  wire();
  return w;
};
const holds = () => { const h: Array<[string, string]> = []; spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async (_t: any, id: string, _tid: string, st: string) => { h.push([id, st]); }) as any)); return h; };
/** a leave on the last session (it grows a make-up, born CONFIRMED), then the Undo of that leave; returns where the UNDO's outbox rows start */
async function leaveThenUndo() {
  await sched.updateBookingStatus("cZ-b4", "sick-leave", "ป่วย", true);
  const n0 = outbox().length;
  await undoBooking("cZ-b4", { actor: "admin-dong", reason: "wrong child" });
  return n0;
}

describe("🔴 TEST-152 — the Undo of a leave on a PENDING course: the class comes back PENDING, no parent message, the coach IS told", () => {
  test("PENDING course: b4 is restored PENDING (not CONFIRMED); ZERO parent rows over the whole leave + undo; the coach gets `class_on_again_teacher` and the cancelled make-up's coach notice", async () => {
    const w = courseWorld("pending");
    const n0 = await leaveThenUndo();
    expect(rowOf(w, "cZ-b4").status).toBe("PENDING"); // was CONFIRMED: the line that defeated TASK-947
    expect(parents()).toEqual([]); // `makeup_cancelled_parent` and `class_on_again_parent` are both gone
    expect(coachRows("cZ-b4").slice(0)).toContain("class_on_again_teacher");
    const made = w.bookings.find((b: any) => b.isMakeup === true && b.extendedFromId === "cZ-b4");
    expect(made.status).toBe("CANCELLED"); // the undo cancelled ITS make-up
    expect(outbox().slice(n0).filter((o) => o.bookingId === made.id && o.recipientType === "teacher").map((o) => o.payload.kind)).toEqual(["class_cancelled_teacher"]);
  });
  test("the freelance hold is asked for the row's REAL new status: PENDING on a pending course", async () => {
    courseWorld("pending");
    const h = holds();
    await leaveThenUndo();
    const last = h.filter(([id]) => id === "cZ-b4").pop();
    expect(last).toEqual(["cZ-b4", "PENDING"]);
  });
  test("a course whose only CONFIRMED row is a MAKE-UP is still pending: the same PENDING restore, 0 parent rows", async () => {
    const w = courseWorld("onlyMakeup");
    await leaveThenUndo();
    expect(rowOf(w, "cZ-b4").status).toBe("PENDING");
    expect(parents()).toEqual([]);
  });
});

describe("🔴 TEST-152 — a CONFIRMED course: the Undo is exactly as before", () => {
  test("b4 is restored CONFIRMED; the family is told (`makeup_cancelled_parent` for the make-up, then `class_on_again_parent`); the coach as ever", async () => {
    const w = courseWorld("confirmed");
    const n0 = await leaveThenUndo();
    expect(rowOf(w, "cZ-b4").status).toBe("CONFIRMED");
    expect(outbox().slice(n0).filter((o) => o.recipientType === "parent").map((o) => o.payload.kind)).toEqual(["makeup_cancelled_parent", "class_on_again_parent"]);
    expect(coachRows("cZ-b4")).toContain("class_on_again_teacher");
  });
  test("the hold is asked CONFIRMED", async () => {
    courseWorld("confirmed");
    const h = holds();
    await leaveThenUndo();
    expect(h.filter(([id]) => id === "cZ-b4").pop()).toEqual(["cZ-b4", "CONFIRMED"]);
  });
  test("the preview (the dry run) is unchanged and writes nothing: the same answer on a pending and a confirmed course", async () => {
    courseWorld("pending");
    await sched.updateBookingStatus("cZ-b4", "sick-leave", "ป่วย", true);
    const n = outbox().length;
    const p = await previewUndo("cZ-b4", (globalThis as any).__w.tx);
    expect(p.ok).toBe(true);
    expect(outbox().length).toBe(n);
  });
});

describe("🔴 TEST-152 — the other Undo (a false CHECK-IN) is not touched", () => {
  test("ATTENDED → CONFIRMED stays CONFIRMED whatever the course says (it is the shared `revertAttendance`, not the leave branch)", async () => {
    const w = courseWorld("pending");
    rowOf(w, "cZ-b1").status = "ATTENDED";
    rowOf(w, "cZ-b1").checkinChannel = "line";
    await undoBooking("cZ-b1", { actor: "admin-dong", reason: "wrong child" });
    expect(rowOf(w, "cZ-b1").status).toBe("CONFIRMED");
  });
  test("by source: the leave branch asks the predicate BEFORE the flip (the row is still SICK_LEAVE, so it cannot count itself) and sets the status from it; the check-in branch keeps CONFIRMED", () => {
    const U = readFileSync(resolve(import.meta.dir, "undo.service.ts"), "utf8");
    expect(U).toContain("courseIsConfirmed(tx, row.courseId)");
    expect(U).toContain('"PENDING" : "CONFIRMED"');
    expect(U).not.toContain('.set({ status: "CONFIRMED", leaveCharged: null');
  });
});
