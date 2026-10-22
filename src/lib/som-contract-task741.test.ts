// 🔻 TASK-741 (REQ-124) — `GET /api/reports/som` serves Palm's contract (filters + Today + Existing Customers + Demographic + Activity/Program). No database: the pure counters by value, the service's READ through
// fake `db.query` / `db.select`, and the route through the real Hono app with both services spied. The OLD report's files are pinned byte-identical.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTIVE_COUNT_UNIT, SINGLE_SESSION_MOVES_OUT, SOM_AGE_BANDS, TRIAL_MOVES_OUT_ON_VOUCHER, addMonths, countSom, mergeSom, monthEnd,
  type SomBooking, type SomContractInput, type SomCourse, type SomStudent, type SomVoucher,
} from "./som-contract";
import * as v from "../validation";
import { countDaily } from "./daily-report";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const schema = await import("../db/schema");
const teacherLeave = await import("./teacher-leave");
const svc = await import("../services/som-contract.service");
const oldSom = await import("../services/som-report.service");
const { bangkokNow } = await import("./bangkok-time");
const { api } = await import("../routes/api");

const S = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const [S1, S2, S3, S4, S5, S6, S7, S8] = [1, 2, 3, 4, 5, 6, 7, 8].map(S) as [string, string, string, string, string, string, string, string];
const BV1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1", BV2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2", BV3 = "b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3";
const BIKE = "aaaa0001-0000-4000-8000-000000000000", SKATE = "aaaa0002-0000-4000-8000-000000000000", OLD = "aaaa0003-0000-4000-8000-000000000000", SURF = "aaaa0004-0000-4000-8000-000000000000";
const MONTH = "2026-10", TODAY = "2026-10-12";

const bk = (o: Partial<SomBooking> = {}): SomBooking => ({ studentIds: [S1], bookingType: "COURSE_PACKAGE", status: "ATTENDED", date: "2026-10-05", subjectId: BIKE, courseId: null, voucherId: null, badgeIds: [], isSeat: false, ...o });
const course = (o: Partial<SomCourse> = {}): SomCourse => ({ id: "c1", studentIds: [S1], createdAt: "2026-09-01T03:00:00Z", size: 10, usedSessions: 2, expiryDate: "2027-03-01", endedAt: null, droppedAt: null, expiryChanges: [], ...o });
const voucher = (o: Partial<SomVoucher> = {}): SomVoucher => ({ id: "v1", studentId: S1, createdAt: "2026-09-01T03:00:00Z", totalHours: 10, usedHours: 3, expiryDate: "2027-03-01", endedAt: null, expiryChanges: [], ...o });
const student = (id: string, o: Partial<SomStudent> = {}): SomStudent => ({ id, gender: null, nationality: null, birthDate: null, province: null, districtCode: null, ...o });
const LABELS: Record<string, string> = { "1001": "บางรัก, กรุงเทพมหานคร", "5001": "เมืองเชียงใหม่, เชียงใหม่" };
const GONE = "aaaa0005-0000-4000-8000-000000000000";
const SUBS: Record<string, string> = { "100101": "พระบรมมหาราชวัง", "100102": "วังบูรพาภิรมย์", "500101": "ศรีภูมิ" };
const SUBJECTS = [{ id: BIKE, name: "Bike", active: true }, { id: SKATE, name: "Skate", active: true }, { id: SURF, name: "Surf", active: true }, { id: OLD, name: "Old", active: false }, { id: GONE, name: "Gone", active: false }];
const run = (o: Partial<SomContractInput> = {}) =>
  countSom({ month: MONTH, today: TODAY, badgeValueIds: [], bookings: [], courses: [], vouchers: [], students: [], subjects: SUBJECTS, districtLabel: (c) => LABELS[c] ?? null, subdistrictLabel: (c) => SUBS[c] ?? null, ...o });

describe("🔒 TASK-741 — the dates and the declared defaults", () => {
  test("addMonths / monthEnd across a year and a leap February", () => {
    expect(addMonths("2027-01", -2)).toBe("2026-11");
    expect(addMonths("2026-10", -2)).toBe("2026-08");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(monthEnd("2026-10")).toBe("2026-10-31");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
  });
  test("each of Palm's open answers is ONE named constant at the CHECK §4 default (a ruling is a one-line flip)", () => {
    expect(ACTIVE_COUNT_UNIT).toBe("PEOPLE"); // K1
    expect(TRIAL_MOVES_OUT_ON_VOUCHER).toBe(false); // Q2.2
    expect(SINGLE_SESSION_MOVES_OUT).toBe(false); // Q2.3
    expect(SOM_AGE_BANDS.map((b) => b.key)).toEqual(["1-2", "3-4", "5-7", "8-10", "11-13", "14-19", "20-39", "40-54", "55+"]); // Q5.1 / K3
  });
});

