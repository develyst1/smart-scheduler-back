// 🔻 TASK-742 (REQ-124 2/3) — SOM «New vs Renewing» (6 cards + the list endpoint) and «Coach Capacity». No database: the pure counters by value, the service's READ through fake db, the route through the
// real Hono app. Today in every fixture is Monday 2026-10-12; October 2026 has 22 weekdays + 9 weekend days.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  CAPACITY_HOURS_PER_DAY, CAPACITY_NOT_COUNTED_STATUSES, CAPACITY_PCT_CAP, NVR_BUCKETS, RENEW_ENDED_STATUSES, countCapacity, countNvr, countSom, mergeSom,
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
    expect(Object.keys(nvr().counts).sort()).toEqual(["month", ...NVR_BUCKETS].sort());
  });
  test("🔒 Q3.7: «the earlier course has ENDED» = cancelled · used up · expired — a PAUSED course is not ended", () => {
    expect([...RENEW_ENDED_STATUSES].sort()).toEqual(["CANCELLED", "COMPLETED", "EXPIRED"]);
  });
  test("🔒 Q4.5 / Palm: only CANCELLED is out of the booked hours; one day = 9 hours; a percentage is capped at 100", () => {
    expect([...CAPACITY_NOT_COUNTED_STATUSES]).toEqual(["CANCELLED"]);
    expect(CAPACITY_HOURS_PER_DAY).toBe(9);
    expect(CAPACITY_PCT_CAP).toBe(100);
  });
});

describe("🔴 TASK-742 — New Course: the month of the 1st Trial, not of the purchase (Palm §3.1)", () => {
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
  test("trial 21 Sep → course 3 Oct ⇒ «previous month» of the October page AND «this month» of the September page", () => {
    const oct = nvr(fixture);
    expect([oct.counts.newCoursePrevMonth, oct.counts.newCourseThisMonth]).toEqual([1, 0]);
    expect(oct.rows.newCoursePrevMonth).toEqual([
      { studentId: S1, studentName: "Ploy", packageLabel: "Course 10 · Bike", courseTeacherId: TB, trialTeacherId: TA, trialDate: "2026-09-21", date: "2026-10-03", remark: null },
    ]);
    const sep = nvr({ ...fixture, month: "2026-09" });
    expect([sep.counts.newCourseThisMonth, sep.counts.newCoursePrevMonth]).toEqual([1, 0]);
    expect(sep.rows.newCourseThisMonth[0]).toMatchObject({ date: "2026-10-03", trialDate: "2026-09-21" }); // «date» is always the purchase day
  });
  test("trial 4 Oct → course 12 Oct ⇒ «this month» of October", () => {
    const r = nvr({ bookings: [trial(S1, "2026-10-04")], courses: [course({ createdAt: "2026-10-12T03:00:00Z" })] });
    expect([r.counts.newCourseThisMonth, r.counts.newCoursePrevMonth]).toEqual([1, 0]);
  });
  test("a trial 2 months back is in NEITHER card (previous month = ONE month back)", () => {
    const r = nvr({ bookings: [trial(S1, "2026-08-20")], courses: [course({ createdAt: "2026-10-03T03:00:00Z" })] });
    expect([r.counts.newCourseThisMonth, r.counts.newCoursePrevMonth]).toEqual([0, 0]);
  });
  test("no trial ⇒ the month it was BOUGHT («this month»), and never «previous month»", () => {
    const bought = (day: string) => nvr({ courses: [course({ createdAt: `${day}T03:00:00Z` })] }).counts;
    expect([bought("2026-10-05").newCourseThisMonth, bought("2026-10-05").newCoursePrevMonth]).toEqual([1, 0]);
    expect([bought("2026-09-05").newCourseThisMonth, bought("2026-09-05").newCoursePrevMonth]).toEqual([0, 0]); // bought in September: it is September's «this month»
  });
  test("a trial AFTER the purchase is not «where he came from»: the purchase month counts", () => {
    const r = nvr({ bookings: [trial(S1, "2026-10-09")], courses: [course({ createdAt: "2026-09-25T03:00:00Z" })] });
    expect([r.counts.newCourseThisMonth, r.counts.newCoursePrevMonth]).toEqual([0, 0]); // bought 25 Sep ⇒ September
    expect(nvr({ month: "2026-09", bookings: [trial(S1, "2026-10-09")], courses: [course({ createdAt: "2026-09-25T03:00:00Z" })] }).counts.newCourseThisMonth).toBe(1);
  });
  test("it counts COURSES, not people: one child opening two courses together = 2; a VOUCHER never counts as a new course", () => {
    const r = nvr({ courses: [course({ id: "c1" }), course({ id: "c2" })], vouchers: [voucher({ studentId: S2 })] });
    expect(r.counts.newCourseThisMonth).toBe(2);
    expect(ids(r.rows.newCourseThisMonth)).toEqual([S1, S1]);
    expect(nvr({ vouchers: [voucher()] }).counts).toMatchObject({ newCourseThisMonth: 0, renewCourse: 0 });
  });
  test("a course bought on a LATER day while the earlier one is still ACTIVE is neither new nor a renew", () => {
    const r = nvr({ courses: [course({ id: "c1", createdAt: "2026-10-03T03:00:00Z" }), course({ id: "c3", createdAt: "2026-10-04T03:00:00Z" })] });
    expect([r.counts.newCourseThisMonth, r.counts.renewCourse]).toEqual([1, 0]);
  });
  test("a DUO course is ONE row: both names, the primary child's id, and either child's trial", () => {
    const r = nvr({ bookings: [trial(S2, "2026-09-21")], courses: [course({ studentIds: [S1, S2] })] });
    expect(r.counts.newCoursePrevMonth).toBe(1);
    expect(r.rows.newCoursePrevMonth[0]).toMatchObject({ studentId: S1, studentName: "Ploy & Pun", trialDate: "2026-09-21" });
  });
});

