// TASK-441 (`REQ-104 §2` items 1–3, SPEC-090 §1) — GROUP parity: the OTHER-series service serves a GROUP series by `{ groupKey }`
// through the SAME functions (one `seriesRows`, one cancel loop, one notifier — no copied function; a bare string key = the
// OTHER series, byte-identical), the DTO's `rows[].seats`, the cancel-all CASCADE by value (every live seat through the
// per-row path `cancelSeatsOfGroup` + `sendClassCancelledToFamilies`, the coach once with the group's name, ATTENDED kept),
// confirm-whole-group (`confirmCourse` per seated course, a refused one reported skipped), add dates as GROUP rows, the primary
// swap DELEGATED to `swapGroupTeacher`, the header PATCH without a kind, the nine routes under the OTHER twins' keys; and the
// Monday weekly coach digest (`weekly_schedule_teacher`, the 24th kind): the Mon–Sun window, per-teacher grouping (primary +
// additional, CONFIRMED only, a GROUP row one line), the owner's ENGLISH-ONLY bytes under BOTH langs, send-once, `job_runs`,
// the internal route + exe. No migration (53 = 53).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import { formatOutboxMessage } from "./line-message";
import { ROUTE_ACCESS } from "./route-access";
import { WEEKLY_DIGEST_JOB, WEEKLY_FOOTER, WEEKLY_GREETING, WEEKLY_TITLE, groupWeekRows, renderWeeklySchedule, weekOf, weeklyDigestKey } from "./weekly-digest";
import * as v from "../validation";
import * as sched from "../services/scheduler.service";
import * as series from "../services/other-series.service";
import * as jobs from "../services/jobs.service";
import * as lineLib from "./line";
import { db } from "../db";
import { bookings, jobRuns } from "../db/schema";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  rootApp.fetch(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
const SVC = code(src("src/services/other-series.service.ts"));
const K = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", T3 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const C1 = "11111111-1111-4111-8111-111111111111", C2 = "22222222-2222-4222-8222-222222222222";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; delete process.env.INTERNAL_JOB_SECRET; });

const seat = (id: string, name: string, courseId: string, status = "PENDING") => ({ id, studentId: `s-${id}`, status, courseId, student: { name, nickname: name }, coStudent: null, otherTitle: null });
const grow = (over: any = {}) => ({ id: `g-${over.date ?? "x"}`, date: "2026-10-05", startTime: "15:00:00", endTime: "16:00:00", status: "PENDING", bookingType: "GROUP", teacherId: T1, otherTitle: "Skate Kids", otherKind: "GROUP", headCount: 4, note: null, teacherRateMinor: 30000, additionalTeachers: [], teacher: { id: T1, nickname: "Ek", name: "Ek", lineUserId: "U1" }, seats: [], ...over });

/** A fake tx over the group's rows: records every write; the reads answer from `rows`. */
const fakeTx = (rows: any[]) => {
  const writes: any[] = [];
  const probes: any[] = [];
  const tx: any = {
    query: {
      bookings: {
        findMany: async ({ where }: any) => { const p: any[] = []; try { where({ otherSeriesKey: "osk", groupKey: "gk", bookingType: "t", groupId: "gid", id: "id" }, { and: (...a: any[]) => a, eq: (c: any, val: any) => { p.push([c, val]); return val; }, inArray: () => null, gte: () => null, lte: () => null }); } catch {} probes.push(p); return rows; },
        findFirst: async () => null,
      },
      teachers: { findMany: async ({ where }: any) => { const ids: string[] = []; where({ id: "id" }, { inArray: (_: any, val: string[]) => { ids.push(...val); return null; } }); return [{ id: T1, lineUserId: "U1" }, { id: T2, lineUserId: "U2" }, { id: T3, lineUserId: "U3" }].filter((t) => ids.includes(t.id)); }, findFirst: async () => null },
      boMovement: { findMany: async () => [] },
      boItem: { findMany: async () => [], findFirst: async () => null },
      appSettings: { findMany: async () => [], findFirst: async () => null },
    },
    insert: (table: any) => ({ values: (val: any) => { writes.push({ op: "insert", table: table === bookings ? "bookings" : "other", val }); const ret = { returning: async () => [{ id: `new-${val.date ?? writes.length}` }], onConflictDoNothing: async () => {} }; return Object.assign(Promise.resolve(), ret); } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: async () => { writes.push({ op: "update", table: table === bookings ? "bookings" : "other", patch }); } }) }),
    delete: () => ({ where: async () => { writes.push({ op: "delete" }); } }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  return { tx, writes, probes };
};

describe("🔴 ONE module, keyed — no copied function; the OTHER callers byte-identical; the seat path exported; 53 = 53", () => {
  test("`SeriesKey` names the column + the row type; a bare string = OTHER; ONE `seriesRows`, ONE cancel loop, ONE `notifySeriesTeachers`", () => {
    expect(SVC).toContain('export type SeriesKey = string | { otherSeriesKey: string } | { groupKey: string };');
    expect((SVC.match(/async function seriesRows\(/g) ?? []).length).toBe(1);
    expect((SVC.match(/async function notifySeriesTeachers\(/g) ?? []).length).toBe(1);
    expect((SVC.match(/export async function \w*Group\w*\(/g) ?? []).length).toBe(1); // only the delegating swap is group-shaped
    expect((SVC.match(/reconcileBookingHolds\(tx, r\.id, r\.teacherId, "CANCELLED", false\);/g) ?? []).length).toBe(1);
    expect(code(src("src/services/scheduler.service.ts"))).toContain("export async function cancelSeatsOfGroup(tx: any, groupId: string, note: string | null) {");
    expect(readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).length).toBe(53);
    expect(JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")).entries.length).toBe(53);
  });
  test("the existing seat path is what the cascade reuses: status + note + `reconcileCoursePlan`; the family sender per household per seat", () => {
    const C = region(code(src("src/services/scheduler.service.ts")), "export async function cancelSeatsOfGroup(", "\n}\n");
    expect(C).toContain('await tx.update(bookings).set({ status: "CANCELLED", note: note ?? s.note }).where(eq(bookings.id, s.id));');
    expect(C).toContain("if (s.courseId) await reconcileCoursePlan(tx, s.courseId);");
    expect(C).not.toContain("enqueueLine"); // a seat sends no teacher notice of its own
    const X = region(SVC, "export async function cancelAllOtherSeries(", "\n}\n");
    expect(X).toContain("seatsCancelled += await cancelSeatsOfGroup(tx, r.id, input.note?.trim() || null);");
    expect(X).toContain('familiesTold += await sendClassCancelledToFamilies(tx, { ...r, bookingType: "GROUP", seats: r.seats ?? undefined } as any, input.reasonCode);');
    expect(X.indexOf("cancelSeatsOfGroup")).toBeGreaterThan(X.indexOf('status: "CANCELLED", cancelReason: input.reasonCode')); // the row first, then its seats
    expect(X.indexOf('notifySeriesTeachers(tx, "other_series_cancelled"')).toBeGreaterThan(X.indexOf("sendClassCancelledToFamilies")); // the coach once, after the loop
  });
});

describe("🔴 the reads by VALUE — the group DTO carries seats; the OTHER DTO does not; the list by type", () => {
  test("`getOtherSeries({ groupKey })` reads `groupKey` + GROUP rows and adds `seats` (every status, the ONE name rule); a bare string reads OTHER and has no `seats` key", async () => {
    const rows = [grow({ date: "2026-10-05", seats: [seat("s1", "Aiwa", C1, "CONFIRMED"), seat("s2", "Bam", C2, "CANCELLED")] }), grow({ date: "2026-10-12", status: "CONFIRMED", seats: [seat("s3", "Aiwa", C1)] })];
    const probes: any[] = [];
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async ({ where, with: w }: any) => { const p: any[] = []; try { where({ otherSeriesKey: "osk", groupKey: "gk", bookingType: "t" }, { and: (...a: any[]) => a, eq: (c: any, val: any) => { p.push([c, val]); return val; } }); } catch {} probes.push({ p, w }); return rows; }) as any));
    const d = await series.getOtherSeries({ groupKey: K });
    expect(probes[0].p).toEqual([["gk", K], ["t", "GROUP"]]);
    expect(probes[0].w.seats).toEqual({ with: { student: true, coStudent: true } });
    expect(d.key).toBe(K);
    expect(d.title).toBe("Skate Kids");
    expect(d.rows[0]!.seats).toEqual([{ bookingId: "s1", studentId: "s-s1", displayName: "Aiwa", status: "CONFIRMED" }, { bookingId: "s2", studentId: "s-s2", displayName: "Bam", status: "CANCELLED" }]);
    expect(d.rows[1]!.seats).toEqual([{ bookingId: "s3", studentId: "s-s3", displayName: "Aiwa", status: "PENDING" }]);
    const o = await series.getOtherSeries(K);
    expect(probes[1].p).toEqual([["osk", K], ["t", "OTHER"]]);
    expect(probes[1].w.seats).toBeUndefined();
    expect(o.rows[0]).not.toHaveProperty("seats");
  });
  test("`listOtherSeries(range, \"GROUP\")` walks `group_key` GROUP rows", async () => {
    const chain = (result: any) => { const q: any = { from: () => q, where: () => q, groupBy: () => q, then: (res: any, rej: any) => Promise.resolve(result).then(res, rej) }; return q; };
    spies.push(spyOn(db, "select").mockImplementation((() => chain([{ key: K }])) as any));
    const probes: any[] = [];
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async ({ where }: any) => { const p: any[] = []; try { where({ otherSeriesKey: "osk", groupKey: "gk", bookingType: "t" }, { and: (...a: any[]) => a, eq: (c: any, val: any) => { p.push([c, val]); return val; } }); } catch {} probes.push(p); return [grow({ date: "2026-10-05" }), grow({ date: "2026-10-12", status: "ATTENDED" })]; }) as any));
    const out = await series.listOtherSeries({ from: "2026-10-01", to: "2026-10-31" }, "GROUP");
    expect(probes[0]).toEqual([["gk", K], ["t", "GROUP"]]);
    expect(out).toEqual([{ key: K, title: "Skate Kids", kind: "GROUP", startTime: "15:00", teacherId: T1, firstDate: "2026-10-05", lastDate: "2026-10-12", liveCount: 1, total: 2 }]);
    expect(SVC).toContain('const col = type === "GROUP" ? bookings.groupKey : bookings.otherSeriesKey;');
  });
});

