// TASK-646 (QA F3, TEST-077 — @Tanya, on two fresh courses) — A FREE PRE-START ABSENCE MUST STRETCH THE EXPIRY.
//
// 🔴 What this file exists to prevent happening again: TASK-609 copied HALF of the at-creation shape — the FREE half
//    (`plannedAtCreation` + `leaveCharged: false`) — and not the STRETCH half. The declaration path appended a make-up and
//    left `expiryDate` where it was, so the make-ups landed PAST the expiry.
// 🔑 And why it was not caught: TASK-643 §3b proved the stretch ON THE FUNCTION (`courseBornCeiling`), while its name and its
//    report claimed the PATH. **A test named for the behaviour that exercises only a helper is how this got through.**
//    ⇒ Everything below drives the REAL `updateBookingStatus` over a fake transaction. 🚫 Nothing here calls `courseBornCeiling`.
// ⚠️ It only broke when the CAP went: the base expiry carries the quota's weeks as slack, so while at most `quota` declared
//    days were allowed, their make-ups fitted exactly inside it. **The cap was load-bearing.**
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as rental from "./rental.service";
import * as lineLib from "../lib/line";
import { courseLeaveQuota } from "../lib/leave";
import { courseExpiry } from "../lib/recurring"; // the stored base, from the rule itself — never hand-rolled here

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
const KEY: Record<string, string> = { bookings: "bookings", course_packages: "courses" };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const WEEK = 7 * 24 * 3600 * 1000;
const plus = (d: string, weeks: number) => new Date(Date.parse(d) + weeks * WEEK).toISOString().slice(0, 10);
const weeksBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / WEEK);

const START = "2026-11-02"; // every session is in the FUTURE ⇒ the course has NOT started
const SIZE = 4;
const T = "t1t1t1t1-t1t1-41t1-81t1-t1t1t1t1t1t1";

/** A not-started course with `SIZE` weekly sessions, and the expiry the creation path would have given it. */
function world(baseExpiry: string) {
  const bookings = Array.from({ length: SIZE }, (_, i) => ({
    id: `b${i + 1}`, status: "PENDING", date: plus(START, i), startTime: "10:00:00", endTime: "11:00:00",
    teacherId: T, studentId: "s1", coStudentId: null, subjectId: "sub1", courseId: "c1", voucherId: null,
    bookingType: "COURSE_PACKAGE", note: null, plannedAtCreation: false, leaveCharged: null,
    checkinSource: null, checkinChannel: null, checkinActor: null, campWeekDayId: null, extendedFromId: null, groupId: null,
  }));
  const courses = [{ id: "c1", size: SIZE, startDate: START, expiryDate: baseExpiry, usedSessions: 0, leaveUsed: 0, leaveQuota: null, status: "ACTIVE", adminUnlocked: false, priorSessions: 0, classRateMinor: null }];
  const w: any = { bookings, courses, inserts: [] as any[] };
  const withRels = (r: any) => r && ({ ...r, course: w.courses.find((c: any) => c.id === r.courseId) ?? null, voucher: null });
  const tx: any = {
    query: {
      bookings: {
        findFirst: async ({ where }: any) => {
          const probe: any[] = [];
          try { where({ id: "id", courseId: "courseId", date: "date", teacherId: "teacherId", startTime: "startTime", status: "status", extendedFromId: "extendedFromId" }, { and: (...a: any[]) => a, eq: (c: any, v: any) => { probe.push([String(c), v]); return v; }, ne: () => null, notInArray: () => null, inArray: () => null, or: () => null, isNull: () => null, gte: () => null, lte: () => null }); } catch {}
          const id = probe.find((x) => x[0] === "id")?.[1];
          return withRels(w.bookings.find((b: any) => b.id === id)) ?? null;
        },
        findMany: async ({ orderBy, limit }: any) => {
          // every read on this path is "the rows of this course" — the fake answers them all from the world, newest-first when asked
          let rows = w.bookings.filter((b: any) => b.courseId === "c1" && b.status !== "CANCELLED");
          if (orderBy) rows = [...rows].sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
          return limit ? rows.slice(0, limit) : rows;
        },
      },
      teacherLeaveDays: { findFirst: async () => undefined },
      teachers: { findFirst: async () => ({ id: T, nickname: "Bank", name: "Bank", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: null }) },
      coursePackages: { findFirst: async () => w.courses[0] },
      appSettings: { findMany: async () => [], findFirst: async () => null },
      jobRuns: { findFirst: async () => null, findMany: async () => [] },
      boItem: { findMany: async () => [] },
      // the notice side of the path: present so it RUNS, empty so it proves nothing here (TASK-647 is where it is proven)
      students: { findFirst: async () => ({ id: "s1", nickname: "Mali", name: "Mali", parentId: "p1" }), findMany: async () => [] },
      parents: { findFirst: async () => ({ id: "p1", lineUserId: null }), findMany: async () => [] },
      familyLineLinks: { findMany: async () => [], findFirst: async () => null },
      notificationOutbox: { findFirst: async () => null, findMany: async () => [] },
    },
    update: (t: any) => ({ set: (set: Record<string, unknown>) => ({ where: (cond: any) => {
      const { sql, params } = dialect.sqlToQuery(cond);
      const conds = [...sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)].map((m) => ({ col: camel(m[2]!), val: params[Number(m[3]) - 1] }));
      // tables this path touches that the world does not model (CRM points, etc.) are accepted and ignored — the claims here
      // are about `bookings` and `course_packages`, and a fake that THROWS on an unmodelled table tests the fake, not the path
      const rows = ((w as any)[KEY[getTableName(t)] ?? "__other"] ?? []) as any[];
      const hits = rows.filter((r) => conds.every((c) => r[c.col] === c.val));
      for (const r of hits) for (const [k, v] of Object.entries(set)) {
        if (v && typeof v === "object" && "queryChunks" in (v as object)) { r[k] = (r[k] ?? 0) + 1; continue; }
        r[k] = v;
      }
      const out = hits.map((r) => ({ id: r.id }));
      return Object.assign(Promise.resolve(out), { returning: async () => out });
    } }) }),
    insert: (t: any) => ({ values: (v: any) => {
      const table = getTableName(t);
      if (table === "bookings") { const row = { ...v, id: `x${w.bookings.length + 1}`, status: v.status ?? "EXTENDED" }; w.bookings.push(row); w.inserts.push(row); return Object.assign(Promise.resolve(), { returning: async () => [{ id: row.id }] }); }
      w.inserts.push({ table, v });
      return Object.assign(Promise.resolve(), { returning: async () => [{ id: "x" }], onConflictDoNothing: async () => {} });
    } }),
    delete: () => ({ where: async () => {} }),
    // the coach-notice read (`teachersOfBooking`) chains `.limit()` and `.innerJoin()`; it answers nobody here on purpose
    select: () => { const q: any = { from: () => q, where: () => q, limit: async () => [], innerJoin: async () => [] }; return q; },
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => withRels(w.bookings[0])) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async (_e: any, id: string) => ({ id })) as any));
  spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_tx: any, _t: string, _st: string, after: string) => plus(after, 1)) as any));
  spies.push(spyOn(rental, "inheritCourseRental").mockImplementation((async () => {}) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async () => ({ status: "queued" }) as any)) as any);
  return w;
}

