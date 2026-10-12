// TEST-098 (TASK-731 follow-up) — the admin's «ครูลา» on a COURSE make-up reaches the family NOTICE only. A Team B file: the harness below is a COPY of `makeup-cancel-family-task537.test.ts`'s
// (it drives the REAL `updateBookingStatus` over a fake tx), so Team A's/the older file is not extended.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as familyLink from "../lib/family-link";
import * as ownScope from "../lib/own-scope";
import * as salePost from "../lib/sale-post";
import { formatOutboxMessage } from "../lib/line-message";
import { t } from "../lib/line-i18n";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const src = (f: string) => code(readFileSync(resolve(root, f), "utf8"));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
const M1 = "m1m1m1m1-m1m1-41m1-81m1-m1m1m1m1m1m1";
const STAFF = { channel: "staff" as const, actor: "admin-dong" };

/** One booking row + a course; UPDATEs judged by their REAL rendered WHERE; every insert recorded (the outbox rows are the evidence). */
function run(row: Record<string, unknown>, replan: { appended?: string[]; rows?: any[]; coaches?: Record<string, string[]> } = {}) { // 🔻 TASK-548 — what the re-plan RETURNS
  const w = {
    bookings: [{ id: M1, status: "EXTENDED", date: "2026-10-30", startTime: "10:00:00", teacherId: "t1", studentId: "s1", coStudentId: null, courseId: "c1", voucherId: null, bookingType: "COURSE_PACKAGE",
      note: null, plannedAtCreation: false, leaveCharged: null, checkinSource: null, checkinChannel: null, checkinActor: null, campWeekDayId: null, confirmedAt: null, isMakeup: true /* 🔻 TASK-702 — the row under test IS a make-up: door 4 asks the MARKER */, ...row }],
    courses: [{ id: "c1", size: 4, usedSessions: 1, leaveUsed: 1 }],
    inserts: [] as Array<{ table: string; v: any }>,
    replanAsked: [] as any[], // 🔻 TASK-552 — the opts each re-plan received
    asked: [] as Array<Array<string | null>>,
  };
  const withRels = (r: any) => r && ({ ...r, course: w.courses.find((c) => c.id === r.courseId) ?? null, voucher: null });
  const tx: any = {
    query: { bookings: { findFirst: async () => withRels(w.bookings[0]), findMany: async () => replan.rows ?? [] }, coursePackages: { findFirst: async () => ({ expiryDate: "2099-12-31" }) } }, // 🔻 TASK-657 — the overflow check reads the course expiry (far future here: nothing overflows)
    update: (t: any) => ({ set: (set: Record<string, unknown>) => ({ where: (cond: any) => {
      const { sql, params } = dialect.sqlToQuery(cond);
      const conds = [...sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)].map((m) => ({ col: camel(m[2]!), val: params[Number(m[3]) - 1] }));
      const rows = getTableName(t) === "bookings" ? w.bookings : getTableName(t) === "course_packages" ? w.courses : [];
      const hits = rows.filter((r: any) => conds.every((c) => r[c.col] === c.val));
      for (const r of hits) for (const [k, v] of Object.entries(set)) if (!(v && typeof v === "object" && "queryChunks" in (v as object))) (r as any)[k] = v;
      const out = hits.map((r: any) => ({ id: r.id }));
      return Object.assign(Promise.resolve(out), { returning: async () => out });
    } }) }),
    insert: (t: any) => ({ values: async (v: any) => { w.inserts.push({ table: getTableName(t), v }); } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }), innerJoin: async () => [] }) }), // no coach rows needed here
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  // 🔻 TASK-551 — per row when a test says so (the same-slot decider compares coach SETS); else the two coaches, as before
  spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async (_e: any, id: string) => (replan.coaches?.[id] ?? ["t1", "t2"]).map((c) => ({ id: c, lineUserId: `U-coach-${c}` }))) as any));
  spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async (_e: any, ids: Array<string | null>) => { w.asked.push(ids); return ["U-mom", "U-dad"]; }) as any));
  spies.push(spyOn(sched, "reconcileCoursePlan").mockImplementation((async (_tx: any, _id: string, opts?: any) => { w.replanAsked.push(opts ?? null); return { appended: replan.appended ?? [], cancelled: [] }; }) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async (_e: any, id: string) => ({ id })) as any));
  spies.push(spyOn(salePost, "reverseBookingSale").mockImplementation((async () => ({ posted: false })) as any));
  const coachRows = () => w.inserts.filter((i) => i.v?.recipientType === "teacher").map((i) => ({ to: i.v.recipientLineUserId, kind: i.v.payload?.kind }));
  const parentRows = () => w.inserts.filter((i) => i.v?.recipientType === "parent").map((i) => ({ to: i.v.recipientLineUserId, kind: i.v.payload?.kind }));
  return { w, parentRows, coachRows };
}

