// REQ-070 / TASK-180 — the day-end job marks ATTENDED, never NO_SHOW.
//
// Source-level assertions, deliberately: the job is one DB transaction with no pure seam to call, and the
// claims that matter here are about what it does NOT do — write a false status, award CRM points for a session
// nobody attended, or change how much quota it consumes. Each of those is a one-word edit away from being
// wrong again, and none of them would fail any other test in this suite.
import { describe, expect, test } from "bun:test";
import { ATTENTION_CHECKS } from "../lib/attention";
import { isDueForAutoAttend } from "../lib/auto-cut";

const SRC = await Bun.file(new URL("./jobs.service.ts", import.meta.url)).text();
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
