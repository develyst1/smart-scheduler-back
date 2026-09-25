// TASK-466 — the extender must never RESURRECT a date an admin cancelled.
//
// 🔴 It read only LIVE rows, so a cancelled date was invisible to it: cancel a series' LAST date and the anchor fell
// back to the last live row, and the job re-created the cancelled session that night. A CANCELLED row holds no slot,
// so nothing clashed and nothing complained — the parents' next reminder would announce a class that was called off.
// 📌 Every older extender fixture had LIVE rows only, which is exactly why no test ever saw this: the full suite stayed
// green through the fix, before these tests existed.
//
// The setting is NOT spied (TASK-465): only the `app_settings` row and the GROUP rows are faked.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { uuidFor } from "./test-uuid";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const { db } = await import("../db");
const jobs = await import("../services/jobs.service");

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const T1 = uuidFor("c466-t1");
/** A weekly Tuesday series; `status` per row. */
const row = (key: string, date: string, status = "CONFIRMED", extra: Record<string, unknown> = {}) => ({
  id: uuidFor(`c466-${key}-${date}`), groupKey: key, date, startTime: "15:00:00", bookingType: "GROUP", status,
  teacherId: T1, teacher: { id: T1, nickname: "Bank", name: "Bank" }, otherTitle: `Series ${key}`, otherKind: "GROUP",
  headCount: null, teacherRateMinor: null, additionalTeachers: [], groupClosedAt: null, ...extra,
});
// runDate Thu 2026-10-01, 4 weeks ahead ⇒ horizon Thu 2026-10-29
const RUN = "2026-10-01";
const plan = async (rows: any[]) => {
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => ({ key: "group_series_weeks_ahead", value: 4 })) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
  const out: any = await jobs.runGroupSeriesExtenderJob(RUN);
  return Object.fromEntries(out.plan.map((p: any) => [p.groupKey, p.dates]));
};

describe("🔴 TASK-466 — a CANCELLED date is a date the series HAD: never re-created", () => {
  test("🔑 the case that started this: cancel the LAST date ⇒ it is NOT re-created, and the series continues after it", async () => {
    const got = await plan([row("K", "2026-09-29"), row("K", "2026-10-06"), row("K", "2026-10-13", "CANCELLED")]);
    expect(got.K).toEqual(["2026-10-20", "2026-10-27"]);
    expect(got.K).not.toContain("2026-10-13"); // 🔴 before this task: ["2026-10-13", "2026-10-20", "2026-10-27"]
  });

  test("the next TWO Tuesdays cancelled ⇒ no row on either, and the Tuesday cadence resumes after them", async () => {
    const got = await plan([row("K", "2026-09-29"), row("K", "2026-10-06", "CANCELLED"), row("K", "2026-10-13", "CANCELLED")]);
    expect(got.K).toEqual(["2026-10-20", "2026-10-27"]);
    for (const d of got.K) expect(new Date(`${d}T00:00:00`).getDay()).toBe(2); // still Tuesday
  });

  test("🔑 a SECOND run over what the first created makes nothing — cancelled rows included in the picture", async () => {
    const got = await plan([
      row("K", "2026-09-29"), row("K", "2026-10-06", "CANCELLED"), row("K", "2026-10-13", "CANCELLED"),
      row("K", "2026-10-20"), row("K", "2026-10-27"),
    ]);
    expect(got.K).toBeUndefined(); // nothing to do ⇒ not in the plan at all
  });

  test("an ATTENDED last date counts as a date the series had (the same rule, any status)", async () => {
    const got = await plan([row("K", "2026-09-22", "ATTENDED"), row("K", "2026-09-29", "ATTENDED"), row("K", "2026-10-06")]);
    expect(got.K).toEqual(["2026-10-13", "2026-10-20", "2026-10-27"]);
  });
});

