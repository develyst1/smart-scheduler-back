// 🔻 TASK-950 (SPEC-104) — SOM Dashboard BE for Palm's front end: #3 the demographics BASE («Total Customer + 1 HR (last 3 months)») and #5 `activityPackages` (courses counted as COURSES by their own
// subject + size, 1 HR as CHILDREN, 1st Trial beside and not in `total`, vouchers never). Pure counters by value — no database.
import { describe, expect, test } from "bun:test";
import { countSom, mergeSom, type SomBooking, type SomContractInput, type SomCourse, type SomStudent, type SomVoucher } from "./som-contract";

const SURF = "aaaa0004-0000-4000-8000-000000000000", BIKE = "aaaa0001-0000-4000-8000-000000000000", SKATE = "aaaa0002-0000-4000-8000-000000000000", OLD = "aaaa0003-0000-4000-8000-000000000000", NOSUCH = "ffff0000-0000-4000-8000-000000000000";
const BV1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1", BV2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const MONTH = "2026-10", TODAY = "2026-10-12";
const SUBJECTS = [{ id: SURF, name: "Private SURFSKATE", active: true }, { id: BIKE, name: "Private BIKE", active: true }, { id: SKATE, name: "Private SKATE", active: true }, { id: OLD, name: "Old", active: false }];

const bk = (o: Partial<SomBooking> = {}): SomBooking => ({ studentIds: ["s0"], bookingType: "COURSE_PACKAGE", status: "ATTENDED", date: "2026-10-05", subjectId: BIKE, courseId: null, voucherId: null, badgeIds: [], isSeat: false, ...o });
const course = (o: Partial<SomCourse> = {}): SomCourse => ({ id: "c0", studentIds: ["s0"], createdAt: "2026-09-01T03:00:00Z", size: 10, usedSessions: 2, expiryDate: "2027-03-01", endedAt: null, droppedAt: null, expiryChanges: [], subjectId: BIKE, ...o });
const voucher = (o: Partial<SomVoucher> = {}): SomVoucher => ({ id: "v0", studentId: "s0", createdAt: "2026-09-01T03:00:00Z", totalHours: 10, usedHours: 3, expiryDate: "2027-03-01", endedAt: null, expiryChanges: [], ...o });
const student = (id: string, o: Partial<SomStudent> = {}): SomStudent => ({ id, gender: null, nationality: null, birthDate: null, province: null, districtCode: null, ...o });
const single = (id: string, subjectId: string | null, o: Partial<SomBooking> = {}) => bk({ studentIds: [id], bookingType: "SINGLE_SESSION", subjectId, status: "CONFIRMED", date: "2026-10-08", ...o });
const trial = (id: string, subjectId: string | null, o: Partial<SomBooking> = {}) => bk({ studentIds: [id], bookingType: "FIRST_TRIAL", subjectId, status: "ATTENDED", date: "2026-10-03", ...o });
/** An ACTIVE course holds its class after today (REQ-5002 Q2) — `withClass` gives each course one. */
const withClass = (courses: SomCourse[], extra: SomBooking[] = []): SomBooking[] => [...extra, ...courses.map((c) => bk({ courseId: c.id, studentIds: [...c.studentIds], status: "CONFIRMED", date: "2027-01-15" }))];
const run = (o: Partial<SomContractInput> = {}) =>
  countSom({ month: MONTH, today: TODAY, badgeValueIds: [], bookings: [], courses: [], vouchers: [], students: [], subjects: SUBJECTS, districtLabel: () => null, ...o });
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const pk = (r: ReturnType<typeof run>, key: string) => r.activityPackages.activities.find((a) => a.key === key)!;

