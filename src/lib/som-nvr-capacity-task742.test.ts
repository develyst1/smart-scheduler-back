// 🔻 TASK-742 (REQ-124 2/3) — SOM «New vs Renewing» (6 cards + the list endpoint) and «Coach Capacity». No database: the pure counters by value, the service's READ through fake db, the route through the
// real Hono app. Today in every fixture is Monday 2026-10-12; October 2026 has 22 weekdays + 9 weekend days.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  CAPACITY_FREELANCE_HOURS, CAPACITY_FULL_TIME_WEEKDAY_HOURS, CAPACITY_NOT_COUNTED_STATUSES, CAPACITY_FULL_TIME_WEEKEND_HOURS, CAPACITY_PART_TIME_WEEKDAY_HOURS, CAPACITY_PART_TIME_WEEKEND_HOURS, CAPACITY_PCT_CAP, NVR_BUCKETS, RENEW_ENDED_STATUSES, RENEW_ONLY_AFTER_OLD_FINISHED, VOUCHER_FINISHED_STATUSES, addMonths, cancelledIds, countCapacity, countNvr, countSom, mergeSom,
  type SomBooking, type SomContractInput, type SomCourse, type SomStudent, type SomTeacher, type SomVoucher,
} from "./som-contract";
import { ROUTE_ACCESS, routeKey } from "./route-access";
import * as v from "../validation";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const teacherLeave = await import("./teacher-leave");
const svc = await import("../services/som-contract.service");
const { bangkokNow } = await import("./bangkok-time");
const { api } = await import("../routes/api");

