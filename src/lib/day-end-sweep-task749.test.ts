// 🔻 TASK-749 (REQ-130) — the day-end ALSO posts the last 7 days' ATTENDED trial / 1 HR / priced OTHER rows that never reached the books. `runEndOfDayJob` needs a database, so (as every test of that file
// always has) the WINDOW and the SELECTION are pinned by value here — the real `postingWhere` is rendered to SQL by the real dialect — and the job's WIRING by source. The money itself (price / discount
// resolution, `postOtherBookingSale`, the generation-aware `rev:<id>[#n]` key) is the existing per-booking path and is not re-implemented anywhere in this task.
import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { POSTING_TYPES, SWEEP_WINDOW_DAYS, hasStarted, isSwept, postingWhere, startedSql, sweepDates } from "./day-end-sweep";
import { NOT_POSTED_WINDOW_DAYS } from "./attention";
import { revKey } from "./sale-post";
import { readSrc } from "./read-src";

const JOBS = readSrc(await Bun.file(new URL("../services/jobs.service.ts", import.meta.url)).text());
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const render = (runDate: string) => { const q = new PgDialect().sqlToQuery(postingWhere(runDate)!); return { text: q.sql, params: q.params as unknown[] }; };
/** The posting block of the job: from the attended select to the webhook sweep that follows it. */
const POSTING = (() => { const a = JOBS.indexOf("const attended = await db"); return code(JOBS.slice(a, JOBS.indexOf("TASK-460", a))); })();
/** The two posting paths (REOPENED: each skips a live row first). */
const TRIAL_FN = code(JOBS.slice(JOBS.indexOf("export async function postTrialOrSingleSale"), JOBS.indexOf("export async function postOtherBookingSale")));
const OTHER_FN = code(JOBS.slice(JOBS.indexOf("export async function postOtherBookingSale"), JOBS.indexOf("export async function postOtherBookingSale") + 6000));
/** Everything BEFORE the posting block — the auto-attend. */
const AUTO_ATTEND = code(JOBS.slice(JOBS.indexOf("export async function runEndOfDayJob"), JOBS.indexOf("const attended = await db")));

describe("🔒 TASK-749 — the window is ONE named constant, the digest's own", () => {
  test("SWEEP_WINDOW_DAYS === NOT_POSTED_WINDOW_DAYS === 7: what «Sales not posted» names, the sweep can reach", () => {
    expect(SWEEP_WINDOW_DAYS).toBe(NOT_POSTED_WINDOW_DAYS);
    expect(SWEEP_WINDOW_DAYS).toBe(7);
  });
  test("the posting types are the three that post at the day-end (course / voucher recognise revenue at SALE)", () => {
    expect([...POSTING_TYPES]).toEqual(["FIRST_TRIAL", "SINGLE_SESSION", "OTHER"]);
  });
});

describe("🔴 TASK-749 — sweepDates: runDate − 7 … runDate, oldest first", () => {
  test("eight dates; the oldest is 7 days back, the newest is runDate", () => {
    expect(sweepDates("2026-10-25")).toEqual(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  });
  test("across a month and a year boundary", () => {
    expect(sweepDates("2026-11-03")[0]).toBe("2026-10-27");
    expect(sweepDates("2027-01-03")[0]).toBe("2026-12-27");
    expect(sweepDates("2026-11-03")).toHaveLength(8);
  });
  test("a row 8 days old is NOT in the window; 7 days old is", () => {
    expect(sweepDates("2026-10-25")).not.toContain("2026-10-17");
    expect(sweepDates("2026-10-25")).toContain("2026-10-18");
  });
});

describe("🔴 TASK-749 — postingWhere, rendered to SQL by the real dialect", () => {
  const { text, params } = render("2026-10-25");
  test("the 8 dates, ATTENDED, and exactly the three posting types — nothing else", () => {
    expect(params.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(String(p)))).toEqual(sweepDates("2026-10-25"));
    expect(params).toContain("ATTENDED");
    expect(params.filter((p) => POSTING_TYPES.includes(p as never))).toEqual(["FIRST_TRIAL", "SINGLE_SESSION", "OTHER"]);
    expect(params).toHaveLength(8 + 1 + 3);
  });
  test("an undone attendance (CONFIRMED again) is not selected: the status term is ATTENDED only", () => {
    for (const s of ["CONFIRMED", "CANCELLED", "PENDING", "NO_SHOW", "SICK_LEAVE", "PAUSED"]) expect(params).not.toContain(s);
    expect(text).toContain('"bookings"."status" = $');
  });
  test("a course / voucher / group row is not selected", () => {
    for (const t of ["COURSE_PACKAGE", "VOUCHER", "GROUP"]) expect(params).not.toContain(t);
  });
  test("the window follows the run date (a run on the 1st reaches into the month before)", () => {
    expect(render("2026-11-01").params.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(String(p)))[0]).toBe("2026-10-25");
  });
});

