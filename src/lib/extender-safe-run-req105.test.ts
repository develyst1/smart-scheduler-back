// TASK-462 — after the `sid` incident (2026-09-24): the extender trigger got NO HTTP response, and at the same moment
// the shared Postgres cluster went into recovery (`57P03`). Whatever caused the restart, three things on OUR side made
// it unreadable and dangerous, and this file pins that each one is gone:
//   1. a human poking the endpoint WROTE rows — now a DRY RUN is the default and `apply` must be said out loud;
//   2. the route held the connection for the whole job, so "it ran long" and "the process died" were the SAME error —
//      now an apply is ACKed with a `job_runs` row that says `running` and later finishes (or visibly never does);
//   3. a rejection nobody awaited could end the process — now the process logs it and keeps serving.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSrc } from "./read-src";
import { uuidFor } from "./test-uuid";

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
const tick = () => new Promise((r) => setTimeout(r, 5));

const T1 = uuidFor("y-t1");
const groupRow = (key: string, date: string, o: { closed?: boolean } = {}) => ({
  id: uuidFor(`b-${key}-${date}`), groupKey: key, date, startTime: "15:00:00", bookingType: "GROUP", status: "CONFIRMED",
  teacherId: T1, teacher: { id: T1, nickname: "Bank", name: "Bank" }, otherTitle: `Series ${key}`, otherKind: "GROUP",
  headCount: null, teacherRateMinor: 60000, additionalTeachers: [], groupClosedAt: o.closed ? new Date() : null,
});
/** Spy the reads, and COUNT every write — the dry run's whole promise is that this stays at zero. */
const world = (rows: any[]) => {
  const writes: string[] = [];
  // 🔻 TASK-465 — this used to be `spyOn(settings, "getSetting") → 2`: a BARE NUMBER where production returns an OBJECT,
  // which is exactly why this suite passed while every real box computed `NaN-NaN-NaN`. Now only the ROW is faked, and the
  // value goes through the real resolver — a test that mocks the thing under test proves only the mock.
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => ({ key: "group_series_weeks_ahead", value: 2 })) as any)); // 2 weeks ahead
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any));
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => { writes.push("tx"); return fn({} as any); }) as any));
  spies.push(spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, _s: any, input: any) => { writes.push(`insert ${input.groupKey}/${input.date}`); return uuidFor(`n-${input.date}`); }) as any));
  return writes;
};

// ═══════════════════ §1 DRY RUN by default ═══════════════════

describe("🔴 §1 a DRY RUN is the default — `apply` must be said out loud", () => {
  test("by value: no `apply` ⇒ the PLAN (series, title, coach, dates) and ZERO writes — not even a `job_runs` row", async () => {
    const writes = world([groupRow("K1", "2026-10-06"), groupRow("K2", "2026-10-07")]);
    const inserts: any[] = [];
    spies.push(spyOn(db, "insert").mockImplementation(((t: any) => ({ values: (v: any) => { inserts.push({ t: t === jobRuns ? "jobRuns" : "other", v }); return { returning: async () => [{ id: "x" }] }; } })) as any));
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-10-06");
    expect(out.dryRun).toBe(true);
    expect(out.plan).toEqual([
      { groupKey: "K1", title: "Series K1", teacherId: T1, coach: "Bank", dates: ["2026-10-13", "2026-10-20"] },
      { groupKey: "K2", title: "Series K2", teacherId: T1, coach: "Bank", dates: ["2026-10-14"] },
    ]);
    expect(out.wouldCreate).toBe(3);
    expect(writes).toEqual([]); // 🔑 the whole promise
    expect(inserts).toEqual([]);
  });

  test("…and through the ROUTE: `{}` from a human with the secret is a dry run answered in the response (200)", async () => {
    process.env.INTERNAL_JOB_SECRET = "s5";
    const writes = world([groupRow("K1", "2026-10-06")]);
    const res = await json("POST", "/internal/jobs/group-series-extender", { date: "2026-10-06" }, { "x-internal-secret": "s5" });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect({ dryRun: body.dryRun, wouldCreate: body.wouldCreate }).toEqual({ dryRun: true, wouldCreate: 2 });
    expect(writes).toEqual([]);
  });

  test("🔑 BOTH triggers send `apply: true` — a trigger that sent `{}` would report a plan every night and create nothing, green", () => {
    const ps1 = readFileSync(resolve(root, "sm-jobs/group-series-extender.ps1"), "utf8");
    expect(/-Body\s+'(\{[^']*\})'/.exec(ps1)?.[1] && JSON.parse(/-Body\s+'(\{[^']*\})'/.exec(ps1)![1]!)).toEqual({ apply: true });
    const exe = code(readFileSync(resolve(root, "scripts/group-series-extender.ts"), "utf8"));
    expect(exe).toContain("body: JSON.stringify({ apply: true }),");
  });

  test("📌 the default lives in the route's schema, not in a caller's good intentions", () => {
    const I = code(src("src/routes/internal.ts"));
    expect(I).toContain("apply: z.boolean().default(false),");
  });
});