describe("⚖️ TASK-466 — the ANCHOR decision, pinned so the next reader sees the choice", () => {
  // Three possible readings of "the last two dates were cancelled":
  //   (a) anchor on the last LIVE date     ⇒ re-creates the cancelled dates           — THE DEFECT
  //   (b) treat a cancelled tail as the END ⇒ the series silently stops               — shortens every edited series
  //   (c) anchor on the last date it HAD    ⇒ skips the cancelled ones, keeps the week — CHOSEN (Sober's call, agreed)
  const cancelledTail = [row("K", "2026-09-29"), row("K", "2026-10-06", "CANCELLED"), row("K", "2026-10-13", "CANCELLED")];

  test("(c) is what the code does", async () => {
    expect((await plan(cancelledTail)).K).toEqual(["2026-10-20", "2026-10-27"]);
  });
  test("…and it is NEITHER (a) nor (b)", async () => {
    const got = (await plan(cancelledTail)).K;
    expect(got).not.toEqual(["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"]); // (a) — resurrection
    expect(got).not.toBeUndefined(); // (b) — the series quietly ended
  });
});

describe("🚫 TASK-466 — what did NOT change", () => {
  test("a series cancelled IN FULL is not extended — a cancel-all stays terminal (the live rows still decide whether it runs)", async () => {
    const got = await plan([row("K", "2026-09-29", "CANCELLED"), row("K", "2026-10-06", "CANCELLED")]);
    expect(got.K).toBeUndefined();
  });

  test("the TEMPLATE is still the last LIVE row — a cancelled row is not what the class looks like today", async () => {
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => ({ key: "group_series_weeks_ahead", value: 4 })) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => [
      row("K", "2026-09-29", "CONFIRMED", { otherTitle: "Skate Kids" }),
      row("K", "2026-10-06", "CANCELLED", { otherTitle: "Old name on a cancelled row" }),
    ]) as any));
    const out: any = await jobs.runGroupSeriesExtenderJob(RUN);
    expect(out.plan[0].title).toBe("Skate Kids");
  });

  test("a CLOSED series is still skipped and still counted", async () => {
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => ({ key: "group_series_weeks_ahead", value: 4 })) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => [row("K", "2026-09-29", "CONFIRMED", { groupClosedAt: new Date() })]) as any));
    const out: any = await jobs.runGroupSeriesExtenderJob(RUN);
    expect({ plan: out.plan, closedSkipped: out.closedSkipped }).toEqual({ plan: [], closedSkipped: 1 });
  });
});

describe("🔑 TASK-466 — the READ itself must not filter by status (a spy that ignores `where` cannot see that)", () => {
  test("the extender's GROUP read applies NO status filter — recorded from the `where` callback it actually passes", async () => {
    // 📌 Every fixture above fakes `findMany` and so IGNORES the where clause: a status filter re-added at the database
    // would be invisible to all of them. The first break-and-watch run proved it (the "DB read filtered to live" mutation
    // passed). So this test runs the real `where` callback against recording operators and reads what it asked for.
    const asked: string[] = [];
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => ({ key: "group_series_weeks_ahead", value: 4 })) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async ({ where }: any) => {
      const col = (name: string) => ({ name });
      where({ bookingType: col("bookingType"), status: col("status") }, {
        and: (...xs: any[]) => xs,
        eq: (c: any, v: any) => { asked.push(`eq ${c.name}=${v}`); return true; },
        inArray: (c: any, v: any) => { asked.push(`inArray ${c.name}=${JSON.stringify(v)}`); return true; },
        notInArray: (c: any, v: any) => { asked.push(`notInArray ${c.name}=${JSON.stringify(v)}`); return true; },
        ne: (c: any, v: any) => { asked.push(`ne ${c.name}=${v}`); return true; },
      });
      return [];
    }) as any));
    await jobs.runGroupSeriesExtenderJob(RUN);
    expect(asked).toEqual(["eq bookingType=GROUP"]); // 🔑 and nothing about `status`
  });
});