describe("🔴 the doors by VALUE through a fake tx — the CASCADE, confirm-whole-group, add dates, the delegated swap, the header", () => {
  test("cancel-all on a group: every LIVE row CANCELLED + its seats through `cancelSeatsOfGroup` + each family; ATTENDED untouched; the coach ONCE per teacher with the group's name; the counts", async () => {
    const r1 = grow({ date: "2026-10-05", status: "CONFIRMED", seats: [seat("s1", "Aiwa", C1, "CONFIRMED"), seat("s2", "Bam", C2, "CONFIRMED")] });
    const r2 = grow({ date: "2026-10-12", status: "PENDING", seats: [seat("s3", "Aiwa", C1)], additionalTeachers: [{ teacherId: T2, rateMinor: null, teacher: { id: T2, lineUserId: "U2" } }] });
    const r3 = grow({ date: "2026-09-28", status: "ATTENDED", seats: [seat("s0", "Aiwa", C1, "ATTENDED")] });
    const f = fakeTx([r3, r1, r2]);
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(f.tx)) as any));
    const seatCalls: any[] = [], famCalls: any[] = [], notices: any[] = [];
    spies.push(spyOn(sched, "cancelSeatsOfGroup").mockImplementation((async (_tx: any, groupId: string, note: string | null) => { seatCalls.push([groupId, note]); return groupId === r1.id ? 2 : 1; }) as any));
    spies.push(spyOn(sched, "sendClassCancelledToFamilies").mockImplementation((async (_tx: any, current: any, reason: string) => { famCalls.push([current.id, current.bookingType, current.seats?.length, reason]); return current.status === "CONFIRMED" ? current.seats.length : 0; }) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { notices.push(o); return { status: "queued" } as any; }) as any));
    const out = await series.cancelAllOtherSeries({ groupKey: K }, { reasonCode: "ADMIN_ERROR", note: "wrong entry" }, "dev");
    expect(out).toEqual({ cancelled: 2, seatsCancelled: 3, familiesTold: 2 });
    expect(f.writes.filter((w) => w.op === "update").map((w) => w.patch)).toEqual([{ status: "CANCELLED", cancelReason: "ADMIN_ERROR", note: "wrong entry" }, { status: "CANCELLED", cancelReason: "ADMIN_ERROR", note: "wrong entry" }]);
    expect(seatCalls).toEqual([[r1.id, "wrong entry"], [r2.id, "wrong entry"]]); // the ATTENDED row's seats never touched
    expect(famCalls).toEqual([[r1.id, "GROUP", 2, "ADMIN_ERROR"], [r2.id, "GROUP", 1, "ADMIN_ERROR"]]);
    expect(notices).toHaveLength(2); // Ek (primary on both) + Ple (extra on r2) — once each
    for (const n of notices) expect(n.payload).toMatchObject({ kind: "other_series_cancelled", title: "Skate Kids", otherKind: "GROUP", dates: ["2026-10-05", "2026-10-12"], reason: "ADMIN_ERROR" });
    expect(notices.map((n) => n.recipientLineUserId).sort()).toEqual(["U1", "U2"]);
    expect(notices.every((n) => n.recipientType === "teacher")).toBe(true);
  });
  test("cancel-all on an OTHER series (a bare string) never touches seats or families — `{ cancelled }` as before", async () => {
    const f = fakeTx([{ ...grow({ date: "2026-10-05" }), bookingType: "OTHER", seats: undefined }]);
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(f.tx)) as any));
    const seatSpy = spyOn(sched, "cancelSeatsOfGroup").mockImplementation((async () => 9) as any); spies.push(seatSpy);
    const famSpy = spyOn(sched, "sendClassCancelledToFamilies").mockImplementation((async () => 9) as any); spies.push(famSpy);
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async () => ({ status: "queued" }) as any) as any));
    expect(await series.cancelAllOtherSeries(K, { reasonCode: "ADMIN_ERROR" }, "dev")).toEqual({ cancelled: 1 });
    expect(seatSpy).not.toHaveBeenCalled();
    expect(famSpy).not.toHaveBeenCalled();
  });
  test("confirm-whole-group: the group rows through `bulkConfirm`, every seated course ONCE through `confirmCourse`; a refused course is `skipped` with its reason, never thrown; OTHER's shape unchanged", async () => {
    const rows = [grow({ date: "2026-10-05", seats: [seat("s1", "Aiwa", C1), seat("s2", "Bam", C2)] }), grow({ date: "2026-10-12", status: "CONFIRMED", seats: [seat("s3", "Aiwa", C1), seat("s4", "Cat", C2, "CANCELLED")] })];
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
    const bulk: string[][] = [];
    spies.push(spyOn(sched, "bulkConfirm").mockImplementation((async (ids: string[]) => { bulk.push(ids); return { results: ids.map((id) => ({ id, outcome: "confirmed" })) }; }) as any));
    const confirmed: string[] = [];
    spies.push(spyOn(sched, "confirmCourse").mockImplementation((async (id: string) => { confirmed.push(id); if (id === C2) throw new ApiException(409, "COURSE_ENDED", "ended"); return { confirmed: 3 }; }) as any));
    const out = await series.confirmAllOtherSeries({ groupKey: K });
    expect(bulk).toEqual([["g-2026-10-05"]]);
    expect(confirmed).toEqual([C1, C2]); // C1 seated twice ⇒ once; C2's cancelled seat on r2 does not un-seat its live seat on r1
    expect(out).toEqual({ confirmed: 1, skipped: 0, results: [{ id: "g-2026-10-05", outcome: "confirmed" }], courses: 2, courseResults: [{ courseId: C1, outcome: "confirmed", confirmed: 3 }, { courseId: C2, outcome: "skipped", reason: "ended" }] });
    const other = await series.confirmAllOtherSeries(K);
    expect(other).not.toHaveProperty("courses");
    expect(confirmed).toEqual([C1, C2]); // the OTHER call confirmed no course
  });
  test("add dates on a group: a GROUP row under `groupKey`, the template's facts, NO seats, no `otherSeriesKey`; on OTHER: an OTHER row under `otherSeriesKey`", async () => {
    const inserts: any[] = [];
    spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _u: any, input: any) => { inserts.push(input); return `new-${input.date}`; }) as any));
    const f = fakeTx([grow({ date: "2026-10-05" })]);
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(f.tx)) as any));
    expect(await series.addDatesToOtherSeries({ groupKey: K }, { dates: ["2026-10-19"] })).toEqual({ created: 1, bookingIds: ["new-2026-10-19"] });
    expect(inserts[0]).toEqual({ teacherId: T1, subjectId: null, date: "2026-10-19", startTime: "15:00", bookingType: "GROUP", otherTitle: "Skate Kids", otherKind: "GROUP", headCount: 4, note: null, teacherRates: { [T1]: 30000 }, groupKey: K });
    expect(inserts[0]).not.toHaveProperty("otherSeriesKey");
    expect(inserts[0]).not.toHaveProperty("seats");
    const g = fakeTx([{ ...grow({ date: "2026-10-05" }), bookingType: "OTHER", otherKind: "ECA" }]);
    spies[spies.length - 1]!.mockRestore(); spies[spies.length - 1] = spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(g.tx)) as any);
    await series.addDatesToOtherSeries(K, { dates: ["2026-10-19"] });
    expect(inserts[1]).toMatchObject({ bookingType: "OTHER", otherSeriesKey: K });
    expect(inserts[1]).not.toHaveProperty("groupKey");
  });
  test("the group's primary swap DELEGATES to `swapGroupTeacher` from the first live row on/after `fromDate`; the same teacher ⇒ ALREADY_ON_ROW; the OTHER swap refuses a group key", async () => {
    const rows = [grow({ date: "2026-10-05", status: "ATTENDED" }), grow({ date: "2026-10-12" }), grow({ date: "2026-10-19", status: "CONFIRMED" })];
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
    const calls: any[] = [];
    spies.push(spyOn(sched, "swapGroupTeacher").mockImplementation((async (id: string, input: any) => { calls.push([id, input]); return { moved: 2, booking: {} }; }) as any));
    expect(await series.swapGroupSeriesTeacher({ groupKey: K }, { to: T2, fromDate: "2026-10-06" })).toEqual({ moved: 2 });
    expect(calls).toEqual([["g-2026-10-12", { teacherId: T2, fromHereOn: true }]]);
    expect(await series.swapGroupSeriesTeacher({ groupKey: K }, { to: T2, fromDate: "2026-10-19" })).toEqual({ moved: 2 });
    expect(calls[1]![0]).toBe("g-2026-10-19");
    await expect(series.swapGroupSeriesTeacher({ groupKey: K }, { to: T1, fromDate: "2026-10-06" })).rejects.toMatchObject({ code: "ALREADY_ON_ROW" });
    expect(await series.swapGroupSeriesTeacher({ groupKey: K }, { to: T2, fromDate: "2026-11-01" })).toEqual({ moved: 0 });
    await expect(series.swapOtherSeriesTeacher({ groupKey: K } as any, { from: T1, to: T2 })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(2);
    // the OTHER swap never moves seats — the reason the group delegates
    expect(region(SVC, "export async function swapOtherSeriesTeacher(", "\n}\n")).not.toContain("groupId");
    expect(region(code(src("src/services/scheduler.service.ts")), "export async function swapGroupTeacher(", "\n}\n")).toContain("await tx.update(bookings).set({ teacherId: input.teacherId }).where(and(eq(bookings.groupId, g.id), inArray(bookings.status, [...COURSE_LIVE_STATUSES])));");
  });
  test("the header PATCH on a group refuses a kind (400) — the validator carries no `otherKind`; title / heads / rates as OTHER", async () => {
    await expect(series.updateOtherSeries({ groupKey: K }, { otherKind: "ECA" })).rejects.toMatchObject({ status: 400 });
    expect(v.groupSeriesPatch.safeParse({ otherKind: "ECA" }).success).toBe(false); // stripped ⇒ "at least one field" fails
    expect(v.groupSeriesPatch.safeParse({ title: "Skate Kids 2", headCount: 6 }).success).toBe(true);
    expect(v.groupSeriesSwap.safeParse({ to: T2 }).success).toBe(true);
    expect(v.groupSeriesSwap.safeParse({ from: T1, to: T2 }).data).toEqual({ to: T2 }); // no `from`: one primary
    const f = fakeTx([grow({ date: "2026-10-05" }), grow({ date: "2026-10-12", status: "CANCELLED" })]);
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(f.tx)) as any));
    expect(await series.updateOtherSeries({ groupKey: K }, { title: "Skate Kids 2", headCount: 6 })).toEqual({ updated: 1 });
    expect(f.writes).toEqual([{ op: "update", table: "bookings", patch: { otherTitle: "Skate Kids 2", headCount: 6 } }]);
  });
});

