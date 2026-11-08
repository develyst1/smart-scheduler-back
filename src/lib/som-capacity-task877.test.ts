// 🔻 TASK-877 (REQ-5009; ขวัญ for พี่ปุ้ม + พี่ตั้ม, 2026-11-08) — Coach Capacity: FT 4 h weekday / 5 h Sat–Sun, PT 5 h Sat–Sun (or his own value), FL 0; and the ECA / CAMP `OTHER` rows count as booked hours, in clock minutes.
// Pure: `countCapacity` by value, the service mapper by source. October 2026 has 22 weekdays + 9 weekend days.
import { describe, expect, test } from "bun:test";
import { CAPACITY_FREELANCE_HOURS, CAPACITY_FULL_TIME_WEEKDAY_HOURS, CAPACITY_FULL_TIME_WEEKEND_HOURS, CAPACITY_OTHER_KINDS, CAPACITY_PART_TIME_WEEKDAY_HOURS, CAPACITY_PART_TIME_WEEKEND_HOURS, countCapacity, type SomBooking, type SomContractInput, type SomTeacher } from "./som-contract";

const file = async (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const TA = "teacher-a", TB = "teacher-b", TC = "teacher-c";
const coach = (id: string, type: SomTeacher["type"], o: Partial<SomTeacher> = {}): SomTeacher => ({ id, nickname: id, type, active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], ...o });
const bk = (o: Partial<SomBooking> = {}): SomBooking => ({ studentIds: [], bookingType: "OTHER", status: "CONFIRMED", date: "2026-10-05", subjectId: null, courseId: null, voucherId: null, badgeIds: [], isSeat: false, teacherId: TA, startTime: "10:00", endTime: "11:00", ...o });
const cap = (o: Partial<SomContractInput>) => countCapacity({ month: "2026-10", today: "2026-10-12", badgeValueIds: [], bookings: [], courses: [], vouchers: [], students: [], subjects: [], districtLabel: () => null, ...o });
const one = (o: Partial<SomContractInput>) => cap(o).byPerson[0]!;

describe("🔒 TASK-877 — the rates (REQ-5009 supersedes REQ-5004's 5 / 6)", () => {
  test("FT 4 weekday / 5 weekend · PT 5 weekend / 0 weekday · FL 0 — and the two weekend rates are separate constants", () => {
    expect([CAPACITY_FULL_TIME_WEEKDAY_HOURS, CAPACITY_FULL_TIME_WEEKEND_HOURS, CAPACITY_PART_TIME_WEEKEND_HOURS, CAPACITY_PART_TIME_WEEKDAY_HOURS, CAPACITY_FREELANCE_HOURS]).toEqual([4, 5, 5, 0, 0]);
  });
  test("an FT coach working 1 weekday + 1 weekend day ⇒ available 4 + 5", () => {
    const r = one({ teachers: [coach(TA, "FULL_TIME", { workDays: [1, 6] })], from: "2026-10-05", to: "2026-10-10", month: undefined } as any); // Mon 5 … Sat 10: ONE Monday, ONE Saturday
    expect([r.weekdayAvailableHours, r.weekendAvailableHours, r.availableHours]).toEqual([4, 5, 9]);
  });
  test("a PT coach: no own rate ⇒ weekend 5; own rate 4 ⇒ 4 (Karn's case — no name in the code); weekday 0 whatever the work days", () => {
    const own = one({ teachers: [coach(TB, "PART_TIME", { weekendCapacityHours: 4 })] });
    const std = one({ teachers: [coach(TB, "PART_TIME")] });
    expect([std.weekendAvailableHours, std.weekdayAvailableHours]).toEqual([45, 0]); // 9 weekend days × 5
    expect([own.weekendAvailableHours, own.weekdayAvailableHours]).toEqual([36, 0]); // 9 × 4
  });
  test("a full month: FT working every day = 22 × 4 + 9 × 5 = 133 hours", () => {
    expect(one({ teachers: [coach(TA, "FULL_TIME")] })).toMatchObject({ weekdayAvailableHours: 88, weekendAvailableHours: 45, availableHours: 133 });
  });
});

describe("🔴 TASK-877 — booked hours: the ECA and CAMP OTHER rows count, in clock minutes (REQ-5009)", () => {
  const T = [coach(TA, "FULL_TIME"), coach(TB, "FULL_TIME")];
  test("the kinds are exactly ECA and CAMP", () => {
    expect([...CAPACITY_OTHER_KINDS].sort()).toEqual(["CAMP", "ECA"]);
  });
  test("a 2-hour ECA on a weekday and a 1-hour CAMP row on a Saturday count as 2 + 1 booked — and an EXTRA coach on the ECA counts it too", () => {
    const eca = bk({ otherKind: "ECA", date: "2026-10-06", startTime: "10:00", endTime: "12:00", teacherId: TA, extraTeacherIds: [TB] });
    const camp = bk({ otherKind: "CAMP", date: "2026-10-03", startTime: "09:00", endTime: "10:00", teacherId: TA });
    const r = cap({ teachers: T, bookings: [eca, camp] });
    const a = r.byPerson.find((p) => p.teacherId === TA)!, b = r.byPerson.find((p) => p.teacherId === TB)!;
    expect([a.weekdayBookedHours, a.weekendBookedHours, a.bookedHours]).toEqual([2, 1, 3]);
    expect([b.weekdayBookedHours, b.weekendBookedHours, b.bookedHours]).toEqual([2, 0, 2]);
  });
  test("a FREE, a KOL and a no-kind OTHER row are NOT counted", () => {
    const rows = ["FREE", "KOL", null, undefined, "", "OTHER"].map((otherKind, i) => bk({ otherKind: otherKind as any, date: `2026-10-0${5 + (i % 3)}` }));
    expect(one({ teachers: T, bookings: rows }).bookedHours).toBe(0);
  });
  test("a CANCELLED ECA row is not counted; a PENDING one is (it still holds the coach's hour); another month's is not", () => {
    const rows = [bk({ otherKind: "ECA", status: "CANCELLED" }), bk({ otherKind: "ECA", status: "PENDING", date: "2026-10-07" }), bk({ otherKind: "ECA", date: "2026-09-30" }), bk({ otherKind: "ECA", date: "2026-11-02" })];
    expect(one({ teachers: T, bookings: rows }).bookedHours).toBe(1);
  });
  test("a GROUP's seats still never count; a seat flagged ECA is out too", () => {
    expect(one({ teachers: T, bookings: [bk({ otherKind: "ECA", isSeat: true })] }).bookedHours).toBe(0);
  });
  test("the badge filter applies to the ECA / CAMP rows as to lessons (booked only; available is not filtered)", () => {
    const rows = [bk({ otherKind: "ECA", badgeIds: ["b1"] }), bk({ otherKind: "ECA", badgeIds: ["b2"], date: "2026-10-06" })];
    const r = one({ teachers: T, bookings: rows, badgeValueIds: ["b1"] });
    expect([r.bookedHours, r.availableHours]).toEqual([1, 133]);
  });
  test("a lesson still counts exactly as before (the clause is an OR, not a replacement)", () => {
    const lesson = bk({ bookingType: "COURSE_PACKAGE", date: "2026-10-05" });
    expect(one({ teachers: T, bookings: [lesson] }).bookedHours).toBe(1);
  });
  test("the service hands the counters each row's `otherKind` (the columns list and the mapper), by source", async () => {
    const S = await file("../services/som-contract.service.ts");
    expect(S).toContain("startTime: true, endTime: true, otherKind: true }");
    expect(S).toContain("otherKind: b.otherKind ?? null,");
  });
});
