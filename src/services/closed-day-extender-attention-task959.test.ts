// TASK-959 (REQ-5013 option B, SPEC-105 §3 + §4.4) — the group-series EXTENDER steps over a closed day (and reports it), and the ATTENTION card `classes_on_closed_days` lists what is still on one.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, inArray, isNull, notInArray, gte } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
import { bookings, closedDays, SLOT_INACTIVE_STATUSES } from "../db/schema";
import { ATTENTION_CHECKS, buildDigestMessage } from "../lib/attention";
import { t } from "../lib/line-i18n";
import { uuidFor } from "../lib/test-uuid";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const { db } = await import("../db");
const jobs = await import("./jobs.service");
const sched = await import("./scheduler.service");
const attentionSvc = await import("./attention.service");
const closedDayLib = await import("../lib/closed-day");
const root = resolve(import.meta.dir, "..", "..");
const dialect = new PgDialect();
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

// ───────────────────────────── the extender ─────────────────────────────
const T1 = uuidFor("c959-t1");
const row = (key: string, date: string, status = "CONFIRMED", extra: Record<string, unknown> = {}) => ({
  id: uuidFor(`c959-${key}-${date}`), groupKey: key, date, startTime: "15:00:00", bookingType: "GROUP", status,
  teacherId: T1, teacher: { id: T1, nickname: "Bank", name: "Bank" }, otherTitle: `Series ${key}`, otherKind: "GROUP",
  headCount: null, teacherRateMinor: null, additionalTeachers: [], groupClosedAt: null, ...extra,
});
// runDate Thu 2026-10-01, 4 weeks ahead ⇒ horizon Thu 2026-10-29: a Tuesday series whose last date is 2026-09-29 needs 10-06, 10-13, 10-20, 10-27
const RUN = "2026-10-01";
const SERIES_A = [row("A", "2026-09-22"), row("A", "2026-09-29")];
function arm(rows: any[], shut: string[]) {
  const asked: string[][] = [];
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => ({ key: "group_series_weeks_ahead", value: 4 })) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
  spies.push(spyOn(closedDayLib, "openClosedDates").mockImplementation((async (_e: any, dates: string[]) => { asked.push([...dates]); return new Set(dates.filter((d) => shut.includes(d))); }) as any));
  return asked;
}

describe("SPEC §4.4 — the extender skips an OPEN closed date, keeps a GAP, and says so in `closedDaySkipped`", () => {
  test("a closed Tuesday inside the horizon is NOT planned: 3 dates instead of 4, `closedDaySkipped: 1`, and the gap is only that date", async () => {
    const asked = arm(SERIES_A, ["2026-10-13"]);
    const out: any = await jobs.runGroupSeriesExtenderJob(RUN);
    expect(out.dryRun).toBe(true);
    expect(out.plan.map((p: any) => p.dates)).toEqual([["2026-10-06", "2026-10-20", "2026-10-27"]]);
    expect(out.wouldCreate).toBe(3);
    expect(out.closedDaySkipped).toBe(1);
    expect(asked).toEqual([["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"]]); // ONE read per series, of exactly the dates it wanted
  });
  test("nothing closed ⇒ `closedDaySkipped: 0` and the plan is byte-for-byte what it was before this task", async () => {
    arm(SERIES_A, []);
    const out: any = await jobs.runGroupSeriesExtenderJob(RUN);
    expect(out.plan.map((p: any) => p.dates)).toEqual([["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"]]);
    expect(out.closedDaySkipped).toBe(0);
    expect(out.closedSkipped).toBe(0); // the OLD field (series closed by an admin) is a different fact and is untouched
  });
  test("EVERY wanted date closed ⇒ no plan item for that series at all, all counted as skipped; another series is unaffected; the dates count per date, not per series", async () => {
    const rows = [...SERIES_A, row("B", "2026-09-23"), row("B", "2026-09-30")]; // B: Wednesday, wants 10-07 10-14 10-21 10-28
    arm(rows, ["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27", "2026-10-14"]);
    const out: any = await jobs.runGroupSeriesExtenderJob(RUN);
    expect(out.plan.map((p: any) => [p.groupKey, p.dates])).toEqual([["B", ["2026-10-07", "2026-10-21", "2026-10-28"]]]);
    expect(out.closedDaySkipped).toBe(5);
    expect(out.series).toBe(2);
  });
  test("the bounds count what will REALLY be created: a closed date does not eat `maxDates`", async () => {
    arm(SERIES_A, ["2026-10-13"]);
    const out: any = await jobs.runGroupSeriesExtenderJob(RUN, { maxDates: 3 }); // 4 wanted, 3 real
    expect(out.truncated).toBeNull();
    expect(out.wouldCreate).toBe(3);
  });
  test("APPLY: the closed date is not created, no clash is logged, and the report carries `closedDaySkipped`; the other dates are created through `insertBooking`", async () => {
    arm(SERIES_A, ["2026-10-13"]);
    const created: string[] = [];
    spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, input: any) => { created.push(input.date); return uuidFor(`new-${input.date}`); }) as any));
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn({})) as any));
    const warns: unknown[][] = [];
    spies.push(spyOn(console, "warn").mockImplementation(((...a: unknown[]) => { warns.push(a); }) as any));
    const out: any = await jobs.runGroupSeriesExtenderJob(RUN, { apply: true });
    expect(created).toEqual(["2026-10-06", "2026-10-20", "2026-10-27"]);
    expect(out).toMatchObject({ dryRun: false, created: 3, extended: 1, closedDaySkipped: 1, clashes: [] });
    expect(warns).toEqual([]); // never logged as a clash
  });
  test("the series keeps its GAP on the NEXT run: the closed date is before the new last date, so it is never re-created", async () => {
    arm([...SERIES_A, row("A", "2026-10-06"), row("A", "2026-10-20"), row("A", "2026-10-27")], []);
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-10-08");
    const all = out.plan.flatMap((p: any) => p.dates);
    expect(all).not.toContain("2026-10-13");
    expect(all.every((d: string) => d > "2026-10-27")).toBe(true);
  });
  test("`insertBooking`'s own refusal stays the backstop: a DAY_CLOSED from it (a day closed between the plan and the insert) is a CLASH in the report, never a crash", async () => {
    arm(SERIES_A, []);
    spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, input: any) => {
      if (input.date === "2026-10-13") throw closedDayLib.DAY_CLOSED(input.date, "HOLIDAY");
      return uuidFor(`new-${input.date}`);
    }) as any));
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn({})) as any));
    spies.push(spyOn(console, "warn").mockImplementation((() => {}) as any));
    const out: any = await jobs.runGroupSeriesExtenderJob(RUN, { apply: true });
    expect(out.created).toBe(3);
    expect(out.clashes).toHaveLength(1);
    expect(out.clashes[0]).toMatchObject({ groupKey: "A", date: "2026-10-13" });
    expect(out.clashes[0].message).toContain("ปิดทำการ");
  });
});