describe("🔴 TASK-741 — Today (REQ-119's counters, badge-filtered, month ignored)", () => {
  const rows = [
    bk({ date: TODAY, status: "CONFIRMED" }), bk({ date: TODAY, status: "CONFIRMED", bookingType: "VOUCHER" }), bk({ date: TODAY, status: "ATTENDED", bookingType: "FIRST_TRIAL" }),
    bk({ date: TODAY, status: "SICK_LEAVE" }), bk({ date: TODAY, status: "PENDING" }), bk({ date: TODAY, status: "CANCELLED" }),
    bk({ date: TODAY, status: "ATTENDED", isSeat: true }), // a GROUP's seat: never a row of the day
    bk({ date: TODAY, status: "CONFIRMED", bookingType: "OTHER" }), // ECA / camp: not a lesson
    bk({ date: "2026-10-11", status: "ATTENDED" }), // yesterday
  ];
  test("confirmed = CONFIRMED + ATTENDED + NO_SHOW lessons (3) · attended 1 · rate = the Daily Report's own (TASK-747, Khwan A): attended ÷ (confirmed + on leave) = round(1/4) = 25 — not attended ÷ confirmed = 33", () => {
    expect(run({ bookings: rows }).today).toEqual({ date: TODAY, confirmed: 3, attended: 1, attendanceRate: 25 });
  });
  test("`month` never moves Today", () => {
    expect(run({ bookings: rows, month: "2026-09" }).today).toEqual({ date: TODAY, confirmed: 3, attended: 1, attendanceRate: 25 });
  });
  test("🔴 TASK-747 — a child on leave: 2 attended, 3 confirmed, 1 on leave ⇒ 50 (÷ 4), not 67 (÷ 3); and the SAME rows give the SAME % on /reports/daily (countDaily is the one formula)", () => {
    const day = [bk({ date: TODAY, status: "ATTENDED" }), bk({ date: TODAY, status: "ATTENDED", bookingType: "VOUCHER" }), bk({ date: TODAY, status: "CONFIRMED" }), bk({ date: TODAY, status: "SICK_LEAVE" })];
    const t = run({ bookings: day }).today;
    expect([t.confirmed, t.attended, t.attendanceRate]).toEqual([3, 2, 50]);
    const daily = countDaily(day.map((b) => ({ status: b.status, bookingType: b.bookingType, coachIds: [] })));
    expect(t.attendanceRate).toBe(daily.attendanceRate);
    expect(daily.attendanceRate).toBe(50);
  });
  test("no class today ⇒ zeros, never a division by zero", () => {
    expect(run().today).toEqual({ date: TODAY, confirmed: 0, attended: 0, attendanceRate: 0 });
  });
  test("the badge filter applies to Today (OR)", () => {
    const b = [bk({ date: TODAY, status: "ATTENDED", badgeIds: [BV1] }), bk({ date: TODAY, status: "CONFIRMED", badgeIds: [BV2] }), bk({ date: TODAY, status: "CONFIRMED", badgeIds: [BV3] }), bk({ date: TODAY, status: "CONFIRMED" })];
    expect(run({ bookings: b, badgeValueIds: [BV1] }).today).toMatchObject({ confirmed: 1, attended: 1, attendanceRate: 100 });
    expect(run({ bookings: b, badgeValueIds: [BV1, BV2] }).today).toMatchObject({ confirmed: 2, attended: 1 });
    expect(run({ bookings: b }).today).toMatchObject({ confirmed: 4, attended: 1 });
  });
});

describe("🔴 TASK-741 — Existing Customers: Active Course / Active Voucher at month end", () => {
  const courses = [
    course({ id: "c1", studentIds: [S1] }),
    course({ id: "c2", studentIds: [S1] }), // the same child, a second active course
    course({ id: "c3", studentIds: [S2], endedAt: "2026-10-01T03:00:00Z" }), // ENDED
    course({ id: "c4", studentIds: [S3], droppedAt: "2026-09-01T03:00:00Z" }), // PAUSED
    course({ id: "c5", studentIds: [S4], size: 4, usedSessions: 4 }), // COMPLETED
    course({ id: "c6", studentIds: [S5], expiryDate: "2026-10-01" }), // EXPIRED
    course({ id: "c7", studentIds: [S6, S7] }), // DUO — both kids
    course({ id: "c8", studentIds: [S6] }), // S6 has a second one
  ];
  test("an ended / paused / completed / expired course is NOT active (courseStatus, not courseEligible); a child counts ONCE", () => {
    expect(run({ courses }).existingCustomers.activeCourse).toBe(3); // S1 · S6 · S7
  });
  test("K1: the unit is ONE switch — PACKAGES counts the courses instead (c1 c2 c7 c8 = 4)", () => {
    expect(run({ courses, activeUnit: "PACKAGES" }).existingCustomers.activeCourse).toBe(4);
    expect(run({ courses, activeUnit: "PEOPLE" }).existingCustomers.activeCourse).toBe(3);
  });
  const vouchers = [
    voucher({ id: "v1", studentId: S1 }), voucher({ id: "v5", studentId: S1 }),
    voucher({ id: "v2", studentId: S2, usedHours: 10 }), // EXHAUSTED
    voucher({ id: "v3", studentId: S3, expiryDate: "2026-10-01" }), // EXPIRED
    voucher({ id: "v4", studentId: S4, endedAt: "2026-10-01T03:00:00Z" }), // ENDED
  ];
  test("Active Voucher: hours left + not expired + not ended; a child with two counts once (people) / twice (packages)", () => {
    expect(run({ vouchers }).existingCustomers.activeVoucher).toBe(1);
    expect(run({ vouchers, activeUnit: "PACKAGES" }).existingCustomers.activeVoucher).toBe(2);
  });
  test("on the last day of its expiry a course is still active; the day after it is not", () => {
    const c = [course({ expiryDate: TODAY })];
    expect(run({ courses: c }).existingCustomers.activeCourse).toBe(1);
    expect(run({ courses: c, today: "2026-10-13" }).existingCustomers.activeCourse).toBe(0);
  });
});

