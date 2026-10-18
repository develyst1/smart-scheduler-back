// 🔻 TASK-743 (REQ-124 3/3) — `GET /reports/daily` gains `kidsByProgram` («Others Program», Palm §10). No database: the pure counters by value (Palm §10.5 is the test base), the service's READ through
// fake db, the route through the real Hono app.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { PROGRAMS, PROGRAM_EXCLUDED_STATUSES, SEAT_NOT_A_KID_STATUSES, KIDS_ONCE_PER_CLASS, classesOf, kidsByProgram, type CampKids, type ProgramRow } from "./daily-report";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const dailySvc = await import("../services/daily-report.service");
const campSvc = await import("../services/camp.service");
const { api } = await import("../routes/api");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const D = "2026-10-12";
const eca = (title: string, headCount: number | null, startTime: string, o: Partial<ProgramRow> = {}): ProgramRow => ({
  status: "CONFIRMED", bookingType: "OTHER", otherKind: "ECA", title, headCount, teacherId: A, coachIds: [A], date: D, startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`, ...o,
});
const group = (title: string, seats: string[] | null, o: Partial<ProgramRow> = {}): ProgramRow => ({ status: "CONFIRMED", bookingType: "GROUP", otherKind: "GROUP", title, headCount: 12, teacherId: A, coachIds: [A], date: D, startTime: "10:00", endTime: "11:00", seatStatuses: seats, ...o });
const camp = (hour: string, weekId: string | null, o: Partial<ProgramRow> = {}): ProgramRow => ({ status: "CONFIRMED", bookingType: "OTHER", otherKind: "CAMP", title: "Summer", headCount: null, teacherId: A, coachIds: [A], date: D, startTime: hour, endTime: `${String(Number(hour.slice(0, 2)) + 1).padStart(2, "0")}:00`, campWeekId: weekId, ...o });
const other = (title: string, headCount: number | null, o: Partial<ProgramRow> = {}): ProgramRow => ({ status: "CONFIRMED", bookingType: "OTHER", otherKind: "FREE", title, headCount, teacherId: A, coachIds: [A], date: D, startTime: "15:00", endTime: "16:00", ...o });
const block = (rows: ProgramRow[], program: string, opts: Parameters<typeof kidsByProgram>[1] = {}) => kidsByProgram(rows, opts).find((b) => b.program === program)!;

describe("🔒 TASK-743 — the declared defaults", () => {
  test("D1 = ONCE PER CLASS (Porter 10-18) is ONE switch; the 4 programs are fixed and ordered", () => {
    expect(KIDS_ONCE_PER_CLASS).toBe(true);
    expect([...PROGRAMS]).toEqual(["GROUP", "ECA", "CAMP", "OTHER"]);
    expect([...PROGRAM_EXCLUDED_STATUSES].sort()).toEqual(["CANCELLED", "PAUSED"]);
    expect([...SEAT_NOT_A_KID_STATUSES].sort()).toEqual(["CANCELLED", "PAUSED", "SICK_LEAVE"]);
  });
});

describe("🔴 TASK-743 — Palm §10.5, by value", () => {
  test("ECA «STA» two rounds (5 + 6) + «ISB» 8 ⇒ total 19, items [STA 11, ISB 8] (K1: the same name merges)", () => {
    const rows = [eca("STA", 5, "09:00"), eca("STA", 6, "14:00"), eca("ISB", 8, "11:00")];
    expect(block(rows, "ECA")).toEqual({ program: "ECA", total: 19, items: [{ name: "STA", kids: 11 }, { name: "ISB", kids: 8 }] });
  });
  test("a camp of 5 hours with 8 kids ⇒ 8, not 40 (once per camp WEEK, never per hour row)", () => {
    const rows = ["09:00", "10:00", "11:00", "13:00", "14:00"].map((h) => camp(h, "w1"));
    expect(block(rows, "CAMP", { camp: { w1: { name: "Summer", kids: 8 } } })).toEqual({ program: "CAMP", total: 8, items: [{ name: "Summer", kids: 8 }] });
  });
  test("an ECA with 2 coaches counts ONCE; `teacherId` = the 2nd coach still sees it, and a coach who is not on it does not", () => {
    const rows = [eca("STA", 5, "09:00", { coachIds: [A, B] })];
    expect(block(rows, "ECA").total).toBe(5);
    expect(block(rows, "ECA", { teacherId: B })).toEqual({ program: "ECA", total: 5, items: [{ name: "STA", kids: 5 }] });
    expect(block(rows, "ECA", { teacherId: "someone-else" })).toEqual({ program: "ECA", total: null, items: [] });
  });
  test("OTHER with no head count ⇒ kids null (never 0); total null when every item is null; `null + n = n`", () => {
    expect(block([other("Birthday", null)], "OTHER")).toEqual({ program: "OTHER", total: null, items: [{ name: "Birthday", kids: null }] });
    expect(block([other("Birthday", 8), other("Rent park", null)], "OTHER")).toEqual({ program: "OTHER", total: 8, items: [{ name: "Birthday", kids: 8 }, { name: "Rent park", kids: null }] });
    expect(block([other("Rent park", 2)], "OTHER").total).toBe(2);
  });
  test("no camp ⇒ still `{CAMP, null, []}` — the 4 programs are ALWAYS there, in order", () => {
    const all = kidsByProgram([]);
    expect(all.map((b) => b.program)).toEqual(["GROUP", "ECA", "CAMP", "OTHER"]);
    for (const b of all) expect(b).toEqual({ program: b.program, total: null, items: [] });
    expect(block([eca("STA", 5, "09:00")], "CAMP")).toEqual({ program: "CAMP", total: null, items: [] });
  });
  test("a GROUP with 4 seats, 1 cancelled ⇒ 3 (the kids are the SEATS, never `headCount` — that is the cap)", () => {
    expect(block([group("Balance Play", ["CONFIRMED", "ATTENDED", "PENDING", "CANCELLED"])], "GROUP")).toEqual({ program: "GROUP", total: 3, items: [{ name: "Balance Play", kids: 3 }] });
  });
});

describe("🔴 TASK-743 — the rules in detail", () => {
  test("GROUP: SICK_LEAVE and PAUSED seats are not kids; delivered seats (ATTENDED / NO_SHOW) are; no seat data ⇒ null, but all-cancelled ⇒ 0", () => {
    expect(block([group("G", ["ATTENDED", "NO_SHOW", "SICK_LEAVE", "PAUSED", "CONFIRMED"])], "GROUP").total).toBe(3);
    expect(block([group("G", null)], "GROUP").items).toEqual([{ name: "G", kids: null }]);
    expect(block([group("G", [])], "GROUP").items).toEqual([{ name: "G", kids: null }]);
    expect(block([group("G", ["CANCELLED", "CANCELLED"])], "GROUP").items).toEqual([{ name: "G", kids: 0 }]);
  });
  test("a CANCELLED or PAUSED row is out of every program; PENDING counts", () => {
    const rows = [eca("STA", 5, "09:00", { status: "CANCELLED" }), eca("ISB", 4, "10:00", { status: "PAUSED" }), eca("KIS", 3, "11:00", { status: "PENDING" }), group("G", ["CONFIRMED"], { status: "CANCELLED" })];
    const out = kidsByProgram(rows);
    expect(out.find((b) => b.program === "ECA")!.items).toEqual([{ name: "KIS", kids: 3 }]);
    expect(out.find((b) => b.program === "GROUP")!.items).toEqual([]);
  });
  test("the program of an OTHER row: ECA by its kind; CAMP by kind or by its week; FREE / KOL / none ⇒ OTHER; a lesson is in none", () => {
    const rows: ProgramRow[] = [
      eca("STA", 1, "09:00"), camp("09:00", "w1"), camp("11:00", null, { title: "Loose camp" }), camp("10:00", null, { otherKind: null, campWeekId: "w2", title: "Spring" }),
      other("A", 2), other("B", 3, { otherKind: "KOL" }), other("C", 4, { otherKind: null }),
      { status: "CONFIRMED", bookingType: "COURSE_PACKAGE", coachIds: [A] },
    ];
    const out = kidsByProgram(rows, { camp: { w1: { name: "Summer", kids: 6 }, w2: { name: "Spring", kids: 7 } } });
    expect(out.map((b) => [b.program, b.total])).toEqual([["GROUP", null], ["ECA", 1], ["CAMP", 13], ["OTHER", 9]]);
    expect(out.find((b) => b.program === "CAMP")!.items).toEqual([{ name: "Spring", kids: 7 }, { name: "Summer", kids: 6 }, { name: "Loose camp", kids: null }]); // a CAMP-kind row with no week is still a camp item, kids not recorded
    expect(out.find((b) => b.program === "OTHER")!.items.map((i) => i.name)).toEqual(["C", "B", "A"]);
  });
  test("two camp weeks on one date are TWO items (one per week); a week with no count ⇒ null; the week's name beats the row title", () => {
    const rows = [camp("09:00", "w1"), camp("10:00", "w1"), camp("09:00", "w2", { title: "ignored" }), camp("09:00", "w3", { title: "Autumn" })];
    const c: CampKids = { w1: { name: "Summer", kids: 8 }, w2: { name: "Winter", kids: 3 } };
    expect(block(rows, "CAMP", { camp: c })).toEqual({ program: "CAMP", total: 11, items: [{ name: "Summer", kids: 8 }, { name: "Winter", kids: 3 }, { name: "Autumn", kids: null }] });
  });
  test("🔴 TEST-109 F2 — a camp week with kids but NO coach (no hour row) is still an item; under a coach filter it is not shown; a week WITH a coach counts once; a week with 0 kids and no row stays out", () => {
    const weeks: CampKids = { w1: { name: "Camp 12-13 Oct", kids: 3 }, w2: { name: "Camp coached", kids: 8 }, w3: { name: "Empty week", kids: 0 } };
    const rows = [camp("09:00", "w2"), camp("10:00", "w2")];
    expect(block(rows, "CAMP", { camp: weeks })).toEqual({ program: "CAMP", total: 11, items: [{ name: "Camp coached", kids: 8 }, { name: "Camp 12-13 Oct", kids: 3 }] });
    expect(block([], "CAMP", { camp: weeks })).toEqual({ program: "CAMP", total: 11, items: [{ name: "Camp coached", kids: 8 }, { name: "Camp 12-13 Oct", kids: 3 }] }); // no camp row at all
    expect(block(rows, "CAMP", { camp: weeks, teacherId: A })).toEqual({ program: "CAMP", total: 8, items: [{ name: "Camp coached", kids: 8 }] }); // the coach-less week belongs to no coach
    expect(block(rows, "CAMP", { camp: weeks, teacherId: B })).toEqual({ program: "CAMP", total: null, items: [] });
    expect(block([camp("09:00", "w3")], "CAMP", { camp: weeks }).items).toEqual([{ name: "Camp coached", kids: 8 }, { name: "Camp 12-13 Oct", kids: 3 }, { name: "Empty week", kids: 0 }]); // a week WITH a row and 0 kids is shown as today (0); the rowless 0-kid ones are not
  });
  test("🔒 D1 — a 2-hour ECA with 5 kids is 5, not 10; two SEPARATE rounds still add; a different coach / date / gap is another class", () => {
    const twoHours = [eca("STA", 5, "09:00"), eca("STA", 5, "10:00")];
    expect(block(twoHours, "ECA").total).toBe(5);
    expect(block(twoHours, "ECA", { oncePerClass: false }).total).toBe(10); // Palm's literal per-row sum — the switch's other side
    expect(block([eca("STA", 5, "09:00"), eca("STA", 6, "13:00")], "ECA").total).toBe(11); // a gap ⇒ two rounds
    expect(block([eca("STA", 5, "09:00"), eca("STA", 5, "10:00", { teacherId: B, coachIds: [B] })], "ECA").total).toBe(10); // two coaches ⇒ two classes
    expect(block([eca("STA", 5, "09:00"), eca("STA", 5, "10:00", { date: "2026-10-13" })], "ECA").total).toBe(10);
    expect(block([eca("STA", 5, "09:00"), eca("STA", 5, "10:00"), eca("STA", 5, "11:00")], "ECA").total).toBe(5); // a 3-hour class
    expect(block([eca("STA", null, "09:00"), eca("STA", 5, "10:00")], "ECA").total).toBe(5); // the first RECORDED number
    expect(block([eca("STA", 5, "09:00", { seriesKey: "s1" }), eca("STA", 5, "10:00", { seriesKey: "s2" })], "ECA").total).toBe(10); // another series
    expect(classesOf([eca("STA", 5, "09:00"), eca("STA", 5, "10:00")], true)).toEqual([{ name: "STA", kids: 5 }]);
  });
  test("order: kids descending (not recorded last), then name; names are merged after trimming", () => {
    const rows = [other("b ", 1), other("b", 2), other("a", 3), other("z", null)];
    expect(block(rows, "OTHER").items).toEqual([{ name: "a", kids: 3 }, { name: "b", kids: 3 }, { name: "z", kids: null }]);
  });
  test("a row with no title falls back to its kind, never a blank name", () => {
    expect(block([eca("", 2, "09:00"), other("  ", 1, { otherKind: null })], "ECA").items).toEqual([{ name: "ECA", kids: 2 }]);
    expect(block([other("  ", 1, { otherKind: null })], "OTHER").items).toEqual([{ name: "OTHER", kids: 1 }]);
  });
});

describe("🔴 TASK-743 — the READ (service) through fake db, and the route", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterAll(() => { for (const s of spies) s.mockRestore(); });
  const row = (o: any = {}) => ({ id: "x", date: D, pendingSlot: false, groupId: null, status: "CONFIRMED", bookingType: "OTHER", teacherId: A, startTime: "09:00:00", endTime: "10:00:00", otherKind: "ECA", otherTitle: "STA", headCount: 5, otherSeriesKey: null, additionalTeachers: [], seats: [], campWeekDay: null, ...o });
  const run = async (rows: any[], teacherId?: string, weeks: any[] = []) => {
    const find = spyOn(db.query.bookings, "findMany").mockImplementation((async (q: any) => {
      const col = (name: string) => ({ __col: name });
      const ops = { and: (...p: Array<(r: any) => boolean>) => (r: any) => p.every((f) => f(r)), eq: (c: any, val: unknown) => (r: any) => r[c.__col] === val, isNull: (c: any) => (r: any) => r[c.__col] == null };
      return rows.filter(q.where(new Proxy({}, { get: (_t, k: string) => col(k) }), ops));
    }) as any);
    const wk = spyOn(campSvc, "weeksForCalendar").mockImplementation((async () => weeks) as any);
    try { return { r: await dailySvc.getDailyReportContract(D, teacherId), weeksCalls: wk.mock.calls.length }; } finally { find.mockRestore(); wk.mockRestore(); }
  };
  test("the rows → the section: an ECA with 2 coaches (booking_teachers) counts once; a GROUP's seats come from its seat rows; seats / pending_slot rows are not rows of the day", async () => {
    const G = "g1";
    const { r } = await run([
      row({ id: "e1", additionalTeachers: [{ teacherId: B }] }),
      row({ id: G, bookingType: "GROUP", otherKind: "GROUP", otherTitle: "Balance Play", headCount: 12, seats: [{ status: "CONFIRMED" }, { status: "CANCELLED" }, { status: "ATTENDED" }] }),
      row({ id: "s1", groupId: G, bookingType: "COURSE_PACKAGE" }), // a seat: never a row of the day
      row({ id: "p1", pendingSlot: true, otherTitle: "ghost" }),
    ]);
    expect(r.kidsByProgram.find((b) => b.program === "ECA")).toEqual({ program: "ECA", total: 5, items: [{ name: "STA", kids: 5 }] });
    expect(r.kidsByProgram.find((b) => b.program === "GROUP")).toEqual({ program: "GROUP", total: 2, items: [{ name: "Balance Play", kids: 2 }] });
    expect((await run([row({ additionalTeachers: [{ teacherId: B }] })], B)).r.kidsByProgram.find((b) => b.program === "ECA")!.total).toBe(5);
    expect((await run([row({ additionalTeachers: [{ teacherId: B }] })], "zzz")).r.kidsByProgram.find((b) => b.program === "ECA")!.total).toBeNull();
  });
  test("the camp week's kid count of the DATE comes from the calendar's own number (`weeksForCalendar`), read EVERY time (a coach-less week has no row to point at it)", async () => {
    const hours = ["09:00:00", "10:00:00", "11:00:00"].map((t, i) => row({ id: `c${i}`, otherKind: "CAMP", otherTitle: "Summer", headCount: null, startTime: t, campWeekDay: { campWeekId: "w1" } }));
    const withCamp = await run(hours, undefined, [{ id: "w1", name: "Summer camp", dayCounts: { [D]: 8, "2026-10-13": 2 } }]);
    expect(withCamp.r.kidsByProgram.find((b) => b.program === "CAMP")).toEqual({ program: "CAMP", total: 8, items: [{ name: "Summer camp", kids: 8 }] });
    expect(withCamp.weeksCalls).toBe(1);
    const noRow = await run([row()], undefined, [{ id: "w9", name: "Camp 19 - 23 Oct", dayCounts: { [D]: 2 } }, { id: "w8", name: "Empty", dayCounts: { [D]: 0 } }]);
    expect(noRow.weeksCalls).toBe(1); // F2: read even though no camp row exists
    expect(noRow.r.kidsByProgram.find((b) => b.program === "CAMP")).toEqual({ program: "CAMP", total: 2, items: [{ name: "Camp 19 - 23 Oct", kids: 2 }] });
  });
  test("the response keeps every 737 field and adds `kidsByProgram`", async () => {
    const { r } = await run([row({ bookingType: "COURSE_PACKAGE", status: "ATTENDED", otherKind: null })]);
    expect(r).toMatchObject({ date: D, attended: 1, confirmed: 1 });
    expect(r.kidsByProgram.map((b) => b.program)).toEqual(["GROUP", "ECA", "CAMP", "OTHER"]);
  });
  test("`GET /reports/daily` returns it through the route", async () => {
    spies.push(spyOn(dailySvc, "getDailyReportContract").mockImplementation((async () => ({ date: D, kidsByProgram: kidsByProgram([eca("STA", 5, "09:00")]) })) as any));
    const res = await api.request(`/reports/daily?date=${D}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).kidsByProgram[1]).toEqual({ program: "ECA", total: 5, items: [{ name: "STA", kids: 5 }] });
  });
});