// ───────────────────────── TEST-098 (TASK-731 follow-up) — the admin's «ครูลา» on a COURSE make-up reaches the family NOTICE only ───────────
// 🔴 The admin cancel's `enumReason` carries a code for 1HR / VOUCHER / OTHER / GROUP but for a COURSE only SCHOOL_ISSUE; it is what is STORED on the row and it feeds the re-plan, so it is NOT widened.
// The notice gets the admin's choice through its own argument (`scheduler.service.ts` the `sendClassCancelledToFamilies` call, make-up only).
describe("🔴 TEST-098 — «ครูลา» on a COURSE make-up: the notice prints the Reason; the STORED reason and the re-plan are byte-identical", () => {
  const familyPayloads = (h: ReturnType<typeof run>) => h.w.inserts.filter((i) => i.v?.recipientType === "parent").map((i) => i.v.payload);
  const CTX98 = { studentName: "มะขิด", subject: "Freeskate", date: "2026-10-30", startTime: "10:00", endTime: "11:00" };
  test("by value: the make-up family payload carries `cancelReason: TEACHER_LEAVE`, and the words print `Reason : Teacher leave` / `เหตุผล : ครูลา`", async () => {
    const h = run({}, { appended: ["n1"], rows: [{ date: "2026-11-13" }] });
    await sched.updateBookingStatus(M1, "cancel", "coach away", false, "TEACHER_LEAVE", STAFF);
    const [p] = familyPayloads(h);
    expect(p).toEqual({ kind: "makeup_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4, newClassDates: ["2026-11-13"], cancelReason: "TEACHER_LEAVE" });
    expect(formatOutboxMessage(p, CTX98 as any, "EN", "parent").split("\n")).toContain("Reason : Teacher leave");
    expect(formatOutboxMessage(p, CTX98 as any, "TH", "parent").split("\n")).toContain("เหตุผล : ครูลา");
  });
  test("🔑 the STORED reason and the re-plan are the SAME as without «ครูลา»: nothing stored, the re-plan asked identically (it drives the +1 week)", async () => {
    const withLeave = run({}, { appended: ["n1"], rows: [{ date: "2026-11-13" }] });
    await sched.updateBookingStatus(M1, "cancel", "coach away", false, "TEACHER_LEAVE", STAFF);
    for (const s of spies.splice(0)) s.mockRestore();
    const without = run({}, { appended: ["n1"], rows: [{ date: "2026-11-13" }] });
    await sched.updateBookingStatus(M1, "cancel", "coach away", false, undefined, STAFF);
    expect(withLeave.w.bookings[0]!.status).toBe("CANCELLED");
    expect((withLeave.w.bookings[0] as any).cancelReason ?? null).toBe((without.w.bookings[0] as any).cancelReason ?? null); // the stored code is not widened
    expect((withLeave.w.bookings[0] as any).cancelReason ?? null).toBeNull(); // a COURSE cancel stores no TEACHER_LEAVE
    // the re-plan is asked what it was ALWAYS asked for «ครูลา»: a coach's leave already hands it `coachOff` (from the raw `reasonCode`, not from `enumReason`) — TEST-098 changes none of it
    expect(withLeave.w.replanAsked).toEqual([{ reowedFor: [], coachOff: [{ date: "2026-10-30", teacherId: "t1" }, { date: "2026-10-30", teacherId: "t2" }], holdConfirmNotices: [] }]);
    expect(without.w.replanAsked).toEqual([{ reowedFor: [], holdConfirmNotices: [] }]); // …and without «ครูลา» there is no coachOff, as ever
  });
  test("an ORDINARY (non make-up) course cancel with «ครูลา» is UNCHANGED: the same class_cancelled_parent payload as before (no reason)", async () => {
    const h = run({ status: "CONFIRMED", isMakeup: false });
    await sched.updateBookingStatus(M1, "cancel", "coach away", false, "TEACHER_LEAVE", STAFF);
    expect(familyPayloads(h)[0]).toEqual({ kind: "class_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4, cancelReason: null });
  });
  test("any OTHER reason on a make-up adds nothing: the payload stays TASK-537's (no reason field)", async () => {
    const h = run({});
    await sched.updateBookingStatus(M1, "cancel", "x", false, "ADMIN_ERROR", STAFF);
    expect(familyPayloads(h)[0]).toEqual({ kind: "makeup_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4 });
  });
  test("by source: `enumReason` is NOT widened (still only SCHOOL_ISSUE for a course) and the call passes the make-up-only notice value", () => {
    const S = code(readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8"));
    expect(S).toContain('current.bookingType === "COURSE_PACKAGE" && reasonCode === SCHOOL_ISSUE');
    expect(S).toContain('enumReason ?? (current.isMakeup === true && reasonCode === "TEACHER_LEAVE" ? "TEACHER_LEAVE" : null)');
  });
});