describe("🔴 TASK-741 — a PAST month is rebuilt (the counter's past value is not stored, CHECK M12)", () => {
  const SEP = { month: "2026-09" }; // today stays 2026-10-12 ⇒ asOf = 2026-09-30
  test("a course used up AFTER that month end is still active for it: the delivered rows dated after it (ATTENDED and NO_SHOW) are taken back off the counter — used 4 − 3 = 1 < size 4 ⇒ ACTIVE in September, COMPLETED in October", () => {
    const used = course({ id: "cA", studentIds: [S1], size: 4, usedSessions: 4 });
    const later = [bk({ courseId: "cA", date: "2026-10-03" }), bk({ courseId: "cA", date: "2026-10-04", status: "NO_SHOW" }), bk({ courseId: "cA", date: "2026-10-10" })];
    expect(run({ ...SEP, courses: [used], bookings: later }).existingCustomers.activeCourse).toBe(1);
    expect(run({ courses: [used], bookings: later }).existingCustomers.activeCourse).toBe(0); // October: completed
    const inSep = [bk({ courseId: "cA", date: "2026-09-20" }), bk({ courseId: "cA", date: "2026-09-25" }), bk({ courseId: "cA", date: "2026-09-27" }), bk({ courseId: "cA", date: "2026-09-29" })];
    expect(run({ ...SEP, courses: [used], bookings: inSep }).existingCustomers.activeCourse).toBe(0); // used up INSIDE September ⇒ not active at its end
  });
  test("a course bought after the month end did not exist yet", () => {
    expect(run({ ...SEP, courses: [course({ createdAt: "2026-10-05T03:00:00Z" })] }).existingCustomers.activeCourse).toBe(0);
    expect(run({ ...SEP, courses: [course({ createdAt: "2026-09-30T16:59:00Z" })] }).existingCustomers.activeCourse).toBe(1); // 30 Sep 23:59 Bangkok
    expect(run({ ...SEP, courses: [course({ createdAt: "2026-09-30T17:00:00Z" })] }).existingCustomers.activeCourse).toBe(0); // 1 Oct 00:00 Bangkok
  });
  test("a course ended / paused AFTER the month end was active for it", () => {
    expect(run({ ...SEP, courses: [course({ endedAt: "2026-10-03T03:00:00Z" })] }).existingCustomers.activeCourse).toBe(1);
    expect(run({ ...SEP, courses: [course({ droppedAt: "2026-10-03T03:00:00Z" })] }).existingCustomers.activeCourse).toBe(1);
    expect(run({ ...SEP, courses: [course({ endedAt: "2026-09-15T03:00:00Z" })] }).existingCustomers.activeCourse).toBe(0);
  });
  test("the expiry IN FORCE that day (course_expiry_changes): a move made after the month end is taken back; one made before it stands", () => {
    const movedAfter = course({ id: "cD", studentIds: [S1], expiryDate: "2026-11-30", expiryChanges: [{ fromDate: "2026-09-25", changedAt: "2026-10-05T03:00:00Z" }] });
    expect(run({ ...SEP, courses: [movedAfter] }).existingCustomers.activeCourse).toBe(0); // on 30 Sep the expiry was 25 Sep
    expect(run({ courses: [movedAfter] }).existingCustomers.activeCourse).toBe(1); // October: the new expiry
    const movedBefore = course({ id: "cE", studentIds: [S2], expiryDate: "2026-11-30", expiryChanges: [{ fromDate: "2026-09-05", changedAt: "2026-09-10T03:00:00Z" }] });
    expect(run({ ...SEP, courses: [movedBefore] }).existingCustomers.activeCourse).toBe(1);
  });
  test("the same rebuild for a voucher (hours taken back, expiry in force, ended later)", () => {
    const used = voucher({ id: "vA", totalHours: 5, usedHours: 5 });
    const later = [bk({ voucherId: "vA", bookingType: "VOUCHER", date: "2026-10-02" }), bk({ voucherId: "vA", bookingType: "VOUCHER", date: "2026-10-03" })];
    expect(run({ ...SEP, vouchers: [used], bookings: later }).existingCustomers.activeVoucher).toBe(1);
    expect(run({ vouchers: [used], bookings: later }).existingCustomers.activeVoucher).toBe(0);
    expect(run({ ...SEP, vouchers: [voucher({ endedAt: "2026-10-02T03:00:00Z" })] }).existingCustomers.activeVoucher).toBe(1);
    expect(run({ ...SEP, vouchers: [voucher({ expiryDate: "2026-11-30", expiryChanges: [{ fromDate: "2026-09-20", changedAt: "2026-10-05T03:00:00Z" }] })] }).existingCustomers.activeVoucher).toBe(0);
  });
});

describe("🔴 TASK-741 — Existing Customers: 1st Trial / 1 HR (3 FULL months, class date) and Total", () => {
  test("recentFrom / recentTo: the selected month and the 2 before it, whole months; echoed", () => {
    expect(run().existingCustomers).toMatchObject({ month: "2026-10", recentFrom: "2026-08", recentTo: "2026-10" });
    expect(run({ month: "2027-01", today: "2027-01-15" }).existingCustomers).toMatchObject({ recentFrom: "2026-11", recentTo: "2027-01" });
  });
  const trial = (id: string, date: string, status = "CONFIRMED") => bk({ studentIds: [id], bookingType: "FIRST_TRIAL", status, date });
  test("the window is by CLASS date, whole months (31 Aug in · 31 Jul out); CANCELLED never counts; PAUSED does", () => {
    const b = [trial(S1, "2026-08-31"), trial(S2, "2026-07-31"), trial(S3, "2026-10-02", "CANCELLED"), trial(S7, "2026-10-01", "PAUSED"), trial(S8, "2026-10-31")];
    expect(run({ bookings: b }).existingCustomers.recentFirstTrial).toBe(3); // S1 · S7 · S8
  });
  test("🔻 TEST-109 N1 — ANY course bought no later than the month end moves the child OUT, whatever its order with the trial (before, same day or after); a VOUCHER does not (Q2.2 default)", () => {
    const b = [trial(S4, "2026-09-10"), trial(S5, "2026-09-10"), trial(S6, "2026-09-10"), trial(S1, "2026-09-10")];
    const courses = [course({ id: "k4", studentIds: [S4], createdAt: "2026-09-10T08:00:00Z" }), course({ id: "k6", studentIds: [S6], createdAt: "2026-09-09T03:00:00Z" })];
    const vouchers = [voucher({ id: "w5", studentId: S5, createdAt: "2026-09-11T03:00:00Z" })];
    expect(run({ bookings: b, courses, vouchers }).existingCustomers.recentFirstTrial).toBe(2); // S5 (voucher only) · S1 (nothing) — S4 (course same day) and S6 (course BEFORE the trial) are out
  });
  test("a course bought AFTER the selected month's end does not move a past month's trial out", () => {
    const b = [trial(S4, "2026-08-10")];
    const courses = [course({ studentIds: [S4], createdAt: "2026-10-05T03:00:00Z" })];
    expect(run({ month: "2026-09", bookings: b, courses }).existingCustomers.recentFirstTrial).toBe(1);
    expect(run({ bookings: b, courses }).existingCustomers.recentFirstTrial).toBe(0);
  });
  test("a DUO child's course moves HIS trial out", () => {
    expect(run({ bookings: [trial(S7, "2026-09-10")], courses: [course({ studentIds: [S6, S7], createdAt: "2026-09-12T03:00:00Z" })] }).existingCustomers.recentFirstTrial).toBe(0);
  });
  test("1 HR: the same window, CANCELLED out, and a course does NOT move it out (Q2.3 default)", () => {
    const one = (id: string, date: string, status = "CONFIRMED") => bk({ studentIds: [id], bookingType: "SINGLE_SESSION", status, date });
    const b = [one(S1, "2026-09-03"), one(S4, "2026-09-10"), one(S8, "2026-10-02", "CANCELLED"), one(S2, "2026-07-30")];
    const courses = [course({ studentIds: [S4], createdAt: "2026-09-12T03:00:00Z" })];
    expect(run({ bookings: b, courses }).existingCustomers.recentSingleSession).toBe(2); // S1 · S4
  });
  test("a child with two trials in the window counts ONCE", () => {
    expect(run({ bookings: [trial(S1, "2026-08-10"), trial(S1, "2026-09-10")] }).existingCustomers.recentFirstTrial).toBe(1);
  });
  test("Total Customers (Q2.7): distinct names of Active Course + Active Voucher + the SELECTED month's 1st Trial + 1 HR — not the 3-month window", () => {
    const b = [
      trial(S3, "2026-08-10"), // in the 3-month card, NOT in Total
      trial(S4, "2026-10-02"), // in the month
      bk({ studentIds: [S5], bookingType: "SINGLE_SESSION", status: "CONFIRMED", date: "2026-10-03" }),
      trial(S1, "2026-10-04"), // S1 also holds a course ⇒ once
    ];
    const r = run({ bookings: b, courses: [course({ studentIds: [S1] })], vouchers: [voucher({ studentId: S2 })] }).existingCustomers;
    expect(r.recentFirstTrial).toBe(2); // S3 · S4 — S1 holds a course (bought 1 Sep, BEFORE his 4 Oct trial) ⇒ he is a course customer, out of the trial box (N1)
    expect(r.recentSingleSession).toBe(1); // S5
    expect(r.totalCustomers).toBe(4); // S1 (course + trial: once) · S2 (voucher) · S4 · S5 — and NOT S3 (an August trial)
  });
});