describe("🔴 the routes — the OTHER twins' keys one-for-one (confirm-all = course-confirm, dates = group-series); through the ROOT app", () => {
  test("the access map", () => {
    const twin = (g: string, o: string) => expect(ROUTE_ACCESS[g]).toEqual(ROUTE_ACCESS[o]);
    twin("GET /group-series", "GET /other-series");
    twin("GET /group-series/:key", "GET /other-series/:key");
    twin("POST /group-series/:key/cancel-all", "POST /other-series/:key/cancel-all");
    twin("POST /group-series/:key/teachers", "POST /other-series/:key/teachers");
    twin("DELETE /group-series/:key/teachers/:teacherId", "DELETE /other-series/:key/teachers/:teacherId");
    twin("PATCH /group-series/:key/teacher", "PATCH /other-series/:key/teacher");
    twin("PATCH /group-series/:key", "PATCH /other-series/:key");
    expect(ROUTE_ACCESS["POST /group-series/:key/cancel-all"]).toMatchObject({ action: "action:calendar.other-cancel-all" }); // key 58
    expect(ROUTE_ACCESS["POST /group-series/:key/confirm-all"]).toEqual({ menus: ["menu:calendar"], action: "action:bookings.course-confirm" });
    expect(ROUTE_ACCESS["POST /group-series/:key/dates"]).toEqual({ menus: ["menu:calendar"], action: "action:calendar.group-series" });
  });
  test("the nine routes reach the ONE service with `{ groupKey }` (spied); no service function is group-only but the swap", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const spy = (name: keyof typeof series, ret: any) => spies.push(spyOn(series, name).mockImplementation((async (...a: any[]) => { calls.push([name, ...a]); return ret; }) as any));
    spy("listOtherSeries", []); spy("getOtherSeries", { key: K }); spy("confirmAllOtherSeries", { confirmed: 1, courses: 1 }); spy("cancelAllOtherSeries", { cancelled: 2, seatsCancelled: 3, familiesTold: 2 });
    spy("addTeacherToOtherSeries", { added: 2 }); spy("removeTeacherFromOtherSeries", { removed: 1 }); spy("swapGroupSeriesTeacher", { moved: 2 }); spy("addDatesToOtherSeries", { created: 1, bookingIds: ["x"] }); spy("updateOtherSeries", { updated: 2 });
    const api = (m: string, p: string, b?: unknown) => json(m, `/api${p}`, b);
    expect((await api("GET", "/group-series?from=2026-10-01&to=2026-10-31")).status).toBe(200);
    expect((await api("GET", `/group-series/${K}`)).status).toBe(200);
    expect((await api("POST", `/group-series/${K}/confirm-all`)).status).toBe(200);
    expect((await api("POST", `/group-series/${K}/cancel-all`, { reasonCode: "ADMIN_ERROR" })).status).toBe(200);
    expect((await api("POST", `/group-series/${K}/teachers`, { teacherId: T2 })).status).toBe(201);
    expect((await api("DELETE", `/group-series/${K}/teachers/${T2}?fromDate=2026-10-06`)).status).toBe(200);
    expect((await api("PATCH", `/group-series/${K}/teacher`, { to: T2 })).status).toBe(200);
    expect((await api("POST", `/group-series/${K}/dates`, { dates: ["2026-10-19"] })).status).toBe(201);
    expect((await api("PATCH", `/group-series/${K}`, { title: "Skate Kids 2" })).status).toBe(200);
    expect(calls).toEqual([
      ["listOtherSeries", { from: "2026-10-01", to: "2026-10-31" }, "GROUP"],
      ["getOtherSeries", { groupKey: K }],
      ["confirmAllOtherSeries", { groupKey: K }],
      ["cancelAllOtherSeries", { groupKey: K }, { reasonCode: "ADMIN_ERROR" }, "dev"],
      ["addTeacherToOtherSeries", { groupKey: K }, { teacherId: T2 }],
      ["removeTeacherFromOtherSeries", { groupKey: K }, T2, { fromDate: "2026-10-06" }],
      ["swapGroupSeriesTeacher", { groupKey: K }, { to: T2 }],
      ["addDatesToOtherSeries", { groupKey: K }, { dates: ["2026-10-19"] }],
      ["updateOtherSeries", { groupKey: K }, { title: "Skate Kids 2" }],
    ]);
    expect((await api("PATCH", `/group-series/${K}/teacher`, { from: T1, to: T2, fromDate: "bad" })).status).toBe(400);
  });
});