const declare = (id: string) => sched.updateBookingStatus(id, "sick-leave", "ลาล่วงหน้า", false);
const expiry = (w: any) => w.courses[0].expiryDate as string;
const makeups = (w: any) => w.bookings.filter((b: any) => b.extendedFromId).map((b: any) => b.date as string);

describe("🔴 TASK-646 — ON THE PATH: declaring a pre-start day stretches the expiry, and the make-up lands inside it", () => {
  const QUOTA = courseLeaveQuota({ size: SIZE });
  // ⚠️ The base is taken from the REAL rule, not computed here. My first version wrote `START + size + quota` weeks by hand and
  // the stretch test passed VACUOUSLY: that guess sits a week PAST what creation stores, so the first declaration's new ceiling
  // was not greater than it and nothing was written. 🔑 **A fixture that hand-rolls the rule under test can hide the bug it is for.**
  const BASE = courseExpiry(START, SIZE); // exactly what the creation path stores for a plan with no declared absences

  test("🔑 ONE declared day: the expiry moves by exactly ONE week, and its make-up is on or before it", async () => {
    const w = world(BASE);
    await declare("b1");
    expect(weeksBetween(BASE, expiry(w))).toBe(1);
    expect(makeups(w)).toHaveLength(1);
    for (const m of makeups(w)) expect({ m, inside: m <= expiry(w) }).toEqual({ m, inside: true });
    // …and the day itself is still FREE — the half TASK-609 got right is untouched
    expect(w.bookings[0]).toMatchObject({ status: "SICK_LEAVE", plannedAtCreation: true, leaveCharged: false });
    expect(w.courses[0].leaveUsed).toBe(0); // 🔑 a declaration is still not paid out of the counter
  });

  test("🔴 TANYA'S CASE — `quota + 3` declared days: stretched by exactly that many weeks, EVERY make-up inside it", async () => {
    const over = QUOTA + 3;
    const w = world(BASE);
    // the course needs enough sessions to declare that many — born with `over + 1` weekly rows
    w.bookings.length = 0;
    for (let i = 0; i < over + 1; i++) w.bookings.push({ id: `b${i + 1}`, status: "PENDING", date: plus(START, i), startTime: "10:00:00", endTime: "11:00:00", teacherId: T, studentId: "s1", coStudentId: null, subjectId: "sub1", courseId: "c1", voucherId: null, bookingType: "COURSE_PACKAGE", note: null, plannedAtCreation: false, leaveCharged: null, checkinSource: null, checkinChannel: null, checkinActor: null, campWeekDayId: null, extendedFromId: null, groupId: null });
    for (let i = 0; i < over; i++) await declare(`b${i + 1}`);
    expect(w.bookings.filter((b: any) => b.plannedAtCreation)).toHaveLength(over);
    // 🔴 the number QA found missing: exactly one week per declared day
    expect(weeksBetween(BASE, expiry(w))).toBe(over);
    expect(makeups(w)).toHaveLength(over);
    for (const m of makeups(w)) expect({ m, inside: m <= expiry(w) }).toEqual({ m, inside: true });
    // 🚫 and the quota counter never moved — unlimited free days, as the owner ruled
    expect(w.courses[0].leaveUsed).toBe(0);
  });

  test("⚠️ the expiry NEVER SHRINKS, and that is a DECISION: undoing a declaration does not give the week back", async () => {
    const w = world(BASE);
    await declare("b1");
    const stretched = expiry(w);
    expect(weeksBetween(BASE, stretched)).toBe(1);
    // the Undo's own path puts the row back; whatever else it does, it must not pull the window in under a family
    w.bookings[0]!.status = "CONFIRMED";
    w.bookings[0]!.plannedAtCreation = false;
    await declare("b2"); // a second declaration recomputes from the course's facts…
    expect(Date.parse(expiry(w))).toBeGreaterThanOrEqual(Date.parse(stretched)); // …and never pulls it back
    // 🔑 Deliberate, and stated at the line: a make-up may already have been placed inside the widened window, so shrinking
    // could strand a session the family is holding. 🚫 If a lift should reclaim the week, that is the owner's call, not arithmetic.
  });

  test("🚫 a STARTED course is untouched by any of this — the stretch rides the DECLARATION, not every leave", async () => {
    const w = world(BASE);
    w.bookings[0]!.status = "ATTENDED"; // one session delivered ⇒ the course has started
    await declare("b2");
    expect(expiry(w)).toBe(BASE); // no stretch…
    expect(w.bookings[1]).toMatchObject({ status: "SICK_LEAVE", plannedAtCreation: false }); // …because it is an ordinary leave
    expect(w.courses[0].leaveUsed).toBe(1); // …and THAT one is paid out of the counter
  });
});