describe("🔴 TASK-741 — the badge filter on the PERSON sections (any qualifying booking of theirs matches; each child ONCE)", () => {
  const b = [
    bk({ studentIds: [S1], badgeIds: [BV1], date: "2026-10-03" }), bk({ studentIds: [S1], badgeIds: [BV2], date: "2026-10-04" }), // S1 in TWO branches
    bk({ studentIds: [S2], badgeIds: [BV2] }), bk({ studentIds: [S3], badgeIds: [BV3] }), bk({ studentIds: [S4], badgeIds: [] }),
  ];
  const students = [S1, S2, S3, S4].map((id) => student(id));
  test("OR across the chosen badges; one child in two selected branches is ONE person but two sessions", () => {
    const r = run({ bookings: b, students, badgeValueIds: [BV1, BV2] });
    expect(r.demographics.gender.total).toBe(2); // S1 · S2
    expect(r.activityProgram.categories.find((c) => c.key === BIKE)!.course).toBe(3); // rows, not people
  });
  test("no badge selected = every branch (a row with no badge too)", () => {
    expect(run({ bookings: b, students }).demographics.gender.total).toBe(4);
  });
  test("a course / voucher is in a branch ONLY through its (non-cancelled) session rows", () => {
    const rows = [bk({ courseId: "c1", badgeIds: [BV1] }), bk({ courseId: "c2", badgeIds: [BV3] }), bk({ courseId: "c4", badgeIds: [BV1], status: "CANCELLED" }), bk({ voucherId: "v1", bookingType: "VOUCHER", badgeIds: [BV1] })];
    const courses = [course({ id: "c1", studentIds: [S1] }), course({ id: "c2", studentIds: [S2] }), course({ id: "c3", studentIds: [S3] }), course({ id: "c4", studentIds: [S4] })];
    const vouchers = [voucher({ id: "v1", studentId: S1 }), voucher({ id: "v2", studentId: S2 })];
    const one = run({ bookings: rows, courses, vouchers, badgeValueIds: [BV1] }).existingCustomers;
    expect(one.activeCourse).toBe(1); // c1 only: c2 is another branch, c3 has no rows, c4's only row is cancelled
    expect(one.activeVoucher).toBe(1);
    const all = run({ bookings: rows, courses, vouchers }).existingCustomers;
    expect([all.activeCourse, all.activeVoucher]).toEqual([4, 2]);
  });
  test("the trial / 1 HR sections filter on the trial's OWN badge", () => {
    const rows = [bk({ studentIds: [S1], bookingType: "FIRST_TRIAL", status: "CONFIRMED", date: "2026-09-10", badgeIds: [BV1] }), bk({ studentIds: [S2], bookingType: "FIRST_TRIAL", status: "CONFIRMED", date: "2026-09-10", badgeIds: [BV2] })];
    expect(run({ bookings: rows, badgeValueIds: [BV1] }).existingCustomers.recentFirstTrial).toBe(1);
    expect(run({ bookings: rows }).existingCustomers.recentFirstTrial).toBe(2);
  });
});

