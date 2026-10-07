// TASK-692 §RE-CUT (REQ-112, owner ruling) — a FAMILY leave with no room before the course expiry is REFUSED: at the parent's LINE door (her sentence, verbatim) AND at the
// admin's two doors (Record leave, Mark absence) — "parent refused, admin allowed" is two rules for one act. Coach's leave / school cancel / any cancel NEVER refuse (657 as built).
// 🔑 Driven THROUGH the real entry points over the same fake transaction as 656/657's proofs — which now ROLLS BACK on a throw, so "nothing written" is a byte comparison of the world.
// ⚠️ The parent's LINE handler is not exported (the existing LINE-flow suites pin it by source), so the parent half is proven by VALUE on its pieces (the code, her sentence, the admin
// notice's words) and by SOURCE on the wiring — said here, not hidden.
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

const enq = () => ((globalThis as any).__w.outbox as any[]); // 🔻 TASK-702 — the world's outbox (rolled back with its transaction)
const adminNotices = (kind: string) => enq().filter((p) => p?.recipientType === "admin" && p?.payload?.kind === kind);
const STARTED = () => plus(bangkokNow().date, -14);
const landAt = (days: number) => spies.push(spyOn(sched, "findFreeExtensionDate").mockImplementation((async (_t: any, _s: string, _x: string, after: string) => plus(after, days)) as any));
const REFUSAL = "อายุคอร์สไม่พอสำหรับคาบชดเชย — ขยายวันหมดอายุก่อน แล้วค่อยบันทึกลา";
/** A started 4-session course whose last class sits ON the expiry (t+14): any make-up lands past it. `room` pushes the expiry out by that many days. */
const course = (room = 0) => {
  const t = bangkokNow().date;
  const c = baseCourse("c1", STARTED());
  const w = world([c], [row("c1-b1", "c1", plus(t, -14), "ATTENDED"), row("c1-b2", "c1", plus(t, -7), "ATTENDED"), row("c1-b3", "c1", plus(t, 7)), row("c1-b4", "c1", plus(t, 14))]);
  w.courses[0].expiryDate = plus(c.expiryDate, room);
  return { c, w, snap: () => JSON.stringify({ b: w.bookings, c: w.courses, e: w.expiryChanges, i: w.inserts }) };
};
const refused = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return { code: e.code, message: e.message as string }; } return null; };

describe("🔴 R1/R2 — the admin's FAMILY-leave doors REFUSE with no room: refused, admin wording, NOTHING written, NO admin notice", () => {
  test("door 1 (Record leave) with room ⇒ booked", async () => {
    const { w } = course(60);
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    expect(w.bookings.find((b: any) => b.id === "c1-b3").status).toBe("SICK_LEAVE");
    expect(w.inserts.filter((i: any) => i.table === "bookings")).toHaveLength(1);
  });
  test("door 1 with NO room ⇒ `LEAVE_NO_VALIDITY` + the admin wording; the world is BYTE-IDENTICAL (no status, no make-up, no count, no expiry record) and NOBODY is told", async () => {
    const { w, snap } = course(0);
    const before = snap();
    const e = await refused(sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false));
    expect(e).toEqual({ code: "LEAVE_NO_VALIDITY", message: REFUSAL });
    expect(snap()).toBe(before);
    expect(enq()).toHaveLength(0); // no coach notice, no admin notice
    expect(w.courses[0].leaveUsed).toBe(0);
  });
  test("door 2 (the plan editor's Mark absence) answers the SAME — one rule, two doors", async () => {
    const { snap } = course(0);
    const before = snap();
    const e = await refused(sched.applyPlanChange("c1", { kind: "mark-absence", bookingId: "c1-b3", planned: true, reason: "ป่วย", override: true }));
    expect(e).toEqual({ code: "LEAVE_NO_VALIDITY", message: REFUSAL });
    expect(snap()).toBe(before);
    expect(enq()).toHaveLength(0);
  });
  test("the boundary is INCLUSIVE — a make-up landing ON the expiry is booked", async () => {
    const { w } = course(7); // expiry t+21; the make-up lands t+21
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    expect(w.bookings.find((b: any) => b.extendedFromId)!.date).toBe(plus(bangkokNow().date, 21));
    expect(w.courses[0].expiryDate).toBe(plus(bangkokNow().date, 21));
  });
});

