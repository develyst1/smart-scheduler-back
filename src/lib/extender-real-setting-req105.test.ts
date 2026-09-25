// TASK-465 — the extender's horizon was `NaN-NaN-NaN` on EVERY box: `Number(await getSetting(…))` fed the whole
// resolved OBJECT to `Number()`. It was mine (TASK-456), and my tests could never see it — **they spied `getSetting`
// to return a bare `2`**, so they asserted the horizon the SPY produced. A test that mocks the thing under test proves
// only the mock.
//
// 🔑 So nothing in this file spies the setting. The only fake is the DATABASE ROW (`app_settings`), and the value is
// built by the REAL `getSetting` → the REAL `resolveSetting`, exactly as production builds it — so the day the
// setting's shape changes again, this suite says so.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readSrc } from "./read-src";
import { uuidFor } from "./test-uuid";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const walk = (d: string): string[] => readdirSync(resolve(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const { db } = await import("../db");
const jobs = await import("../services/jobs.service");
const settingsSvc = await import("../services/settings.service");

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const T1 = uuidFor("z-t1");
const series = (key: string, date: string) => ({
  id: uuidFor(`r-${key}-${date}`), groupKey: key, date, startTime: "15:00:00", bookingType: "GROUP", status: "CONFIRMED",
  teacherId: T1, teacher: { id: T1, nickname: "Bank", name: "Bank" }, otherTitle: `Series ${key}`, otherKind: "GROUP",
  headCount: null, teacherRateMinor: null, additionalTeachers: [], groupClosedAt: null,
});
/** The ONLY fakes: the `app_settings` row (none ⇒ the coded default) and the GROUP rows. The setting is never spied. */
const box = (o: { settingRow?: unknown; rows?: any[] } = {}) => {
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => (o.settingRow === undefined ? undefined : { key: "group_series_weeks_ahead", value: o.settingRow })) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => o.rows ?? []) as any));
};

describe("🔴 TASK-465 — the horizon, built through the REAL `getSetting` (no spy on the setting)", () => {
  test("🔑 `uat`'s exact case — no override row, no group series: a REAL horizon, `weeks: 8`, and zeros that mean 'nothing to do'", async () => {
    box();
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-09-25");
    expect({ weeks: out.weeks, horizon: out.horizon }).toEqual({ weeks: 8, horizon: "2026-11-20" }); // 8 × 7 = 56 days
    expect({ series: out.series, wouldCreate: out.wouldCreate, truncated: out.truncated }).toEqual({ series: 0, wouldCreate: 0, truncated: null });
  });

  test("an admin's override (`12`) is honoured — the value comes from the row, through the resolver", async () => {
    box({ settingRow: 12 });
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-09-25");
    expect({ weeks: out.weeks, horizon: out.horizon }).toEqual({ weeks: 12, horizon: "2026-12-18" });
  });

  test("a box WITH an open series: the plan names it, and the dates stop at the real horizon", async () => {
    box({ rows: [series("K1", "2026-11-06")] });
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-09-25");
    expect(out.plan).toEqual([{ groupKey: "K1", title: "Series K1", teacherId: T1, coach: "Bank", dates: ["2026-11-13", "2026-11-20"] }]);
    expect(out.wouldCreate).toBe(2);
  });

  test("a CORRUPT override row falls back to the coded default — the resolver's own rule, not a NaN", async () => {
    box({ settingRow: "banana" });
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-09-25");
    expect(out.weeks).toBe(8);
  });
});