describe("🔴 TASK-749 — a row older than runDate is a SWEPT one (counted apart)", () => {
  test("yesterday and 7 days back are swept; today is not; (a future date cannot be ATTENDED, but is not swept either)", () => {
    expect(isSwept("2026-10-24", "2026-10-25")).toBe(true);
    expect(isSwept("2026-10-18", "2026-10-25")).toBe(true);
    expect(isSwept("2026-10-25", "2026-10-25")).toBe(false);
    expect(isSwept("2026-10-26", "2026-10-25")).toBe(false);
  });
});

describe("🔴 TASK-749 — idempotency is the KEY's, and generation-aware (no pre-filter)", () => {
  test("a second run builds the SAME key for the same booking & generation; the re-attend case gets its NEXT generation", () => {
    expect(revKey("b1", 0)).toBe("rev:b1");
    expect(revKey("b1", 0)).toBe(revKey("b1", 0)); // a second run: the same key ⇒ `recordSale` returns «duplicate», nothing more is written
    expect(revKey("b1", 1)).toBe("rev:b1#1"); // undone then attended again ⇒ a new key ⇒ posted once
    expect(revKey("b1", 1)).not.toBe(revKey("b1", 0));
  });
});

describe("🔴 TASK-749 — the job's wiring (by source)", () => {
  test("the posting block selects through `postingWhere(runDate)` (not `date = runDate`) and reads the row's date", () => {
    expect(POSTING).toContain(".where(postingWhere(runDate))");
    expect(POSTING).toContain("date: bookings.date,");
    expect(POSTING).not.toContain("eq(bookings.date, runDate)");
  });
  test("ONE loop posts every selected row through the SAME two paths: a priced OTHER via `postOtherBookingSale`, a trial / 1 HR via `postTrialOrSingleSale` (`recordSale` with the generation-aware key)", () => {
    expect(POSTING.match(/for \(const b of attended\)/g)).toHaveLength(1);
    expect(POSTING).toContain('const posted = b.bookingType === "OTHER" ? await postOtherBookingSale(b) : await postTrialOrSingleSale(b);');
    expect(TRIAL_FN).toContain("const generation = await revGeneration(b.id);");
    expect(TRIAL_FN).toContain("idempotencyKey: revKey(b.id, generation),");
  });
  test("🚫 NO pre-filter by «has a SALE movement» in the loop — the loop has no `continue` at all; the only skip is the LIVE check inside each path (sales > reversals), which is generation-aware", () => {
    expect(POSTING).not.toMatch(/boMovement|SALE_SOURCE|hasSale|alreadyPosted|saleMovement|\bcontinue;/);
    expect(POSTING.match(/\bswept\b/g)).toHaveLength(2); // the declaration + the counter line
  });
  test("🔴 REOPENED (TEST-123, the double post): BOTH paths skip a LIVE row BEFORE posting — the trial path first thing, the OTHER path right after its uncharged guard — and before any generation is read", () => {
    expect(TRIAL_FN.indexOf("if (await liveRevenue(b.id)) return false;")).toBeGreaterThan(-1);
    expect(TRIAL_FN.indexOf("liveRevenue(b.id)")).toBeLessThan(TRIAL_FN.indexOf("resolvePriceGroup"));
    expect(TRIAL_FN.indexOf("liveRevenue(b.id)")).toBeLessThan(TRIAL_FN.indexOf("revGeneration(b.id)"));
    const guard = OTHER_FN.indexOf("if (b.otherPriceMinor == null && b.otherPriceItemId == null) return false;");
    const live = OTHER_FN.indexOf("if (await liveRevenue(b.id)) return false;");
    expect(guard).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(guard); // an UNCHARGED booking still touches no ledger at all (AC-4)
    expect(live).toBeLessThan(OTHER_FN.indexOf("revGeneration(b.id)"));
  });
  test("a double post: each path posts a row ONCE", () => {
    expect(POSTING.match(/postOtherBookingSale\(/g)).toHaveLength(1);
    expect(POSTING.match(/postTrialOrSingleSale\(/g)).toHaveLength(1);
    expect(TRIAL_FN.match(/recordSale\(/g)).toHaveLength(1);
    expect(POSTING.match(/sweptPosted\+\+/g)).toHaveLength(1);
    expect(POSTING).toContain("if (posted) { if (swept) sweptPosted++; else revenuePosted++; }");
  });
  test("the count: `revenuePosted` stays today's; older rows go to `sweptPosted`, which is in the job summary", () => {
    expect(POSTING).toContain("isSwept(b.date, runDate)");
    expect(POSTING).toContain("sweptPosted");
    expect(code(JOBS)).toContain("const summary = { ...marked, revenuePosted, sweptPosted, webhookEventsSwept: swept.length, report };");
  });
  test("🚫 the POSTING block only posts: it writes no booking (no status update, no quota)", () => {
    expect(POSTING).not.toMatch(/\.update\(|usedSessions|usedHours/);
  });
  test("🔁 WIDENED — the auto-attend takes every day of the window; the clause keeps CONFIRMED only (never EXTENDED / PENDING), the START gate, and the undo guard", () => {
    expect(AUTO_ATTEND).toContain('.where(and(inArray(bookings.date, sweepDates(runDate)), eq(bookings.status, "CONFIRMED"), startedSql(now), notUndoneAttendance()));');
    expect(AUTO_ATTEND).not.toMatch(/EXTENDED|PENDING|inArray\(bookings\.status/);
    expect(AUTO_ATTEND).not.toContain("eq(bookings.date, runDate)");
    expect(AUTO_ATTEND).not.toContain("const ended"); // the per-day gate is `startedSql`
  });
  test("the auto-attend writes ATTENDED, so a second run finds nothing (one quota cut, one deduction message per class)", () => {
    expect(AUTO_ATTEND).toContain('status: "ATTENDED"');
    expect(AUTO_ATTEND.match(/usedSessions\} \+ 1/g)).toHaveLength(1);
    expect(AUTO_ATTEND.match(/notifyCourseDeduction\(/g)).toHaveLength(2); // the course branch and the voucher branch — one each
  });
  test("best-effort as today: the posting is not wrapped into anything that can fail the job (no new throw)", () => {
    expect(POSTING).not.toMatch(/throw /);
  });
});

describe("🔁 TASK-749 (widened) — the auto-attend is START-based over the window", () => {
  const NOW = { date: "2026-10-25", time: "17:30" };
  test("a class confirmed after day D's run, START passed ⇒ cut by D+1's run (D is in D+1's window); 8 days old ⇒ untouched", () => {
    expect(sweepDates("2026-10-26")).toContain("2026-10-25");
    expect(sweepDates("2026-10-25")).not.toContain("2026-10-17");
  });
  test("hasStarted: a past date ⇒ all of it; today ⇒ only what has STARTED at the clock (17:00 at 17:30 yes, 17:45 no, 17:30 sharp yes); a future date ⇒ none", () => {
    expect(hasStarted("2026-10-24", "17:45", NOW)).toBe(true); // yesterday: even its last class
    expect(hasStarted("2026-10-18", "09:00", NOW)).toBe(true);
    expect(hasStarted("2026-10-25", "17:00", NOW)).toBe(true);
    expect(hasStarted("2026-10-25", "17:30", NOW)).toBe(true);
    expect(hasStarted("2026-10-25", "17:45", NOW)).toBe(false); // today, not started yet ⇒ untouched
    expect(hasStarted("2026-10-26", "09:00", NOW)).toBe(false); // a future date ⇒ none
  });
  test("startedSql is the SAME rule in SQL: date < today OR (date = today AND start_time <= now), with the clock as parameters", () => {
    const q = new PgDialect().sqlToQuery(startedSql(NOW));
    expect(q.sql).toBe('("bookings"."date" < $1 or ("bookings"."date" = $2 and "bookings"."start_time" <= $3::time))');
    expect(q.params).toEqual(["2026-10-25", "2026-10-25", "17:30"]);
  });
  test("🔴 18:20 on day D (after D's 17:30 run): a trial marked ATTENDED then is posted by D+1's 17:30 run, ONCE — D is in D+1's window, the row is selected, its key is the same on a second run", () => {
    const D = "2026-10-25";
    expect(sweepDates("2026-10-26")).toContain(D);
    const w = new PgDialect().sqlToQuery(postingWhere("2026-10-26")!);
    expect(w.params).toContain(D);
    expect(w.params).toContain("ATTENDED");
    expect(isSwept(D, "2026-10-26")).toBe(true); // counted in sweptPosted
    expect(revKey("trial-1", 0)).toBe(revKey("trial-1", 0)); // D+2's run builds the same key ⇒ «duplicate», nothing more
  });
});