describe("🔴 TASK-950 #5 — activityPackages: the SPEC's worked example (her SURFSKATE / BIKE lines)", () => {
  const surfCourses = [...ids("sa", 61).map((id, i) => course({ id: `cs10-${i}`, studentIds: [id], size: 10, subjectId: SURF })), ...ids("sb", 11).map((id, i) => course({ id: `cs6-${i}`, studentIds: [id], size: 6, subjectId: SURF }))];
  const bikeCourses = ids("bb", 10).map((id, i) => course({ id: `cb4-${i}`, studentIds: [id], size: 4, subjectId: BIKE }));
  const courses = [...surfCourses, ...bikeCourses];
  const bookings = withClass(courses, [...ids("sc", 15).map((id) => single(id, SURF)), ...ids("bc", 25).map((id) => single(id, BIKE))]);
  const r = run({ courses, bookings });
  test("SURFSKATE = 61 × Course 10 + 15 × 1 HR + 11 × Course 6 → total 87 (largest count first)", () => {
    expect(pk(r, SURF)).toEqual({ key: SURF, label: "Private SURFSKATE", total: 87, packages: [{ kind: "COURSE", size: 10, count: 61 }, { kind: "SINGLE_SESSION", count: 15 }, { kind: "COURSE", size: 6, count: 11 }], firstTrial: 0 });
  });
  test("BIKE = 25 × 1 HR + 10 × Course 4 → total 35", () => {
    expect(pk(r, BIKE)).toEqual({ key: BIKE, label: "Private BIKE", total: 35, packages: [{ kind: "SINGLE_SESSION", count: 25 }, { kind: "COURSE", size: 4, count: 10 }], firstTrial: 0 });
  });
  test("every ACTIVE subject is listed, 0 included; an inactive one is not; the biggest activity first; the header echoes the period + base", () => {
    expect(r.activityPackages.activities.map((a) => [a.key, a.total])).toEqual([[SURF, 87], [BIKE, 35], [SKATE, 0]]);
    expect(pk(r, SKATE)).toEqual({ key: SKATE, label: "Private SKATE", total: 0, packages: [], firstTrial: 0 });
    expect(r.activityPackages).toMatchObject({ month: MONTH, from: "2026-10-01", to: "2026-10-31", base: "CUSTOMERS_PLUS_RECENT_1HR" });
  });
});