describe("🔴 TASK-741 — Demographic: students who ATTENDED in the month", () => {
  test("only ATTENDED lessons of THAT month make a person: CONFIRMED / CANCELLED / another month / ECA / the group row do not", () => {
    const rows = [
      bk({ studentIds: [S1] }), bk({ studentIds: [S2], status: "CONFIRMED" }), bk({ studentIds: [S3], status: "CANCELLED" }), bk({ studentIds: [S4], date: "2026-09-30" }), bk({ studentIds: [S5], date: "2026-11-01" }),
      bk({ studentIds: [S6], bookingType: "OTHER" }), bk({ studentIds: [S7], bookingType: "GROUP" }), bk({ studentIds: [S8], status: "NO_SHOW" }),
    ];
    expect(run({ bookings: rows, students: [S1, S2, S3, S4, S5, S6, S7, S8].map((id) => student(id)) }).demographics.gender.total).toBe(1);
  });
  test("a group SEAT is a student's own attended session; a DUO row is BOTH children; a child with 3 sessions is ONE", () => {
    const rows = [bk({ studentIds: [S1], isSeat: true }), bk({ studentIds: [S2, S3] }), bk({ studentIds: [S4] }), bk({ studentIds: [S4], date: "2026-10-06" }), bk({ studentIds: [S4], date: "2026-10-07" })];
    expect(run({ bookings: rows, students: [S1, S2, S3, S4].map((id) => student(id)) }).demographics.gender.total).toBe(4);
  });
  test("gender / nationality / province carry their unknowns; a child with no parent is unknown, not dropped", () => {
    const rows = [S1, S2, S3, S4].map((id) => bk({ studentIds: [id] }));
    const students = [
      student(S1, { gender: "female", nationality: "TH", province: "กรุงเทพมหานคร" }), student(S2, { gender: "female", nationality: "TH", province: "กรุงเทพมหานคร" }),
      student(S3, { gender: "male", nationality: "JP", province: "เชียงใหม่" }), student(S4),
    ];
    const d = run({ bookings: rows, students }).demographics;
    expect(d.gender).toEqual({ buckets: [{ key: "female", label: undefined, count: 2 }, { key: "male", label: undefined, count: 1 }, { key: "unknown", label: "ไม่ระบุ", count: 1 }], known: 3, unknown: 1, total: 4 });
    expect(d.nationality.buckets.map((x) => [x.key, x.count])).toEqual([["TH", 2], ["JP", 1], ["unknown", 1]]);
    expect(d.province.buckets.map((x) => [x.key, x.count])).toEqual([["กรุงเทพมหานคร", 2], ["เชียงใหม่", 1], ["unknown", 1]]);
  });
  test("🔒 the 9 NEW age bands: all nine always, in order, zeros kept, then unknown; edges 2|3 · 4|5 · 7|8 · 10|11 · 13|14 · 19|20 · 39|40 · 54|55; an infant is `1-2`", () => {
    const born = (age: number) => `${2026 - age}-01-01`; // today 2026-10-12 ⇒ exactly `age`
    const ages = [0, 1, 2, 3, 4, 5, 7, 8, 10, 11, 13, 14, 19, 20, 39, 40, 54, 55, 70];
    const rows = [...ages.map((_, i) => bk({ studentIds: [`a${i}`] })), bk({ studentIds: ["nodob"] })];
    const students = [...ages.map((a, i) => student(`a${i}`, { birthDate: born(a) })), student("nodob")];
    const d = run({ bookings: rows, students }).demographics.ageBand;
    expect(d.buckets.map((x) => [x.key, x.count])).toEqual([["1-2", 3], ["3-4", 2], ["5-7", 2], ["8-10", 2], ["11-13", 2], ["14-19", 2], ["20-39", 2], ["40-54", 2], ["55+", 2], ["unknown", 1]]);
    expect(d.buckets.filter((x) => x.label).map((x) => [x.key, x.label])).toEqual([["14-19", "14+"], ["20-39", "20+"], ["40-54", "40+"], ["unknown", "ไม่ระบุ"]]);
    expect([d.known, d.unknown, d.total]).toEqual([19, 1, 20]);
  });
  test("with nobody attending, all nine bands are still there at 0", () => {
    const d = run().demographics.ageBand;
    expect(d.buckets).toHaveLength(10);
    expect(d.buckets.every((x) => x.count === 0)).toBe(true);
    expect([d.known, d.unknown, d.total]).toEqual([0, 0, 0]);
  });
  test("District: key = the code, label = «district, province», most first, unknown LAST; a code outside the dataset is unknown", () => {
    const codes = ["1001", "1001", "1001", "5001", "9999", null];
    const ids = codes.map((_, i) => `d${i}`);
    const d = run({ bookings: ids.map((id) => bk({ studentIds: [id] })), students: ids.map((id, i) => student(id, { districtCode: codes[i] })) }).demographics.district;
    expect(d.buckets).toEqual([
      { key: "1001", label: "บางรัก, กรุงเทพมหานคร", count: 3 },
      { key: "5001", label: "เมืองเชียงใหม่, เชียงใหม่", count: 1 },
      { key: "unknown", label: "ไม่ระบุ", count: 2 },
    ]);
    expect([d.known, d.unknown, d.total]).toEqual([4, 2, 6]);
  });
  test("the month is echoed on every section", () => {
    const r = run({ month: "2026-09" });
    expect([r.existingCustomers.month, r.demographics.month, r.activityProgram.month]).toEqual(["2026-09", "2026-09", "2026-09"]);
  });
});

