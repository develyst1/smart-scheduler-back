// TASK-657 §3 (REQ-112 — the centre of the customer's model) — a make-up that lands PAST the course's expiry is CREATED, the expiry does NOT
// move, and the ADMIN is told, once per make-up, through a NEW notice beside `makeup_far_out`. Her words: «แจ้งแอดมินเท่านั้นค่ะ ที่เหลือเราจะ
// จัดการเองว่าจะยืดอายุคอร์สให้ไหมค่ะ». 🔑 Driven THROUGH the real entry points over the same fake transaction TASK-656's proof uses; what is
// asserted is what the outbox would hold. The harness below is TASK-656's (copied, because it is not exported) — keep the two in step.
//    DATABASE would end up holding: the expiry date, the expiry-change RECORDS, and the make-up ROWS. Nothing here calls
//    `addLeaveWeek` directly, so a door that forgets to call it fails — which a test of the helper could never see.
// 🔑 Per door, ONE assertion shape: expiry = base + exactly 7 days · exactly ONE expiry-change record (from → to, no actor) ·
//    exactly ONE make-up. Never +14 (a leave AND its re-owe both adding), never 0.
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
  slotYieldedAt: null, cancelReason: null, ...over,
});
const courseRows = (courseId: string, start: string, delivered = 0) =>
  Array.from({ length: SIZE }, (_, i) => row(`${courseId}-b${i + 1}`, courseId, plus(start, i * 7), i < delivered ? "ATTENDED" : "PENDING"));

/** The world: bookings + courses in memory, every write recorded. `expiryChanges` is what the audit table would hold. */
function world(courses: Course[], rows: any[]) {
  const w: any = {
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
    select: () => { const q: any = { from: () => q, where: () => q, limit: async () => [], innerJoin: async () => [] }; return q; },
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => withRels(w.bookings[0])) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => w.bookings.filter((b: any) => b.status !== "CANCELLED").map(withRels)) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async (_e: any, id: string) => ({ id })) as any));
  spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_tx: any, _t: string, _st: string, after: string) => plus(after, 7)) as any));
  spies.push(spyOn(rental, "inheritCourseRental").mockImplementation((async () => {}) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async () => ({ status: "queued" }) as any)) as any);
  w.tx = tx; // for the doors whose entry point TAKES a transaction (a group date's seats)
  return w;
}

const code = (x: string) => x.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
/** Every admin notice of the new kind that was enqueued (the world's `enqueueLine` spy records them). With no admin configured `notifyAdmins` writes ONE skipped row — still ONE per notice. */
const enq = () => ((lineLib.enqueueLine as any).mock.calls as any[]).map((c) => c[0]);
const past = () => enq().filter((p) => p?.payload?.kind === "makeup_past_expiry");
const far = () => enq().filter((p) => p?.payload?.kind === "makeup_far_out");
const STARTED = () => plus(bangkokNow().date, -14);
/** A started 4-session course whose last class sits ON the expiry — so ANY make-up lands past it (HER case: ordinary leaves are unlimited). */
const startedCourse = () => {
  const t = bangkokNow().date;
  const c = baseCourse("c1", STARTED());
  const rows = [row("c1-b1", "c1", plus(t, -14), "ATTENDED"), row("c1-b2", "c1", plus(t, -7), "ATTENDED"), row("c1-b3", "c1", plus(t, 7)), row("c1-b4", "c1", plus(t, 14))];
  return { c, rows, w: world([c], rows) };
};
const landAt = (days: number) => spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_t: any, _s: string, _x: string, after: string) => plus(after, days)) as any));

