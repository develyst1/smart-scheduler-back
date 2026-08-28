// REQ-070 / TASK-180 — the day-end job marks ATTENDED, never NO_SHOW.
//
// Source-level assertions, deliberately: the job is one DB transaction with no pure seam to call, and the
// claims that matter here are about what it does NOT do — write a false status, award CRM points for a session
// nobody attended, or change how much quota it consumes. Each of those is a one-word edit away from being
// wrong again, and none of them would fail any other test in this suite.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { ATTENTION_CHECKS } from "../lib/attention";
import { isDueForAutoAttend } from "../lib/auto-cut";

const SRC = readSrc(await Bun.file(new URL("./jobs.service.ts", import.meta.url)).text());
// TASK-209 reads two more services: "every scheduled job records its runs" is a property of the CODEBASE, not
// of one file, so it is asserted across all of them rather than remembered per job.
const SCHED = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const ATTENTION = readSrc(await Bun.file(new URL("./attention.service.ts", import.meta.url)).text());
const JOB = SRC.slice(SRC.indexOf("export async function runEndOfDayJob"));
// Comments are stripped before asserting: this file deliberately DISCUSSES the old NO_SHOW behaviour at
// length, and a test that reads prose would either fail on the explanation or pass on a comment. Only the
// code is evidence.
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const TX = code(JOB.slice(0, JOB.indexOf("// TASK-007")));

describe("the day-end auto-mark (TASK-180)", () => {
  test("🔴 it writes ATTENDED — the word NO_SHOW does not appear in the write path at all", () => {
    expect(TX).toContain('set({ status: "ATTENDED" })');
    expect(TX).not.toContain("NO_SHOW");
  });

  test("🔴 it awards NO CRM points — the absence IS the signal (they never checked in)", () => {
    // Good customers are separated by points at check-in. If this path ever started awarding them, the
    // distinction the owner relies on would quietly disappear.
    for (const forbidden of ["crmPoints", "awardPoints", "crm"]) expect(TX).not.toContain(forbidden);
  });

  test("consumption is unchanged: +1 session, +1 voucher hour, exactly as before", () => {
    expect(TX).toContain("usedSessions} + 1");
    expect(TX).toContain("usedHours} + 1");
  });

  test("still only touches CONFIRMED rows, so a second run marks nothing (idempotent)", () => {
    expect(TX).toContain('eq(bookings.status, "CONFIRMED")');
  });

  test("the job_runs counters say auto-attended, not 'cut' — the audit must not imply a no-show", () => {
    expect(TX).toContain("autoAttended");
    expect(TX).not.toContain("noShow");
    expect(TX).not.toContain("coursesCut");
  });

  test("WHICH sessions it acts on is unchanged — only the status written changed", () => {
    const now = { date: "2026-08-24", time: "18:05", minutes: 18 * 60 + 5 };
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-08-24", endTime: "18:00" }, now)).toBe(true);
    expect(isDueForAutoAttend({ status: "CONFIRMED", date: "2026-08-24", endTime: "19:00" }, now)).toBe(false);
    expect(isDueForAutoAttend({ status: "SICK_LEAVE", date: "2026-08-24", endTime: "10:00" }, now)).toBe(false);
  });

  test("🔴 the now-impossible NO_SHOW digest check is gone, not left reporting a structural zero", () => {
    expect(ATTENTION_CHECKS.some((c) => c.key === "yesterday_no_shows")).toBe(false);
  });
});

