// TASK-456 (REQ-105 §3) — the ROLLING EXTENDER: a group series with no end date always has N weeks of rows ahead.
//
// 🔑 A group slot runs until an admin CLOSES it, but its rows are real bookings — so something must create them, and
// "something" being a human who remembers is how a class quietly stops existing three weeks out.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSrc } from "./read-src";
import { GROUP_EXTENDER_JOB, weeklyDatesToCreate } from "./group-extend";
import { SETTINGS } from "./settings";
import { uuidFor } from "./test-uuid";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const { db } = await import("../db");
const { jobRuns } = await import("../db/schema");
const jobs = await import("../services/jobs.service");
const sched = await import("../services/scheduler.service");
const settings = await import("../services/settings.service");
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const json = (method: string, path: string, body?: any, headers: Record<string, string> = {}) =>
  rootApp.fetch(new Request(`http://localhost${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const T1 = uuidFor("x-t1"), K1 = uuidFor("x-k1"), K2 = uuidFor("x-k2");

// ═══════════════════ §1 which dates are missing — the pure half ═══════════════════

describe("🔴 §1 `weeklyDatesToCreate` — by value", () => {
  test("the weekly steps after the last row, up to the horizon, keeping the series' own weekday", () => {
    expect(weeklyDatesToCreate({ existing: ["2026-10-06", "2026-10-13"], from: "2026-10-10", horizon: "2026-11-10" }))
      .toEqual(["2026-10-20", "2026-10-27", "2026-11-03", "2026-11-10"]); // Tuesdays, and the horizon is INCLUSIVE
  });

  test("🔑 idempotent BY STATE: run it again against the rows it just created and there is nothing to do", () => {
    const first = weeklyDatesToCreate({ existing: ["2026-10-06"], from: "2026-10-06", horizon: "2026-10-27" });
    expect(first).toEqual(["2026-10-13", "2026-10-20", "2026-10-27"]);
    expect(weeklyDatesToCreate({ existing: ["2026-10-06", ...first], from: "2026-10-06", horizon: "2026-10-27" })).toEqual([]);
  });

  test("⚠️ an ABANDONED series is not back-filled: the steps keep the weekday but the past is skipped", () => {
    // last row in March, today in October — the missing Tuesdays in between are NOT created.
    const out = weeklyDatesToCreate({ existing: ["2026-03-03"], from: "2026-10-06", horizon: "2026-10-27" });
    expect(out).toEqual(["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"]);
    expect(out.every((d) => d >= "2026-10-06")).toBe(true);
    expect(new Date(`${out[0]}T00:00:00`).getDay()).toBe(new Date("2026-03-03T00:00:00").getDay()); // still a Tuesday
  });

  test("🚫 never a duplicate — the anchor is the MAX date, so the property holds by construction and not by a guard", () => {
    // Irregular rows (someone added an off-cadence date by hand) still produce only dates after the last one.
    const existing = ["2026-10-06", "2026-10-09", "2026-10-20"];
    const out = weeklyDatesToCreate({ existing, from: "2026-10-06", horizon: "2026-11-10" });
    expect(out).toEqual(["2026-10-27", "2026-11-03", "2026-11-10"]);
    expect(out.filter((d) => existing.includes(d))).toEqual([]);
    expect(out.every((d) => d > "2026-10-20")).toBe(true);
    // 🔑 and the dead branch is gone rather than kept "just in case" — a guard for an impossible case reads as if
    // the case happens (the break-and-watch run proved removing it changed nothing).
    expect(code(src("src/lib/group-extend.ts"))).not.toContain("have.has(");
  });

  test("a series with no rows at all yields nothing — never a guess", () => {
    expect(weeklyDatesToCreate({ existing: [], from: "2026-10-06", horizon: "2026-11-30" })).toEqual([]);
  });

  test("the horizon is the SETTING, and it is a number an admin can feel", () => {
    expect(SETTINGS.group_series_weeks_ahead).toMatchObject({ type: "number", default: 8, unit: "weeks" });
    expect(SETTINGS.group_series_weeks_ahead.parse(0)).toBeNull();
    expect(SETTINGS.group_series_weeks_ahead.parse(53)).toBeNull();
    expect(SETTINGS.group_series_weeks_ahead.parse(12)).toBe(12);
  });
});

// ═══════════════════ §2 the job, by value ═══════════════════

const groupRow = (o: { key: string; date: string; closed?: boolean }) => ({
  id: uuidFor(`b-${o.key}-${o.date}`), groupKey: o.key, date: o.date, startTime: "15:00:00", bookingType: "GROUP",
  status: "CONFIRMED", teacherId: T1, otherTitle: "Skate Kids", otherKind: "GROUP", headCount: null,
  teacherRateMinor: 60000, additionalTeachers: [], groupClosedAt: o.closed ? new Date() : null,
});

const runWith = async (rows: any[], opts: { failOn?: string } = {}) => {
  const inserted: any[] = [], runs: any[] = [];
  spies.push(spyOn(settings, "getSetting").mockImplementation((async () => 2) as any)); // 2 weeks ahead
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn({} as any)) as any));
  spies.push(spyOn(db, "insert").mockImplementation(((table: any) => ({ values: async (val: any) => { runs.push({ table: table === jobRuns ? "jobRuns" : "other", val }); } })) as any));
  spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, input: any) => {
    if (input.date === opts.failOn) { const { ApiException } = await import("./http"); throw new ApiException(409, "SLOT_TAKEN", "ครูไม่ว่าง"); }
    inserted.push(input);
    return uuidFor(`new-${input.date}`);
  }) as any));
  const out = await jobs.runGroupSeriesExtenderJob("2026-10-06");
  return { out, inserted, runs };
};

describe("🔴 §2 the extender, by value", () => {
  test("the missing dates are created from the LAST row's facts — the series as it stands TODAY, not as it began", async () => {
    // 🔑 The two rows differ: the series was renamed and moved to another coach at some point. Extending it from
    // the FIRST row would quietly restore the old name and the old coach every week, for ever.
    const began = { ...groupRow({ key: K1, date: "2026-09-29" }), otherTitle: "Skate Kids (old)", teacherId: uuidFor("x-t0"), teacherRateMinor: 40000 };
    const { out, inserted, runs } = await runWith([began, groupRow({ key: K1, date: "2026-10-06" })]);
    expect(inserted.map((i) => i.date)).toEqual(["2026-10-13", "2026-10-20"]); // 2 weeks ahead of 06-10
    expect(inserted[0]).toEqual({ teacherId: T1, subjectId: null, date: "2026-10-13", startTime: "15:00", bookingType: "GROUP", otherTitle: "Skate Kids", otherKind: "GROUP", headCount: null, groupKey: K1, teacherRates: { [T1]: 60000 } });
    expect(inserted.map((i) => i.otherTitle)).toEqual(["Skate Kids", "Skate Kids"]); // 🚫 never "(old)"
    expect(out).toMatchObject({ date: "2026-10-06", horizon: "2026-10-20", weeks: 2, series: 1, extended: 1, created: 2, closedSkipped: 0, clashes: [] });
    expect(runs).toEqual([{ table: "jobRuns", val: expect.objectContaining({ job: GROUP_EXTENDER_JOB, runDate: "2026-10-06", status: "success" }) }]);
  });

  test("🔑 a SECOND run over the rows the first one created makes nothing — idempotent by state, no stamp anywhere", async () => {
    const rows = [groupRow({ key: K1, date: "2026-10-06" }), groupRow({ key: K1, date: "2026-10-13" }), groupRow({ key: K1, date: "2026-10-20" })];
    const { out, inserted } = await runWith(rows);
    expect(inserted).toEqual([]);
    expect(out).toMatchObject({ created: 0, extended: 0 });
    expect(code(src("src/services/jobs.service.ts"))).not.toMatch(/lastExtendedAt|extendedThrough/);
  });

  test("🚫 a CLOSED series gains nothing — and it is counted, so 'nothing happened' is never silent", async () => {
    const { out, inserted } = await runWith([groupRow({ key: K1, date: "2026-10-06", closed: true })]);
    expect(inserted).toEqual([]);
    expect(out).toMatchObject({ series: 1, closedSkipped: 1, created: 0 });
  });

  test("🔴 a clashing date is REPORTED and the run continues — one bad coach-hour cannot stop every other series", async () => {
    const { out, inserted, runs } = await runWith(
      [groupRow({ key: K1, date: "2026-10-06" }), groupRow({ key: K2, date: "2026-10-07" })],
      { failOn: "2026-10-13" },
    );
    // K1's 13-10 fails; its 20-10 is still created, and so is K2's 14-10 (its 21-10 is past the 2-week horizon)
    expect(inserted.map((i) => `${i.groupKey === K1 ? "K1" : "K2"} ${i.date}`)).toEqual(["K1 2026-10-20", "K2 2026-10-14"]);
    expect(out.clashes).toEqual([{ groupKey: K1, date: "2026-10-13", message: "ครูไม่ว่าง" }]);
    expect(out).toMatchObject({ created: 2, extended: 2 });
    // it reaches a human twice: the run's summary AND a warn line
    expect((runs[0]!.val.summary as any).clashes).toHaveLength(1);
    expect(code(src("src/services/jobs.service.ts"))).toContain("console.warn(");
  });

  test("📌 ONE DATE PER TRANSACTION, by source — that is what makes 'the run continues' true", () => {
    const J = code(src("src/services/jobs.service.ts"));
    const F = J.slice(J.indexOf("export async function runGroupSeriesExtenderJob("));
    expect(F.indexOf("for (const d of dates) {")).toBeLessThan(F.indexOf("await db.transaction("));
    expect(F).toContain("} catch (e) {");
    expect(F).toContain("clashes.push({ groupKey, date: d, message:");
  });

  test("🚫 the job sends nothing, enrols nobody and posts no money", () => {
    const J = code(src("src/services/jobs.service.ts"));
    const F = J.slice(J.indexOf("export async function runGroupSeriesExtenderJob("));
    for (const forbidden of ["enqueueLine", "recordSale", "seatOnGroup", "reconcileCoursePlan"]) {
      expect({ forbidden, present: F.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});

// ═══════════════════ §3 the wiring ═══════════════════

describe("🔑 §3 the route, the exe, the script — the TASK-441 shape", () => {
  test("`POST /internal/jobs/group-series-extender`: the secret gate, then the job (spied)", async () => {
    process.env.INTERNAL_JOB_SECRET = "s4";
    const calls: string[] = [];
    spies.push(spyOn(jobs, "runGroupSeriesExtenderJob").mockImplementation((async (d?: string) => { calls.push(d!); return { date: d ?? "today", created: 0 }; }) as any));
    expect((await json("POST", "/internal/jobs/group-series-extender", {})).status).toBe(401);
    const ok = await json("POST", "/internal/jobs/group-series-extender", { date: "2026-10-06" }, { "x-internal-secret": "s4" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ date: "2026-10-06", created: 0 });
    expect(calls).toEqual(["2026-10-06"]);
  });

  test("the exe is a THIN trigger and the package script exists", () => {
    const exe = readFileSync(resolve(root, "scripts/group-series-extender.ts"), "utf8");
    expect(exe).toContain("/internal/jobs/group-series-extender");
    expect(exe).toContain('"x-internal-secret": secret');
    expect(exe).not.toContain("drizzle"); // no DB connection in the exe — it cannot drift from the API's rules
    expect(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts["job:group-series-extender"]).toBe("bun run scripts/group-series-extender.ts");
    expect(GROUP_EXTENDER_JOB).toBe("group-series-extender");
  });

  test("🚫 no migration: the extender is behaviour over the rows TASK-453 already gave it", () => {
    expect(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8").match(/"tag"/g)!.length).toBe(56);
  });
});