describe("🔴 §3 — a make-up that cannot fit ⇒ the ADMIN is told, once, and NOTHING extends (her words: «แจ้งแอดมินเท่านั้นค่ะ»)", () => {
  test("door 1, an ORDINARY leave on a course whose last class is the expiry: the make-up is CREATED past it, the expiry does NOT move, ONE notice", async () => {
    const { c, w } = startedCourse();
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    const makeup = w.bookings.find((b: any) => b.extendedFromId);
    expect(makeup).toBeDefined(); // 🔑 created — never held, never refused
    expect(makeup.date > c.expiryDate).toBe(true);
    expect(w.courses[0].expiryDate).toBe(c.expiryDate); // 🔴 nothing extended
    expect(past()).toHaveLength(1);
    expect(past()[0]).toMatchObject({ recipientType: "admin", bookingId: makeup.id, payload: { kind: "makeup_past_expiry", landedOn: makeup.date, expiry: c.expiryDate } });
  });

  test("🔑 a make-up INSIDE the expiry warns NOBODY — a warning that fires every time is not a warning", async () => {
    const { w } = startedCourse();
    landAt(-4); // lands a few days before the last class — comfortably inside
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    expect(w.bookings.find((b: any) => b.extendedFromId)).toBeDefined();
    expect(past()).toHaveLength(0);
  });

  test("🔴 ONCE PER MAKE-UP — two ordinary leaves ⇒ two make-ups ⇒ two notices (never one per door, never three)", async () => {
    const { w } = startedCourse();
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    await sched.updateBookingStatus("c1-b4", "sick-leave", "ป่วย", false);
    expect(w.bookings.filter((b: any) => b.extendedFromId)).toHaveLength(2);
    expect(past()).toHaveLength(2);
    expect(new Set(past().map((p) => p.bookingId)).size).toBe(2);
  });

  test("🔑 ASKED AFTER THE WEEK — a declared pre-start absence whose make-up lands past the BASE expiry but inside the week it earned raises NOTHING", async () => {
    // The base expiry is start+28; the declaration adds a week (T1 ⇒ start+35); the make-up lands on start+35. Asked BEFORE the week it would
    // have shouted about a class the new week already covers — which is why the check is the caller's, after its week decision.
    const c = baseCourse("c1", FUTURE);
    const w = world([c], courseRows("c1", FUTURE));
    landAt(14); // after = start+21 (the last class) ⇒ start+35
    await sched.updateBookingStatus("c1-b1", "sick-leave", "ลาล่วงหน้า", false);
    expect(w.courses[0].expiryDate).toBe(plus(c.expiryDate, 7));
    expect(w.bookings.find((b: any) => b.extendedFromId)!.date).toBe(plus(FUTURE, 35));
    expect(past()).toHaveLength(0);
  });

  test("…and one that lands PAST even the earned week tells the admin", async () => {
    const c = baseCourse("c1", FUTURE);
    const w = world([c], courseRows("c1", FUTURE));
    landAt(21); // start+42 > start+35
    await sched.updateBookingStatus("c1-b1", "sick-leave", "ลาล่วงหน้า", false);
    expect(past()).toHaveLength(1);
    expect(w.courses[0].expiryDate).toBe(plus(c.expiryDate, 7)); // the week the trigger earned — and nothing more
  });

  test("door 2 (the plan editor), an ordinary mark-absence ⇒ ONE notice", async () => {
    const { c, w } = startedCourse();
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b4", planned: true, reason: "ป่วย", override: true });
    expect(w.courses[0].expiryDate).toBe(c.expiryDate);
    expect(past()).toHaveLength(1);
  });

  test("door 3 (a coach's leave) ⇒ ONE notice for the make-up it re-owes — after T2's own week", async () => {
    const t = bangkokNow().date;
    const c = baseCourse("c1", t);
    const w = world([c], courseRows("c1", t));
    const todays = w.bookings.filter((b: any) => b.date === t).map((b: any) => ({ ...b, course: w.courses[0], voucher: null, additionalTeachers: [], seats: [] }));
    spies.push(spyOn(ownScope, "assertLinked").mockImplementation((() => T1) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => todays) as any));
    landAt(28);
    await sched.reportTeacherLeave(T1, { date: t, reason: "ป่วย" }, "admin-dong", { onBehalf: true });
    expect(w.courses[0].expiryDate).toBe(plus(c.expiryDate, 7)); // T2's week, and only that
    expect(past()).toHaveLength(1);
  });

  test("door 4 (a school cancel, any reason) ⇒ ONE notice for the make-up the cancel re-owes", async () => {
    const { c, w } = startedCourse();
    // cancelling c1-b3 (not the LAST class): the re-owed class goes after the last one, which is ON the expiry
    await sched.updateBookingStatus("c1-b3", "cancel", "ยกเลิก", false, "CUSTOMER_CANCELLED");
    expect(w.courses[0].expiryDate).toBe(c.expiryDate);
    expect(past()).toHaveLength(1);
  });

  test("door 5 (each seat of a cancelled group date) ⇒ one notice per seat whose make-up lands past ITS course's expiry", async () => {
    const t = bangkokNow().date;
    const a = baseCourse("c1", plus(t, -14)), b = baseCourse("c2", plus(t, -14));
    const rows = [
      row("c1-b1", "c1", plus(t, -14), "ATTENDED"), row("c1-b2", "c1", plus(t, -7), "ATTENDED"), row("c1-b3", "c1", plus(t, 14)),
      row("c2-b1", "c2", plus(t, -14), "ATTENDED"), row("c2-b2", "c2", plus(t, -7), "ATTENDED"), row("c2-b3", "c2", plus(t, 14)),
      row("seat1", "c1", plus(t, 7), "CONFIRMED", { groupId: "g1" }), row("seat2", "c2", plus(t, 7), "CONFIRMED", { groupId: "g1" }),
    ];
    const w = world([a, b], rows);
    await sched.cancelSeatsOfGroup(w.tx, "g1", "ยกเลิกกลุ่ม");
    expect(w.courses.map((x: any) => x.expiryDate)).toEqual([a.expiryDate, b.expiryDate]); // nothing extended
    expect(past()).toHaveLength(2);
  });

  test("🔴 TWO DIFFERENT EVENTS — `makeup_far_out` still fires on EXHAUSTION alone (expiry far away), and the new notice does not", async () => {
    const { w } = startedCourse();
    w.courses[0].expiryDate = "2099-12-31";
    landAt(27 * 7); // the search surrendered: more than the 26 weeks it scans
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b4", planned: true, reason: "ป่วย", override: true });
    expect(far()).toHaveLength(1);
    expect(past()).toHaveLength(0);
  });

  test("…and the new notice fires on the EXPIRY alone — the search did not run out, so `makeup_far_out` stays quiet", async () => {
    const { w } = startedCourse();
    await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b4", planned: true, reason: "ป่วย", override: true });
    expect(past()).toHaveLength(1);
    expect(far()).toHaveLength(0);
    expect(w.bookings.filter((b: any) => b.extendedFromId)).toHaveLength(1);
  });

  test("🚫 the FAMILY is never told — every notice of the new kind is addressed to an admin", async () => {
    startedCourse();
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    for (const p of past()) expect(p.recipientType).toBe("admin");
    expect(enq().filter((p) => p?.recipientType === "parent" && p?.payload?.kind === "makeup_past_expiry")).toHaveLength(0);
  });
});