describe("🔴 R1 — T1 (a pre-start declaration): refused ONLY if it STILL does not fit AFTER its +1 week (asked AFTER the week decision)", () => {
  test("fits after its week ⇒ BOOKED (the week made the room)", async () => {
    const c = baseCourse("c1", FUTURE);
    const w = world([c], courseRows("c1", FUTURE));
    landAt(14); // after the last class (start+21) ⇒ start+35 = the base expiry (start+28) + the week
    await sched.updateBookingStatus("c1-b1", "sick-leave", "ลาล่วงหน้า", false);
    expect(w.courses[0].expiryDate).toBe(plus(c.expiryDate, 7));
    expect(w.bookings.find((b: any) => b.extendedFromId)!.date).toBe(plus(FUTURE, 35));
  });
  test("still does not fit even after its week ⇒ REFUSED, and the WEEK rolls back with it (the expiry is untouched)", async () => {
    const c = baseCourse("c1", FUTURE);
    const w = world([c], courseRows("c1", FUTURE));
    landAt(21);
    const e = await refused(sched.updateBookingStatus("c1-b1", "sick-leave", "ลาล่วงหน้า", false));
    expect(e?.code).toBe("LEAVE_NO_VALIDITY");
    expect(w.courses[0].expiryDate).toBe(c.expiryDate);
    expect(w.expiryChanges).toHaveLength(0);
  });
});

describe("🔴 R1 — a coach's leave (T2) · a school cancel (T3) · ANY other cancel NEVER refuse: created + the admin told (657 as built)", () => {
  test("a school cancel «our side» and a CUSTOMER_CANCELLED cancel, with no room ⇒ NOT refused; the make-up exists; ONE admin notice each", async () => {
    for (const reason of ["SCHOOL_ISSUE", "CUSTOMER_CANCELLED"]) {
      for (const x of spies.splice(0)) x.mockRestore();
      const { w } = course(0);
      landAt(14); // past even the week an "our side" cancel earns (T3)
      await sched.updateBookingStatus("c1-b3", "cancel", "ยกเลิก", false, reason);
      expect(w.bookings.filter((b: any) => b.isMakeup === true && b.status !== "CANCELLED")).toHaveLength(1);
      expect(adminNotices("makeup_past_expiry")).toHaveLength(1);
    }
  });
  test("a coach's leave with no room ⇒ NOT refused; created; admin told", async () => {
    const t = bangkokNow().date;
    const c = baseCourse("c1", t);
    const w = world([c], courseRows("c1", t));
    const todays = w.bookings.filter((b: any) => b.date === t).map((b: any) => ({ ...b, course: w.courses[0], voucher: null, additionalTeachers: [], seats: [] }));
    spies.push(spyOn(ownScope, "assertLinked").mockImplementation((() => T1) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => todays) as any));
    landAt(28);
    const out: any = await sched.reportTeacherLeave(T1, { date: t, reason: "ป่วย" }, "admin-dong", { onBehalf: true });
    expect(out.cancelled).toBe(1);
    expect(adminNotices("makeup_past_expiry")).toHaveLength(1);
  });
});

describe("🔴 R3 — build ONLY what is true either way: refused ⇒ the admin extends ⇒ the SAME leave recorded again ⇒ it works, make-up booked (no held state, no retry, no re-plan on extend)", () => {
  test("by value", async () => {
    const { w } = course(0);
    expect((await refused(sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false)))?.code).toBe("LEAVE_NO_VALIDITY");
    w.courses[0].expiryDate = plus(w.courses[0].expiryDate, 14); // the admin extends — a plain edit; nothing is re-planned or booked by it
    expect(w.inserts.filter((i: any) => i.table === "bookings")).toHaveLength(0);
    await sched.updateBookingStatus("c1-b3", "sick-leave", "ป่วย", false);
    expect(w.bookings.find((b: any) => b.id === "c1-b3").status).toBe("SICK_LEAVE");
    expect(w.inserts.filter((i: any) => i.table === "bookings")).toHaveLength(1); // the make-up, booked at once
  });
  test("🚫 no held state, no pending leave, no retry anywhere", () => {
    const S = readSrc(readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8"));
    expect(S).not.toMatch(/pendingLeave|HELD_MAKEUP|heldMakeup|retryLeave/i);
  });
});

