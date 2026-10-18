// 🔻 TASK-737 (REQ-119) — `GET /api/reports/daily` serves Palm's contract. No database: the pure counters by value (Palm §8 is the test base), the service's READ through a fake `db.query`
// that EVALUATES the real `where` callback, and the route through the real Hono app with the service spied.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LESSON_TYPES, TOTAL_BOOKED_INCLUDES_PENDING, countDaily, type ReportRow } from "./daily-report";
import * as v from "../validation";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const dailySvc = await import("../services/daily-report.service");
const campSvc = await import("../services/camp.service");
const { api } = await import("../routes/api");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = (status: string, bookingType: string, ...coachIds: string[]): ReportRow => ({ status, bookingType, coachIds: coachIds.length ? coachIds : [A] });

/** Palm §8: ONE day, coach A. Lesson rows CONFIRMED×2, ATTENDED×2, PENDING×1, SICK_LEAVE×1, CANCELLED×1 + a PAUSED SINGLE_SESSION + ECA (OTHER) ×2 + CAMP ×3 (OTHER, coach A). */
const PALM: ReportRow[] = [
  row("CONFIRMED", "COURSE_PACKAGE"), row("CONFIRMED", "FIRST_TRIAL"),
  row("ATTENDED", "COURSE_PACKAGE"), row("ATTENDED", "VOUCHER"),
  row("PENDING", "SINGLE_SESSION"),
  row("SICK_LEAVE", "COURSE_PACKAGE"),
  row("CANCELLED", "SINGLE_SESSION"),
  row("PAUSED", "SINGLE_SESSION"),
  row("CONFIRMED", "OTHER"), row("CONFIRMED", "OTHER"), // ECA
  row("CONFIRMED", "OTHER"), row("CONFIRMED", "OTHER"), row("CONFIRMED", "OTHER"), // CAMP hour rows
];

describe("🔴 TASK-737 — Palm §8, by value", () => {
  const r = countDaily(PALM, { includePending: true });
  test("the seven cards: attended 2 · confirmed 4 · pending 1 · awaiting 1 · onLeave 1 · cancelled 1", () => {
    expect([r.attended, r.confirmed, r.pending, r.awaiting, r.onLeave, r.cancelled]).toEqual([2, 4, 1, 1, 1, 1]);
  });
  test("🔒 totalBooked BOTH ways: Palm's default (every booked lesson: 6) and the Excel (confirmed + onLeave: 5); the attendance circle follows", () => {
    expect(countDaily(PALM, { includePending: true }).totalBooked).toBe(6);
    expect(countDaily(PALM, { includePending: false }).totalBooked).toBe(5);
    expect(countDaily(PALM, { includePending: true }).attendanceRate).toBe(33); // round(2 / 6 × 100)
    expect(countDaily(PALM, { includePending: false }).attendanceRate).toBe(40); // round(2 / 5 × 100)
    expect(countDaily([], {}).attendanceRate).toBe(0); // no division by zero
  });
  test("🔒 the switch is RULED (Khwan, 2026-10-13, option A): Total booked = Confirmed + On leave — and the DEFAULT path (no option passed) says so, with the % from it", () => {
    expect(TOTAL_BOOKED_INCLUDES_PENDING).toBe(false);
    const d = countDaily(PALM); // no `includePending` passed
    expect(d.totalBooked).toBe(d.confirmed + d.onLeave); // 4 + 1
    expect(d.totalBooked).toBe(5);
    expect(d.attendanceRate).toBe(40); // round(2 / 5 × 100)
    expect(d.pending).toBe(1); // the pending class is on its own card, not in Total booked
  });
  test("byTeacher[A]: count 4 · attended 2 · total = 6 lessons not cancelled/paused + 2 ECA + 3 CAMP = 11", () => {
    expect(r.byTeacher).toEqual([{ teacherId: A, count: 4, attended: 2, total: 11 }]);
  });
  test("byBookingTypeAttended / Confirmed: all four types, fixed order, zeros kept; each row sums to attended / confirmed", () => {
    expect(r.byBookingTypeAttended).toEqual([{ type: "FIRST_TRIAL", count: 0 }, { type: "SINGLE_SESSION", count: 0 }, { type: "COURSE_PACKAGE", count: 1 }, { type: "VOUCHER", count: 1 }]);
    expect(r.byBookingTypeConfirmed).toEqual([{ type: "FIRST_TRIAL", count: 1 }, { type: "SINGLE_SESSION", count: 0 }, { type: "COURSE_PACKAGE", count: 2 }, { type: "VOUCHER", count: 1 }]);
    expect(r.byBookingTypeAttended.map((x) => x.type)).toEqual([...LESSON_TYPES]);
    expect(r.byBookingTypeAttended.reduce((s, x) => s + x.count, 0)).toBe(r.attended);
    expect(r.byBookingTypeConfirmed.reduce((s, x) => s + x.count, 0)).toBe(r.confirmed);
  });
  test("the response is integers only, with Palm §5's names (plus the legacy noShow / byBookingType)", () => {
    expect(Object.keys(r).sort()).toEqual(["attendanceRate", "attended", "awaiting", "byBookingType", "byBookingTypeAttended", "byBookingTypeConfirmed", "byTeacher", "cancelled", "confirmed", "noShow", "onLeave", "pending", "totalBooked"]);
    for (const k of ["totalBooked", "attended", "confirmed", "pending", "awaiting", "onLeave", "cancelled", "attendanceRate", "noShow"] as const) expect(Number.isInteger(r[k])).toBe(true);
  });
});