describe("🔑 TASK-465 — the misuse is IMPOSSIBLE, not merely corrected", () => {
  test("🔴 a resolved setting REFUSES to become a number: `Number(obj)` / `+obj` / `obj * 7` / `${obj}` all THROW, naming the fix", async () => {
    box();
    const resolved = await settingsSvc.getSetting("group_series_weeks_ahead");
    expect(() => Number(resolved)).toThrow(/read `\.value`/);
    expect(() => +(resolved as any)).toThrow(/read `\.value`/);
    expect(() => (resolved as any) * 7).toThrow(/read `\.value`/);
    expect(() => `${resolved}`).toThrow(/read `\.value`/);
    // …while every CORRECT use is untouched: `.value`, destructuring, and structural equality
    expect(resolved.value).toBe(8);
    const { value, isDefault } = resolved;
    expect({ value, isDefault }).toEqual({ value: 8, isDefault: true });
    expect(resolved).toEqual({ value: 8, isDefault: true, reason: "no override set — using default" });
    expect(JSON.parse(JSON.stringify(resolved))).toEqual({ value: 8, isDefault: true, reason: "no override set — using default" });
  });

  test("the numeric helper returns a finite NUMBER, and REFUSES a non-finite one loudly, naming the setting", async () => {
    box({ settingRow: 3 });
    expect(await settingsSvc.getNumberSetting("group_series_weeks_ahead")).toBe(3);
    // a spec whose parse let a non-number through would be a bug in the registry — the helper still refuses it
    spies.push(spyOn(settingsSvc, "getSetting").mockImplementation((async () => ({ value: Number.NaN, isDefault: false })) as any));
    const other = await import("../services/settings.service");
    await expect(other.getNumberSetting("group_series_weeks_ahead")).rejects.toThrow(/group_series_weeks_ahead/);
  });

  test("🔴 a non-finite horizon FAILS the run — never a green zero with `weeks: null`", async () => {
    box();
    spies.push(spyOn(settingsSvc, "getNumberSetting").mockImplementation((async () => Number.NaN) as any));
    await expect(jobs.runGroupSeriesExtenderJob("2026-09-25")).rejects.toThrow(/horizon/);
  });

  test("📌 no caller in src feeds a `getSetting(…)` result to Number / parseInt / arithmetic without `.value`", () => {
    // A tiny paren matcher, not a regex: `Number((await getSetting(leaveCutoffKey(type))).value)` is CORRECT code, and a
    // regex that stops at the first `)` calls it an offender (the first draft of this very pin did exactly that).
    const argOf = (s: string, open: number): string => { let depth = 0; for (let i = open; i < s.length; i++) { if (s[i] === "(") depth++; else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i); } return s.slice(open + 1); };
    const offenders = walk("src")
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .flatMap((f) => {
        const c = code(readSrc(readFileSync(resolve(root, f), "utf8")));
        return [...c.matchAll(/\b(Number|parseInt|parseFloat)\(/g)]
          .map((m) => argOf(c, m.index! + m[0].length - 1))
          .filter((arg) => /getSetting\(/.test(arg) && !/\.value\b/.test(arg))
          .map((arg) => `${f}: ${arg.slice(0, 80)}`);
      });
    expect(offenders).toEqual([]);
    // …and the extender reads its number through the helper
    expect(code(readSrc(readFileSync(resolve(root, "src/services/jobs.service.ts"), "utf8")))).toContain(`await getNumberSetting("group_series_weeks_ahead")`);
  });
});

describe("🔴 TASK-465 — the loop that could run FOR EVER on a NaN horizon", () => {
  test("`\"2026-11-13\" <= \"NaN-NaN-NaN\"` is TRUE (digits sort before 'N') — so the guard must be at the loop, and it throws at once", async () => {
    const { weeklyDatesToCreate } = await import("./group-extend");
    expect("2026-11-13" <= "NaN-NaN-NaN").toBe(true); // the trap, stated
    const t0 = Date.now();
    expect(() => weeklyDatesToCreate({ existing: ["2026-11-06"], from: "2026-09-25", horizon: "NaN-NaN-NaN" })).toThrow(/horizon is not a date/);
    expect(() => weeklyDatesToCreate({ existing: ["2026-11-06"], from: "NaN-NaN-NaN", horizon: "2026-11-20" })).toThrow(/from is not a date/);
    expect(Date.now() - t0).toBeLessThan(50); // 🔑 it refuses; it does not spin (before this task: 360k steps / 300 ms, unbounded)
  });
});