describe("🔴 R2 — the PARENT's reply: HER sentence, verbatim, ONLY on this code; the admins are told ONCE, after the rollback", () => {
  const WH = () => readSrc(readFileSync(resolve(import.meta.dir, "line-webhook.service.ts"), "utf8")).replace(/\r\n/g, "\n");
  const BOOK = () => { const w = WH(); return w.slice(w.indexOf("async function doLeaveBooking("), w.indexOf("async function doChildren(")); };
  test("her sentence, both languages, VERBATIM (from her edited sheet)", async () => {
    const { t } = await import("../lib/line-i18n");
    expect(t("leave_no_validity", "TH")).toBe("ไม่สามารถแจ้งลาได้ เนื่องจากวันหมดอายุไม่เพียงพอค่ะ กรุณาติดต่อแอดมินค่ะ");
    expect(t("leave_no_validity", "EN")).toBe("Leave request unavailable because there is not enough time before the course expiry date. Please contact Admin.");
  });
  test("the code and the sentence are wired: the parent's handler prints her sentence only on this code; every other refusal keeps its own", () => {
    const B = BOOK();
    expect(B).toContain("if (e?.code === LEAVE_NO_VALIDITY_CODE) {");
    expect(B).toContain('return send(replyToken, [textReply(t("leave_no_validity", lang), lang)]);');
    expect(B).toContain('if (e?.code === "LEAVE_NOTICE_TOO_LATE") {');
    expect(B).toContain('return send(replyToken, [textReply(e?.message ?? tb("leave_err"), lang)]);');
    expect(B.split("leave_no_validity").length - 1).toBe(1);
  });
  test("the admin notice is sent ONCE, BEFORE the reply, only on this code, and NOT from the service (an admin refused at their own door needs none)", () => {
    const B = BOOK();
    const at = B.indexOf("if (e?.code === LEAVE_NO_VALIDITY_CODE) {");
    const blk = B.slice(at, B.indexOf("return send(replyToken, [textReply(e?.message", at));
    expect(blk.match(/notifyAdmins\(/g)).toHaveLength(1);
    expect(blk.indexOf("notifyAdmins(")).toBeLessThan(blk.indexOf("send(replyToken"));
    expect(blk).toContain('kind: "leave_refused_no_validity"');
    const SVC = readSrc(readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8"));
    expect(SVC).not.toContain("leave_refused_no_validity");
  });
  test("the admin notice's words (📋 DRAFT, both languages) carry the student and the date, never a raw placeholder", () => {
    const m = (lang: "TH" | "EN") => formatOutboxMessage({ kind: "leave_refused_no_validity" } as any, { studentName: "Mali", date: "2026-11-25" } as any, lang);
    expect(m("TH")).toBe("ผู้ปกครองแจ้งลาไม่สำเร็จ — อายุคอร์สไม่พอสำหรับคาบชดเชย: Mali · 25-11-2026");
    expect(m("EN")).toBe("A parent's leave was refused — not enough course validity for a make-up: Mali · 25-11-2026");
    for (const lang of ["TH", "EN"] as const) expect(formatOutboxMessage({ kind: "leave_refused_no_validity" } as any, {}, lang)).not.toMatch(/[{}]/);
  });
  test("🔑 `LEAVE_NOTICE_TOO_LATE` and every existing refusal are UNCHANGED", () => {
    const SVC = readSrc(readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8"));
    expect(SVC.split('throw conflict("LEAVE_NOTICE_TOO_LATE"').length - 1).toBe(2);
  });
});

describe("🔑 the refusal is ONE decision point, asked by exactly the two FAMILY-leave doors, AFTER their week decision", () => {
  const S = readSrc(readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8")).replace(/\r\n/g, "\n");
  const C = S.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  test("two callers, by function name; a third fails here with a name", () => {
    const where = (re: RegExp) => [...C.matchAll(re)].map((m) => {
      const head = C.slice(0, m.index!).split("\n");
      for (let i = head.length - 1; i >= 0; i--) { const mm = head[i]!.match(/^(?:export )?async function (\w+)\(/); if (mm) return mm[1]!; }
      return "?";
    }).sort();
    expect(where(/await assertRoomForLeave\(tx, /g)).toEqual(["applyPlanChange", "updateBookingStatus"]);
  });
  test("asked AFTER the T1 week at door 1 and at door 2", () => {
    expect(C.indexOf('await addLeaveWeek(tx, current.courseId, "T1_PRE_START_DECLARATION")')).toBeLessThan(C.indexOf("await assertRoomForLeave(tx, current.courseId, [extendedId])"));
    expect(C.indexOf('await addLeaveWeek(tx, courseId, "T1_PRE_START_DECLARATION")')).toBeLessThan(C.indexOf("await assertRoomForLeave(tx, courseId, moves.appended"));
  });
  test("it writes nothing and throws the ONE distinct code", () => {
    const FN = C.slice(C.indexOf("async function assertRoomForLeave("), C.indexOf("async function flagMakeupsPastExpiry("));
    expect(FN).toContain("throw LEAVE_NO_VALIDITY();");
    expect(FN).not.toMatch(/\.update\(|\.insert\(|notifyAdmins|enqueueLine/);
  });
});