// ═══════════════════ §2 bounds, reported ═══════════════════

describe("🔴 §2 the bounds — honoured, REPORTED, and resumable", () => {
  test("by value: `maxSeries: 1` over three series with work ⇒ one planned, and the rest SAID to be left", async () => {
    world([groupRow("K1", "2026-10-06"), groupRow("K2", "2026-10-07"), groupRow("K3", "2026-10-08")]);
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-10-06", { maxSeries: 1 });
    expect(out.plan.map((p: any) => p.groupKey)).toEqual(["K1"]);
    expect(out.truncated).toEqual({ bound: "maxSeries", limit: 1, seriesNotReached: 2 });
    expect(out.datesNotReached).toBe(2); // K2's 14-10 and K3's 15-10
  });

  test("📌 a COMPLETE series does not eat the budget — otherwise the first N finished series would block the rest for ever", async () => {
    // K1 is already stocked to the horizon; K2 is not. With maxSeries 1, K2 must still be reached.
    world([groupRow("K1", "2026-10-06"), groupRow("K1", "2026-10-13"), groupRow("K1", "2026-10-20"), groupRow("K2", "2026-10-07")]);
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-10-06", { maxSeries: 1 });
    expect(out.plan.map((p: any) => p.groupKey)).toEqual(["K2"]);
    expect(out.truncated).toBeNull();
  });

  test("by value: `maxDates` stops BEFORE a series that would cross it — a series is never half-extended", async () => {
    world([groupRow("K1", "2026-10-06"), groupRow("K2", "2026-10-07")]);
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-10-06", { maxDates: 2 });
    expect(out.plan.map((p: any) => [p.groupKey, p.dates.length])).toEqual([["K1", 2]]);
    expect(out.truncated).toEqual({ bound: "maxDates", limit: 2, seriesNotReached: 1 });
  });

  test("🔑 resumable for free: the next run over the rows the first created picks up exactly what was left", async () => {
    const first = [groupRow("K1", "2026-10-06"), groupRow("K2", "2026-10-07")];
    world([...first, groupRow("K1", "2026-10-13"), groupRow("K1", "2026-10-20")]); // K1 done by the first bite
    const out: any = await jobs.runGroupSeriesExtenderJob("2026-10-06", { maxSeries: 1 });
    expect(out.plan.map((p: any) => p.groupKey)).toEqual(["K2"]);
  });

  test("the defaults exist and the route validates them (a typo cannot mean 'no bound')", () => {
    expect([jobs.EXTENDER_DEFAULT_MAX_SERIES, jobs.EXTENDER_DEFAULT_MAX_DATES]).toEqual([25, 100]);
    const I = code(src("src/routes/internal.ts"));
    expect(I).toContain("maxSeries: z.number().int().min(1).max(500).optional(),");
    expect(I).toContain("maxDates: z.number().int().min(1).max(5000).optional(),");
  });
});