describe("🔴 TASK-737 — Palm's temporary choices (Q1/Q2/Q4/Q5), one by one", () => {
  test("Q1 NO_SHOW counts as Confirmed (and is not Attended)", () => {
    const x = countDaily([row("NO_SHOW", "COURSE_PACKAGE")]);
    expect([x.confirmed, x.attended, x.noShow]).toEqual([1, 0, 1]);
  });
  test("Q2 EXTENDED counts as Pending", () => {
    expect(countDaily([row("EXTENDED", "COURSE_PACKAGE")]).pending).toBe(1);
  });
  test("Q4 Awaiting = a PAUSED 1st-trial / 1-hour class ONLY (a paused VOUCHER session / course session appears on no card)", () => {
    const x = countDaily([row("PAUSED", "FIRST_TRIAL"), row("PAUSED", "SINGLE_SESSION"), row("PAUSED", "VOUCHER"), row("PAUSED", "COURSE_PACKAGE")]);
    expect([x.awaiting, x.totalBooked, x.pending, x.confirmed]).toEqual([2, 0, 0, 0]);
  });
  test("Q5 PAUSED is NOT in Total booked; CANCELLED is not either", () => {
    expect(countDaily([row("PAUSED", "SINGLE_SESSION"), row("CANCELLED", "SINGLE_SESSION"), row("CONFIRMED", "SINGLE_SESSION")]).totalBooked).toBe(1);
  });
  test("a SICK_LEAVE sharing a slot with its replacement: BOTH are counted (onLeave 1, the replacement in confirmed)", () => {
    const x = countDaily([row("SICK_LEAVE", "COURSE_PACKAGE"), row("CONFIRMED", "COURSE_PACKAGE")]);
    expect([x.onLeave, x.confirmed, x.totalBooked]).toEqual([1, 1, 2]);
  });
});