describe("🔑 TASK-646 — ONE formula, in the same transaction, and the comment that lied is gone", () => {
  const SRC = readSrc();
  function readSrc() {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    return readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
  }
  const REGION = (() => {
    const at = SRC.indexOf("if (declaredFree) {");
    if (at < 0) throw new Error("the stretch block is missing"); // 🔑 the anchor is checked before it is sliced on
    return SRC.slice(at, at + 2000);
  })();
  test("it is `courseBornCeiling` — 🚫 no second formula and no inline `+ 7`", () => {
    expect(REGION).toContain("courseBornCeiling(courseExpiry(current.course.startDate, current.course.size), lastPlanned, declared)");
    expect(REGION).not.toMatch(/\+ 7|setDate\(|\* WEEK/);
    // the plan end EXCLUDES make-ups, exactly as the start-date change computes it — one shape, two callers
    expect(REGION).toContain("filter((r) => !r.extendedFromId)");
  });
  test("⚠️ the DECLARED COUNT is pinned at the SOURCE, because it cannot be told apart by value on this path — and that is said, not hidden", () => {
    // 🔑 Mutation X4 (`const declared = 1`) SURVIVED every value assertion above. The reason is worth writing down: the ceiling is
    // `max(born, last row)`, and each declaration appends a make-up a week after the last row — so the MAKE-UP CHAIN produces the
    // same date as the declared term in every scenario this path can reach. **Two different rules, one observable number.**
    // 🚫 I did not invent a scenario to force them apart: the honest statement is that at the path level they are indistinguishable,
    // so the term is pinned where it IS distinguishable — its own line — and X4 bites on this assertion rather than on a value.
    expect(REGION).toContain('const declared = (planRows as any[]).filter((r) => r.status === "SICK_LEAVE" && r.plannedAtCreation).length;');
    // …and the two terms it is combined with, so a change to either is visible here
    expect(REGION).toContain("const next = born > lastAny ? born : lastAny;");
  });
  test("🔴 the write is INSIDE the declaration's transaction — same `tx`, not a follow-up", () => {
    expect(REGION).toContain("await tx.update(coursePackages).set({ expiryDate: next }).where(eq(coursePackages.id, current.courseId));");
  });
  test("⚠️ the never-shrink decision is STATED at the line, not left as an accident of the function", () => {
    expect(REGION).toContain("if (next > current.course.expiryDate) {");
    expect(REGION).toContain("lifting or undoing a declaration does NOT give the week back");
  });
  test("🚫 and TASK-643's FALSE comment is gone — it is the sentence that made this gap read as closed", () => {
    expect(SRC).not.toContain("⚠️ What BOUNDS a pre-start course now is the expiry, not a count: `courseBornCeiling` stretches it by one week per declared");
  });
});