// ═══════════════════ §3 a long run and a dead process stop looking identical ═══════════════════

describe("🔴 §3 apply is ACKed with a run id; the `job_runs` row is the record of whether it finished", () => {
  const jobRunsWorld = (o: { failRun?: boolean; failUpdate?: boolean } = {}) => {
    const ledger: any[] = [];
    spies.push(spyOn(db, "insert").mockImplementation(((t: any) => ({ values: (v: any) => { ledger.push({ op: "insert", t: t === jobRuns ? "jobRuns" : "other", v }); return { returning: async () => [{ id: "run-1" }] }; } })) as any));
    spies.push(spyOn(db, "update").mockImplementation(((t: any) => ({ set: (v: any) => ({ where: async () => { if (o.failUpdate) throw new Error("57P03 recovery mode"); ledger.push({ op: "update", t: t === jobRuns ? "jobRuns" : "other", v }); } }) })) as any));
    if (o.failRun) spies.push(spyOn(jobs, "runGroupSeriesExtenderJob").mockImplementation((async () => { throw new Error("57P03 the database system is in recovery mode"); }) as any));
    return ledger;
  };

  test("by value: `running` is written FIRST, the caller gets the id at once, and the SAME row finishes as `success`", async () => {
    world([groupRow("K1", "2026-10-06")]);
    const ledger = jobRunsWorld();
    const r = await jobs.startGroupSeriesExtenderRun("2026-10-06", {});
    expect(r).toEqual({ runId: "run-1", status: "running" });
    expect(ledger[0]).toMatchObject({ op: "insert", t: "jobRuns", v: { job: "group-series-extender", status: "running" } });
    expect(ledger[0].v.finishedAt).toBeUndefined(); // 🔑 a running row has no finish — that absence IS the signal
    await tick();
    expect(ledger.at(-1)).toMatchObject({ op: "update", t: "jobRuns", v: { status: "success" } });
    expect(ledger.at(-1).v.finishedAt).toBeInstanceOf(Date);
  });

  test("a run that FAILS finishes its row as `failed` with the reason — it does not vanish", async () => {
    const errs: string[] = [];
    spies.push(spyOn(console, "error").mockImplementation(((...a: any[]) => { errs.push(a.map(String).join(" ")); }) as any));
    const ledger = jobRunsWorld({ failRun: true });
    await jobs.startGroupSeriesExtenderRun("2026-10-06", {});
    await tick();
    expect(ledger.at(-1)).toMatchObject({ op: "update", v: { status: "failed", summary: { error: expect.stringContaining("57P03") } } });
    expect(errs.some((e) => e.includes("run run-1 FAILED"))).toBe(true);
  });

  test("🔑 and when the DATABASE is what failed, the row stays `running` for ever — which is the honest record, and it is logged", async () => {
    const errs: string[] = [];
    spies.push(spyOn(console, "error").mockImplementation(((...a: any[]) => { errs.push(a.map(String).join(" ")); }) as any));
    const ledger = jobRunsWorld({ failRun: true, failUpdate: true });
    await jobs.startGroupSeriesExtenderRun("2026-10-06", {});
    await tick();
    expect(ledger.filter((l) => l.op === "update")).toEqual([]); // nothing could be recorded…
    expect(errs.some((e) => e.includes("could not record the failure of run run-1"))).toBe(true); // …and it says so
  });

  test("through the ROUTE: `apply: true` answers 202 with the run id; a second apply while one runs answers 409", async () => {
    process.env.INTERNAL_JOB_SECRET = "s6";
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    spies.push(spyOn(db, "insert").mockImplementation(((_t: any) => ({ values: () => ({ returning: async () => [{ id: "run-9" }] }) })) as any));
    spies.push(spyOn(db, "update").mockImplementation(((_t: any) => ({ set: () => ({ where: async () => {} }) })) as any));
    spies.push(spyOn(jobs, "runGroupSeriesExtenderJob").mockImplementation((async () => { await gate; return { dryRun: false }; }) as any));
    const first = await json("POST", "/internal/jobs/group-series-extender", { apply: true }, { "x-internal-secret": "s6" });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ runId: "run-9", status: "running" });
    const second = await json("POST", "/internal/jobs/group-series-extender", { apply: true }, { "x-internal-secret": "s6" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error.code).toBe("ALREADY_RUNNING");
    release();
    await tick();
  });

  test("📌 by source: the route no longer AWAITS an apply — the shape TASK-460 removed from the webhook", () => {
    const I = code(src("src/routes/internal.ts"));
    const R = region(I, `.post("/jobs/group-series-extender"`, "  })");
    expect(R).not.toContain("await jobs.runGroupSeriesExtenderJob(date, { apply: true");
    expect(R).toContain("await jobs.startGroupSeriesExtenderRun(date, { maxSeries, maxDates })");
    expect(R).toContain("return c.json(r, 202);");
  });
});