describe("🔴 TASK-742 — Renew Course: a pack bought by a child whose earlier COURSE has ended", () => {
  const earlier = (o: Partial<SomCourse>) => course({ id: "e1", studentIds: [S2], createdAt: "2026-03-01T03:00:00Z", ...o });
  const renewal = course({ id: "n1", studentIds: [S2], createdAt: "2026-10-05T03:00:00Z" });
  test("the earlier course USED UP / EXPIRED / ENDED EARLY ⇒ renew, and the new course is NOT a «new course»", () => {
    for (const e of [earlier({ size: 4, usedSessions: 4 }), earlier({ expiryDate: "2026-06-01" }), earlier({ endedAt: "2026-05-01T03:00:00Z" })]) {
      const r = nvr({ courses: [e, renewal] });
      expect([r.counts.renewCourse, r.counts.newCourseThisMonth]).toEqual([1, 0]);
      expect(r.rows.renewCourse[0]).toMatchObject({ studentId: S2, packageLabel: "Course 10 · Bike", date: "2026-10-05", remark: null });
    }
  });
  test("the earlier course still ACTIVE, or only PAUSED ⇒ not a renew (and not new either)", () => {
    for (const e of [earlier({}), earlier({ droppedAt: "2026-06-01T03:00:00Z" })]) {
      const r = nvr({ courses: [e, renewal] });
      expect([r.counts.renewCourse, r.counts.newCourseThisMonth]).toEqual([0, 0]);
    }
  });
  test("the earlier course's status is judged ON THE PURCHASE DAY, not today (rows delivered after it are taken back)", () => {
    const e = earlier({ size: 4, usedSessions: 4 }); // used up TODAY, but on 20 Sep it still had sessions left
    const rows = ["2026-09-25", "2026-09-26", "2026-10-01", "2026-10-02"].map((d) => bk({ courseId: "e1", studentIds: [S2], date: d }));
    const bought = course({ id: "n1", studentIds: [S2], createdAt: "2026-09-20T03:00:00Z" });
    expect(nvr({ month: "2026-09", courses: [e, bought], bookings: rows }).counts.renewCourse).toBe(0);
    expect(nvr({ month: "2026-09", courses: [e, bought] }).counts.renewCourse).toBe(1); // with no rows after the day it WAS used up
  });
  test("a VOUCHER bought by such a child renews («Voucher 10 hrs»); a voucher bought by a child with no ended course does not", () => {
    const done = earlier({ studentIds: [S3], size: 4, usedSessions: 4 });
    const r = nvr({ courses: [done], vouchers: [voucher({ id: "v1", studentId: S3, createdAt: "2026-10-06T03:00:00Z" }), voucher({ id: "v2", studentId: S4 }), voucher({ id: "v3", studentId: S3, createdAt: "2026-09-10T03:00:00Z" })] }); // v3: bought in September ⇒ September's card
    expect(r.rows.renewCourse).toEqual([{ studentId: S3, studentName: "Kid 3", packageLabel: "Voucher 10 hrs", courseTeacherId: null, trialTeacherId: null, trialDate: null, date: "2026-10-06", remark: null }]);
  });
  test("the card is the PURCHASE month", () => {
    const c = [earlier({ size: 4, usedSessions: 4 }), course({ id: "n1", studentIds: [S2], createdAt: "2026-09-05T03:00:00Z" })];
    expect([nvr({ courses: c }).counts.renewCourse, nvr({ month: "2026-09", courses: c }).counts.renewCourse]).toEqual([0, 1]);
  });
});