describe("`openClosedDates` (the extender's one read) — OPEN rows only", () => {
  test("its where-clause carries `reopened_at is null`, so a re-opened day is history and the series is planned there again", async () => {
    let q: { sql: string; params: unknown[] } | null = null;
    const exec = { select: () => ({ from: () => ({ where: async (c: any) => { const p = dialect.sqlToQuery(c); q = { sql: p.sql, params: p.params as unknown[] }; return [{ date: "2026-10-13" }]; } }) }) };
    const got = await closedDayLib.openClosedDates(exec, ["2026-10-13", "2026-10-20"]);
    expect([...got]).toEqual(["2026-10-13"]);
    expect(q!.sql).toContain('"closed_days"."reopened_at" is null');
    expect(q!.params).toEqual(["2026-10-13", "2026-10-20"]);
  });
});

// ───────────────────────────── the attention card ─────────────────────────────
describe("SPEC §3 — the attention check `classes_on_closed_days`", () => {
  const check = ATTENTION_CHECKS.find((c) => c.key === "classes_on_closed_days")!;
  const ctxWith = (rows: Array<{ booking: any; teacher: any }>) => ({ today: "2026-11-13", tomorrow: "2026-11-14", yesterday: "2026-11-12", expiryCutoff: "2026-11-27", salesWindowStart: "2026-11-06", load: { closedDayClasses: async () => rows } }) as any;
  const cls = (id: string, date: string, over: any = {}) => ({
    booking: { id, date, startTime: "10:00:00", bookingType: "COURSE_PACKAGE", student: { nickname: "Mali", name: "Malee" }, coStudent: null, otherTitle: null, ...over },
    teacher: { nickname: "Ek" },
  });
  test("it is registered LAST, with its i18n key; TH «คลาสในวันปิดทำการ» / EN «Classes on a closed day»; it does NOT name people in the digest", () => {
    expect(ATTENTION_CHECKS[ATTENTION_CHECKS.length - 1]!.key).toBe("classes_on_closed_days");
    expect(check.titleKey).toBe("att_classes_on_closed_days");
    expect(t("att_classes_on_closed_days", "TH")).toBe("คลาสในวันปิดทำการ");
    expect(t("att_classes_on_closed_days", "EN")).toBe("Classes on a closed day");
    expect(check.namesPeopleInDigest).toBeFalsy();
  });
  test("each item: { id: bookingId, label: `<date> <HH:MM> · <child nickname> · <coach>`, link: { kind: 'day', date } }; the count is the number of classes", async () => {
    const r = await check.run(ctxWith([cls("b1", "2026-11-20"), cls("b2", "2026-11-20", { startTime: "14:30:00", student: { nickname: null, name: "Pim" } }), cls("b3", "2026-11-22")]));
    expect(r.count).toBe(3);
    expect(r.items).toEqual([
      { id: "b1", label: "2026-11-20 10:00 · Mali · Ek", link: { kind: "day", date: "2026-11-20" } },
      { id: "b2", label: "2026-11-20 14:30 · Pim · Ek", link: { kind: "day", date: "2026-11-20" } },
      { id: "b3", label: "2026-11-22 10:00 · Mali · Ek", link: { kind: "day", date: "2026-11-22" } },
    ]);
  });
  test("a group / other class is named by its TITLE (the one name rule), a missing coach prints «-»", async () => {
    const r = await check.run(ctxWith([{ booking: { id: "g1", date: "2026-11-20", startTime: "09:00:00", bookingType: "OTHER", student: null, coStudent: null, otherTitle: "Skate group" }, teacher: null }]));
    expect(r.items[0]!.label).toBe("2026-11-20 09:00 · Skate group · -");
  });
  test("nothing on a closed day ⇒ count 0 and no items", async () => {
    expect(await check.run(ctxWith([]))).toEqual({ count: 0, items: [] });
  });
  test("🔒 the LINE digest carries the COUNT only: the heading and the number, never a child's name or the date list", () => {
    const msg = buildDigestMessage([{ key: "classes_on_closed_days", titleKey: "att_classes_on_closed_days", count: 2, items: [{ id: "b1", label: "2026-11-20 10:00 · Mali · Ek" }, { id: "b2", label: "2026-11-20 11:00 · Pim · Nok" }] }] as any, "TH" as any);
    expect(msg).toContain("คลาสในวันปิดทำการ");
    expect(msg).toContain("2");
    for (const secret of ["Mali", "Pim", "Ek", "Nok", "2026-11-20"]) expect(msg).not.toContain(secret);
  });
  test("the loader, BY VALUE: open closed rows from TODAY on, then ONE read of the live classes on those dates — slot-active statuses only, no seats", async () => {
    const reads: Array<{ table: string; sql: string; params: unknown[] }> = [];
    const select = () => ({ from: (tb: any) => ({ where: async (cond: any) => { const q = dialect.sqlToQuery(cond); reads.push({ table: getTableName(tb), sql: q.sql, params: q.params as unknown[] }); return [{ date: "2026-11-20" }, { date: "2026-11-22" }]; } }) });
    let bookingQ: { sql: string; params: unknown[] } | null = null;
    spies.push(spyOn(db, "select").mockImplementation(select as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async (q: any) => {
      const c = dialect.sqlToQuery(q.where(bookings, { and, inArray, notInArray, isNull }));
      bookingQ = { sql: c.sql, params: c.params as unknown[] };
      return [{ id: "b1", date: "2026-11-20", startTime: "10:00:00", teacher: { nickname: "Ek" }, student: { nickname: "Mali" } }];
    }) as any));
    const rows = await attentionSvc.buildCtx("2026-11-13").load.closedDayClasses();
    expect(rows).toEqual([{ booking: expect.objectContaining({ id: "b1" }), teacher: { nickname: "Ek" } }]);
    // the closed days: only OPEN ones, only from today on
    expect(reads).toHaveLength(1);
    expect(reads[0]!.table).toBe("closed_days");
    expect(reads[0]!.sql).toContain('"closed_days"."date" >= $1');
    expect(reads[0]!.sql).toContain('"closed_days"."reopened_at" is null');
    expect(reads[0]!.params).toEqual(["2026-11-13"]);
    // the classes: on exactly those dates, never a cancelled / on-leave / paused / pending-reschedule row (so a planned absence, a cancelled and a moved-away class all drop), never a seat
    expect(bookingQ!.params).toEqual(["2026-11-20", "2026-11-22", ...SLOT_INACTIVE_STATUSES]);
    expect(bookingQ!.sql).toContain('"group_id" is null');
    expect([...SLOT_INACTIVE_STATUSES]).toEqual(["CANCELLED", "PENDING_RESCHEDULE", "SICK_LEAVE", "PAUSED"]);
  });
  test("it drops BY ITSELF: no open closed day ⇒ the class read is not even made (after a re-open, after the date passes); the memo is per run (one read for several checks)", async () => {
    let selects = 0, finds = 0;
    spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: async () => { selects++; return []; } }) })) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => { finds++; return []; }) as any));
    const ctx = attentionSvc.buildCtx("2026-11-13");
    expect(await ctx.load.closedDayClasses()).toEqual([]);
    expect(await ctx.load.closedDayClasses()).toEqual([]);
    expect({ selects, finds }).toEqual({ selects: 1, finds: 0 });
  });
  test("by source: the card's link is the ONLY new `link` shape, and a closed-day item needs no `id`", () => {
    const S = readFileSync(resolve(root, "src/services/attention.service.ts"), "utf8");
    expect(S).toContain('{ kind: "day"; date: string }');
    expect(S).toContain("gte(closedDays.date, today)");
    expect(S).toContain("isNull(closedDays.reopenedAt)");
  });
});
