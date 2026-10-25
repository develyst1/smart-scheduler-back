// 🔻 TASK-748 (REQ-129 = B, Khwan 2026-10-25: «แบบ A แต่นับงานกลุ่มเป็นชั่วโมง») — the Daily Report's per-coach `total` (+Group) = CONFIRMED lessons + group work in HOURS (one row = one hour).
// Pure, by value: `countDaily`'s workload loop. `count` / `attended` do not move.
import { describe, expect, test } from "bun:test";
import { CONFIRMED_STATUSES, WORKLOAD_STATUSES, countDaily, type ReportRow } from "./daily-report";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = (status: string, bookingType: string, ...coachIds: string[]): ReportRow => ({ status, bookingType, coachIds: coachIds.length ? coachIds : [A] });
const times = (n: number, make: () => ReportRow): ReportRow[] => Array.from({ length: n }, make);
const total = (rows: ReportRow[], id = A, teacherId?: string) => countDaily(rows, { teacherId }).byTeacher.find((t) => t.teacherId === id);

describe("🔒 TASK-748 — the rule is ONE named constant", () => {
  test("only a CONFIRMED-set status adds to the workload: CONFIRMED · ATTENDED · NO_SHOW", () => {
    expect([...WORKLOAD_STATUSES].sort()).toEqual(["ATTENDED", "CONFIRMED", "NO_SHOW"]);
    expect(WORKLOAD_STATUSES).toBe(CONFIRMED_STATUSES);
  });
});

describe("🔴 TASK-748 — lessons: exactly the coach's confirmed count", () => {
  test("6 confirmed + 3 on leave ⇒ total 6 (was 9)", () => {
    const rows = [...times(6, () => row("CONFIRMED", "COURSE_PACKAGE")), ...times(3, () => row("SICK_LEAVE", "COURSE_PACKAGE"))];
    expect(total(rows)).toEqual({ teacherId: A, count: 6, attended: 0, total: 6 });
  });
  test("0 confirmed + 2 on leave ⇒ the coach is still LISTED, with total 0 (was 2)", () => {
    expect(total(times(2, () => row("SICK_LEAVE", "COURSE_PACKAGE")))).toEqual({ teacherId: A, count: 0, attended: 0, total: 0 });
  });
  test("a pending (PENDING / EXTENDED) lesson adds 0; a paused or cancelled one does not even list the coach", () => {
    expect(total([row("PENDING", "COURSE_PACKAGE"), row("EXTENDED", "SINGLE_SESSION")])).toEqual({ teacherId: A, count: 0, attended: 0, total: 0 });
    expect(countDaily([row("PAUSED", "SINGLE_SESSION"), row("CANCELLED", "COURSE_PACKAGE")]).byTeacher).toEqual([]);
  });
  test("a leave and its same-slot replacement count ONCE (the replacement)", () => {
    expect(total([row("SICK_LEAVE", "COURSE_PACKAGE"), row("CONFIRMED", "COURSE_PACKAGE")])).toEqual({ teacherId: A, count: 1, attended: 0, total: 1 });
  });
  test("ATTENDED and NO_SHOW are confirmed work", () => {
    expect(total([row("ATTENDED", "VOUCHER"), row("NO_SHOW", "FIRST_TRIAL")])).toEqual({ teacherId: A, count: 2, attended: 1, total: 2 });
  });
});

describe("🔴 TASK-748 — group work in HOURS (one row = one hour)", () => {
  test("a 2-hour ECA ⇒ +2; a 5-hour camp ⇒ +5; a 1-hour group class ⇒ +1", () => {
    expect(total(times(2, () => row("CONFIRMED", "OTHER")))!.total).toBe(2);
    expect(total(times(5, () => row("CONFIRMED", "OTHER")))!.total).toBe(5); // a camp's hour rows are born CONFIRMED and are OTHER rows
    expect(total([row("CONFIRMED", "GROUP")])!.total).toBe(1);
    expect(total([row("CONFIRMED", "GROUP")])).toMatchObject({ count: 0, attended: 0 }); // work, not a lesson
  });
  test("the ECA's EXTRA coach also gets +2; the filter keeps it for him", () => {
    const rows = times(2, () => row("CONFIRMED", "OTHER", A, B));
    expect([total(rows, A)!.total, total(rows, B)!.total]).toEqual([2, 2]);
    expect(total(rows, B, B)!.total).toBe(2);
    expect(countDaily(rows, { teacherId: B }).byTeacher).toEqual([{ teacherId: B, count: 0, attended: 0, total: 2 }]);
  });
  test("group work that is not confirmed adds 0: a PENDING ECA hour is listed at 0, ATTENDED / NO_SHOW group work counts", () => {
    expect(total([row("PENDING", "OTHER")])).toEqual({ teacherId: A, count: 0, attended: 0, total: 0 });
    expect(total([row("ATTENDED", "GROUP"), row("NO_SHOW", "OTHER")])!.total).toBe(2);
  });
  test("a group's SEATS never count (they are COURSE_PACKAGE rows under the group row — the service never hands them over, and the group hour is the coach's only +1)", () => {
    expect(total([row("CONFIRMED", "GROUP")])!.total).toBe(1);
  });
});

describe("🔴 TASK-748 — the whole day, and what did not move", () => {
  test("Palm §8's day: total = 4 confirmed lessons + 2 ECA + 3 camp = 9 (the pending / leave / paused / cancelled ones are out)", () => {
    const rows = [
      row("CONFIRMED", "COURSE_PACKAGE"), row("CONFIRMED", "FIRST_TRIAL"), row("ATTENDED", "COURSE_PACKAGE"), row("ATTENDED", "VOUCHER"),
      row("PENDING", "SINGLE_SESSION"), row("SICK_LEAVE", "COURSE_PACKAGE"), row("CANCELLED", "SINGLE_SESSION"), row("PAUSED", "SINGLE_SESSION"),
      ...times(2, () => row("CONFIRMED", "OTHER")), ...times(3, () => row("CONFIRMED", "OTHER")),
    ];
    expect(total(rows)).toEqual({ teacherId: A, count: 4, attended: 2, total: 9 });
  });
  test("relation over many shapes: total = count + the confirmed non-lesson rows (and the other counters do not move)", () => {
    const statuses = ["PENDING", "CONFIRMED", "ATTENDED", "SICK_LEAVE", "NO_SHOW", "EXTENDED", "PAUSED", "CANCELLED"];
    const types = ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER", "OTHER", "GROUP"];
    for (let seed = 1; seed <= 40; seed++) {
      const rows: ReportRow[] = [];
      for (let i = 0; i < 14; i++) rows.push(row(statuses[(seed * 7 + i * 3) % statuses.length]!, types[(seed + i * 5) % types.length]!, i % 3 === 0 ? B : A));
      const r = countDaily(rows);
      for (const t of r.byTeacher) {
        const mine = rows.filter((x) => x.coachIds.includes(t.teacherId));
        const work = mine.filter((x) => (x.bookingType === "OTHER" || x.bookingType === "GROUP") && CONFIRMED_STATUSES.has(x.status)).length;
        expect(t.total).toBe(t.count + work);
      }
    }
  });
  test("the order follows the new total (desc), then count, then id", () => {
    const rows = [...times(3, () => row("CONFIRMED", "OTHER", B)), ...times(5, () => row("SICK_LEAVE", "COURSE_PACKAGE", A)), row("CONFIRMED", "COURSE_PACKAGE", A)];
    expect(countDaily(rows).byTeacher.map((t) => [t.teacherId, t.total])).toEqual([[B, 3], [A, 1]]); // A has 6 rows but 1 confirmed hour
  });
});