describe("🔴 TASK-744 — demographics.subdistrictByDistrict (K4 = B): the sub-district under each district", () => {
  const people = (specs: Array<[string | null, string | null]>, extra: Partial<SomBooking> = {}) => {
    const ids = specs.map((_, i) => `p${i}`);
    return { bookings: ids.map((id) => bk({ studentIds: [id], ...extra })), students: ids.map((id, i) => student(id, { districtCode: specs[i]![0], subdistrictCode: specs[i]![1] })) };
  };
  test("two sub-districts in one district (2 + 1) ⇒ the district's total 3, every bucket sent, `unknown` last", () => {
    const d = run(people([["1001", "100101"], ["1001", "100101"], ["1001", "100102"]])).demographics.subdistrictByDistrict;
    expect(d["1001"]).toEqual({ buckets: [{ key: "100101", label: "พระบรมมหาราชวัง", count: 2 }, { key: "100102", label: "วังบูรพาภิรมย์", count: 1 }, { key: "unknown", label: "ไม่ระบุ", count: 0 }], known: 3, unknown: 0, total: 3 });
  });
  test("a person in the district with no sub-district, a code outside the dataset, or a sub-district that belongs to ANOTHER district ⇒ that district's `unknown`", () => {
    const d = run(people([["1001", "100101"], ["1001", null], ["1001", "999999"], ["1001", "100199"], ["1001", "500101"], ["5001", "500101"]])).demographics.subdistrictByDistrict;
    expect(d["1001"]!.buckets).toEqual([{ key: "100101", label: "พระบรมมหาราชวัง", count: 1 }, { key: "unknown", label: "ไม่ระบุ", count: 4 }]); // null · 999999 · 100199 (inside the district but NOT in the dataset) · 500101 (another district's)
    expect([d["1001"]!.known, d["1001"]!.unknown, d["1001"]!.total]).toEqual([1, 4, 5]);
    expect(d["5001"]!.buckets).toEqual([{ key: "500101", label: "ศรีภูมิ", count: 1 }, { key: "unknown", label: "ไม่ระบุ", count: 0 }]); // the wrong-district code did NOT leak here
  });
  test("the keys are EXACTLY the district card's bucket keys (`unknown` excluded) and each total is that district's count; a child with no district is in neither", () => {
    const r = run(people([["1001", "100101"], ["5001", null], ["9999", "100101"], [null, "100101"]])).demographics;
    expect(Object.keys(r.subdistrictByDistrict).sort()).toEqual(r.district.buckets.filter((b) => b.key !== "unknown").map((b) => b.key).sort());
    for (const b of r.district.buckets) if (b.key !== "unknown") expect(r.subdistrictByDistrict[b.key]!.total).toBe(b.count);
    expect(run().demographics.subdistrictByDistrict).toEqual({}); // nobody attended
  });
  test("the SAME people as District: the badge OR and `month` change both together, and `district` itself is unchanged", () => {
    const specs: Array<[string | null, string | null]> = [["1001", "100101"], ["1001", "100102"], ["5001", "500101"]];
    const rows = people(specs);
    rows.bookings[0] = bk({ studentIds: ["p0"], badgeIds: [BV1] });
    rows.bookings[1] = bk({ studentIds: ["p1"], badgeIds: [BV2] });
    rows.bookings[2] = bk({ studentIds: ["p2"], badgeIds: [BV1], date: "2026-09-10" });
    const one = run({ ...rows, badgeValueIds: [BV1] }).demographics;
    expect(Object.keys(one.subdistrictByDistrict)).toEqual(["1001"]);
    expect(one.subdistrictByDistrict["1001"]!.total).toBe(1);
    expect(one.district.buckets[0]).toMatchObject({ key: "1001", count: 1 });
    const sep = run({ ...rows, month: "2026-09" }).demographics;
    expect(Object.keys(sep.subdistrictByDistrict)).toEqual(["5001"]);
    expect(run(rows).demographics.district.buckets.map((b) => [b.key, b.count])).toEqual([["1001", 2], ["unknown", 0]]); // October: p2 attended in September — and the district card is exactly as before
  });
});

describe("🔴 TASK-741 — Activity / Program: attended SESSIONS of the month by each session's subject", () => {
  const rows = [
    bk({ subjectId: BIKE }), bk({ subjectId: BIKE }), bk({ subjectId: BIKE, bookingType: "VOUCHER", voucherId: "v1" }), bk({ subjectId: BIKE, bookingType: "SINGLE_SESSION" }), bk({ subjectId: BIKE, bookingType: "FIRST_TRIAL" }),
    bk({ subjectId: SKATE }), bk({ subjectId: OLD, bookingType: "SINGLE_SESSION" }),
    // not counted:
    bk({ subjectId: BIKE, status: "CONFIRMED" }), bk({ subjectId: BIKE, status: "CANCELLED" }), bk({ subjectId: BIKE, status: "NO_SHOW" }), bk({ subjectId: BIKE, date: "2026-09-30" }),
    bk({ subjectId: BIKE, bookingType: "OTHER" }), bk({ subjectId: BIKE, bookingType: "GROUP" }),
  ];
  const r = run({ bookings: rows }).activityProgram;
  test("one row per category with Palm's fields; typeTotal = course + voucher + 1 HR; total = typeTotal + firstTrial; a voucher session takes its booking's subject", () => {
    expect(r.categories.find((c) => c.key === BIKE)).toEqual({ key: BIKE, label: "Bike", course: 2, voucher: 1, singleSession: 1, typeTotal: 4, firstTrial: 1, total: 5 });
    expect(r.categories.find((c) => c.key === SKATE)).toEqual({ key: SKATE, label: "Skate", course: 1, voucher: 0, singleSession: 0, typeTotal: 1, firstTrial: 0, total: 1 });
  });
  test("every ACTIVE subject is present even at 0; an INACTIVE one only when it has sessions; sorted total desc, then name; integers", () => {
    expect(r.categories.map((c) => [c.label, c.total])).toEqual([["Bike", 5], ["Old", 1], ["Skate", 1], ["Surf", 0]]);
    for (const c of r.categories) for (const k of ["course", "voucher", "singleSession", "typeTotal", "firstTrial", "total"] as const) expect(Number.isInteger(c[k])).toBe(true);
  });
  test("a group SEAT counts as a course session; DUO is ONE row (a class)", () => {
    const x = run({ bookings: [bk({ isSeat: true }), bk({ studentIds: [S2, S3] })] }).activityProgram.categories.find((c) => c.key === BIKE)!;
    expect(x.course).toBe(2);
  });
  test("a session with no subject falls to `unknown`, LAST, and only when it has sessions", () => {
    expect(r.categories.some((c) => c.key === "unknown")).toBe(false);
    const x = run({ bookings: [bk({ subjectId: null }), bk({ subjectId: null }), bk({ subjectId: SURF })] }).activityProgram.categories;
    expect(x.map((c) => [c.key, c.total])).toEqual([[SURF, 1], [BIKE, 0], [SKATE, 0], ["unknown", 2]]); // `unknown` is last even though it has the most
  });
  test("the badge filter and the month both apply", () => {
    const b = [bk({ badgeIds: [BV1] }), bk({ badgeIds: [BV2] }), bk({ badgeIds: [BV1], date: "2026-09-10" })];
    expect(run({ bookings: b, badgeValueIds: [BV1] }).activityProgram.categories.find((c) => c.key === BIKE)!.total).toBe(1);
    expect(run({ bookings: b, month: "2026-09", badgeValueIds: [BV1] }).activityProgram.categories.find((c) => c.key === BIKE)!.total).toBe(1);
    expect(run({ bookings: b, month: "2026-08" }).activityProgram.categories.find((c) => c.key === BIKE)!.total).toBe(0);
  });
});