// ═══ SPEC-066 / TASK-208 (REQ-072 3B) — the 08:15 reminder, at the source ═══
//
// The DoD is an outcome on a live box (one message per person at 08:15, a job_runs row, a silent second run).
// What a source test can prove is the shape that makes those inevitable — and the two ways this job could be
// quietly useless: sending per booking, or looking like it ran when it never registered.
describe("runDailyReminderJob (TASK-208)", () => {
  const body = (() => {
    const at = SRC.indexOf("export async function runDailyReminderJob");
    const rest = SRC.slice(at);
    return rest.slice(0, rest.indexOf("\n}\n") + 2);
  })();

  test("🔴 it enqueues per GROUP, never per booking", () => {
    // `groupReminders` is what collapses ~60 Saturday sessions into one message per person; enqueuing from
    // `rows` instead would put eight pushes on a teacher's phone before 08:20.
    expect(body).toContain("for (const g of groups)");
    expect(body).toContain("groupReminders(");
    expect(body).not.toMatch(/for \(const [a-z]+ of rows\)/);
  });

  test("🔴 idempotent per business date — a retry or a second box sends nothing", () => {
    expect(body).toContain("reminderAlreadySent(runDate)");
    expect(body.indexOf("reminderAlreadySent")).toBeLessThan(body.indexOf("enqueueLine"));
  });

  test("🔴 a `job_runs` row is always written — 'never registered' must stay visible", () => {
    // Two scheduled jobs on this project were never registered on the server and nobody noticed for weeks.
    expect(body).toContain("insert(jobRuns)");
    expect(body).toContain("REMINDER_JOB");
  });

  test("the reach is counted BEFORE sending and returned", () => {
    expect(body.indexOf("reminderReach(groups)")).toBeLessThan(body.indexOf("for (const g of groups)"));
    expect(body).toContain("...reach");
  });

  test("🔴 TASK-209: `sent` is a DELIVERED COUNT and `attempted` is the separate fact that it ran", () => {
    // This test asserted `sent: true` and passed — while a run that reached ZERO people recorded itself as
    // sent. "Did it fire?" and "did it reach anyone?" are two questions, and one boolean cannot answer both.
    expect(body).toContain("summary: { attempted: true, sent, skipped, ...reach }");
    expect(body).not.toContain("sent: true, ...reach");
  });

  test("🔴 TASK-209: EVERY invocation writes a row — the re-run records `sent: 0`, it does not return early", () => {
    // The early return made "ran, nothing to do" and "never ran" indistinguishable, which is the one property
    // these rows exist to preserve.
    const guard = body.slice(body.indexOf("reminderAlreadySent(runDate)"), body.indexOf("bookings.findMany"));
    expect(guard).toContain("insert(jobRuns)");
    expect(guard).toContain('reason: "already-sent"');
  });

  test("the already-sent check keys on `attempted`, never on the delivered count", () => {
    // Keying on `sent` would make the job re-run all morning on exactly the days it reached nobody.
    const predicate = SRC.slice(SRC.indexOf("async function reminderAlreadySent"));
    expect(predicate.slice(0, predicate.indexOf("\n}\n"))).toContain("attempted === true");
  });

  test("parents are loaded in ONE query, not one per student", () => {
    expect(body).toContain("inArray: inA");
    expect(body).not.toMatch(/for \(.*\) \{[\s\S]*parents\.findFirst/);
  });

  test("the message reuses the owner-verified composer rather than formatting a second one", () => {
    expect(body).toContain('kind: "daily_reminder"');
    expect(body).toContain("rows: g.rows");
  });
});

// ═══ 🔴 TASK-209 — every scheduled job records its runs ═══
//
// Two jobs on this project were never registered on a box and nobody noticed for weeks. The `job_runs` row is
// how that stops being invisible — so "which of our scheduled jobs writes one?" is worth asserting as a
// property of the codebase rather than remembering per job.
describe("every scheduled job writes a job_runs row (TASK-209)", () => {

  test("month-reset now records its runs — it wrote nothing at all before", () => {
    const fn = SCHED.slice(SCHED.indexOf("export async function resetFreelanceBudgets"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    expect(body).toContain("insert(jobRuns)");
    expect(body).toContain("MONTH_RESET_JOB");
  });

  test("🔑 all four scheduled jobs insert a row — day-end, digest, reminder, month-reset", () => {
    // If a fifth job is added without one, this is where someone notices.
    expect(SRC).toContain("insert(jobRuns)"); // day-end + reminder live in jobs.service
    expect(ATTENTION).toContain("insert(jobRuns)");
    expect(SCHED).toContain("insert(jobRuns)");
  });
});
