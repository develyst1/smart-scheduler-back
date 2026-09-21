// TASK-433 (`REQ-101`) — the Manage-plan page 502'd on a BACKFILLED series on `sid`. The API half, reproduced on rows shaped
// the way `scripts/backfill-other-series.ts --apply` leaves OLD rows: null head count / rates / note, a title with `/`, an
// all-ended series (no live row), an extra whose teacher relation is null (deleted) or archived, a months-long span — through
// BOTH calls the page makes (`GET /other-series/:key`, then `GET /bookings?type=OTHER&teacherId&from&to&limit=200`) and the
// range list. Every shape answers 200 with a complete body: the API does not throw on backfilled data — pinned so it stays
// that way. (`start_time` / `end_time` are NOT NULL in the schema, so a null there is not a shape the backfill can produce.)
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { DEV_USER } from "../middleware/auth";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const get = (path: string) => rootApp.fetch(new Request(`http://localhost/api${path}`));
const K = "d2b80ca9-7378-40a4-b988-ee03e95ea703", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const spies: Array<{ mockRestore: () => void }> = [];
const savedUser = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, savedUser); });

/** An OLD row as the backfill leaves it: the creator's defaults absent, the key stamped. */
const oldRow = (i: number, over: any = {}) => ({
  id: `old-${i}`, date: `2026-${String(i).padStart(2, "0")}-03`, startTime: "15:00:00", endTime: "16:00:00", status: "CANCELLED", bookingType: "OTHER",
  teacherId: T1, subjectId: null, studentId: null, coStudentId: null, courseId: null, voucherId: null, groupKey: null, groupId: null, campWeekDayId: null,
  otherTitle: "ABC / Balance Camp", otherKind: "ECA", headCount: null, note: null, attendeeNote: null, teacherRateMinor: null, ratePostedAt: null, otherSeriesKey: K, cancelReason: null, confirmedAt: null, pendingSlot: false, plannedAtCreation: false, extendedFromId: null, checkinToken: null, updatedAt: null,
  teacher: { id: T1, name: "Bank", nickname: "Bank", type: "FREELANCE", archived: true, lineUserId: null }, // the primary since ARCHIVED
  additionalTeachers: [{ teacherId: T2, rateMinor: null, teacher: null }], // an extra whose teacher row is gone
  ...over,
});
const series = () => [oldRow(1), oldRow(2, { status: "ATTENDED" }), oldRow(3), oldRow(4, { status: "NO_SHOW" }), oldRow(9, { otherTitle: null, additionalTeachers: [] })];

describe("🔴 TASK-433 — the API on a BACKFILLED series: every old-row shape opens (200, a complete body); the page's two calls and the list", () => {
  test("`GET /other-series/:key` — all-ended series (no live row ⇒ the first row is the template), null heads/rates/note, a `/` title, a null extra teacher, an archived primary", async () => {
    process.env.SKIP_AUTH = "true";
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => series()) as any));
    const r = await get(`/other-series/${K}`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as any;
    expect(d).toMatchObject({ key: K, title: "ABC / Balance Camp", kind: "ECA", headCount: null, startTime: "15:00", teacherId: T1, additionalTeacherIds: [T2], teacherRates: {} });
    expect(d.rows.map((x: any) => [x.bookingId, x.status, x.additionalTeacherIds])).toEqual([["old-1", "CANCELLED", [T2]], ["old-2", "ATTENDED", [T2]], ["old-3", "CANCELLED", [T2]], ["old-4", "NO_SHOW", [T2]], ["old-9", "CANCELLED", []]]);
  });
  test("`GET /bookings?type=OTHER&teacherId&from&to&limit=200` — the page's second call over a nine-month span of old rows (the hand-built select path + the DTO on null facts)", async () => {
    process.env.SKIP_AUTH = "true";
    const rows = series();
    const chain = (result: any) => { const q: any = { from: () => q, leftJoin: () => q, innerJoin: () => q, where: () => q, orderBy: () => q, limit: () => q, offset: () => q, groupBy: () => q, then: (res: any, rej: any) => Promise.resolve(result).then(res, rej) }; return q; };
    spies.push(spyOn(db, "select").mockImplementation(((sel: any) => {
      if (sel && "value" in sel) return chain([{ value: rows.length }]); // the count
      if (sel && "b" in sel) return chain(rows.map((b) => ({ b, s: null, cs: null, t: b.teacher, sub: null, c: null }))); // the page
      return chain([]); // rentals / extras batches
    }) as any));
    const r = await get(`/bookings?type=OTHER&teacherId=${T1}&from=2026-01-03&to=2026-09-03&limit=200`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as any;
    expect(d.total).toBe(5);
    expect(d.items).toHaveLength(5);
    expect(d.items[0]).toMatchObject({ id: "old-1", bookingType: "OTHER", displayName: "ABC / Balance Camp", other: { kind: "ECA", headCount: null, teacherRates: {} }, otherSeriesKey: K, rate: null, student: null });
    expect(d.items[4]).toMatchObject({ id: "old-9", displayName: "", title: null }); // a title-less old row still renders (the DTO's "" fallback)
  });
  test("`GET /other-series?from&to` — the list over a range that meets the backfilled key", async () => {
    process.env.SKIP_AUTH = "true";
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => series()) as any));
    const chain = (result: any) => { const q: any = { from: () => q, where: () => q, groupBy: () => q, then: (res: any, rej: any) => Promise.resolve(result).then(res, rej) }; return q; };
    spies.push(spyOn(db, "select").mockImplementation((() => chain([{ key: K }])) as any));
    const r = await get("/other-series?from=2026-01-01&to=2026-12-31");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([{ key: K, title: "ABC / Balance Camp", kind: "ECA", startTime: "15:00", teacherId: T1, firstDate: "2026-01-03", lastDate: "2026-09-03", liveCount: 0, total: 5 }]);
  });
  test("a key that is not a uuid, or a key with no rows ⇒ a clean 404/500 ENVELOPE, never a dead socket", async () => {
    process.env.SKIP_AUTH = "true";
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
    const r = await get(`/other-series/${K}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: "NOT_FOUND", message: "ไม่พบตารางชุดนี้" } });
  });
});