describe("🔴 TASK-741 — the merge (the OLD result stays whole)", () => {
  const old = {
    existingCustomers: { byCourse: 9, byVoucher: 8, byRecentTrial: 7, total: 6, recentTrialSince: "2026-07-14" },
    sportShare: { buckets: [], known: 0, unknown: 0, total: 0 },
    newVsRenewing: { month: "2026-10", newByFirstTrial: 1, newByRegistration: 2, renewing: 0 },
    demographics: { gender: "old", ageBand: "old", province: "old", nationality: "old" },
    today: { date: TODAY, expected: 12, attended: 5 },
    generatedAt: "x",
  };
  const fresh = run();
  const merged = mergeSom(old, fresh);
  test("every old field is still there; the new fields sit beside them; the new definition wins where the names meet (`today.attended`, `ageBand`)", () => {
    expect(merged.sportShare).toBe(old.sportShare);
    expect(merged.newVsRenewing).toMatchObject({ ...old.newVsRenewing, firstTrial: 0, notRenewed: 0 }); // 742: the old three stay beside Palm's six
    expect(merged.generatedAt).toBe("x");
    expect(merged.existingCustomers).toMatchObject({ byCourse: 9, byVoucher: 8, byRecentTrial: 7, total: 6, recentTrialSince: "2026-07-14", activeCourse: 0, recentFrom: "2026-08" });
    expect(merged.today).toMatchObject({ expected: 12, confirmed: 0, attended: 0, attendanceRate: 0 });
    expect((merged.demographics as any).ageBand).toEqual(fresh.demographics.ageBand); // the old `"old"` is overwritten by the new bands
    expect((merged.demographics as any).district).toEqual(fresh.demographics.district);
    expect(merged.activityProgram).toBe(fresh.activityProgram);
  });
});

describe("🔴 TASK-741 — the READ (service) through fake db, and the district label from the REAL dataset", () => {
  const T = bangkokNow().date; // the service resolves «today» itself — the fixtures hang off the real Bangkok day
  const M = T.slice(0, 7);
  const spies: Array<{ mockRestore: () => void }> = [];
  afterAll(() => { for (const s of spies) s.mockRestore(); });
  const stub = (rows: { bookings?: any[]; courses?: any[]; vouchers?: any[]; students?: any[]; parents?: any[]; subjects?: any[]; courseMoves?: any[]; voucherMoves?: any[] }) => {
    const bookingsSpy = spyOn(db.query.bookings, "findMany").mockImplementation((async (q: any) => {
      const col = (name: string) => ({ __col: name });
      const pred = q.where(new Proxy({}, { get: (_t, k: string) => col(k) }), { eq: (c: any, val: unknown) => (r: any) => r[c.__col] === val });
      return (rows.bookings ?? []).filter(pred);
    }) as any);
    const parentsSpy = spyOn(db.query.parents, "findMany").mockImplementation((async () => rows.parents ?? []) as any);
    spies.push(
      bookingsSpy, parentsSpy,
      spyOn(db.query.coursePackages, "findMany").mockImplementation((async () => rows.courses ?? []) as any),
      spyOn(db.query.vouchers, "findMany").mockImplementation((async () => rows.vouchers ?? []) as any),
      spyOn(db.query.students, "findMany").mockImplementation((async () => rows.students ?? []) as any),
      spyOn(db.query.subjects, "findMany").mockImplementation((async () => rows.subjects ?? []) as any),
      spyOn(db.query.teachers, "findMany").mockImplementation((async () => []) as any),
      spyOn(teacherLeave, "recordedLeaveDays").mockImplementation((async () => []) as any), // 742 — Coach Capacity's leave days, through THE reader
      spyOn(db, "select").mockImplementation((() => ({ from: async (t: unknown) => (t === schema.courseExpiryChanges ? rows.courseMoves ?? [] : t === schema.voucherExpiryChanges ? rows.voucherMoves ?? [] : []) })) as any),
    );
    return { parentsSpy, bookingsSpy };
  };
  const done = () => { for (const s of spies.splice(0)) s.mockRestore(); };
  const B = (o: any = {}) => ({ studentId: S1, coStudentId: null, bookingType: "COURSE_PACKAGE", status: "ATTENDED", date: T, subjectId: BIKE, courseId: null, voucherId: null, groupId: null, pendingSlot: false, badges: [], ...o });

  test("rows → the pure input: a DUO row names both children, the badges ride along, a seat is flagged, a pending_slot row is not read at all", async () => {
    const withBadge = [{ badgeValueId: BV1 }];
    const { bookingsSpy } = stub({
      bookings: [B({ studentId: S1, coStudentId: S2, badges: withBadge }), B({ studentId: S3, groupId: "g1", badges: withBadge }), B({ studentId: S4, pendingSlot: true, badges: withBadge })],
      students: [1, 2, 3, 4].map((n) => ({ id: S(n), gender: null, nationality: null, birthDate: null, parentId: null })),
      subjects: [{ id: BIKE, name: "Bike", active: true }],
    });
    try {
      const r = await svc.getSomContract({ month: M, badgeValueIds: [BV1] });
      expect(r.demographics.gender.total).toBe(3); // the DUO row's two children + the SEAT's child (a seat is a student's own session); the pending_slot row never read
      expect(r.activityProgram.categories[0]).toMatchObject({ key: BIKE, course: 2 }); // the DUO row (one class) + the seat
      expect(r.today).toMatchObject({ date: T, confirmed: 1, attended: 1 }); // the DUO row only: the seat is out of the day
      expect(bookingsSpy).toHaveBeenCalledTimes(1);
    } finally { done(); }
  });
  test("courses / vouchers carry their own expiry moves (grouped by id) and both children of a DUO course", async () => {
    stub({
      courses: [{ id: "c1", studentId: S1, coStudentId: S2, createdAt: new Date("2026-01-05T03:00:00Z"), size: 10, usedSessions: 2, expiryDate: "2099-01-01", endedAt: null, droppedAt: null }],
      vouchers: [{ id: "v1", studentId: S3, createdAt: new Date("2026-01-05T03:00:00Z"), totalHours: 5, usedHours: 1, expiryDate: "2099-01-01", endedAt: null }],
      courseMoves: [{ courseId: "c1", fromDate: "2020-01-01", changedAt: new Date(`${T}T20:00:00Z`) }], // a move made AFTER today (Bangkok) ⇒ the expiry in force today was 2020 ⇒ not active
      subjects: [],
    });
    try {
      const r = await svc.getSomContract({ month: M });
      expect(r.existingCustomers.activeCourse).toBe(0); // the expiry move reached the counters
      expect(r.existingCustomers.activeVoucher).toBe(1);
    } finally { done(); }
    stub({ courses: [{ id: "c1", studentId: S1, coStudentId: S2, createdAt: new Date("2026-01-05T03:00:00Z"), size: 10, usedSessions: 2, expiryDate: "2099-01-01", endedAt: null, droppedAt: null }], subjects: [] });
    try { expect((await svc.getSomContract({ month: M })).existingCustomers.activeCourse).toBe(2); } finally { done(); } // both kids of the DUO course
  });
  test("the parents are read through `activeParentWhere` (an archived household is not counted); the province / district come from the ACTIVE parent only", async () => {
    const { parentsSpy } = stub({
      bookings: [B({ studentId: S1 }), B({ studentId: S2 })],
      students: [{ id: S1, parentId: "p1" }, { id: S2, parentId: "p-archived" }],
      parents: [{ id: "p1", province: "กรุงเทพมหานคร", districtCode: "1001" }], // p-archived is filtered out by the real SQL predicate
      subjects: [],
    });
    try {
      const r = await svc.getSomContract({ month: M });
      expect((parentsSpy.mock.calls[0] as any)[0].where).toBeDefined();
      expect(r.demographics.province.buckets.map((x) => [x.key, x.count])).toEqual([["กรุงเทพมหานคร", 1], ["unknown", 1]]);
      expect(r.demographics.district.buckets[0]).toMatchObject({ key: "1001", count: 1 });
      expect(r.demographics.district.buckets[0]!.label).toMatch(/, กรุงเทพมหานคร$/);
    } finally { done(); }
  });
  test("🔒 `districtLabel` — «district, province» from the REAL dataset; a code that is not in it is null", () => {
    expect(svc.districtLabel("1001")).toMatch(/^.+, กรุงเทพมหานคร$/);
    expect(svc.districtLabel("9999")).toBeNull();
    expect(svc.districtLabel("")).toBeNull();
  });
  test("no month sent ⇒ this month (Bangkok), every branch", async () => {
    stub({ subjects: [] });
    try {
      const r = await svc.getSomContract();
      expect([r.existingCustomers.month, r.today.date]).toEqual([M, T]);
    } finally { done(); }
  });
});