describe("🔴 TASK-737 — the coach filter and the workload (what only the back can do)", () => {
  test("?teacherId filters EVERY counter, incl. onLeave / cancelled / awaiting; byTeacher lists only that coach", () => {
    const rows = [row("ATTENDED", "COURSE_PACKAGE", A), row("SICK_LEAVE", "COURSE_PACKAGE", B), row("CANCELLED", "SINGLE_SESSION", B), row("PAUSED", "SINGLE_SESSION", B), row("CONFIRMED", "VOUCHER", B)];
    const x = countDaily(rows, { teacherId: B });
    expect([x.attended, x.onLeave, x.cancelled, x.awaiting, x.confirmed, x.totalBooked]).toEqual([0, 1, 1, 1, 1, 2]);
    expect(x.byTeacher).toEqual([{ teacherId: B, count: 1, attended: 0, total: 2 }]);
    const y = countDaily(rows, { teacherId: A });
    expect([y.attended, y.onLeave, y.cancelled, y.awaiting]).toEqual([1, 0, 0, 0]);
  });
  test("an ECA with coaches A + B counts for BOTH (total +1 each); filtering A still sees it", () => {
    const rows = [row("CONFIRMED", "OTHER", A, B)];
    expect(countDaily(rows).byTeacher.map((t) => [t.teacherId, t.total, t.count, t.attended])).toEqual([[A, 1, 0, 0], [B, 1, 0, 0]]);
    expect(countDaily(rows, { teacherId: A }).byTeacher).toEqual([{ teacherId: A, count: 0, attended: 0, total: 1 }]);
  });
  test("a coach with group work only appears (0 / 0 / N); a GROUP row is ONE per coach", () => {
    expect(countDaily([row("CONFIRMED", "GROUP", A), row("CONFIRMED", "GROUP", A)]).byTeacher).toEqual([{ teacherId: A, count: 0, attended: 0, total: 2 }]);
  });
  test("a cancelled / paused row adds nothing to the workload", () => {
    expect(countDaily([row("CANCELLED", "OTHER", A), row("PAUSED", "OTHER", A)]).byTeacher).toEqual([]);
  });
  test("the order: total desc, then count desc, then teacherId asc (the stable tie-break)", () => {
    const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const rows = [row("CONFIRMED", "OTHER", C), row("CONFIRMED", "OTHER", B), row("CONFIRMED", "COURSE_PACKAGE", A), row("CONFIRMED", "COURSE_PACKAGE", A), row("CONFIRMED", "OTHER", A), row("CONFIRMED", "COURSE_PACKAGE", B)];
    expect(countDaily(rows).byTeacher.map((t) => t.teacherId)).toEqual([A, B, C]); // A total 3 · B total 2 (count 1) · C total 1
    const tie = [row("CONFIRMED", "OTHER", C), row("CONFIRMED", "OTHER", B)];
    expect(countDaily(tie).byTeacher.map((t) => t.teacherId)).toEqual([B, C]); // equal everything ⇒ by id
  });
  test("§2 relations hold over many shapes: attended ≤ confirmed · leave ∉ confirmed · cancelled ∉ totalBooked · Σ byType = attended / confirmed", () => {
    const statuses = ["PENDING", "CONFIRMED", "ATTENDED", "SICK_LEAVE", "NO_SHOW", "EXTENDED", "PAUSED", "CANCELLED"];
    for (let seed = 1; seed <= 40; seed++) {
      const rows: ReportRow[] = [];
      for (let i = 0; i < 12; i++) rows.push(row(statuses[(seed * 7 + i * 3) % statuses.length]!, [...LESSON_TYPES, "OTHER", "GROUP"][(seed + i * 5) % 6]!, i % 3 === 0 ? B : A));
      for (const includePending of [true, false]) {
        const x = countDaily(rows, { includePending });
        expect(x.attended).toBeLessThanOrEqual(x.confirmed);
        expect(x.byBookingTypeAttended.reduce((s, t) => s + t.count, 0)).toBe(x.attended);
        expect(x.byBookingTypeConfirmed.reduce((s, t) => s + t.count, 0)).toBe(x.confirmed);
        const lessons = rows.filter((r) => (LESSON_TYPES as readonly string[]).includes(r.bookingType));
        expect(x.cancelled).toBe(lessons.filter((r) => r.status === "CANCELLED").length);
        expect(x.totalBooked).toBeLessThanOrEqual(lessons.filter((r) => r.status !== "CANCELLED").length);
        expect(lessons.filter((r) => r.status === "SICK_LEAVE").length).toBe(x.onLeave); // and none of them is in confirmed:
        expect(x.confirmed).toBe(lessons.filter((r) => ["CONFIRMED", "ATTENDED", "NO_SHOW"].includes(r.status)).length);
      }
    }
  });
});

/** A fake `db.query.bookings.findMany` that EVALUATES the real `where` callback with fake operators, over rows that carry their own date / pendingSlot / groupId / coaches. */
function fakeBookings(all: Array<{ id: string; date: string; pendingSlot: boolean; groupId: string | null; status: string; bookingType: string; teacherId: string; additionalTeachers: Array<{ teacherId: string }> }>) {
  const col = (name: string) => ({ __col: name });
  const ops = {
    and: (...p: Array<(r: any) => boolean>) => (r: any) => p.every((f) => f(r)),
    eq: (c: any, val: unknown) => (r: any) => r[c.__col] === val,
    isNull: (c: any) => (r: any) => r[c.__col] == null,
  };
  const b = new Proxy({}, { get: (_t, k: string) => col(k) });
  return async (q: any) => {
    const pred = q.where(b, ops);
    return all.filter(pred).map((r) => ({ status: r.status, bookingType: r.bookingType, teacherId: r.teacherId, additionalTeachers: r.additionalTeachers }));
  };
}