const S = (n: number) => `s${String(n).padStart(3, "0")}`;
const [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(S) as [string, string, string, string, string, string, string, string, string, string, string];
const TA = "teacher-a", TB = "teacher-b", TC = "teacher-c";
const BIKE = "subj-bike";
const BV1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1", BV2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const MONTH = "2026-10", TODAY = "2026-10-12";

const bk = (o: Partial<SomBooking> = {}): SomBooking => ({ studentIds: [S1], bookingType: "COURSE_PACKAGE", status: "ATTENDED", date: "2026-10-05", subjectId: BIKE, courseId: null, voucherId: null, badgeIds: [], isSeat: false, teacherId: TA, startTime: "10:00", endTime: "11:00", ...o });
const trial = (id: string, date: string, o: Partial<SomBooking> = {}) => bk({ studentIds: [id], bookingType: "FIRST_TRIAL", status: "CONFIRMED", date, ...o });
const course = (o: Partial<SomCourse> = {}): SomCourse => ({ id: "c1", subjectId: BIKE, studentIds: [S1], createdAt: "2026-10-03T03:00:00Z", size: 10, usedSessions: 0, expiryDate: "2027-06-01", endedAt: null, droppedAt: null, expiryChanges: [], ...o });
const voucher = (o: Partial<SomVoucher> = {}): SomVoucher => ({ id: "v1", studentId: S1, createdAt: "2026-10-03T03:00:00Z", totalHours: 10, usedHours: 0, expiryDate: "2027-06-01", endedAt: null, expiryChanges: [], ...o });
const STUDENTS: SomStudent[] = [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11].map((id, i) => ({
  id, name: i === 0 ? "Ploy Wong" : i === 1 ? "Pun Lee" : `Kid ${i + 1}`, nickname: i === 0 ? "Ploy" : i === 1 ? "Pun" : null, gender: null, nationality: null, birthDate: null, province: null, districtCode: null,
}));
const base = (o: Partial<SomContractInput> = {}): SomContractInput => ({
  month: MONTH, today: TODAY, badgeValueIds: [], bookings: [], courses: [], vouchers: [], students: STUDENTS, subjects: [{ id: BIKE, name: "Bike", active: true }], districtLabel: () => null, ...o,
});
const nvr = (o: Partial<SomContractInput> = {}) => countNvr(base(o));
const ids = (rows: Array<{ studentId: string }>) => rows.map((r) => r.studentId);

describe("🔴 TASK-742 — the declared defaults and the contract's shape", () => {
  test("the six cards are Palm's, in his order; the card is the bucket's name", () => {
    expect([...NVR_BUCKETS]).toEqual(["firstTrial", "newCourseThisMonth", "newCoursePrevMonth", "renewCourse", "trialNotConverted", "notRenewed"]);
    expect(Object.keys(nvr().counts).sort()).toEqual(["from", "month", "to", ...NVR_BUCKETS].sort());
  });
  test("🔒 Q3.7 (REQ-5002): «the earlier course has FINISHED» = used up · expired · ended with ENDED_EARLY (the only ended course left in the list — every other ended one is cancelled and out) — a PAUSED one is not finished; a voucher finishes by used up · expired", () => {
    expect([...RENEW_ENDED_STATUSES].sort()).toEqual(["CANCELLED", "COMPLETED", "EXPIRED"]);
    expect([...VOUCHER_FINISHED_STATUSES].sort()).toEqual(["EXHAUSTED", "EXPIRED"]);
  });
  test("🔒 Q4.5 / Palm: only CANCELLED is out of the booked hours; one day = 9 hours; a percentage is capped at 100", () => {
    expect([...CAPACITY_NOT_COUNTED_STATUSES]).toEqual(["CANCELLED"]);
    expect([CAPACITY_FULL_TIME_WEEKDAY_HOURS, CAPACITY_FULL_TIME_WEEKEND_HOURS, CAPACITY_PART_TIME_WEEKEND_HOURS, CAPACITY_PART_TIME_WEEKDAY_HOURS, CAPACITY_FREELANCE_HOURS]).toEqual([4, 5, 5, 0, 0]); // 🔻 TASK-877 (REQ-5009, was REQ-5004 5 / 6 / 6): FT 4 h weekday / 5 h Sat–Sun · PT 5 h Sat–Sun, 0 weekday · FL 0
    expect(CAPACITY_PCT_CAP).toBe(100);
  });
});

describe("🔴 TASK-755 (REQ-5002 §5 Q4 / Q5, §7.1) — the two New Course lines: the child's FIRST course, opened in the selected month, with the earliest trial on/before the buy day", () => {
  const fixture = {
    students: STUDENTS,
    bookings: [
      trial(S1, "2026-09-21", { teacherId: TA }),
      bk({ courseId: "c1", teacherId: TC, date: "2026-10-13", status: "CONFIRMED" }),
      bk({ courseId: "c1", teacherId: TB, date: "2026-10-06", status: "CONFIRMED" }),
      bk({ courseId: "c1", teacherId: TA, date: "2026-10-04", status: "CANCELLED" }), // a cancelled row is not «the first session»
    ],
    courses: [course({ id: "c1", studentIds: [S1], createdAt: "2026-10-03T03:00:00Z" })],
  };
  const lines = (o: Partial<SomContractInput>) => { const r = nvr(o); return [r.counts.newCourseThisMonth, r.counts.newCoursePrevMonth, r.counts.renewCourse]; };
  test("trial 21 Sep → course 3 Oct ⇒ «previous month» of the October page; the SEPTEMBER page has no purchase in it ⇒ nothing (a course is judged in the month it was OPENED)", () => {
    const oct = nvr(fixture);
    expect([oct.counts.newCourseThisMonth, oct.counts.newCoursePrevMonth]).toEqual([0, 1]);
    expect(oct.rows.newCoursePrevMonth).toEqual([
      { studentId: S1, studentName: "Ploy", packageLabel: "Course 10 · Bike", courseTeacherId: TB, trialTeacherId: TA, trialDate: "2026-09-21", date: "2026-10-03", remark: null },
    ]);
    const sep = nvr({ ...fixture, month: "2026-09" });
    expect([sep.counts.newCourseThisMonth, sep.counts.newCoursePrevMonth]).toEqual([0, 0]);
  });
  test("trial 4 Oct → course 12 Oct ⇒ «this month»; a trial the SAME day as the purchase is on/before ⇒ «this month»", () => {
    expect(lines({ bookings: [trial(S1, "2026-10-04")], courses: [course({ createdAt: "2026-10-12T03:00:00Z" })] })).toEqual([1, 0, 0]);
    expect(lines({ bookings: [trial(S1, "2026-10-12")], courses: [course({ createdAt: "2026-10-12T03:00:00Z" })] })).toEqual([1, 0, 0]);
  });
  test("the month's FIRST and LAST day: a course opened 1 Oct and one opened 31 Oct are October's; 30 Sep and 1 Nov are not (trial in August)", () => {
    const at = (day: string, month = "2026-10") => lines({ month, bookings: [trial(S1, "2026-08-10")], courses: [course({ createdAt: `${day}T03:00:00Z` })] });
    expect(at("2026-10-01")).toEqual([0, 1, 0]);
    expect(at("2026-10-31")).toEqual([0, 1, 0]);
    expect(at("2026-09-30")).toEqual([0, 0, 0]);
    expect(at("2026-11-01")).toEqual([0, 0, 0]);
    expect(at("2026-09-30", "2026-09")).toEqual([0, 1, 0]);
  });
  test("a trial 2+ months back is on «previous month» (ANY earlier month, §7.1) — no constant, no window", () => {
    expect(lines({ bookings: [trial(S1, "2026-08-20")], courses: [course({ createdAt: "2026-10-03T03:00:00Z" })] })).toEqual([0, 1, 0]);
    expect(lines({ bookings: [trial(S1, "2025-01-20")], courses: [course({ createdAt: "2026-10-03T03:00:00Z" })] })).toEqual([0, 1, 0]);
  });
  test("a child with TWO trials is read by his EARLIEST one (Sep, not the Oct re-trial) ⇒ «previous month»", () => { expect(lines({ bookings: [trial(S1, "2026-10-05"), trial(S1, "2026-09-21")], courses: [course({ createdAt: "2026-10-12T03:00:00Z" })] })).toEqual([0, 1, 0]); });
  test("no trial ⇒ the course is on NEITHER New line (and not a Renew either)", () => {
    expect(lines({ courses: [course({ createdAt: "2026-10-05T03:00:00Z" })] })).toEqual([0, 0, 0]);
  });
  test("a trial AFTER the purchase (even the next day, or a future-dated one) is not «where he came from» ⇒ neither line", () => {
    expect(lines({ bookings: [trial(S1, "2026-10-13")], courses: [course({ createdAt: "2026-10-12T03:00:00Z" })] })).toEqual([0, 0, 0]);
    expect(lines({ bookings: [trial(S1, "2026-10-30")], courses: [course({ createdAt: "2026-10-05T03:00:00Z" })] })).toEqual([0, 0, 0]);
    expect(lines({ bookings: [trial(S1, "2026-10-09")], courses: [course({ createdAt: "2026-09-25T03:00:00Z" })] })).toEqual([0, 0, 0]);
  });
  test("the trial need not have been ATTENDED for the New lines (a no-show counts: the earliest NON-cancelled trial is looked at); a CANCELLED trial is not a trial", () => {
    expect(lines({ bookings: [trial(S1, "2026-09-21", { status: "NO_SHOW" })], courses: [course()] })).toEqual([0, 1, 0]);
    expect(lines({ bookings: [trial(S1, "2026-09-21", { status: "CANCELLED" })], courses: [course()] })).toEqual([0, 0, 0]);
  });
  test("a course with NO class booked still counts (the New lines read the purchase, not the rows)", () => {
    expect(lines({ bookings: [trial(S1, "2026-10-01")], courses: [course({ createdAt: "2026-10-05T03:00:00Z" })] })).toEqual([1, 0, 0]);
  });
  test("it counts COURSES, not people: one child opening two courses TOGETHER (same day) = 2 and neither is a Renew; a VOUCHER never counts as a new course", () => {
    const r = nvr({ bookings: [trial(S1, "2026-10-01"), trial(S2, "2026-10-01")], courses: [course({ id: "c1" }), course({ id: "c2" })], vouchers: [voucher({ studentId: S2 })] });
    expect([r.counts.newCourseThisMonth, r.counts.renewCourse]).toEqual([2, 0]);
    expect(ids(r.rows.newCourseThisMonth)).toEqual([S1, S1]);
    expect(nvr({ bookings: [trial(S1, "2026-10-01")], vouchers: [voucher()] }).counts).toMatchObject({ newCourseThisMonth: 0, renewCourse: 0 });
  });
  test("🔴 a SECOND course on a LATER day is a Renew and NOT on a New line — also while the first one is still running (the child's FIRST course is the only New one)", () => {
    const r = nvr({ bookings: [trial(S1, "2026-09-21")], courses: [course({ id: "c1", createdAt: "2026-10-03T03:00:00Z" }), course({ id: "c3", createdAt: "2026-10-04T03:00:00Z" })] });
    expect([r.counts.newCourseThisMonth, r.counts.newCoursePrevMonth, r.counts.renewCourse]).toEqual([0, 1, 1]);
    expect(r.rows.newCoursePrevMonth[0]).toMatchObject({ date: "2026-10-03" });
    expect(r.rows.renewCourse[0]).toMatchObject({ date: "2026-10-04" });
    expect(ids([...r.rows.newCourseThisMonth, ...r.rows.newCoursePrevMonth]).length + r.rows.renewCourse.length).toBe(2); // two purchases, two lines, no purchase on both
  });
  test("a child whose only course is CANCELLED is on no New line; his next course is NEW (the cancelled one never was a first course)", () => {
    const dead = course({ id: "dead", createdAt: "2026-10-01T03:00:00Z", endedAt: "2026-10-02T03:00:00Z", endReason: "ADMIN_ERROR" });
    expect(lines({ bookings: [trial(S1, "2026-09-21")], courses: [dead] })).toEqual([0, 0, 0]);
    expect(lines({ bookings: [trial(S1, "2026-09-21")], courses: [dead, course({ id: "next", createdAt: "2026-10-05T03:00:00Z" })] })).toEqual([0, 1, 0]);
  });
  test("a DUO course is ONE row: both names, the primary child's id, and either child's trial", () => {
    const r = nvr({ bookings: [trial(S2, "2026-09-21")], courses: [course({ studentIds: [S1, S2] })] });
    expect(r.counts.newCoursePrevMonth).toBe(1);
    expect(r.rows.newCoursePrevMonth[0]).toMatchObject({ studentId: S1, studentName: "Ploy & Pun", trialDate: "2026-09-21" });
  });
});

describe("🔴 TASK-755 (REQ-5002 §5 Q6, §7.2) — Renew Course: a course on a LATER day than an earlier course of the child, even one still running (one constant)", () => {
  const earlier = (o: Partial<SomCourse>) => course({ id: "e1", studentIds: [S2], createdAt: "2026-03-01T03:00:00Z", ...o });
  const renewal = course({ id: "n1", studentIds: [S2], createdAt: "2026-10-05T03:00:00Z" });
  test("the earlier course USED UP / EXPIRED ⇒ renew, and the new course is NOT on a New line", () => {
    for (const e of [earlier({ size: 4, usedSessions: 4 }), earlier({ expiryDate: "2026-06-01" })]) {
      const r = nvr({ bookings: [trial(S2, "2026-02-01")], courses: [e, renewal] });
      expect([r.counts.renewCourse, r.counts.newCourseThisMonth, r.counts.newCoursePrevMonth]).toEqual([1, 0, 0]);
      expect(r.rows.renewCourse[0]).toMatchObject({ studentId: S2, packageLabel: "Course 10 · Bike", date: "2026-10-05", remark: null });
    }
  });
  test("the earlier course still ACTIVE, or only PAUSED ⇒ ALSO a Renew with the constant false (Q6) — and not on a New line", () => {
    for (const e of [earlier({}), earlier({ droppedAt: "2026-06-01T03:00:00Z" })]) {
      const r = nvr({ bookings: [trial(S2, "2026-02-01")], courses: [e, renewal] });
      expect([r.counts.renewCourse, r.counts.newCourseThisMonth, r.counts.newCoursePrevMonth]).toEqual([1, 0, 0]);
    }
  });
  test("🔒 the same fixtures with the constant TRUE (the older rule) would leave a running earlier course out — the switch is ONE constant (its value is pinned above and in the declared-defaults block)", () => {
    expect(RENEW_ONLY_AFTER_OLD_FINISHED).toBe(false);
  });
  test("the earlier course's status no longer matters (finished on the purchase day or not): the later-day purchase is a Renew", () => {
    const e = earlier({ size: 4, usedSessions: 4 });
    const rows = ["2026-09-25", "2026-09-26", "2026-10-01", "2026-10-02"].map((d) => bk({ courseId: "e1", studentIds: [S2], date: d }));
    const bought = course({ id: "n1", studentIds: [S2], createdAt: "2026-09-20T03:00:00Z" });
    expect(nvr({ month: "2026-09", courses: [e, bought], bookings: rows }).counts.renewCourse).toBe(1);
    expect(nvr({ month: "2026-09", courses: [e, bought] }).counts.renewCourse).toBe(1);
  });
  test("the SAME day is not «later»: two courses bought together are not each other's Renew", () => {
    const r = nvr({ courses: [course({ id: "a", studentIds: [S2], createdAt: "2026-10-05T03:00:00Z" }), course({ id: "b", studentIds: [S2], createdAt: "2026-10-05T09:00:00Z" })] });
    expect(r.counts.renewCourse).toBe(0);
  });
  test("a VOUCHER renews only after an earlier VOUCHER — never after a course: a finished course + a voucher ⇒ no Renew", () => {
    const done = earlier({ studentIds: [S3], size: 4, usedSessions: 4 });
    expect(nvr({ courses: [done], vouchers: [voucher({ id: "v1", studentId: S3, createdAt: "2026-10-06T03:00:00Z" })] }).rows.renewCourse).toEqual([]);
    const old = voucher({ id: "v0", studentId: S3, createdAt: "2026-03-01T03:00:00Z", expiryDate: "2026-06-01" }); // expired
    const r = nvr({ vouchers: [old, voucher({ id: "v1", studentId: S3, createdAt: "2026-10-06T03:00:00Z" }), voucher({ id: "v2", studentId: S4 }), voucher({ id: "o5", studentId: S5, createdAt: "2026-03-01T03:00:00Z", expiryDate: "2026-06-01" }), voucher({ id: "v3", studentId: S5, createdAt: "2026-09-10T03:00:00Z" })] }); // v3: bought in September ⇒ September's card
    expect(r.rows.renewCourse).toEqual([{ studentId: S3, studentName: "Kid 3", packageLabel: "Voucher 10 hrs", courseTeacherId: null, trialTeacherId: null, trialDate: null, date: "2026-10-06", remark: null }]);
  });
  test("the card is the PURCHASE month", () => {
    const c = [earlier({ size: 4, usedSessions: 4 }), course({ id: "n1", studentIds: [S2], createdAt: "2026-09-05T03:00:00Z" })];
    expect([nvr({ courses: c }).counts.renewCourse, nvr({ month: "2026-09", courses: c }).counts.renewCourse]).toEqual([0, 1]);
  });
});

describe("🔴 TASK-754 (REQ-5002) — cancelled courses and vouchers are OUT of New vs Renewing, and the Renew rules are hers", () => {
  const gone = (id: string, student: string, day: string, endedAt = "2026-08-20T03:00:00Z") => course({ id, studentIds: [student], createdAt: `${day}T03:00:00Z`, endedAt, endReason: "ADMIN_ERROR" });
  /** the same fixture with and without a branch filter: every row carries BV1 — the answer must not depend on the filter */
  const sameWithFilter = (o: Partial<SomContractInput>, bucket: (typeof NVR_BUCKETS)[number]) => {
    const badged = ((o.bookings ?? []) as SomBooking[]).map((b) => ({ ...b, badgeIds: [BV1] }));
    const all = countNvr(base({ ...o, bookings: badged })).rows[bucket].length;
    const filtered = countNvr(base({ ...o, bookings: badged, badgeValueIds: [BV1] })).rows[bucket].length;
    expect(filtered).toBe(all);
    return all;
  };
  const sessions = (courseId: string, student: string, dates: string[], status = "ATTENDED") => dates.map((d) => bk({ courseId, studentIds: [student], date: d, status, bookingType: "COURSE_PACKAGE" }));

  test("🔒 the declared default (REQ-5002 §5 Q6 / §7.2): a Renew does NOT need the old purchase to have finished — ONE constant, false", () => {
    expect(RENEW_ONLY_AFTER_OLD_FINISHED).toBe(false);
  });
  test("🔴 HER CASE: one child, 5 courses (3 cancelled, 1 completed, 1 active) ⇒ Renew Course has ONE row — the active one — both when bought after the completed one finished AND while it was still running; the card = the list", () => {
    const three = [gone("x1", S2, "2026-01-10"), gone("x2", S2, "2026-02-10"), gone("x3", S2, "2026-03-10")];
    const completed = course({ id: "done", studentIds: [S2], createdAt: "2026-04-01T03:00:00Z", size: 4, usedSessions: 4 });
    const active = (day: string) => course({ id: "act", studentIds: [S2], createdAt: `${day}T03:00:00Z` });
    const delivered = sessions("done", S2, ["2026-04-05", "2026-04-12", "2026-04-19", "2026-04-26"]); // finished on 26 Apr
    const after = nvr({ courses: [...three, completed, active("2026-10-05")], bookings: delivered });
    expect(after.counts.renewCourse).toBe(1);
    expect(after.rows.renewCourse).toHaveLength(1);
    expect(after.rows.renewCourse[0]).toMatchObject({ studentId: S2, date: "2026-10-05" });
    expect(after.counts.newCourseThisMonth).toBe(0); // the three cancelled ones and the completed one are not October's «new»
    // bought while the completed one was STILL RUNNING: the same ONE row (Q6)
    const running = course({ id: "done", studentIds: [S2], createdAt: "2026-04-01T03:00:00Z", size: 4, usedSessions: 2 });
    const during = nvr({ courses: [...three, running, active("2026-10-05")], bookings: sessions("done", S2, ["2026-04-05", "2026-04-12"]) });
    expect([during.counts.renewCourse, during.rows.renewCourse.length]).toEqual([1, 1]);
    expect(during.rows.renewCourse[0]).toMatchObject({ studentId: S2, date: "2026-10-05" });
    expect(sameWithFilter({ courses: [...three, completed, active("2026-10-05")], bookings: [...delivered, bk({ courseId: "act", studentIds: [S2], status: "CONFIRMED", date: "2026-10-12" })] }, "renewCourse")).toBe(1);
  });
  test("RENEW: a cancelled OWN purchase is not counted; a cancelled EARLIER course is neither «earlier» nor «ended» (so the next course is NEW, not a Renew); a cancelled LATER purchase changes nothing", () => {
    const old = course({ id: "old", studentIds: [S3], createdAt: "2026-03-01T03:00:00Z", size: 4, usedSessions: 4 });
    const done = sessions("old", S3, ["2026-03-10", "2026-03-17", "2026-03-24", "2026-03-31"]);
    expect(nvr({ courses: [old, gone("own", S3, "2026-10-05")], bookings: done }).counts.renewCourse).toBe(0); // own, cancelled
    const afterCancelled = nvr({ bookings: [trial(S4, "2026-10-01")], courses: [gone("e", S4, "2026-05-01"), course({ id: "n", studentIds: [S4], createdAt: "2026-10-05T03:00:00Z" })] });
    expect([afterCancelled.counts.renewCourse, afterCancelled.counts.newCourseThisMonth]).toEqual([0, 1]); // the re-booking after a cancel is NEW
    expect(nvr({ courses: [old, course({ id: "r", studentIds: [S3], createdAt: "2026-10-05T03:00:00Z" }), gone("later", S3, "2026-10-20")], bookings: done }).counts.renewCourse).toBe(1);
  });
  test("NEW: a cancelled own course is not a New Course (even with a trial); a cancelled earlier one does not make the next one «not first»; filter ⇒ the same answer", () => {
    const o = { bookings: [trial(S5, "2026-09-21")], courses: [gone("c", S5, "2026-10-03")] };
    expect(sameWithFilter(o, "newCoursePrevMonth")).toBe(0);
    expect(sameWithFilter({ ...o, courses: [gone("c0", S5, "2026-08-01"), course({ id: "c1", studentIds: [S5], createdAt: "2026-10-03T03:00:00Z" })], bookings: [...o.bookings, bk({ courseId: "c1", studentIds: [S5], status: "CONFIRMED", date: "2026-10-10" })] }, "newCoursePrevMonth")).toBe(1);
  });
  test("1st Trial, no course: a CANCELLED course does not convert the child; a live one does — with and without a branch filter", () => {
    const o = { bookings: [trial(S6, "2026-10-02", { status: "ATTENDED" }), trial(S7, "2026-10-03", { status: "ATTENDED" })], courses: [gone("c6", S6, "2026-10-04"), course({ id: "c7", studentIds: [S7], createdAt: "2026-10-04T03:00:00Z" })] };
    expect(nvr(o).rows.trialNotConverted.map((x) => x.studentId)).toEqual([S6]);
    expect(sameWithFilter(o, "trialNotConverted")).toBe(1);
  });
  test("NOT RENEWED: a cancelled / ended course or voucher is not «finished»; a cancelled LATER purchase does not count as the renewal; used up and expired stay", () => {
    const expired = course({ id: "ex", studentIds: [S8], createdAt: "2026-04-01T03:00:00Z", expiryDate: "2026-10-05" });
    expect(nvr({ courses: [expired] }).counts.notRenewed).toBe(1);
    expect(nvr({ courses: [expired, gone("later", S8, "2026-10-08")] }).counts.notRenewed).toBe(1); // the cancelled purchase is not a renewal
    expect(nvr({ courses: [gone("e", S9, "2026-04-01", "2026-10-03T03:00:00Z")] }).counts.notRenewed).toBe(0); // cancelled ≠ finished
    expect(nvr({ vouchers: [voucher({ id: "ev", studentId: S10, createdAt: "2026-04-01T03:00:00Z", endedAt: "2026-10-04T03:00:00Z" })] }).counts.notRenewed).toBe(0);
    expect(sameWithFilter({ courses: [expired, gone("e", S9, "2026-04-01", "2026-10-03T03:00:00Z")], bookings: [bk({ courseId: "ex", studentIds: [S8], status: "CONFIRMED", date: "2026-04-10" })] }, "notRenewed")).toBe(1);
  });
  test("VOUCHER renew (line 9): voucher → voucher IN (the earlier used up / expired / still running, Q6); a voucher after a COURSE is OUT; a first voucher is never a Renew", () => {
    const vNew = (id: string, student: string, day: string, o: Partial<SomVoucher> = {}) => voucher({ id, studentId: student, createdAt: `${day}T03:00:00Z`, ...o });
    const finished = vNew("v0", S2, "2026-03-01", { totalHours: 5, usedHours: 5 }); // used up
    expect(nvr({ vouchers: [finished, vNew("v1", S2, "2026-10-06")] }).rows.renewCourse.map((x) => x.packageLabel)).toEqual(["Voucher 10 hrs"]);
    expect(nvr({ vouchers: [vNew("e", S3, "2026-03-01", { expiryDate: "2026-06-01" }), vNew("v1", S3, "2026-10-06")] }).counts.renewCourse).toBe(1); // expired
    const done = course({ id: "cc", studentIds: [S4], createdAt: "2026-03-01T03:00:00Z", size: 4, usedSessions: 4 });
    expect(nvr({ courses: [done], vouchers: [vNew("v1", S4, "2026-10-06")] }).counts.renewCourse).toBe(0); // after a course
    expect(nvr({ vouchers: [vNew("run", S5, "2026-03-01"), vNew("v1", S5, "2026-10-06")] }).counts.renewCourse).toBe(1); // old still running ⇒ IN (Q6)
    expect(nvr({ vouchers: [vNew("v1", S6, "2026-10-06")] }).counts.renewCourse).toBe(0); // first voucher
    expect(nvr({ vouchers: [vNew("a", S6, "2026-10-06"), vNew("b", S6, "2026-10-06", { createdAt: "2026-10-06T09:00:00Z" })] }).counts.renewCourse).toBe(0); // bought the SAME day: not each other's Renew
    expect(nvr({ vouchers: [finished, vNew("v1", S2, "2026-10-06", { endedAt: "2026-10-10T03:00:00Z" })] }).counts.renewCourse).toBe(0); // the OWN voucher is cancelled (ended)
    expect(nvr({ vouchers: [{ ...finished, endedAt: "2026-05-01T03:00:00Z" }, vNew("v1", S2, "2026-10-06")] }).counts.renewCourse).toBe(0); // the earlier voucher is cancelled ⇒ not an earlier purchase
  });
  test("a course after a (finished) VOUCHER only is a NEW course, not a Renew (a course renews only after an earlier COURSE)", () => {
    const r = nvr({ bookings: [trial(S7, "2026-10-01")], vouchers: [voucher({ id: "v0", studentId: S7, createdAt: "2026-03-01T03:00:00Z", totalHours: 5, usedHours: 5 })], courses: [course({ id: "c", studentIds: [S7], createdAt: "2026-10-05T03:00:00Z" })] });
    expect([r.counts.renewCourse, r.counts.newCourseThisMonth]).toEqual([0, 1]);
  });
  test("🔴 ENDED_EARLY (ตัดจบคอร์ส, Porter's ruling on REQ-126) is NOT a cancel: the course stays a PURCHASE, counts as FINISHED for the next Renew, and shows in Not renewed with endedAt as its end day — and the same course with ADMIN_ERROR + a class taught is OUT of all three", () => {
    const withReason = (reason: string, o: Partial<SomCourse>) => course({ endedAt: "2026-10-03T03:00:00Z", endReason: reason, ...o });
    for (const [reason, inn] of [["ENDED_EARLY", true], ["ADMIN_ERROR", false]] as const) {
      // 1) New: the ended course is itself October's purchase
      const own = withReason(reason, { id: "own", studentIds: [S2], createdAt: "2026-10-01T03:00:00Z" });
      expect(nvr({ courses: [own], bookings: [trial(S2, "2026-09-20"), ...sessions("own", S2, ["2026-10-02"])] }).counts.newCoursePrevMonth).toBe(inn ? 1 : 0);
      // 2) Renew: it is the EARLIER course of a later purchase — finished (ENDED_EARLY) or no earlier purchase at all (cancelled ⇒ the later one is NEW)
      const old = withReason(reason, { id: "old", studentIds: [S3], createdAt: "2026-04-01T03:00:00Z", endedAt: "2026-05-01T03:00:00Z" });
      const later = course({ id: "later", studentIds: [S3], createdAt: "2026-10-05T03:00:00Z" });
      const r2 = nvr({ courses: [old, later], bookings: [trial(S3, "2026-03-20"), ...sessions("old", S3, ["2026-04-10"])] });
      expect([r2.counts.renewCourse, r2.counts.newCoursePrevMonth]).toEqual(inn ? [1, 0] : [0, 1]);
      // 3) Not renewed: it is listed, dated by endedAt
      const r3 = nvr({ courses: [withReason(reason, { id: "nr", studentIds: [S4], createdAt: "2026-04-01T03:00:00Z" })], bookings: sessions("nr", S4, ["2026-04-10"]) }).rows.notRenewed;
      expect(r3.map((x) => [x.studentId, x.date])).toEqual(inn ? [[S4, "2026-10-03"]] : []);
    }
  });
  test("an ENDED_EARLY course that is RENEWED leaves Not renewed (a cancelled later purchase does not renew it)", () => {
    const old = course({ id: "old", studentIds: [S5], createdAt: "2026-04-01T03:00:00Z", endedAt: "2026-10-03T03:00:00Z", endReason: "ENDED_EARLY" });
    expect(nvr({ courses: [old, course({ id: "n", studentIds: [S5], createdAt: "2026-10-08T03:00:00Z" })] }).counts.notRenewed).toBe(0);
    expect(nvr({ courses: [old, gone("c", S5, "2026-10-08")] }).counts.notRenewed).toBe(1);
  });
  test("🔒 the seam is ONE helper: a course is cancelled = endedAt set AND reason ≠ ENDED_EARLY (a legacy row with no reason is cancelled; one that TAUGHT classes still is); a voucher with endedAt is always cancelled; a pause is neither", () => {
    const ids = (cs: SomCourse[], vs: SomVoucher[] = []) => [...cancelledIds({ courses: cs, vouchers: vs })].sort();
    expect(ids([
      course({ id: "a", endedAt: "2026-01-01T03:00:00Z", endReason: "ENDED_EARLY" }), // ตัดจบคอร์ส — not a cancel
      course({ id: "b", endedAt: "2026-01-01T03:00:00Z", endReason: "ADMIN_ERROR" }),
      course({ id: "c", endedAt: "2026-01-01T03:00:00Z", endReason: "CUSTOMER_CANCELLED" }),
      course({ id: "d", endedAt: "2026-01-01T03:00:00Z", endReason: "PROGRAM_CHANGED" }),
      course({ id: "e", endedAt: "2026-01-01T03:00:00Z" }), // no reason recorded
      course({ id: "f" }),
      course({ id: "g", droppedAt: "2026-01-01T03:00:00Z" }),
    ], [voucher({ id: "v1", endedAt: "2099-01-01T03:00:00Z" }), voucher({ id: "v2" })])).toEqual(["b", "c", "d", "e", "v1"]);
  });
});

describe("🔴 TASK-755 (REQ-5002 §5 Q3) — 1st Trial = the child's first ATTENDED trial class, in this month; «1st Trial, no course» follows it", () => {
  const att = (id: string, date: string, o: Partial<SomBooking> = {}) => trial(id, date, { status: "ATTENDED", ...o });
  const bookings = [
    att(S1, "2026-10-02"), att(S2, "2026-10-03", { status: "CANCELLED" }), att(S3, "2026-09-30"),
    att(S4, "2026-10-04"), att(S5, "2026-10-05", { status: "PAUSED" }), att(S6, "2026-10-06"), att(S7, "2026-10-07"), att(S7, "2026-10-20"),
    att(S8, "2026-10-08", { status: "NO_SHOW" }), trial(S9, "2026-10-09"), // a no-show and a still-booked trial are not «attended»
    att(S10, "2026-09-15"), att(S10, "2026-10-05"), // his FIRST attended trial was in September
  ];
  const courses = [course({ id: "k4", studentIds: [S4], createdAt: "2026-10-04T08:00:00Z" }), course({ id: "k6", studentIds: [S6], createdAt: "2026-10-01T03:00:00Z" })];
  const vouchers = [voucher({ studentId: S5, createdAt: "2026-10-06T03:00:00Z" })];
  const r = nvr({ bookings, courses, vouchers });
  test("firstTrial = children whose first ATTENDED trial class is this month, by CLASS date: cancelled / paused / no-show / still-booked out, September out (also when a second attended one is in October), two attended = once; it stays after a course", () => {
    expect(ids(r.rows.firstTrial)).toEqual([S1, S4, S6, S7]);
    expect(r.rows.firstTrial[0]).toEqual({ studentId: S1, studentName: "Ploy", packageLabel: null, courseTeacherId: null, trialTeacherId: TA, trialDate: "2026-10-02", date: null, remark: null });
  });
  test("trialNotConverted follows firstTrial: ANY course bought no later than the month end converts, whatever its order with the trial (TEST-109 N1); a voucher does not (Q3.4)", () => {
    expect(ids(r.rows.trialNotConverted)).toEqual([S1, S7]); // S4, S6 hold a course ⇒ converted; the no-show S8 and the booked S9 were never in firstTrial
    expect(ids(nvr({ bookings, courses: [...courses, course({ id: "late", studentIds: [S1], createdAt: "2026-11-02T03:00:00Z" })], vouchers }).rows.trialNotConverted)).toEqual([S1, S7]); // a course bought AFTER the month end converts nobody in October
    expect(ids(nvr({ bookings: [att(S5, "2026-10-05")], vouchers }).rows.trialNotConverted)).toEqual([S5]); // a voucher does not convert
  });
  test("both are children, in trial-date order", () => {
    expect(r.rows.firstTrial.map((x) => x.trialDate)).toEqual(["2026-10-02", "2026-10-04", "2026-10-06", "2026-10-07"]);
  });
  test("the month's FIRST and LAST day are in; the day before and the day after are not", () => {
    const b = [att(S1, "2026-10-01"), att(S2, "2026-10-31"), att(S3, "2026-09-30"), att(S4, "2026-11-01")];
    expect(ids(nvr({ bookings: b }).rows.firstTrial)).toEqual([S1, S2]);
  });
  test("a no-show alone is NOT in 1st Trial (nor in «no course»), but its course IS on a New line (the New lines look at the earliest non-cancelled trial of any status)", () => {
    const o = { bookings: [trial(S1, "2026-10-01", { status: "NO_SHOW" })], courses: [course({ createdAt: "2026-10-05T03:00:00Z" })] };
    const x = nvr(o);
    expect([x.counts.firstTrial, x.counts.trialNotConverted, x.counts.newCourseThisMonth]).toEqual([0, 0, 1]);
  });
});

describe("🔴 TASK-742 — Course / Voucher not renewed (counted from the day AFTER the end; a later renewal removes it)", () => {
  const rowsOf = (c: Partial<SomContractInput>) => nvr(c).rows.notRenewed.map((x) => [x.studentId, x.date, x.packageLabel]);
  test("ended by EXPIRY or USED UP; counted from the next day; ENDED EARLY (cancelled, REQ-5002) / paused / still-active are not", () => {
    const r = rowsOf({
      courses: [
        course({ id: "cA", studentIds: [S1], expiryDate: "2026-10-05" }), // expired
        course({ id: "cB", studentIds: [S2], expiryDate: "2026-10-12" }), // last day = today ⇒ still ACTIVE
        course({ id: "cC", studentIds: [S3], expiryDate: "2026-10-11" }), // ended yesterday ⇒ counted today
        course({ id: "cD", studentIds: [S4], size: 4, usedSessions: 4 }), // used up on 8 Oct
        course({ id: "cE", studentIds: [S5], endedAt: "2026-10-03T03:00:00Z" }), // ended early
        course({ id: "cF", studentIds: [S6], droppedAt: "2026-10-01T03:00:00Z", expiryDate: "2026-10-05" }), // paused ⇒ not ended
      ],
      bookings: [bk({ courseId: "cD", studentIds: [S4], date: "2026-10-01" }), bk({ courseId: "cD", studentIds: [S4], date: "2026-10-08" })],
    });
    expect(r).toEqual([[S1, "2026-10-05", "Course 10 · Bike"], [S4, "2026-10-08", "Course 4 · Bike"], [S3, "2026-10-11", "Course 10 · Bike"]]);
  });
  test("the month boundary: last valid day 30 Sep ⇒ counted from 1 Oct (the OCTOBER page); last valid day 29 Sep ⇒ the September page", () => {
    const c = [course({ id: "cG", studentIds: [S1], expiryDate: "2026-09-30" }), course({ id: "cH", studentIds: [S2], expiryDate: "2026-09-29" })];
    expect(rowsOf({ courses: c }).map((x) => x[0])).toEqual([S1]);
    expect(rowsOf({ courses: c, month: "2026-09" }).map((x) => x[0])).toEqual([S2]);
  });
  test("a course that ended TODAY is not counted until tomorrow (the «from» day is after today)", () => {
    expect(rowsOf({ courses: [course({ expiryDate: "2026-10-11" })], today: "2026-10-11" })).toEqual([]);
    expect(rowsOf({ courses: [course({ expiryDate: "2026-10-11" })], today: "2026-10-12" })).toHaveLength(1);
  });
  test("a LATER pack (a course or a voucher, even one bought before the end) removes it; one bought the SAME day does not", () => {
    const old = course({ id: "cA", studentIds: [S1], createdAt: "2026-04-01T03:00:00Z", expiryDate: "2026-10-05" });
    expect(rowsOf({ courses: [old, course({ id: "n", studentIds: [S1], createdAt: "2026-10-08T03:00:00Z" })] })).toEqual([]);
    expect(rowsOf({ courses: [old], vouchers: [voucher({ studentId: S1, createdAt: "2026-10-08T03:00:00Z" })] })).toEqual([]);
    expect(rowsOf({ courses: [old], vouchers: [voucher({ studentId: S1, createdAt: "2026-04-01T09:00:00Z" })] })).toHaveLength(1); // bought the same day as the old course
  });
  test("vouchers: exhausted · expired — each with its end day; an ENDED (cancelled) voucher is not finished (REQ-5002)", () => {
    const r = rowsOf({
      vouchers: [
        voucher({ id: "vA", studentId: S9, totalHours: 5, usedHours: 5 }), voucher({ id: "vB", studentId: S10, expiryDate: "2026-10-01" }), voucher({ id: "vC", studentId: S11, endedAt: "2026-10-04T03:00:00Z" }),
        voucher({ id: "vD", studentId: S8 }), // active
      ],
      bookings: [bk({ voucherId: "vA", studentIds: [S9], bookingType: "VOUCHER", date: "2026-10-09" })],
    });
    expect(r).toEqual([[S10, "2026-10-01", "Voucher 10 hrs"], [S9, "2026-10-09", "Voucher 5 hrs"]]);
  });
  test("a DUO course is ONE row, and a renewal by EITHER child removes it", () => {
    const duo = course({ id: "d1", studentIds: [S1, S2], expiryDate: "2026-10-05", createdAt: "2026-04-01T03:00:00Z" });
    expect(nvr({ courses: [duo] }).rows.notRenewed).toHaveLength(1);
    expect(nvr({ courses: [duo, course({ id: "n", studentIds: [S2], createdAt: "2026-10-08T03:00:00Z" })] }).rows.notRenewed).toHaveLength(0);
  });
});

describe("🔴 TASK-742 — the list IS the card; the badge filter; the first session's coach", () => {
  const mixed = base({
    bookings: [trial(S1, "2026-10-02", { status: "ATTENDED" }), trial(S2, "2026-10-03", { status: "ATTENDED" }), trial(S3, "2026-09-21"), bk({ courseId: "c3", studentIds: [S3], teacherId: TB, date: "2026-10-07", status: "CONFIRMED" })],
    courses: [
      course({ id: "c3", studentIds: [S3], createdAt: "2026-10-03T03:00:00Z" }),
      course({ id: "old", studentIds: [S4], createdAt: "2026-03-01T03:00:00Z", expiryDate: "2026-10-05" }),
      course({ id: "ren", studentIds: [S5], createdAt: "2026-10-06T03:00:00Z" }), course({ id: "oldS5", studentIds: [S5], createdAt: "2026-02-01T03:00:00Z", size: 4, usedSessions: 4 }),
    ],
    vouchers: [voucher({ id: "vx", studentId: S6, expiryDate: "2026-10-04" })],
  });
  test("every card's number equals its list's length, for every bucket", () => {
    const r = countNvr(mixed);
    for (const k of NVR_BUCKETS) expect(r.counts[k]).toBe(r.rows[k].length);
    expect(r.counts).toEqual({ month: MONTH, from: "2026-10-01", to: "2026-10-31", firstTrial: 2, newCourseThisMonth: 0, newCoursePrevMonth: 1, renewCourse: 1, trialNotConverted: 2, notRenewed: 2 }); // notRenewed: `old` (expired 5 Oct) + the voucher (expired 4 Oct); S5's used-up course ended in February and was renewed
    expect(countSom(mixed).newVsRenewing).toEqual(r.counts); // the page and the list read the SAME function
  });
  test("the badge filter: a trial by ITS OWN badge, a pack through its (non-cancelled) session rows", () => {
    const b = [trial(S1, "2026-10-02", { status: "ATTENDED", badgeIds: [BV1] }), trial(S2, "2026-10-03", { status: "ATTENDED", badgeIds: [BV2] }), trial(S3, "2026-10-01", { badgeIds: [BV2] }), bk({ courseId: "c1", studentIds: [S1], badgeIds: [BV1], status: "CONFIRMED" }), bk({ courseId: "c2", studentIds: [S3], badgeIds: [BV2], status: "CONFIRMED" })];
    const c = [course({ id: "c1", studentIds: [S1] }), course({ id: "c2", studentIds: [S3] })];
    const one = nvr({ bookings: b, courses: c, badgeValueIds: [BV1] });
    expect([ids(one.rows.firstTrial), ids(one.rows.newCourseThisMonth)]).toEqual([[S1], [S1]]);
    const all = nvr({ bookings: b, courses: c });
    expect([ids(all.rows.firstTrial), all.counts.newCourseThisMonth]).toEqual([[S1, S2], 2]);
  });
  test("the names: nickname first, else the name; an unknown child falls back to his id", () => {
    const r = nvr({ bookings: [trial(S3, "2026-10-02", { status: "ATTENDED" })] }).rows.firstTrial[0]!;
    expect(r.studentName).toBe("Kid 3");
    expect(nvr({ students: [], bookings: [trial("ghost", "2026-10-02", { status: "ATTENDED" })] }).rows.firstTrial[0]!.studentName).toBe("ghost");
  });
});

describe("🔴 TASK-756 (REQ-5004 row 4) — Coach Capacity: available hours per day worked (FT 4 / 5, PT 5 weekend or his own, FL 0) minus recorded leave, booked hours, weekday / weekend", () => {
  const coach = (id: string, type: SomTeacher["type"], o: Partial<SomTeacher> = {}): SomTeacher => ({ id, nickname: id, type, active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], ...o });
  const cap = (o: Partial<SomContractInput>) => countCapacity(base(o));
  const MONFRI = [1, 2, 3, 4, 5];
  test("October 2026 (22 weekdays + 9 weekend days): FT working every day = 22 × 4 + 9 × 5; PT = weekend only (9 × 5), weekday capacity 0; PT with his own value 4 = 9 × 4; FL = 0 everywhere", () => {
    const r = cap({ teachers: [coach(TA, "FULL_TIME"), coach(TB, "PART_TIME"), coach("pt4", "PART_TIME", { weekendCapacityHours: 4 }), coach(TC, "FREELANCE")] });
    const by = (id: string) => r.byPerson.find((p) => p.teacherId === id)!;
    expect(by(TA)).toMatchObject({ weekdayAvailableHours: 88, weekendAvailableHours: 45, availableHours: 133 });
    expect(by(TB)).toMatchObject({ weekdayAvailableHours: 0, weekdayPct: 0, weekendAvailableHours: 45, availableHours: 45 });
    expect(by("pt4")).toMatchObject({ weekdayAvailableHours: 0, weekendAvailableHours: 36, availableHours: 36 });
    expect(by(TC)).toMatchObject({ weekdayAvailableHours: 0, weekendAvailableHours: 0, availableHours: 0, weekdayPct: 0, weekendPct: 0 });
  });
  test("a PT whose own value is 0 has no capacity (set means set); null / absent = the type's rate", () => {
    expect(cap({ teachers: [coach(TA, "PART_TIME", { weekendCapacityHours: 0 })] }).byPerson[0]).toMatchObject({ weekendAvailableHours: 0 });
    expect(cap({ teachers: [coach(TA, "PART_TIME", { weekendCapacityHours: null })] }).byPerson[0]).toMatchObject({ weekendAvailableHours: 45 });
    expect(cap({ teachers: [coach(TA, "FULL_TIME", { weekendCapacityHours: 2 })] }).byPerson[0]).toMatchObject({ weekendAvailableHours: 45 }); // only a PT reads it
  });
  test("an advance-leave day is taken off per the coach's own rate (FT Monday ⇒ −4; PT Saturday ⇒ −5, his own 4 ⇒ −4; a Saturday he does not work ⇒ nothing; a day in ANOTHER month ⇒ nothing)", () => {
    const leave = [{ teacherId: TB, date: "2026-10-05" }, { teacherId: TB, date: "2026-10-03" }, { teacherId: TB, date: "2026-11-02" }, { teacherId: TA, date: "2026-10-06" }, { teacherId: TC, date: "2026-10-10" }];
    const r = cap({ teachers: [coach(TB, "FULL_TIME", { workDays: MONFRI }), coach(TA, "PART_TIME", { workDays: [0, 6] }), coach(TC, "PART_TIME", { weekendCapacityHours: 4 })], leaveDays: leave });
    const by = (id: string) => r.byPerson.find((p) => p.teacherId === id)!;
    expect(by(TB)).toMatchObject({ weekdayAvailableHours: 84, weekendAvailableHours: 0 }); // Mon 5 Oct off; Sat 3 Oct he does not work
    expect(by(TA)).toMatchObject({ weekdayAvailableHours: 0, weekendAvailableHours: 45 }); // a weekday leave day changes nothing for a weekend coach
    expect(by(TC)).toMatchObject({ weekendAvailableHours: 32 }); // 9 × 4 − Sat 10 Oct (4)
  });
  test("🔴 a PT's Hours (x / y) = WEEKEND booked only: his weekday classes stay real in the weekday cell (0 available, 0 %) but out of bookedHours; his weekend % is unaffected", () => {
    const b = [lesson("2026-10-05"), lesson("2026-10-06"), lesson("2026-10-03"), lesson("2026-10-04"), lesson("2026-10-10")]; // 2 weekday + 3 weekend
    const r = cap({ teachers: [coach(TA, "PART_TIME")], bookings: b }).byPerson[0]!;
    expect([r.weekdayBookedHours, r.weekdayAvailableHours, r.weekdayPct]).toEqual([2, 0, 0]);
    expect([r.weekendBookedHours, r.weekendAvailableHours, r.weekendPct, r.bookedHours]).toEqual([3, 45, 7, 3]); // 3 / 45 = 6.7 %
    expect(r.availableHours).toBe(45);
  });
  test("🔴 FREELANCE: booked hours real (both cells and the total), available 0, % 0", () => {
    const b = [lesson("2026-10-05"), lesson("2026-10-06"), lesson("2026-10-03")];
    const r = cap({ teachers: [coach(TC, "FREELANCE")], bookings: b.map((x) => ({ ...x, teacherId: TC })) }).byPerson[0]!;
    expect([r.weekdayBookedHours, r.weekendBookedHours, r.bookedHours]).toEqual([2, 1, 3]);
    expect([r.availableHours, r.weekdayPct, r.weekendPct]).toEqual([0, 0, 0]);
  });
  test("a weekend-only FULL_TIME coach: weekday 0 / 0, weekend 9 × 6", () => {
    expect(cap({ teachers: [coach(TA, "FULL_TIME", { workDays: [0, 6] })] }).byPerson[0]).toMatchObject({ weekdayAvailableHours: 0, weekdayPct: 0, weekendAvailableHours: 45 });
  });
  test("February 2026 (20 weekdays + 8 weekend days): FT = 20 × 4 + 8 × 5; a FREELANCE gets 0 whatever his workDays", () => {
    expect(cap({ month: "2026-02", teachers: [coach(TA, "FULL_TIME")] }).byPerson[0]).toMatchObject({ weekdayAvailableHours: 80, weekendAvailableHours: 40 });
    expect(cap({ month: "2026-02", teachers: [coach(TC, "FREELANCE")] }).byPerson[0]).toMatchObject({ availableHours: 0 });
  });
  const lesson = (date: string, o: Partial<SomBooking> = {}) => bk({ date, status: "CONFIRMED", teacherId: TA, ...o });
  test("booked hours split by the day of the week; % = round(booked ÷ available × 100)", () => {
    const b = [lesson("2026-10-05"), lesson("2026-10-06"), lesson("2026-10-07"), lesson("2026-10-08"), lesson("2026-10-03"), lesson("2026-10-04")]; // 4 weekday + Sat + Sun
    const r = cap({ teachers: [coach(TA, "FULL_TIME")], bookings: b }).byPerson[0]!;
    expect([r.weekdayBookedHours, r.weekendBookedHours, r.bookedHours]).toEqual([4, 2, 6]);
    expect([r.weekdayPct, r.weekendPct]).toEqual([5, 4]); // 4/88 = 4.5 · 2/45 = 4.4
  });
  test("what counts as booked: lessons + the GROUP row (once per coach, extras too); NOT cancelled rows, a group's SEATS, ECA / camp rows, other months; PENDING / PAUSED / SICK_LEAVE still hold the hour (Q4.5 default)", () => {
    const b = [
      lesson("2026-10-05"), lesson("2026-10-05", { status: "CANCELLED" }), lesson("2026-10-05", { isSeat: true }), lesson("2026-10-05", { bookingType: "OTHER" }), lesson("2026-09-30"), lesson("2026-11-02"),
      lesson("2026-10-06", { status: "PENDING" }), lesson("2026-10-07", { status: "PAUSED" }), lesson("2026-10-08", { status: "SICK_LEAVE" }),
      lesson("2026-10-09", { bookingType: "GROUP", extraTeacherIds: [TB] }),
    ];
    const r = cap({ teachers: [coach(TA, "FULL_TIME"), coach(TB, "FULL_TIME")], bookings: b });
    expect(r.byPerson.find((p) => p.teacherId === TA)!.bookedHours).toBe(5); // 05 · 06 · 07 · 08 · 09(group)
    expect(r.byPerson.find((p) => p.teacherId === TB)!.bookedHours).toBe(1); // the group row only
  });
  test("the booked hours are the rows' DURATION (a 2-hour row = 2 h), rounded once per coach and bucket", () => {
    const two = lesson("2026-10-05", { startTime: "10:00", endTime: "12:00" });
    expect(cap({ teachers: [coach(TA, "FULL_TIME")], bookings: [two] }).byPerson[0]!.bookedHours).toBe(2);
    const half = (d: string) => lesson(d, { startTime: "10:00", endTime: "11:30" });
    expect(cap({ teachers: [coach(TA, "FULL_TIME")], bookings: [half("2026-10-05"), half("2026-10-06")] }).byPerson[0]!.bookedHours).toBe(3); // 90 + 90 minutes
    expect(cap({ teachers: [coach(TA, "FULL_TIME")], bookings: [half("2026-10-05")] }).byPerson[0]!.bookedHours).toBe(2); // 90 minutes rounds to 2, it is not cut to 1
  });
  test("the badge filter applies to BOOKED only (Q0.2) — available is not filtered", () => {
    const b = [lesson("2026-10-05", { badgeIds: [BV1] }), lesson("2026-10-06", { badgeIds: [BV2] }), lesson("2026-10-07")];
    const r = cap({ teachers: [coach(TA, "FULL_TIME")], bookings: b, badgeValueIds: [BV1] }).byPerson[0]!;
    expect([r.bookedHours, r.availableHours]).toEqual([1, 133]);
  });
  test("only ACTIVE, non-archived coaches; ordered Full-time → Part-time → Freelance, then nickname", () => {
    const r = cap({ teachers: [coach("z", "FREELANCE"), coach("b", "PART_TIME"), coach("y", "FULL_TIME"), coach("a", "FULL_TIME"), coach("off", "FULL_TIME", { active: false }), coach("gone", "PART_TIME", { archived: true })] });
    expect(r.byPerson.map((p) => p.teacherId)).toEqual(["a", "y", "b", "z"]);
  });
  test("byType: always the three rows; coaches counted; hours are SUMS and the % comes from the sums — not an average of percentages", () => {
    const b = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((d) => lesson(d, { teacherId: TA }));
    const r = cap({ teachers: [coach(TA, "FULL_TIME", { workDays: MONFRI }), coach(TB, "FULL_TIME", { workDays: MONFRI })], bookings: b });
    expect(r.byType.map((t) => [t.teacherType, t.coaches])).toEqual([["FULL_TIME", 2], ["PART_TIME", 0], ["FREELANCE", 0]]);
    const ft = r.byType[0]!;
    expect([ft.weekdayBookedHours, ft.weekdayAvailableHours, ft.weekdayPct]).toEqual([4, 176, 2]); // 4/176 = 2.3% — the mean of A's 5% and B's 0% would be 3%
    expect(r.byPerson[0]!.weekdayPct).toBe(5); // 4/88 = 4.5% ⇒ 5
    expect(r.byType[1]).toMatchObject({ coaches: 0, bookedHours: 0, availableHours: 0, weekdayPct: 0, weekendPct: 0 });
  });
  test("byType sums the same rule: a PT type's bookedHours is the sum of his PTs' WEEKEND hours; FL's booked hours are real with available 0", () => {
    const b = [lesson("2026-10-05"), lesson("2026-10-03"), lesson("2026-10-06", { teacherId: TC })];
    const r = cap({ teachers: [coach(TA, "PART_TIME"), coach(TC, "FREELANCE")], bookings: b });
    expect(r.byType[1]).toMatchObject({ teacherType: "PART_TIME", coaches: 1, bookedHours: 1, weekdayBookedHours: 1, weekdayAvailableHours: 0, weekendBookedHours: 1, weekendAvailableHours: 45, availableHours: 45 });
    expect(r.byType[2]).toMatchObject({ teacherType: "FREELANCE", coaches: 1, bookedHours: 1, availableHours: 0, weekdayPct: 0, weekendPct: 0 });
  });
  test("a percentage never passes 100 (an over-booked coach), but his hours stay real: 12 booked vs ONE available Saturday (5) ⇒ 240% ⇒ 100", () => {
    const b = Array.from({ length: 12 }, () => lesson("2026-10-03"));
    const r = cap({ month: "2026-10", teachers: [coach(TA, "FULL_TIME", { workDays: [6] })], leaveDays: ["10", "17", "24", "31"].map((d) => ({ teacherId: TA, date: `2026-10-${d}` })), bookings: b }).byPerson[0]!;
    expect([r.weekendAvailableHours, r.weekendBookedHours, r.weekendPct]).toEqual([5, 12, 100]);
  });
  test("with no roster the report is empty but whole: three type rows at zero, month echoed", () => {
    const r = cap({});
    expect([r.month, r.byPerson.length, r.byType.length]).toEqual([MONTH, 0, 3]);
  });
  test("the page carries it, with Palm's field names, integers only", () => {
    const x = countSom(base({ teachers: [coach(TA, "FULL_TIME")] })).coachCapacity;
    expect(Object.keys(x.byPerson[0]!).sort()).toEqual(["availableHours", "bookedHours", "teacherId", "teacherType", "weekdayAvailableHours", "weekdayBookedHours", "weekdayPct", "weekendAvailableHours", "weekendBookedHours", "weekendPct"]);
    expect(Object.keys(x.byType[0]!).sort()).toEqual(["availableHours", "bookedHours", "coaches", "teacherType", "weekdayAvailableHours", "weekdayBookedHours", "weekdayPct", "weekendAvailableHours", "weekendBookedHours", "weekendPct"]);
    for (const k of ["availableHours", "bookedHours", "weekdayPct", "weekendPct"] as const) expect(Number.isInteger(x.byPerson[0]![k])).toBe(true);
  });
});