// ═══════════════════ §4 the process survives a database blip ═══════════════════

describe("🔴 §4 a rejection storm is logged and survived; an uncaught throw is logged and restarts clean", () => {
  test("by value: the registered `unhandledRejection` handler LOGS the reason and does NOT exit", () => {
    const exits: number[] = [];
    spies.push(spyOn(process, "exit").mockImplementation(((c?: number) => { exits.push(c ?? 0); }) as any));
    const errs: string[] = [];
    spies.push(spyOn(console, "error").mockImplementation(((...a: any[]) => { errs.push(a.map(String).join(" ")); }) as any));
    const ours = process.listeners("unhandledRejection").filter((l) => String(l).includes("still serving"));
    expect(ours).toHaveLength(1);
    ours[0]!(new Error("57P03 the database system is in recovery mode"), Promise.resolve());
    expect(errs.some((e) => e.includes("unhandledRejection") && e.includes("57P03"))).toBe(true);
    expect(exits).toEqual([]); // 🔑 a DB blip must not take the API down
  });

  test("by value: the `uncaughtException` handler LOGS and exits(1) — never 0, which a supervisor would read as a clean stop", () => {
    const exits: number[] = [];
    spies.push(spyOn(process, "exit").mockImplementation(((c?: number) => { exits.push(c ?? 0); }) as any));
    spies.push(spyOn(console, "error").mockImplementation(((..._a: any[]) => {}) as any));
    const ours = process.listeners("uncaughtException").filter((l) => String(l).includes("state unknown"));
    expect(ours).toHaveLength(1);
    ours[0]!(new Error("sync throw"), "uncaughtException");
    expect(exits).toEqual([1]);
  });

  test("🔴 my TASK-460 queue no longer manufactures an unhandled rejection: `.finally` on a rejecting promise rejects", () => {
    const S = code(src("src/services/line-webhook.service.ts"));
    const Q = region(S, "function onChatQueue(", "\n}\n");
    expect(Q).not.toContain(".finally(");
    expect(Q).toContain("void next.then(clear, clear);");
  });

  test("🔴 and a DB failure on the dedupe insert is INSIDE the try: the event finishes as `error` instead of rejecting", async () => {
    spies.push(spyOn(db, "insert").mockImplementation((() => { throw new Error("57P03 the database system is in recovery mode"); }) as any));
    const lineClient = await import("./line-client");
    spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async () => {}) as any)); // 🚫 never api.line.me
    const infos: string[] = [];
    spies.push(spyOn(console, "info").mockImplementation(((...a: any[]) => { infos.push(a.map(String).join(" ")); }) as any));
    spies.push(spyOn(console, "error").mockImplementation(((..._a: any[]) => {}) as any));
    const svc = await import("../services/line-webhook.service");
    await expect(
      svc.handleLineWebhookEvents([{ type: "postback", webhookEventId: "blip-1", replyToken: "r", source: { userId: "Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1" }, postback: { data: "action=x" } } as any]),
    ).resolves.toBeUndefined();
    expect(infos.some((i) => i.includes("FINISH id=blip-1") && i.includes("outcome=error"))).toBe(true);
  });
});