describe("🔴 TASK-741 — the validator and the route", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterAll(() => { for (const s of spies) s.mockRestore(); });
  const nextMonth = addMonths(bangkokNow().date.slice(0, 7), 1);
  test("`month` is YYYY-MM, a real month, never in the future; `badgeValueIds` is a comma list of uuids, trimmed, empty ⇒ []", () => {
    const ok = v.somQuery.safeParse({ month: "2026-10", badgeValueIds: ` ${BV1} , ${BV2} ` });
    expect(ok.success && ok.data).toEqual({ month: "2026-10", badgeValueIds: [BV1, BV2] });
    expect(v.somQuery.parse({})).toEqual({ month: undefined, badgeValueIds: [] });
    expect(v.somQuery.parse({ badgeValueIds: "" }).badgeValueIds).toEqual([]);
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", nextMonth]) expect(v.somQuery.safeParse({ month: bad }).success).toBe(false);
    expect(v.somQuery.safeParse({ badgeValueIds: `${BV1},not-a-uuid` }).success).toBe(false);
    expect(v.somQuery.safeParse({ month: bangkokNow().date.slice(0, 7) }).success).toBe(true); // the current month is allowed
  });
  test("`GET /reports/som?month&badgeValueIds` reaches the new service with the parsed filters and the response is the OLD result with the new sections laid over it", async () => {
    const calls: unknown[][] = [];
    spies.push(
      spyOn(oldSom, "getSomReport").mockImplementation((async () => ({ sportShare: "old-sport", newVsRenewing: { newByFirstTrial: 7 }, demographics: { ageBand: "old" }, existingCustomers: { byCourse: 9 }, today: { date: TODAY, expected: 4, attended: 1 }, generatedAt: "t" })) as any),
      spyOn(svc, "getSomContract").mockImplementation((async (...a: unknown[]) => { calls.push(a); return run({ month: "2026-09" }); }) as any),
    );
    const res = await api.request(`/reports/som?month=2026-09&badgeValueIds=${BV1},${BV2}`);
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual([{ month: "2026-09", badgeValueIds: [BV1, BV2] }]);
    const body: any = await res.json();
    expect(body).toMatchObject({ sportShare: "old-sport", newVsRenewing: { newByFirstTrial: 7, firstTrial: 0 }, generatedAt: "t", today: { expected: 4, confirmed: 0 }, existingCustomers: { byCourse: 9, activeCourse: 0, month: "2026-09" } });
    expect(body.activityProgram.month).toBe("2026-09");
    await api.request("/reports/som");
    expect(calls[1]).toEqual([{ month: undefined, badgeValueIds: [] }]);
    expect((await api.request("/reports/som?month=2026-13")).status).toBe(400);
    expect((await api.request(`/reports/som?month=${nextMonth}`)).status).toBe(400);
    expect((await api.request("/reports/som?badgeValueIds=nope")).status).toBe(400);
  });
  test("🚫 the OLD report's two files are BYTE-IDENTICAL (7 test files pin their text) — pinned by hash", () => {
    const sha = (rel: string) => createHash("sha1").update(readFileSync(resolve(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n")).digest("hex");
    expect(sha("../services/som-report.service.ts")).toBe("d61a6a72a59dae2b8a91ab9d2d6b520d682c5ff0");
    expect(sha("./som-report.ts")).toBe("da8287c27c6aa82469238cbca5f18452a951edc5");
  });
});