describe("📋 §3 — the DRAFT copy (owner approval pending), both languages, the product's date format", () => {
  const msg = (lang: "TH" | "EN") => formatOutboxMessage({ kind: "makeup_past_expiry", landedOn: "2026-11-25", expiry: "2026-11-18" } as any, { studentName: "Mali" } as any, lang);
  test("TH is the spec's sentence, with the dates in the product's dd-mm-yyyy (never raw ISO)", () => {
    expect(msg("TH")).toBe("คาบชดเชยของ Mali ถูกสร้างวันที่ 25-11-2026 ซึ่งเลยวันหมดอายุคอร์ส (18-11-2026) — เรียนได้ตามปกติ กรุณาตรวจสอบและขยายวันหมดอายุถ้าต้องการ");
  });
  test("EN is the spec's reading line", () => {
    expect(msg("EN")).toBe("Mali's make-up was created on 25-11-2026, past the course expiry (18-11-2026) — the class stands; please check and extend the expiry if you want to.");
  });
  test("a missing student/date renders `-`, never a raw `{placeholder}`", () => {
    for (const lang of ["TH", "EN"] as const) {
      const m = formatOutboxMessage({ kind: "makeup_past_expiry" } as any, {}, lang);
      expect(m).not.toMatch(/[{}]/);
    }
  });
  test("the draft is MARKED as a draft in the dictionary", () => {
    const I = readFileSync(resolve(import.meta.dir, "../lib/line-i18n.ts"), "utf8");
    expect(I).toContain("ob_makeup_past_expiry");
    expect(I).toMatch(/📋 DRAFT: owner\s+\/\/ approval pending/);
  });
});