describe("🔴 TASK-950 #5 — the course / voucher / 1 HR / trial rules", () => {
  test("a voucher holder adds NOTHING to activityPackages (but is in the demographics base)", () => {
    const r = run({ vouchers: [voucher({ studentId: "v-kid" })], students: [student("v-kid")], bookings: [bk({ voucherId: "v0", studentIds: ["v-kid"], bookingType: "VOUCHER", status: "CONFIRMED", date: "2026-10-20" })] });
    expect(r.activityPackages.activities.every((a) => a.total === 0 && a.packages.length === 0)).toBe(true);
    expect(r.existingCustomers.activeVoucher).toBe(1);
    expect(r.demographics.gender.total).toBe(1);
  });
  test("a child with TWO courses of one activity counts 2 courses (never class rows, never people); he is ONE child in the base", () => {
    const courses = [course({ id: "c1", studentIds: ["s1"], subjectId: BIKE }), course({ id: "c2", studentIds: ["s1"], subjectId: BIKE })];
    const rows = [...withClass(courses), bk({ courseId: "c1", studentIds: ["s1"] }), bk({ courseId: "c1", studentIds: ["s1"], date: "2026-10-06" }), bk({ courseId: "c2", studentIds: ["s1"], date: "2026-10-07" })]; // 3 attended class rows
    const r = run({ courses, bookings: rows, students: [student("s1")] });
    expect(pk(r, BIKE).packages).toEqual([{ kind: "COURSE", size: 10, count: 2 }]);
    expect(r.demographics.gender.total).toBe(1);
  });
  test("courses are grouped by the course's OWN subject and size; an ended / not-yet-bought / no-class-after course is not active", () => {
    const courses = [
      course({ id: "a", studentIds: ["s1"], subjectId: BIKE, size: 4 }), course({ id: "b", studentIds: ["s2"], subjectId: SKATE, size: 4 }),
      course({ id: "ended", studentIds: ["s3"], subjectId: BIKE, size: 4, endedAt: "2026-09-20T03:00:00Z" }), course({ id: "future", studentIds: ["s4"], subjectId: BIKE, size: 4, createdAt: "2026-11-20T03:00:00Z" }),
      course({ id: "noclass", studentIds: ["s5"], subjectId: BIKE, size: 4 }),
    ];
    const r = run({ courses, bookings: withClass(courses.filter((c) => c.id !== "noclass")) });
    expect(pk(r, BIKE).packages).toEqual([{ kind: "COURSE", size: 4, count: 1 }]);
    expect(pk(r, SKATE).packages).toEqual([{ kind: "COURSE", size: 4, count: 1 }]);
  });
  test("a child with a 1 HR in TWO activities counts once in EACH; two 1 HR rows of one activity are one child", () => {
    const r = run({ bookings: [single("s1", BIKE), single("s1", BIKE, { date: "2026-10-09" }), single("s1", SKATE)] });
    expect(pk(r, BIKE).packages).toEqual([{ kind: "SINGLE_SESSION", count: 1 }]);
    expect(pk(r, SKATE).packages).toEqual([{ kind: "SINGLE_SESSION", count: 1 }]);
    expect(r.existingCustomers.recentSingleSession).toBe(1); // …and ONE child on the 1 HR card
  });
  test("1 HR window = the card's last 3 months: before the window / after the range end / cancelled do not count; a child who opened a course leaves 1 HR", () => {
    const owner = course({ id: "own", studentIds: ["s9"], subjectId: SKATE, size: 6 });
    const r = run({
      courses: [owner],
      bookings: withClass([owner], [single("s1", BIKE, { date: "2026-08-01" }), single("s2", BIKE, { date: "2026-07-31" }), single("s3", BIKE, { date: "2026-11-01" }), single("s4", BIKE, { status: "CANCELLED" }), single("s9", BIKE)]),
    });
    expect(pk(r, BIKE).packages).toEqual([{ kind: "SINGLE_SESSION", count: 1 }]); // s1 only
    expect(pk(r, SKATE).packages).toEqual([{ kind: "COURSE", size: 6, count: 1 }]); // s9's course counts; his 1 HR does not (the card moves him out)
  });
  test("the window and the cancelled rule hold PER ACTIVITY too: a child's 1 HR of ANOTHER activity outside the window, after the range or cancelled does not count there", () => {
    const r = run({ bookings: [single("s1", BIKE), single("s1", SKATE, { date: "2026-07-31" }), single("s1", SURF, { date: "2026-11-01" }), single("s1", OLD, { status: "CANCELLED" }), trial("s1", SURF, { status: "CANCELLED" })] });
    expect(pk(r, BIKE).packages).toEqual([{ kind: "SINGLE_SESSION", count: 1 }]);
    expect(pk(r, SKATE)).toMatchObject({ total: 0, packages: [] });
    expect(pk(r, SURF)).toMatchObject({ total: 0, packages: [], firstTrial: 0 }); // after the range / a cancelled trial
  });
  test("`unknown` is not listed for a 1 HR that the card does not count (a course owner's 1 HR with no subject); a trial-only unknown IS listed (total 0, trial 1)", () => {
    const owner = course({ id: "own", studentIds: ["s9"], subjectId: SKATE });
    const r = run({ courses: [owner], bookings: withClass([owner], [single("s9", null)]) });
    expect(r.activityPackages.activities.some((a) => a.key === "unknown")).toBe(false);
    expect(pk(run({ bookings: [trial("t1", null)] }), "unknown")).toMatchObject({ total: 0, packages: [], firstTrial: 1 });
  });
  test("1st Trial is counted SEPARATELY (in the range) and is NOT in `total`", () => {
    const r = run({ bookings: [trial("t1", BIKE), trial("t2", BIKE), trial("t3", BIKE, { date: "2026-09-10" }), single("s1", BIKE)] });
    expect(pk(r, BIKE).firstTrial).toBe(2); // t3 is September — out of the range
    expect(pk(r, BIKE).total).toBe(1); // the 1 HR child only
  });
  test("a subject the list does not know goes under `unknown`, last, only when > 0", () => {
    expect(run().activityPackages.activities.some((a) => a.key === "unknown")).toBe(false);
    const r = run({ bookings: [single("s1", NOSUCH), single("s2", null), single("s3", BIKE)] });
    const keys = r.activityPackages.activities.map((a) => a.key);
    expect(keys[keys.length - 1]).toBe("unknown");
    expect(pk(r, "unknown")).toMatchObject({ label: "ไม่ระบุ", total: 2, packages: [{ kind: "SINGLE_SESSION", count: 2 }] });
  });
  test("the badge filter: a course is in a branch only through its rows; a 1 HR / trial on its own badge", () => {
    const courses = [course({ id: "c1", studentIds: ["s1"], size: 6 }), course({ id: "c2", studentIds: ["s2"], size: 6 })];
    const rows = [
      bk({ courseId: "c1", studentIds: ["s1"], status: "CONFIRMED", date: "2027-01-15", badgeIds: [BV1] }), bk({ courseId: "c2", studentIds: ["s2"], status: "CONFIRMED", date: "2027-01-15", badgeIds: [BV2] }),
      single("s3", BIKE, { badgeIds: [BV1] }), single("s4", BIKE, { badgeIds: [BV2] }), trial("t1", BIKE, { badgeIds: [BV1] }), trial("t2", BIKE, { badgeIds: [BV2] }),
    ];
    const r1 = run({ courses, bookings: rows, badgeValueIds: [BV1] });
    expect(pk(r1, BIKE)).toMatchObject({ total: 2, firstTrial: 1, packages: [{ kind: "COURSE", size: 6, count: 1 }, { kind: "SINGLE_SESSION", count: 1 }] });
    const all = run({ courses, bookings: rows });
    expect(pk(all, BIKE)).toMatchObject({ total: 4, firstTrial: 2 });
  });
});