describe("🔴 TASK-742 — 1st Trial and «1st Trial, no course»", () => {
  const bookings = [
    trial(S1, "2026-10-02"), trial(S2, "2026-10-03", { status: "CANCELLED" }), trial(S3, "2026-09-30"),
    trial(S4, "2026-10-04"), trial(S5, "2026-10-05", { status: "PAUSED" }), trial(S6, "2026-10-06"), trial(S7, "2026-10-07"), trial(S7, "2026-10-20"),
  ];
  const courses = [course({ id: "k4", studentIds: [S4], createdAt: "2026-10-04T08:00:00Z" }), course({ id: "k6", studentIds: [S6], createdAt: "2026-10-01T03:00:00Z" })];
  const vouchers = [voucher({ studentId: S5, createdAt: "2026-10-06T03:00:00Z" })];
  const r = nvr({ bookings, courses, vouchers });
  test("firstTrial = people who BOOKED one this month, by CLASS date: cancelled out, September out, a paused one in, two trials = once; it stays after a course", () => {
    expect(ids(r.rows.firstTrial)).toEqual([S1, S4, S5, S6, S7]);
    expect(r.rows.firstTrial[0]).toEqual({ studentId: S1, studentName: "Ploy", packageLabel: null, courseTeacherId: null, trialTeacherId: TA, trialDate: "2026-10-02", date: null, remark: null });
  });
  test("trialNotConverted: ANY course bought no later than the month end converts, whatever its order with the trial (TEST-109 N1 — the same rule as the Existing Customers 1st Trial card); a voucher does not (Q3.4)", () => {
    expect(ids(r.rows.trialNotConverted)).toEqual([S1, S5, S7]); // S6 holds a course bought BEFORE the trial ⇒ converted
    expect(ids(nvr({ bookings, courses: [...courses, course({ id: "late", studentIds: [S1], createdAt: "2026-11-02T03:00:00Z" })], vouchers }).rows.trialNotConverted)).toEqual([S1, S5, S7]); // a course bought AFTER the month end converts nobody in October
  });
  test("both are people, in trial-date order", () => {
    expect(r.rows.firstTrial.map((x) => x.trialDate)).toEqual(["2026-10-02", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
  });
});

describe("🔴 TASK-742 — Course / Voucher not renewed (counted from the day AFTER the end; a later renewal removes it)", () => {
  const rowsOf = (c: Partial<SomContractInput>) => nvr(c).rows.notRenewed.map((x) => [x.studentId, x.date, x.packageLabel]);
  test("ended by EXPIRY, USED UP or ENDED EARLY; counted from the next day; paused / still-active are not", () => {
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
    expect(r).toEqual([[S5, "2026-10-03", "Course 10 · Bike"], [S1, "2026-10-05", "Course 10 · Bike"], [S4, "2026-10-08", "Course 4 · Bike"], [S3, "2026-10-11", "Course 10 · Bike"]]);
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
  test("vouchers: exhausted · expired · ended — each with its end day", () => {
    const r = rowsOf({
      vouchers: [
        voucher({ id: "vA", studentId: S9, totalHours: 5, usedHours: 5 }), voucher({ id: "vB", studentId: S10, expiryDate: "2026-10-01" }), voucher({ id: "vC", studentId: S11, endedAt: "2026-10-04T03:00:00Z" }),
        voucher({ id: "vD", studentId: S8 }), // active
      ],
      bookings: [bk({ voucherId: "vA", studentIds: [S9], bookingType: "VOUCHER", date: "2026-10-09" })],
    });
    expect(r).toEqual([[S10, "2026-10-01", "Voucher 10 hrs"], [S11, "2026-10-04", "Voucher 10 hrs"], [S9, "2026-10-09", "Voucher 5 hrs"]]);
  });
  test("a DUO course is ONE row, and a renewal by EITHER child removes it", () => {
    const duo = course({ id: "d1", studentIds: [S1, S2], expiryDate: "2026-10-05", createdAt: "2026-04-01T03:00:00Z" });
    expect(nvr({ courses: [duo] }).rows.notRenewed).toHaveLength(1);
    expect(nvr({ courses: [duo, course({ id: "n", studentIds: [S2], createdAt: "2026-10-08T03:00:00Z" })] }).rows.notRenewed).toHaveLength(0);
  });
});

describe("🔴 TASK-742 — the list IS the card; the badge filter; the first session's coach", () => {
  const mixed = base({
    bookings: [trial(S1, "2026-10-02"), trial(S2, "2026-10-03"), trial(S3, "2026-09-21"), bk({ courseId: "c3", studentIds: [S3], teacherId: TB, date: "2026-10-07", status: "CONFIRMED" })],
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
    expect(r.counts).toEqual({ month: MONTH, firstTrial: 2, newCourseThisMonth: 0, newCoursePrevMonth: 1, renewCourse: 1, trialNotConverted: 2, notRenewed: 2 }); // notRenewed: `old` (expired 5 Oct) + the voucher (expired 4 Oct); S5's used-up course ended in February and was renewed
    expect(countSom(mixed).newVsRenewing).toEqual(r.counts); // the page and the list read the SAME function
  });
  test("the badge filter: a trial by ITS OWN badge, a pack through its (non-cancelled) session rows", () => {
    const b = [trial(S1, "2026-10-02", { badgeIds: [BV1] }), trial(S2, "2026-10-03", { badgeIds: [BV2] }), bk({ courseId: "c1", studentIds: [S1], badgeIds: [BV1], status: "CONFIRMED" }), bk({ courseId: "c2", studentIds: [S3], badgeIds: [BV2], status: "CONFIRMED" })];
    const c = [course({ id: "c1", studentIds: [S1] }), course({ id: "c2", studentIds: [S3] })];
    const one = nvr({ bookings: b, courses: c, badgeValueIds: [BV1] });
    expect([ids(one.rows.firstTrial), ids(one.rows.newCourseThisMonth)]).toEqual([[S1], [S1]]);
    const all = nvr({ bookings: b, courses: c });
    expect([ids(all.rows.firstTrial), all.counts.newCourseThisMonth]).toEqual([[S1, S2], 2]);
  });
  test("the names: nickname first, else the name; an unknown child falls back to his id", () => {
    const r = nvr({ bookings: [trial(S3, "2026-10-02")] }).rows.firstTrial[0]!;
    expect(r.studentName).toBe("Kid 3");
    expect(nvr({ students: [], bookings: [trial("ghost", "2026-10-02")] }).rows.firstTrial[0]!.studentName).toBe("ghost");
  });
});

describe("🔴 TASK-742 — Coach Capacity: available hours (workDays − leave days) × 9, booked hours, weekday / weekend", () => {
  const coach = (id: string, type: SomTeacher["type"], o: Partial<SomTeacher> = {}): SomTeacher => ({ id, nickname: id, type, active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], ...o });
  const cap = (o: Partial<SomContractInput>) => countCapacity(base(o));
  const MONFRI = [1, 2, 3, 4, 5];
  test("October 2026: a coach working every day has 22 × 9 weekday + 9 × 9 weekend hours; Mon–Fri only ⇒ weekend 0 / 0 = 0%", () => {
    const r = cap({ teachers: [coach(TA, "FULL_TIME"), coach(TB, "PART_TIME", { workDays: MONFRI })] });
    expect(r.byPerson[0]).toMatchObject({ teacherId: TA, weekdayAvailableHours: 198, weekendAvailableHours: 81, availableHours: 279 });
    expect(r.byPerson[1]).toMatchObject({ teacherId: TB, weekdayAvailableHours: 198, weekendAvailableHours: 0, weekendPct: 0, weekendBookedHours: 0 });
  });
  test("an advance-leave day is taken off (a Monday ⇒ −9 weekday; a Saturday he does not work ⇒ nothing; a day in ANOTHER month ⇒ nothing)", () => {
    const r = cap({ teachers: [coach(TB, "PART_TIME", { workDays: MONFRI })], leaveDays: [{ teacherId: TB, date: "2026-10-05" }, { teacherId: TB, date: "2026-10-03" }, { teacherId: TB, date: "2026-11-02" }, { teacherId: TA, date: "2026-10-06" }] });
    expect(r.byPerson[0]).toMatchObject({ weekdayAvailableHours: 189, weekendAvailableHours: 0 });
  });
  test("a weekend-only coach: weekday 0 / 0", () => {
    expect(cap({ teachers: [coach(TA, "PART_TIME", { workDays: [0, 6] })] }).byPerson[0]).toMatchObject({ weekdayAvailableHours: 0, weekdayPct: 0, weekendAvailableHours: 81 });
  });
  test("a FREELANCE coach with the default all-7 workDays gets a full month (Q4.4); February 2026 = 20 × 9 + 8 × 9", () => {
    expect(cap({ teachers: [coach(TC, "FREELANCE")] }).byPerson[0]).toMatchObject({ teacherType: "FREELANCE", availableHours: 279 });
    expect(cap({ month: "2026-02", teachers: [coach(TC, "FREELANCE")] }).byPerson[0]).toMatchObject({ weekdayAvailableHours: 180, weekendAvailableHours: 72 });
  });
  const lesson = (date: string, o: Partial<SomBooking> = {}) => bk({ date, status: "CONFIRMED", teacherId: TA, ...o });
  test("booked hours split by the day of the week; % = round(booked ÷ available × 100)", () => {
    const b = [lesson("2026-10-05"), lesson("2026-10-06"), lesson("2026-10-07"), lesson("2026-10-08"), lesson("2026-10-03"), lesson("2026-10-04")]; // 4 weekday + Sat + Sun
    const r = cap({ teachers: [coach(TA, "FULL_TIME")], bookings: b }).byPerson[0]!;
    expect([r.weekdayBookedHours, r.weekendBookedHours, r.bookedHours]).toEqual([4, 2, 6]);
    expect([r.weekdayPct, r.weekendPct]).toEqual([2, 2]); // 4/198 · 2/81
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
    expect([r.bookedHours, r.availableHours]).toEqual([1, 279]);
  });
  test("only ACTIVE, non-archived coaches; ordered Full-time → Part-time → Freelance, then nickname", () => {
    const r = cap({ teachers: [coach("z", "FREELANCE"), coach("b", "PART_TIME"), coach("y", "FULL_TIME"), coach("a", "FULL_TIME"), coach("off", "FULL_TIME", { active: false }), coach("gone", "PART_TIME", { archived: true })] });
    expect(r.byPerson.map((p) => p.teacherId)).toEqual(["a", "y", "b", "z"]);
  });
  test("byType: always the three rows; coaches counted; hours are SUMS and the % comes from the sums — not an average of percentages", () => {
    const b = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].map((d) => lesson(d, { teacherId: TA }));
    const r = cap({ teachers: [coach(TA, "FULL_TIME", { workDays: MONFRI }), coach(TB, "FULL_TIME", { workDays: MONFRI })], bookings: b });
    expect(r.byType.map((t) => [t.teacherType, t.coaches])).toEqual([["FULL_TIME", 2], ["PART_TIME", 0], ["FREELANCE", 0]]);
    const ft = r.byType[0]!;
    expect([ft.weekdayBookedHours, ft.weekdayAvailableHours, ft.weekdayPct]).toEqual([5, 396, 1]); // 5/396 = 1.3% — the mean of A's 3% and B's 0% would be 2%
    expect(r.byPerson[0]!.weekdayPct).toBe(3); // 5/198 = 2.5% ⇒ 3
    expect(r.byType[1]).toMatchObject({ coaches: 0, bookedHours: 0, availableHours: 0, weekdayPct: 0, weekendPct: 0 });
  });
  test("a percentage never passes 100 (an over-booked coach), but his hours stay real: 12 booked vs ONE available Saturday (9) ⇒ 133% ⇒ 100", () => {
    const b = Array.from({ length: 12 }, () => lesson("2026-10-03"));
    const r = cap({ month: "2026-10", teachers: [coach(TA, "PART_TIME", { workDays: [6] })], leaveDays: ["10", "17", "24", "31"].map((d) => ({ teacherId: TA, date: `2026-10-${d}` })), bookings: b }).byPerson[0]!;
    expect([r.weekendAvailableHours, r.weekendBookedHours, r.weekendPct]).toEqual([9, 12, 100]);
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
    stub({ bookings: [B(), B({ studentId: S2 })], students: [{ id: S1, name: "Ploy Wong", nickname: "Ploy", parentId: null }, { id: S2, name: "Pun Lee", nickname: null, parentId: null }] });
    try {
      const page = await svc.getSomContract({ month: M });
      const list = await svc.getNvrRows("firstTrial", { month: M });
      expect(page.newVsRenewing.firstTrial).toBe(2);
      expect(list.rows).toHaveLength(page.newVsRenewing.firstTrial);
      expect(list.rows[0]).toMatchObject({ studentId: S1, studentName: "Ploy", trialTeacherId: TA, trialDate: T, remark: null });
      expect((await svc.getNvrRows("renewCourse", { month: M })).rows).toEqual([]);
    } finally { done(); }
  });
  test("Coach Capacity reads the roster, the leave days and the extra coaches (with the rows' times)", async () => {
    stub({
      bookings: [B({ bookingType: "GROUP", status: "CONFIRMED", teacherId: TA, additionalTeachers: [{ teacherId: TB }], startTime: "10:00:00", endTime: "12:00:00" })],
      teachers: [{ id: TA, nickname: "A", type: "FULL_TIME", active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6] }, { id: TB, nickname: "B", type: "PART_TIME", active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6] }],
      leave: [{ teacherId: TB, date: `${M}-15` }],
    });
    try {
      const cc = (await svc.getSomContract({ month: M })).coachCapacity;
      expect(cc.byPerson.map((p) => [p.teacherId, p.bookedHours])).toEqual([[TA, 2], [TB, 2]]); // the 2-hour group row counts for both coaches
      const a = cc.byPerson[0]!, b = cc.byPerson[1]!;
      expect(a.availableHours - b.availableHours).toBe(9); // B's leave day
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