describe("🔴 TASK-737 — the READ (service): which rows, through the real `where`", () => {
  const D = "2026-10-12", Y = "2026-10-11";
  const mk = (o: Partial<{ id: string; date: string; pendingSlot: boolean; groupId: string | null; status: string; bookingType: string; teacherId: string; additionalTeachers: Array<{ teacherId: string }> }>) => ({ id: "x", date: D, pendingSlot: false, groupId: null, status: "CONFIRMED", bookingType: "COURSE_PACKAGE", teacherId: A, additionalTeachers: [], ...o });
  const run = async (rows: ReturnType<typeof mk>[], teacherId?: string) => {
    const spy = spyOn(db.query.bookings, "findMany").mockImplementation(fakeBookings(rows) as any);
    const camp = spyOn(campSvc, "weeksForCalendar").mockImplementation((async () => []) as any); // 🔻 743/F2: the day's camp weeks are always read — none here
    try { return await dailySvc.getDailyReportContract(D, teacherId); } finally { spy.mockRestore(); camp.mockRestore(); }
  };
  test("yesterday's PAUSED class is NOT today's Awaiting; today's is", async () => {
    expect((await run([mk({ status: "PAUSED", bookingType: "SINGLE_SESSION", date: Y })])).awaiting).toBe(0);
    expect((await run([mk({ status: "PAUSED", bookingType: "SINGLE_SESSION" })])).awaiting).toBe(1);
  });
  test("a pending_slot row is out of every counter", async () => {
    const r = await run([mk({ pendingSlot: true, status: "ATTENDED" }), mk({ status: "ATTENDED" })]);
    expect(r.attended).toBe(1);
  });
  test("a GROUP with 4 seats ⇒ the group row counts ONCE for its coach; the seats (group_id set) never count anywhere", async () => {
    const G = "gggggggg-gggg-4ggg-8ggg-gggggggggggg";
    const seats = [1, 2, 3, 4].map((i) => mk({ id: `s${i}`, groupId: G, status: "ATTENDED", bookingType: "COURSE_PACKAGE" }));
    const r = await run([mk({ id: G, bookingType: "GROUP" }), ...seats]);
    expect(r.byTeacher).toEqual([{ teacherId: A, count: 0, attended: 0, total: 1 }]);
    expect([r.attended, r.confirmed, r.totalBooked]).toEqual([0, 0, 0]);
  });
  test("the extra coaches come from `booking_teachers`: an ECA with A + B counts for both", async () => {
    const r = await run([mk({ bookingType: "OTHER", additionalTeachers: [{ teacherId: B }] })]);
    expect(r.byTeacher.map((t) => [t.teacherId, t.total])).toEqual([[A, 1], [B, 1]]);
    expect((await run([mk({ bookingType: "OTHER", additionalTeachers: [{ teacherId: B }] })], B)).byTeacher).toEqual([{ teacherId: B, count: 0, attended: 0, total: 1 }]);
  });
  test("the response carries the date and Palm's whole shape", async () => {
    const r = await run([mk({ status: "ATTENDED" })]);
    expect(r.date).toBe(D);
    expect(r).toMatchObject({ attended: 1, confirmed: 1, awaiting: 0 });
  });
});

describe("🔴 TASK-737 — the route and the old report", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterAll(() => { for (const s of spies) s.mockRestore(); });
  test("`GET /reports/daily?date=…&teacherId=…` reaches the new service with both; a non-uuid teacherId is a 400; no teacherId ⇒ undefined", async () => {
    const calls: unknown[][] = [];
    spies.push(spyOn(dailySvc, "getDailyReportContract").mockImplementation((async (...a: unknown[]) => { calls.push(a); return { ok: true }; }) as any));
    const ok = await api.request(`/reports/daily?date=2026-10-12&teacherId=${A}`);
    expect(ok.status).toBe(200);
    expect(calls[0]).toEqual(["2026-10-12", A]);
    await api.request("/reports/daily?date=2026-10-12");
    expect(calls[1]).toEqual(["2026-10-12", undefined]);
    expect((await api.request("/reports/daily?date=2026-10-12&teacherId=not-a-uuid")).status).toBe(400);
  });
  test("the validator accepts an optional uuid teacherId and still requires the date", () => {
    expect(v.reportQuery.safeParse({ date: "2026-10-12" }).success).toBe(true);
    expect(v.reportQuery.safeParse({ date: "2026-10-12", teacherId: A }).success).toBe(true);
    expect(v.reportQuery.safeParse({ teacherId: A }).success).toBe(false);
  });
  test("🚫 the OLD `getDailyReport` is BYTE-IDENTICAL (the SOM report + the day-end job read it) — pinned by its hash", () => {
    const S = readFileSync(resolve(import.meta.dir, "../services/scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
    const a = S.indexOf("export async function getDailyReport(");
    const text = S.slice(a, S.indexOf("// ───────────────────────────── Writes", a));
    expect(createHash("sha1").update(text).digest("hex")).toBe("2b7d62f69265d9d02b5fc37f9489511d79e82e9a");
    expect(readFileSync(resolve(import.meta.dir, "../services/som-report.service.ts"), "utf8")).toContain("getDailyReport(today)");
  });
});