describe("🔴 TASK-742 — the route's merge keeps the old three beside Palm's six", () => {
  test("`newVsRenewing`: the old fields stay; `coachCapacity` is the new section", () => {
    const fresh = countSom(base({ teachers: [] }));
    const merged = mergeSom({ today: {}, existingCustomers: {}, demographics: {}, newVsRenewing: { newByFirstTrial: 7, newByRegistration: 2, renewing: 0 } }, fresh);
    expect(merged.newVsRenewing).toEqual({ newByFirstTrial: 7, newByRegistration: 2, renewing: 0, ...fresh.newVsRenewing });
    expect(merged.coachCapacity).toBe(fresh.coachCapacity);
  });
});

describe("🔴 TASK-742 — the READ (service), the list endpoint and its access", () => {
  const T = bangkokNow().date;
  const M = T.slice(0, 7);
  const spies: Array<{ mockRestore: () => void }> = [];
  const leaveCalls: unknown[][] = [];
  afterAll(() => { for (const s of spies) s.mockRestore(); });
  const stub = (rows: { bookings?: any[]; courses?: any[]; students?: any[]; teachers?: any[]; leave?: any[] }) => {
    spies.push(
      spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows.bookings ?? []) as any),
      spyOn(db.query.parents, "findMany").mockImplementation((async () => []) as any),
      spyOn(db.query.coursePackages, "findMany").mockImplementation((async () => rows.courses ?? []) as any),
      spyOn(db.query.vouchers, "findMany").mockImplementation((async () => []) as any),
      spyOn(db.query.students, "findMany").mockImplementation((async () => rows.students ?? []) as any),
      spyOn(db.query.subjects, "findMany").mockImplementation((async () => [{ id: BIKE, name: "Bike", active: true }]) as any),
      spyOn(db.query.teachers, "findMany").mockImplementation((async () => rows.teachers ?? []) as any),
      spyOn(db, "select").mockImplementation((() => ({ from: async () => [] })) as any), // the expiry-move reads
      spyOn(teacherLeave, "recordedLeaveDays").mockImplementation((async (...a: unknown[]) => { leaveCalls.push(a.slice(1)); return rows.leave ?? []; }) as any),
    );
  };
  const done = () => { for (const s of spies.splice(0)) s.mockRestore(); };
  const B = (o: any = {}) => ({ studentId: S1, coStudentId: null, bookingType: "FIRST_TRIAL", status: "CONFIRMED", date: T, subjectId: BIKE, courseId: null, voucherId: null, groupId: null, pendingSlot: false, teacherId: TA, startTime: "10:00:00", endTime: "11:00:00", badges: [], additionalTeachers: [], ...o });

  test("the list endpoint's rows are exactly the card's number, from the SAME read; the coach and the child's name come through", async () => {
    stub({ bookings: [B({ status: "ATTENDED" }), B({ status: "ATTENDED", studentId: S2 })], students: [{ id: S1, name: "Ploy Wong", nickname: "Ploy", parentId: null }, { id: S2, name: "Pun Lee", nickname: null, parentId: null }] });
    try {
      const page = await svc.getSomContract({ month: M });
      const list = await svc.getNvrRows("firstTrial", { month: M });
      expect(page.newVsRenewing.firstTrial).toBe(2);
      expect(list.rows).toHaveLength(page.newVsRenewing.firstTrial);
      expect(list.rows[0]).toMatchObject({ studentId: S1, studentName: "Ploy", trialTeacherId: TA, trialDate: T, remark: null });
      expect((await svc.getNvrRows("renewCourse", { month: M })).rows).toEqual([]);
    } finally { done(); }
  });
  test("the service passes each course's `end_reason` to the counters (TEST: an ENDED_EARLY course reaches Not renewed through the real READ; the same course with ADMIN_ERROR does not)", async () => {
    const T = bangkokNow().date;
    const yesterday = new Date(`${T}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const endedAt = new Date(`${yesterday.toISOString().slice(0, 10)}T03:00:00Z`);
    const mk = (reason: string) => ({ id: "c1", studentId: S1, coStudentId: null, createdAt: new Date("2026-01-05T03:00:00Z"), size: 10, usedSessions: 3, expiryDate: "2099-01-01", endedAt, droppedAt: null, endReason: reason, subjectId: null });
    for (const [reason, listed] of [["ENDED_EARLY", 1], ["ADMIN_ERROR", 0]] as const) {
      stub({ courses: [mk(reason)], students: [{ id: S1, name: "Ploy Wong", nickname: "Ploy", parentId: null }] });
      try {
        expect((await svc.getNvrRows("notRenewed", { month: T.slice(0, 7) })).rows).toHaveLength(listed);
      } finally { done(); }
    }
  });
  test("🔴 TASK-757: the READ resolves the PERIOD — a month asks the leave reader for its first–last day, a from–to for the range, no period (ALL DATA) for the earliest lesson row … today; the echo rides on the section", async () => {
    const before = leaveCalls.length;
    stub({ bookings: [B({ date: "2026-08-03", status: "ATTENDED", bookingType: "COURSE_PACKAGE" }), B({ date: "2026-08-01", status: "CANCELLED", bookingType: "COURSE_PACKAGE" })], teachers: [{ id: TA, nickname: "A", type: "FULL_TIME", active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], createdAt: new Date(`${T}T03:00:00Z`) }] });
    try {
      const r = await svc.getSomContract({ from: "2026-10-01", to: "2026-10-05" });
      expect([r.existingCustomers.month, r.existingCustomers.from, r.existingCustomers.to]).toEqual([null, "2026-10-01", "2026-10-05"]);
      expect(leaveCalls[before]).toEqual(["2026-10-01", "2026-10-05"]);
      const all = await svc.getSomContract();
      expect([all.coachCapacity.month, all.coachCapacity.from, all.coachCapacity.to]).toEqual([null, "2026-08-03", T]);
      expect(leaveCalls[before + 1]).toEqual(["2026-08-03", T]);
      const dowT = new Date(`${T}T00:00:00Z`).getUTCDay();
      expect(all.coachCapacity.byPerson[0]!.availableHours).toBe(dowT === 0 || dowT === 6 ? 5 : 4); // all data: a coach created today counts from today only (the READ hands over created_at)
      const m = await svc.getSomContract({ month: "2026-09" });
      expect([m.newVsRenewing.month, m.newVsRenewing.from, m.newVsRenewing.to]).toEqual(["2026-09", "2026-09-01", "2026-09-30"]);
      expect(leaveCalls[before + 2]).toEqual(["2026-09-01", "2026-09-30"]);
      expect((await svc.getNvrRows("firstTrial", { from: "2026-10-01", to: "2026-10-05" })).rows).toEqual([]); // the list endpoint takes the same period
    } finally { done(); }
  });
  test("Coach Capacity reads the roster, the leave days and the extra coaches (with the rows' times)", async () => {
    stub({
      bookings: [B({ bookingType: "GROUP", status: "CONFIRMED", teacherId: TA, additionalTeachers: [{ teacherId: TB }], startTime: "10:00:00", endTime: "12:00:00" })],
      teachers: [{ id: TA, nickname: "A", type: "FULL_TIME", active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6] }, { id: TB, nickname: "B", type: "FULL_TIME", active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6] }, { id: TC, nickname: "C", type: "PART_TIME", active: true, archived: false, workDays: [0, 6], weekendCapacityHours: 3 }],
      leave: [{ teacherId: TB, date: `${M}-15` }],
    });
    try {
      const cc = (await svc.getSomContract({ month: M })).coachCapacity;
      expect(cc.byPerson.map((p) => [p.teacherId, p.bookedHours])).toEqual([[TA, 2], [TB, 2], [TC, 0]]); // the 2-hour group row counts for both coaches
      const a = cc.byPerson[0]!, b = cc.byPerson[1]!, c = cc.byPerson[2]!;
      const dow = new Date(`${M}-15T00:00:00Z`).getUTCDay();
      expect(a.availableHours - b.availableHours).toBe(dow === 0 || dow === 6 ? 5 : 4); // B's leave day, at his own rate
      const weekendDays = Array.from({ length: +new Date(Date.UTC(+M.slice(0, 4), +M.slice(5), 0)).toISOString().slice(8, 10) }, (_, i) => new Date(Date.UTC(+M.slice(0, 4), +M.slice(5) - 1, i + 1)).getUTCDay()).filter((d) => d === 0 || d === 6).length;
      expect(c.availableHours).toBe(weekendDays * 3); // the READ hands over `weekend_capacity_hours`: a PT's own value
      expect(leaveCalls[0]).toEqual([`${M}-01`, new Date(Date.UTC(+M.slice(0, 4), +M.slice(5), 0)).toISOString().slice(0, 10)]); // the whole month, through THE reader
    } finally { done(); }
  });
  test("`GET /reports/som/new-vs-renewing/:bucket` reaches the service with the bucket and the parsed filters; unknown bucket / bad month / bad badge ⇒ 400", async () => {
    const calls: unknown[][] = [];
    spies.push(spyOn(svc, "getNvrRows").mockImplementation((async (...a: unknown[]) => { calls.push(a); return { rows: [] }; }) as any));
    try {
      const ok = await api.request(`/reports/som/new-vs-renewing/notRenewed?month=2026-09&badgeValueIds=${BV1},${BV2}`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ rows: [] });
      expect(calls[0]).toEqual(["notRenewed", { month: "2026-09", badgeValueIds: [BV1, BV2] }]);
      await api.request("/reports/som/new-vs-renewing/firstTrial");
      expect(calls[1]).toEqual(["firstTrial", { month: undefined, badgeValueIds: [] }]);
      expect((await api.request("/reports/som/new-vs-renewing/nope")).status).toBe(400);
      expect((await api.request("/reports/som/new-vs-renewing/firstTrial?month=2026-13")).status).toBe(400);
      expect((await api.request("/reports/som/new-vs-renewing/firstTrial?badgeValueIds=x")).status).toBe(400);
    } finally { done(); }
  });
  test("🔴 through the ROOT app (the uuid guard is on): the list route answers 200 for a card name, and still 400s a bad one", async () => {
    process.env.SKIP_AUTH = "true";
    const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
    spies.push(spyOn(svc, "getNvrRows").mockImplementation((async () => ({ rows: [] })) as any));
    try {
      expect((await rootApp.fetch(new Request("http://localhost/api/reports/som/new-vs-renewing/firstTrial"))).status).toBe(200);
      expect((await rootApp.fetch(new Request("http://localhost/api/reports/som/new-vs-renewing/nope"))).status).toBe(400);
    } finally { done(); delete process.env.SKIP_AUTH; }
  });
  test("the validator takes exactly the six bucket names", () => {
    for (const b of NVR_BUCKETS) expect(v.nvrBucketParam.safeParse({ bucket: b }).success).toBe(true);
    for (const b of ["", "newCourse", "FIRSTTRIAL", "rows"]) expect(v.nvrBucketParam.safeParse({ bucket: b }).success).toBe(false);
  });
  test("the list has the page's access (`menu:som`) — a route with no entry would be refused to everyone", () => {
    const k = routeKey("GET", "/api/reports/som/new-vs-renewing/:bucket");
    expect(ROUTE_ACCESS[k]).toEqual(ROUTE_ACCESS[routeKey("GET", "/api/reports/som")]);
    expect(ROUTE_ACCESS[k]!.menus).toEqual(["menu:som"]);
  });
});

describe("🔴 TASK-757 (REQ-5004 row 1) — the period: all data by default, from–to, or a month that answers exactly as before", () => {
  const coachOf = (id: string, type: SomTeacher["type"], o: Partial<SomTeacher> = {}): SomTeacher => ({ id, nickname: id, type, active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], ...o });
  const att = (id: string, date: string, o: Partial<SomBooking> = {}) => bk({ studentIds: [id], date, status: "ATTENDED", ...o });
  const strip = (x: any): any => JSON.parse(JSON.stringify(x, (k, val) => (k === "month" || k === "from" || k === "to" ? undefined : val)));
  const rich = (): Partial<SomContractInput> => ({
    students: STUDENTS,
    bookings: [
      trial(S1, "2026-10-02", { status: "ATTENDED" }), trial(S2, "2026-09-21", { status: "ATTENDED" }), trial(S5, "2026-08-15", { status: "ATTENDED" }),
      att(S1, "2026-10-05", { courseId: "c1" }), att(S2, "2026-09-25", { courseId: "c2" }), bk({ courseId: "c1", studentIds: [S1], status: "CONFIRMED", date: "2026-10-20" }),
      bk({ studentIds: [S4], bookingType: "SINGLE_SESSION", status: "ATTENDED", date: "2026-10-06" }), att(S3, "2026-10-07", { bookingType: "VOUCHER", voucherId: "v1" }),
      att(S3, "2026-09-02", { bookingType: "VOUCHER", voucherId: "v1", teacherId: TB }),
    ],
    courses: [course({ id: "c1", studentIds: [S1], createdAt: "2026-10-03T03:00:00Z" }), course({ id: "c2", studentIds: [S2], createdAt: "2026-09-22T03:00:00Z" }), course({ id: "c0", studentIds: [S2], createdAt: "2026-02-01T03:00:00Z", size: 4, usedSessions: 4 })],
    vouchers: [voucher({ id: "v1", studentId: S3, createdAt: "2026-09-01T03:00:00Z" })],
    teachers: [coachOf(TA, "FULL_TIME"), coachOf(TB, "PART_TIME"), coachOf(TC, "FREELANCE")],
    leaveDays: [{ teacherId: TA, date: "2026-10-06" }],
  });
  test("🔴 a MONTH answers byte-identically to the same month as a full from–to range (only the echoed month / from / to differ) — the month the screen keeps sending", () => {
    for (const [month, from, to] of [["2026-10", "2026-10-01", "2026-10-31"], ["2026-09", "2026-09-01", "2026-09-30"], ["2026-02", "2026-02-01", "2026-02-28"]] as const) {
      const a = countSom(base({ ...rich(), month }));
      const b = countSom(base({ ...rich(), month: undefined, from, to }));
      expect(strip(b)).toEqual(strip(a));
      expect([a.existingCustomers.month, a.existingCustomers.from, a.existingCustomers.to]).toEqual([month, from, to]); // additive echo
      expect([b.existingCustomers.month, b.existingCustomers.from, b.existingCustomers.to]).toEqual([null, from, to]);
    }
  });
  test("a month still reads its own first–last day: the same fixture, October vs September, differ (the period is not ignored)", () => {
    const oct = countSom(base({ ...rich(), month: "2026-10" })), sep = countSom(base({ ...rich(), month: "2026-09" }));
    expect(oct.activityProgram.categories[0]!.total).not.toBe(sep.activityProgram.categories[0]!.total);
    expect([oct.newVsRenewing.newCourseThisMonth, sep.newVsRenewing.renewCourse]).toEqual([1, 1]); // c1 (S1) bought 3 Oct with the trial on 2 Oct · c2 (S2's second course) bought 22 Sep
  });
  test("ALL DATA (no month, no range): from the EARLIEST non-cancelled LESSON row (not a cancelled row, not an ECA / camp row) to today; month echoed null", () => {
    const b = [att(S1, "2026-03-05", { status: "CANCELLED" }), bk({ studentIds: [S2], bookingType: "OTHER", date: "2026-02-01" }), att(S3, "2026-04-10"), att(S3, "2026-10-05")];
    const r = countSom(base({ month: undefined, bookings: b }));
    expect([r.existingCustomers.month, r.existingCustomers.from, r.existingCustomers.to]).toEqual([null, "2026-04-10", TODAY]);
    expect([r.demographics.from, r.activityProgram.from, r.newVsRenewing.from, r.coachCapacity.from]).toEqual(["2026-04-10", "2026-04-10", "2026-04-10", "2026-04-10"]);
    expect(r.activityProgram.categories.find((c) => c.key === BIKE)!.total).toBe(2); // both attended lessons, from different months
  });
  test("all data with no lesson at all: the range is just today (never an inverted range)", () => {
    const r = countSom(base({ month: undefined }));
    expect([r.existingCustomers.from, r.existingCustomers.to]).toEqual([TODAY, TODAY]);
    expect(countSom(base({ month: undefined, bookings: [att(S1, "2026-12-01")] })).existingCustomers.from).toBe(TODAY); // a future-dated class does not start the range
  });
  test("a from–to range CROSSING months reads every row in it and none outside (boundary days in); ONE day works", () => {
    const b = [att(S1, "2026-09-19"), att(S1, "2026-09-20"), att(S1, "2026-10-05"), att(S1, "2026-10-06")];
    const total = (from: string, to: string) => countSom(base({ month: undefined, from, to, bookings: b })).activityProgram.categories.find((c) => c.key === BIKE)!.total;
    expect(total("2026-09-20", "2026-10-05")).toBe(2);
    expect(total("2026-09-20", "2026-09-20")).toBe(1);
    expect(total("2026-10-05", "2026-10-05")).toBe(1);
  });
  test("the as-of day is the range's END capped at today: Active course reads the end day, not today", () => {
    const c = course({ id: "a", studentIds: [S1], createdAt: "2026-08-01T03:00:00Z", expiryDate: "2026-10-05" });
    const b = [bk({ courseId: "a", studentIds: [S1], status: "CONFIRMED", date: "2026-10-20" })];
    const active = (to: string) => countSom(base({ month: undefined, from: "2026-08-01", to, courses: [c], bookings: b })).existingCustomers.activeCourse;
    expect(active("2026-09-30")).toBe(1); // alive on 30 Sep
    expect(active("2026-10-31")).toBe(0); // as of TODAY (12 Oct) it expired on 5 Oct
    const live = course({ id: "live", studentIds: [S2], createdAt: "2026-08-01T03:00:00Z", expiryDate: "2027-01-01" });
    const later = [bk({ courseId: "live", studentIds: [S2], status: "CONFIRMED", date: "2026-10-20" })];
    expect(countSom(base({ month: undefined, from: "2026-10-01", to: "2026-10-31", courses: [live], bookings: later })).existingCustomers.activeCourse).toBe(1); // the end day (31 Oct) is in the future: the as-of day is TODAY (12 Oct), the class on the 20th is still after it
  });
  test("cards 3 + 4: the 3 calendar months ending at the range's end (Jul 1 … the end day)", () => {
    const b = [trial(S1, "2026-06-30"), trial(S2, "2026-07-01"), trial(S3, "2026-09-14"), trial(S4, "2026-09-20")];
    const r = countSom(base({ month: undefined, from: "2026-09-01", to: "2026-09-15", bookings: b })).existingCustomers;
    expect(r.recentFirstTrial).toBe(2); // S2 · S3
    expect([r.recentFrom, r.recentTo]).toEqual(["2026-07", "2026-09"]);
  });
  test("🔴 the New lines over a range, PER ROW: a first course opened in the range with the 1st Trial in the SAME calendar month as the purchase = this month, an EARLIER month = previous; a later course is a Renew", () => {
    const o = {
      month: undefined, from: "2026-09-01", to: "2026-10-31",
      bookings: [trial(S1, "2026-09-02"), trial(S2, "2026-09-21"), trial(S3, "2026-10-01"), trial(S4, "2026-10-20")],
      courses: [
        course({ id: "a", studentIds: [S1], createdAt: "2026-09-10T03:00:00Z" }), // trial Sep, bought Sep ⇒ this month
        course({ id: "b", studentIds: [S2], createdAt: "2026-10-05T03:00:00Z" }), // trial Sep, bought Oct ⇒ previous
        course({ id: "c", studentIds: [S3], createdAt: "2026-10-08T03:00:00Z" }), // trial Oct, bought Oct ⇒ this month
        course({ id: "d", studentIds: [S4], createdAt: "2026-10-08T03:00:00Z" }), // the trial is AFTER the purchase ⇒ neither
        course({ id: "a2", studentIds: [S1], createdAt: "2026-10-09T03:00:00Z" }), // S1's second course ⇒ Renew, no New line
      ],
    } as Partial<SomContractInput>;
    const r = nvr(o);
    expect([r.counts.newCourseThisMonth, r.counts.newCoursePrevMonth, r.counts.renewCourse]).toEqual([2, 1, 1]);
    expect(ids(r.rows.newCourseThisMonth)).toEqual([S1, S3]);
    expect(ids(r.rows.newCoursePrevMonth)).toEqual([S2]);
  });
  test("the other cards over a range: 1st Trial, Renew and Not renewed count what FALLS IN the range", () => {
    const o = {
      month: undefined, from: "2026-09-01", to: "2026-10-31",
      bookings: [trial(S1, "2026-08-31", { status: "ATTENDED" }), trial(S2, "2026-09-01", { status: "ATTENDED" }), trial(S3, "2026-10-31", { status: "ATTENDED" })],
      courses: [course({ id: "e", studentIds: [S5], createdAt: "2026-02-01T03:00:00Z", expiryDate: "2026-09-30" })], // ends 30 Sep ⇒ counted from 1 Oct, inside
    } as Partial<SomContractInput>;
    const r = nvr(o);
    expect(ids(r.rows.firstTrial)).toEqual([S2, S3]); // 31 Aug is out
    expect(ids(r.rows.notRenewed)).toEqual([S5]);
    expect(ids(nvr({ ...o, from: "2026-10-02", to: "2026-10-31" }).rows.notRenewed)).toEqual([]); // counted from 1 Oct: before this range
  });
  test("🔴 the list IS the card on every period (month, range, one day, all data) — every bucket", () => {
    const r0 = rich();
    for (const p of [{ month: "2026-10" }, { month: undefined, from: "2026-09-15", to: "2026-10-12" }, { month: undefined, from: "2026-10-02", to: "2026-10-02" }, { month: undefined }] as Array<Partial<SomContractInput>>) {
      const x = countNvr(base({ ...r0, ...p }));
      for (const k of NVR_BUCKETS) expect(x.counts[k]).toBe(x.rows[k].length);
      expect(countSom(base({ ...r0, ...p })).newVsRenewing).toEqual(x.counts);
    }
  });
  test("Coach Capacity over a range: each day of the range at the rates; a range of one Saturday = the weekend rate", () => {
    const cap = (o: Partial<SomContractInput>) => countCapacity(base({ month: undefined, ...o }));
    const r = cap({ from: "2026-10-01", to: "2026-10-05", teachers: [coachOf(TA, "FULL_TIME"), coachOf(TB, "PART_TIME")] });
    expect(r.byPerson[0]).toMatchObject({ weekdayAvailableHours: 12, weekendAvailableHours: 10, availableHours: 22 }); // Thu Fri Mon · Sat Sun
    expect(r.byPerson[1]).toMatchObject({ weekdayAvailableHours: 0, weekendAvailableHours: 10 });
    expect(cap({ from: "2026-10-03", to: "2026-10-03", teachers: [coachOf(TA, "FULL_TIME")] }).byPerson[0]).toMatchObject({ availableHours: 5 });
  });
  test("🔴 ALL DATA counts a coach from the LATER of the range start and the day he was created; a month or a from–to stays as asked", () => {
    const late = coachOf(TA, "FULL_TIME", { createdAt: "2026-10-10T03:00:00Z" });
    const b = [att(S1, "2026-10-01")];
    const all = countCapacity(base({ month: undefined, teachers: [late], bookings: b })).byPerson[0]!;
    expect(all.availableHours).toBe(14); // Sat 10 (5) + Sun 11 (5) + Mon 12 (4)
    const ranged = countCapacity(base({ month: undefined, from: "2026-10-01", to: "2026-10-12", teachers: [late], bookings: b })).byPerson[0]!;
    expect(ranged.availableHours).toBe(52); // 8 weekdays × 4 + 4 weekend days × 5 — he is counted from the day the range starts, as asked
    expect(countCapacity(base({ month: "2026-10", teachers: [late], bookings: b })).byPerson[0]!.availableHours).toBe(133);
  });
  test("booked hours follow the range too (a class outside it is not booked)", () => {
    const les = (d: string) => bk({ date: d, status: "CONFIRMED", teacherId: TA });
    const r = countCapacity(base({ month: undefined, from: "2026-10-05", to: "2026-10-06", teachers: [coachOf(TA, "FULL_TIME")], bookings: [les("2026-10-04"), les("2026-10-05"), les("2026-10-06"), les("2026-10-07")] })).byPerson[0]!;
    expect(r.bookedHours).toBe(2);
  });
});

describe("🔴 TASK-757 — the query: month XOR from + to XOR neither; real, ordered, never future", () => {
  const T0 = bangkokNow().date;
  const ok = (q: Record<string, string>) => v.somQuery.safeParse(q);
  test("accepted: nothing (all data) · month · a range · one day (from = to)", () => {
    expect(ok({}).success).toBe(true);
    expect(ok({ month: "2026-10" }).success).toBe(true);
    expect(ok({ from: "2026-09-20", to: "2026-10-05" }).success).toBe(true);
    expect(ok({ from: "2026-10-05", to: "2026-10-05" }).success).toBe(true);
    expect(ok({ from: "2026-09-20", to: T0 }).success).toBe(true); // today is allowed
  });
  test("refused: only one end · month together with a range · from after to · a future end · not a real day · a bad format", () => {
    expect(ok({ from: "2026-09-20" }).success).toBe(false);
    expect(ok({ to: "2026-09-20" }).success).toBe(false);
    expect(ok({ month: "2026-10", from: "2026-09-20", to: "2026-10-05" }).success).toBe(false);
    expect(ok({ from: "2026-10-05", to: "2026-09-20" }).success).toBe(false);
    expect(ok({ from: "2026-09-20", to: addMonths(T0.slice(0, 7), 1) + "-01" }).success).toBe(false);
    expect(ok({ from: "2026-02-30", to: "2026-03-05" }).success).toBe(false);
    expect(ok({ from: "2026-9-20", to: "2026-10-05" }).success).toBe(false);
  });
  test("the route answers 400 for a refused range (month + range) and the list endpoint takes the same query", async () => {
    expect((await api.request("/reports/som?month=2026-10&from=2026-09-20&to=2026-10-05")).status).toBe(400);
    expect((await api.request("/reports/som/new-vs-renewing/renewCourse?from=2026-10-05&to=2026-09-20")).status).toBe(400);
  });
});