describe("🔑 §3 — WHO ASKS: every re-plan caller is named, and the ones that deliberately do not ask are named too", () => {
  const SRC = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, f), "utf8")).replace(/\r\n/g, "\n");
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const SCHED = code(SRC("scheduler.service.ts"));
  const enclosing = (s: string, at: number) => {
    const head = s.slice(0, at).split("\n");
    for (let i = head.length - 1; i >= 0; i--) {
      const m = head[i]!.match(/^(?:export )?async function (\w+)\(/);
      if (m) return m[1]!;
    }
    return "?";
  };
  const where = (re: RegExp) => [...SCHED.matchAll(re)].map((m) => enclosing(SCHED, m.index!)).sort();

  test("the callers that ASK (after their week decision) — by function name", () => {
    expect(where(/await flagMakeupsPastExpiry\(tx, /g)).toEqual(["applyPlanChange", "cancelSeatsOfGroup", "reportTeacherLeave", "updateBookingStatus", "updateBookingStatus"]);
  });
  test("the re-plan callers that DO NOT ask, and why — a new one fails here with a name", () => {
    const replans = where(/reconcileCoursePlan\(tx, /g);
    const asks = new Set(where(/await flagMakeupsPastExpiry\(tx, /g));
    const silent = replans.filter((f) => !asks.has(f)).sort();
    // createCoursePackage (×2): BIRTH — the expiry is born to cover its declared absences, so a make-up it appends is inside by construction
    // applyPlanChange does ask (its mark-absence); its *insert* branch only TRIMS and appends nothing, in the same function.
    expect(silent).toEqual(["createCoursePackage", "createCoursePackage"].sort());
    // the Undo re-plans and REFUSES if anything would be appended — so nothing it creates can be past the expiry
    expect(code(SRC("undo.service.ts"))).toContain("if (moves.appended.length || moves.cancelled.length) throw UNDO_PLAN_WOULD_CHANGE();");
  });
  test("the check is once per make-up id, inside the caller's transaction (`tx`), through the SAME admin sender as the far-out notice", () => {
    const FN = SCHED.slice(SCHED.indexOf("async function flagMakeupsPastExpiry("), SCHED.indexOf("export async function reconcileCoursePlan("));
    expect(FN).toContain('await notifyAdmins({ kind: "makeup_past_expiry", bookingId: r.id, landedOn: r.date, expiry: course.expiryDate }, tx, r.id);');
    expect(FN).toContain("if (r.date <= course.expiryDate) continue;");
    expect(FN).not.toMatch(/\.update\(|\.insert\(/); // it TELLS; it moves nothing (her rule: the admin decides)
    expect(SCHED).toContain('kind: "makeup_far_out",'); // the OTHER notice is untouched and still there
    expect(SCHED.match(/kind: "makeup_past_expiry"/g)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 THE SID GATE, BY VALUE (`TASK-657` §R-gate — replaces `TASK-656` §6). The table @Tanya will hand-check on sid, run here through the REAL
// entry points so the numbers are known BEFORE she looks. Dates are RELATIVE (first session D = yesterday, session 1 delivered) because the
// gate's example date (Wed 2026-10-14) is a calendar fact of the hand-check, not of a test that must pass next month.
// Base expiry = D + 28 / 49 / 84 days for a 4 / 6 / 10-session course.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("🔴 THE SID GATE, by value — the owner's table, row by row (ordinary leaves +0 · coach's leave +14 · school-cancel +7 · other reason +0 · declared +7)", () => {
  const D = plus(bangkokNow().date, -1);
  const gateCourse = (n: number) => {
    const c: Course = { id: "c1", size: n, startDate: D, expiryDate: courseExpiry(D, n) };
    const rows = Array.from({ length: n }, (_, i) => row(`c1-b${i + 1}`, "c1", plus(D, i * 7), i === 0 ? "ATTENDED" : "PENDING"));
    return { c, w: world([c], rows) };
  };
  const expiry = (w: any) => w.courses[0].expiryDate;
  const coachLeaveOn = async (w: any, date: string) => {
    const todays = w.bookings.filter((b: any) => b.date === date && b.status === "PENDING").map((b: any) => ({ ...b, course: w.courses[0], voucher: null, additionalTeachers: [], seats: [] }));
    spies.push(spyOn(ownScope, "assertLinked").mockImplementation((() => T1) as any));
    (db.query.bookings.findMany as any).mockImplementation(async () => todays);
    return sched.reportTeacherLeave(T1, { date, reason: "ป่วย" }, "admin-dong", { onBehalf: true });
  };

  test("step 0 — the BASE expiry is D + 28 / 49 / 84 days", () => {
    for (const [n, days] of [[4, 28], [6, 49], [10, 84]] as const) expect(courseExpiry(D, n)).toBe(plus(D, days));
  });

  for (const n of [4, 6, 10]) {
    test(`${n}-session — steps 1 and 2: an ORDINARY leave on session 2 (the session's Record leave) and on session 3 (the plan modal's Mark absence) ⇒ +0, one make-up each`, async () => {
      const { c, w } = gateCourse(n);
      await sched.updateBookingStatus("c1-b2", "sick-leave", "ป่วย", false);
      expect(expiry(w)).toBe(c.expiryDate);
      await sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b3", planned: true, reason: "ป่วย", override: true });
      expect(expiry(w)).toBe(c.expiryDate);
      expect(w.inserts.filter((i: any) => i.table === "bookings")).toHaveLength(2); // one make-up per absence
      expect(w.expiryChanges).toHaveLength(0);
      expect(w.courses[0].leaveUsed).toBe(2); // a plain count — no "x of y", no lock
    });
  }

  test("10-session — step 3: the coach's leave over TWO classes ⇒ +14 (her \"15 weeks\") — ⚠️ driven through the coach's SAME-DAY door, because that is the only door that cancels", async () => {
    // 🔴 FLAGGED TO @Sober (not decided here): the gate says "an admin records the coach's leave on sessions 4 AND 5". The ADMIN's door is FUTURE-DAYS-ONLY
    // since TASK-648 and is an ADVANCE LEAVE — it blocks the day and cancels NOTHING (so it adds no week: pinned below). The door that cancels classes
    // — and so earns T2 — is the coach's OWN same-day leave. On sid, Tanya can reach +14 only by logging in as the coach on the day, or the model must
    // also earn when an admin cancels a class with the reason TEACHER_LEAVE (door 4 earns ONLY for SCHOOL_ISSUE today).
    const { c, w } = gateCourse(10);
    const today = bangkokNow().date;
    for (const id of ["c1-b4", "c1-b5"]) w.bookings.find((x: any) => x.id === id).date = today;
    w.bookings.find((x: any) => x.id === "c1-b5").startTime = "14:00:00";
    w.bookings.find((x: any) => x.id === "c1-b5").endTime = "15:00:00";
    const out: any = await coachLeaveOn(w, today);
    expect(out.cancelled).toBe(2);
    expect(expiry(w)).toBe(plus(courseExpiry(D, 10), 14));
    expect(w.expiryChanges).toHaveLength(2);
    expect(weekOfExpiry(D, expiry(w), 0) - weekOfExpiry(D, c.expiryDate, 0)).toBe(2);
  });

  test("⚠️ the ADMIN's coach-leave door (a future day = an ADVANCE leave) cancels nothing and adds NO week — pinned by source, as the finding above states", () => {
    const S = code(readSrc(readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8")).replace(/\r\n/g, "\n"));
    const fn = S.slice(S.indexOf("export async function reportTeacherLeave("));
    const advance = fn.slice(fn.indexOf("if (isAdvanceLeave(input.date)) {"), fn.indexOf("const mine = await db.query.bookings.findMany("));
    expect(advance.length).toBeGreaterThan(100);
    expect(advance).not.toMatch(/addLeaveWeek|cancelSeatsOfGroup|reconcileCoursePlan|status: "CANCELLED"/);
  });

  test("6-session — step 4: cancel session 4 with «ปัญหาจากทางเรา» ⇒ +7 · step 5: cancel session 5 with «ลูกค้าไม่เอาแล้ว» ⇒ +0", async () => {
    const { c, w } = gateCourse(6);
    await sched.updateBookingStatus("c1-b4", "cancel", "โรงเรียนปิด", false, "SCHOOL_ISSUE");
    expect(expiry(w)).toBe(plus(c.expiryDate, 7)); // D + 56
    expect(expiry(w)).toBe(plus(D, 56));
    await sched.updateBookingStatus("c1-b5", "cancel", "ลูกค้าไม่เอาแล้ว", false, "CUSTOMER_CANCELLED");
    expect(expiry(w)).toBe(plus(D, 56)); // still
    expect(w.expiryChanges).toHaveLength(1);
  });

  test("a SEPARATE fresh 4-session course NOT YET STARTED: declare session 2 absent ⇒ D + 35 = week 6 (her \"6\")", async () => {
    const start = plus(bangkokNow().date, 8);
    const c: Course = { id: "c1", size: 4, startDate: start, expiryDate: courseExpiry(start, 4) };
    const w = world([c], Array.from({ length: 4 }, (_, i) => row(`c1-b${i + 1}`, "c1", plus(start, i * 7))));
    await sched.updateBookingStatus("c1-b2", "sick-leave", "ลาล่วงหน้า", false);
    expect(expiry(w)).toBe(plus(start, 35));
    expect(weekOfExpiry(start, expiry(w), 0)).toBe(6);
  });

  test("overflow, once: ordinary leaves until a make-up lands past the expiry ⇒ CREATED, the expiry does NOT move, the admin gets the new notice", async () => {
    const { c, w } = gateCourse(4);
    for (const id of ["c1-b2", "c1-b3", "c1-b4"]) await sched.updateBookingStatus(id, "sick-leave", "ป่วย", false);
    expect(expiry(w)).toBe(c.expiryDate);
    const makeups = w.bookings.filter((b: any) => b.extendedFromId);
    expect(makeups).toHaveLength(3);
    expect(makeups.some((m: any) => m.date > c.expiryDate)).toBe(true); // at least one landed past it
    expect(past().length).toBeGreaterThan(0);
    expect(past()).toHaveLength(makeups.filter((m: any) => m.date > c.expiryDate).length); // once per make-up that crossed
  });
});