describe("🔴 TASK-950 #3 — demographics base = customers ∪ 1 HR (last 3 months) children", () => {
  const courses = [course({ id: "c1", studentIds: ["s1"] }), course({ id: "c2", studentIds: ["s2"] })];
  const students = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((id) => student(id, { gender: id === "s1" ? "female" : "male" }));
  const bookings = withClass(courses, [
    single("s3", BIKE), single("s1", BIKE), // s1: a course holder who also has a 1 HR — ONE person (the 1 HR card moves him out, but he is a customer)
    trial("s4", BIKE), // attended a 1st Trial only: NOT in the base
    bk({ studentIds: ["s5"], status: "ATTENDED" }), // attended a course lesson in the range, holds nothing active: NOT in the base (the old rule)
  ]);
  const vouchers = [voucher({ id: "v6", studentId: "s6" })];
  const r = run({ courses, vouchers, bookings, students });
  test("`gender.total` = totalCustomers + the 1 HR children who are not customers (each child once); `base` is named", () => {
    expect(r.existingCustomers.totalCustomers).toBe(3); // s1 · s2 (courses) + s6 (voucher)
    expect(r.demographics.gender.total).toBe(r.existingCustomers.totalCustomers + 1); // + s3
    expect(r.demographics.gender.total).toBe(4);
    expect(r.demographics.base).toBe("CUSTOMERS_PLUS_RECENT_1HR");
    expect(r.demographics.gender.buckets.map((b) => [b.key, b.count])).toEqual([["male", 3], ["female", 1], ["unknown", 0]]);
  });
  test("an ARCHIVED child is out (customer or 1 HR); a child who only attended a 1st Trial is not in the base", () => {
    const arch = run({ courses, vouchers, bookings, students: students.map((s) => (s.id === "s3" || s.id === "s2" ? { ...s, archivedAt: "2026-09-01T03:00:00Z" } : s)) });
    expect(arch.demographics.gender.total).toBe(2); // s1 · s6
    expect(arch.existingCustomers.totalCustomers).toBe(2);
    expect(r.demographics.gender.total).toBe(4); // s4 (trial only) and s5 (attended only) never entered
  });
  test("the shape is unchanged: every section keeps `buckets / known / unknown / total`, over the SAME people", () => {
    const d = r.demographics;
    for (const k of ["gender", "ageBand", "nationality", "province", "district"] as const) expect(d[k].total).toBe(4);
    expect(Object.keys(d).sort()).toEqual(["ageBand", "base", "district", "from", "gender", "month", "nationality", "province", "subdistrictByDistrict", "to"]);
  });
  test("the badge filter narrows both sets: a 1 HR child on his own badge, a customer through his course's rows", () => {
    const rows = withClass([course({ id: "c1", studentIds: ["s1"] })]).map((b) => ({ ...b, badgeIds: [BV1] }));
    const r1 = run({ courses: [course({ id: "c1", studentIds: ["s1"] })], bookings: [...rows, single("s3", BIKE, { badgeIds: [BV1] }), single("s4", BIKE, { badgeIds: [BV2] })], students, badgeValueIds: [BV1] });
    expect(r1.demographics.gender.total).toBe(2); // s1 + s3
  });
});

describe("🔒 TASK-950 — `activityProgram` is unchanged (attended SESSIONS by type); the route's merge carries the new field", () => {
  test("the old section keeps its numbers", () => {
    const rows = [
      bk({ subjectId: BIKE }), bk({ subjectId: BIKE }), bk({ subjectId: BIKE, bookingType: "VOUCHER", voucherId: "v1" }), bk({ subjectId: BIKE, bookingType: "SINGLE_SESSION" }), bk({ subjectId: BIKE, bookingType: "FIRST_TRIAL" }),
      bk({ subjectId: SKATE }), bk({ subjectId: NOSUCH }), bk({ subjectId: BIKE, status: "CONFIRMED" }),
    ];
    const r = run({ bookings: rows });
    expect(r.activityProgram.categories.map((c) => [c.key, c.course, c.voucher, c.singleSession, c.firstTrial, c.typeTotal, c.total])).toEqual([
      [BIKE, 2, 1, 1, 1, 4, 5], [SKATE, 1, 0, 0, 0, 1, 1], [SURF, 0, 0, 0, 0, 0, 0], ["unknown", 1, 0, 0, 0, 1, 1],
    ]);
    expect(r.activityProgram.categories.some((c) => c.key === OLD)).toBe(false);
  });
  test("mergeSom lays `activityPackages` into the response (and keeps the old sections)", () => {
    const fresh = run({ bookings: [single("s1", BIKE)] });
    const merged = mergeSom({ today: {}, existingCustomers: {}, demographics: { legacy: 1 }, newVsRenewing: {}, activityProgram: { old: true } }, fresh);
    expect(merged.activityPackages).toBe(fresh.activityPackages);
    expect(merged.activityProgram as unknown).toBe(fresh.activityProgram);
    expect((merged.demographics as any).legacy).toBe(1);
    expect(merged.demographics.base).toBe("CUSTOMERS_PLUS_RECENT_1HR");
  });
});