describe("🔴 the Monday weekly coach digest — the window, the grouping, the ENGLISH-ONLY bytes under both langs, send-once, the job, the route + exe", () => {
  test("`weekOf`: Mon–Sun containing the date (a Monday is its own start; a Sunday belongs to the week before it)", () => {
    expect(weekOf("2026-10-05")).toEqual({ weekStart: "2026-10-05", weekEnd: "2026-10-11" }); // a Monday
    expect(weekOf("2026-10-07")).toEqual({ weekStart: "2026-10-05", weekEnd: "2026-10-11" }); // Wednesday
    expect(weekOf("2026-10-11")).toEqual({ weekStart: "2026-10-05", weekEnd: "2026-10-11" }); // Sunday
    expect(weekOf("2026-10-12")).toEqual({ weekStart: "2026-10-12", weekEnd: "2026-10-18" });
    expect(weeklyDigestKey(T1, "2026-10-05")).toBe(`weekly-teacher:${T1}:2026-10-05`);
  });
  test("`groupWeekRows`: CONFIRMED only; the primary AND every additional teacher; date+time order; a GROUP/OTHER row = its title alone; a DUO row `A & B`; a teacher with nothing is absent", () => {
    const rows = [
      { id: "b2", date: "2026-10-07", startTime: "16:00:00", endTime: "17:00:00", status: "CONFIRMED", teacherId: T1, teacher: { lineUserId: "U1" }, subject: { name: "Freeskate" }, student: { name: "Aiwa", nickname: "Aiwa" }, coStudent: null, otherTitle: null, additionalTeachers: [] },
      { id: "b1", date: "2026-10-07", startTime: "15:00:00", endTime: "16:00:00", status: "CONFIRMED", teacherId: T1, teacher: { lineUserId: "U1" }, subject: { name: "Balance Bike" }, student: { name: "Bam", nickname: "Bam" }, coStudent: { name: "Cat", nickname: "Cat" }, otherTitle: null, additionalTeachers: [] },
      { id: "g1", date: "2026-10-06", startTime: "15:00:00", endTime: "16:00:00", status: "CONFIRMED", teacherId: T2, teacher: { lineUserId: "U2" }, subject: null, student: null, coStudent: null, otherTitle: "Skate Kids", bookingType: "GROUP", additionalTeachers: [{ teacherId: T1, teacher: { lineUserId: "U1" } }] },
      { id: "p1", date: "2026-10-08", startTime: "10:00:00", endTime: "11:00:00", status: "PENDING", teacherId: T3, teacher: { lineUserId: "U3" }, subject: { name: "Freeskate" }, student: { name: "Dan", nickname: "Dan" }, coStudent: null, otherTitle: null, additionalTeachers: [] },
      { id: "c1", date: "2026-10-09", startTime: "10:00:00", endTime: "11:00:00", status: "CANCELLED", teacherId: T3, teacher: { lineUserId: "U3" }, subject: { name: "Freeskate" }, student: { name: "Dan", nickname: "Dan" }, coStudent: null, otherTitle: null, additionalTeachers: [] },
    ];
    const g = groupWeekRows(rows);
    expect(g.map((x) => x.teacherId).sort()).toEqual([T1, T2].sort()); // T3 has nothing CONFIRMED ⇒ absent
    const ek = g.find((x) => x.teacherId === T1)!;
    expect(ek.lineUserId).toBe("U1");
    expect(ek.rows).toEqual([
      { date: "2026-10-06", startTime: "15:00", endTime: "16:00", program: "Skate Kids", studentName: null },
      { date: "2026-10-07", startTime: "15:00", endTime: "16:00", program: "Balance Bike", studentName: "Bam & Cat" },
      { date: "2026-10-07", startTime: "16:00", endTime: "17:00", program: "Freeskate", studentName: "Aiwa" },
    ]);
    expect(g.find((x) => x.teacherId === T2)!.rows).toEqual([{ date: "2026-10-06", startTime: "15:00", endTime: "16:00", program: "Skate Kids", studentName: null }]);
  });
  test("🔴 the bytes — REQ-104 §3, ENGLISH ONLY: identical under TH and EN, no Thai code point, no `t()`/`lang` in the branch, no ISO date, no trailing whitespace; an empty payload renders", () => {
    const rows = [{ date: "2026-10-06", startTime: "15:00", endTime: "16:00", program: "Skate Kids", studentName: null }, { date: "2026-10-07", startTime: "16:00", endTime: "17:00", program: "Freeskate", studentName: "Aiwa" }];
    const expected = "📅 THIS WEEK'S SCHEDULE\nHello, here is your teaching schedule for this week:\n\n06-10-2026 · 15:00-16:00 · Skate Kids\n07-10-2026 · 16:00-17:00 · Freeskate / Aiwa\n\nPlease review your schedule.";
    expect(renderWeeklySchedule(rows)).toBe(expected);
    expect([WEEKLY_TITLE, WEEKLY_GREETING, WEEKLY_FOOTER]).toEqual(["📅 THIS WEEK'S SCHEDULE", "Hello, here is your teaching schedule for this week:", "Please review your schedule."]);
    for (const lang of ["TH", "EN"] as const) {
      const out = formatOutboxMessage({ kind: "weekly_schedule_teacher", weekStart: "2026-10-05", rows } as any, { studentName: "น้องเอ", subject: "Freeskate" } as any, lang, "teacher");
      expect(out).toBe(expected);
      expect(out).not.toMatch(/[฀-๿]/);
      expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    expect(formatOutboxMessage({ kind: "weekly_schedule_teacher" } as any, {}, "TH", "teacher")).toBe("📅 THIS WEEK'S SCHEDULE\nHello, here is your teaching schedule for this week:\n\n\nPlease review your schedule.");
    const branch = region(code(src("src/lib/line-message.ts")), 'case "weekly_schedule_teacher":', "case ");
    expect(branch).not.toMatch(/\bt\(|lang/);
    expect(code(src("src/lib/weekly-digest.ts"))).not.toMatch(/line-i18n|\bt\(/);
  });
  test("the job by VALUE: the Mon–Sun read; one outbox row per teacher with rows, keyed per week; nothing for a teacher with nothing; `job_runs` written; a second run is `duplicate`", async () => {
    const probes: any[] = [];
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async ({ where }: any) => { const p: any[] = []; try { where({ date: "d" }, { and: (...a: any[]) => a, gte: (_c: any, val: any) => { p.push(["gte", val]); return val; }, lte: (_c: any, val: any) => { p.push(["lte", val]); return val; } }); } catch {} probes.push(p); return [
      { id: "b1", date: "2026-10-07", startTime: "15:00:00", endTime: "16:00:00", status: "CONFIRMED", teacherId: T1, teacher: { lineUserId: "U1" }, subject: { name: "Freeskate" }, student: { name: "Aiwa", nickname: "Aiwa" }, coStudent: null, otherTitle: null, additionalTeachers: [] },
      { id: "p1", date: "2026-10-08", startTime: "10:00:00", endTime: "11:00:00", status: "PENDING", teacherId: T3, teacher: { lineUserId: "U3" }, subject: { name: "Freeskate" }, student: { name: "Dan", nickname: "Dan" }, coStudent: null, otherTitle: null, additionalTeachers: [] },
    ]; }) as any));
    const sends: any[] = [];
    let dup = false;
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { sends.push(o); return { status: dup ? "duplicate" : "queued" } as any; }) as any));
    const runs: any[] = [];
    spies.push(spyOn(db, "insert").mockImplementation(((table: any) => ({ values: async (val: any) => { runs.push({ table: table === jobRuns ? "jobRuns" : "other", val }); } })) as any));
    const out = await jobs.runWeeklyTeacherDigestJob("2026-10-07");
    expect(probes[0]).toEqual([["gte", "2026-10-05"], ["lte", "2026-10-11"]]);
    expect(sends).toHaveLength(1); // T3 (PENDING only) gets nothing
    expect(sends[0]).toEqual({ recipientType: "teacher", recipientLineUserId: "U1", payload: { kind: "weekly_schedule_teacher", weekStart: "2026-10-05", rows: [{ date: "2026-10-07", startTime: "15:00", endTime: "16:00", program: "Freeskate", studentName: "Aiwa" }] }, skipReason: undefined, idempotencyKey: `weekly-teacher:${T1}:2026-10-05` });
    expect(out).toEqual({ date: "2026-10-07", weekStart: "2026-10-05", weekEnd: "2026-10-11", teachers: 1, sent: 1, skipped: 0, duplicate: 0 });
    expect(runs).toEqual([{ table: "jobRuns", val: expect.objectContaining({ job: WEEKLY_DIGEST_JOB, runDate: "2026-10-07", status: "success", summary: { weekStart: "2026-10-05", weekEnd: "2026-10-11", teachers: 1, sent: 1, skipped: 0, duplicate: 0 } }) }]);
    dup = true;
    expect(await jobs.runWeeklyTeacherDigestJob("2026-10-07")).toMatchObject({ sent: 0, duplicate: 1 });
    expect(WEEKLY_DIGEST_JOB).toBe("weekly-teacher-digest");
    expect(code(src("src/services/jobs.service.ts"))).not.toMatch(/weekly_teacher_digest_enabled|getSetting\("weekly/); // no flag — the owner's words, not placeholders
  });
  test("`POST /internal/jobs/weekly-teacher-digest` — the secret gate, the job reached (spied); the exe + the package script; the daily untouched", async () => {
    process.env.INTERNAL_JOB_SECRET = "s3";
    const calls: any[] = [];
    spies.push(spyOn(jobs, "runWeeklyTeacherDigestJob").mockImplementation((async (d?: string) => { calls.push(d); return { date: d ?? "today", sent: 1 }; }) as any));
    expect((await json("POST", "/internal/jobs/weekly-teacher-digest", {})).status).toBe(401);
    const ok = await json("POST", "/internal/jobs/weekly-teacher-digest", { date: "2026-10-05" }, { "x-internal-secret": "s3" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ date: "2026-10-05", sent: 1 });
    expect(calls).toEqual(["2026-10-05"]);
    const exe = readFileSync(resolve(root, "scripts/weekly-teacher-digest.ts"), "utf8");
    expect(exe).toContain("/internal/jobs/weekly-teacher-digest");
    expect(exe).toContain('"x-internal-secret": secret');
    expect(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts["job:weekly-teacher-digest"]).toBe("bun run scripts/weekly-teacher-digest.ts");
    expect(code(src("src/lib/daily-reminder.ts"))).toContain('export const REMINDABLE = new Set(["CONFIRMED"]);');
  });
});
