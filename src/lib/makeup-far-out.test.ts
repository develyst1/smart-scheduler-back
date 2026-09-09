// TASK-309 (REQ-085 §12) — the last refusal, and the search that gave up in silence.
//
// 🔑 Both halves came out of TASK-308: the one live caller I refused to call dead, and the 26-week scan whose
// backstop I had just deleted.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { firstFreeWeeklySlot, MAX_EXTENSION_WEEKS_SCANNED, searchExhausted, weeksBetween } from "./extension-slot";
import { courseBornCeiling } from "./course-plan";
import { courseExpiry } from "./recurring";
import { addDays } from "./time";
import { formatOutboxMessage } from "./line-message";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/scheduler.service.ts"));

const START = "2026-09-01";
const week = (n: number) => addDays(START, (n - 1) * 7);

describe("🔑 TASK-309 §2 — the creation preview refuses NOTHING", () => {
  test("🔴 the owner's `Create plan` case: 4 sessions, 3 declared absences", () => {
    // He was shown *"This course can only extend to week 5 — reduce the planned absences or pick a different
    // start date"*, with the button disabled: **told to change what he wanted because a date could not move.**
    // The boundary the preview reports now covers the plan it describes.
    const born = courseBornCeiling(courseExpiry(START, 4), week(4), 3);
    expect(born).toBe(week(7)); // the plan's own end — nothing to exceed
  });

  test("🔑 `exceedsCeiling` cannot be true — by construction, not by luck", () => {
    // The ceiling is widened to the furthest session in `sessions`, and `exceedsCeiling` asks whether any
    // session exceeds it. ⚠️ Asserted on the SHAPE, because that is what makes it unfalsifiable: a `max` over
    // the same array it is then compared against.
    expect(SVC).toContain("const previewCeiling = sessions.reduce(");
    expect(SVC).toContain("(m, sn) => (sn.date > m ? sn.date : m),");
    expect(SVC).toContain("sessions.some((s) => exceedsExtensionCeiling(s.date, previewCeiling))");
    // …and the arithmetic itself: max(xs) is never exceeded by any member of xs.
    const dates = [week(1), week(4), week(9), week(2)];
    const ceiling = dates.reduce((m, d) => (d > m ? d : m), week(1));
    expect(dates.some((d) => d > ceiling)).toBe(false);
  });

  test("🚫 …and the field still EXISTS on the DTO — the FE gate goes first", () => {
    // §2: a removed field is a contract change, and the FE reads this one to disable `Create plan`.
    // 📌 Two repos, two tasks, one order — never both at once.
    expect(SVC).toContain("exceedsCeiling:");
    expect(code(src("src/types/contract.ts")) + SVC).toContain("exceedsCeiling");
  });
});

describe("🔴 TASK-309 §3 — the search gives up, and someone is TOLD", () => {
  const from = "2026-09-01";

  test("🔑 `searchExhausted` tells a found slot from a surrendered one", () => {
    // `firstFreeWeeklySlot` returns the last candidate either way, so the only signal is the DISTANCE: a
    // success lands at or before `from + maxWeeks` weeks, exhaustion one week beyond.
    expect(searchExhausted(from, addDays(from, MAX_EXTENSION_WEEKS_SCANNED * 7))).toBe(false);
    expect(searchExhausted(from, addDays(from, (MAX_EXTENSION_WEEKS_SCANNED + 1) * 7))).toBe(true);
  });

  test("🔴 a slot booked solid: the search surrenders, and the fact is measurable", async () => {
    // Every week occupied ⇒ the loop runs out and hands back week 27.
    const landed = await firstFreeWeeklySlot(from, () => true);
    expect(landed).toBe(addDays(from, (MAX_EXTENSION_WEEKS_SCANNED + 1) * 7));
    expect(searchExhausted(from, landed)).toBe(true);
    expect(weeksBetween(from, landed)).toBe(MAX_EXTENSION_WEEKS_SCANNED + 1);
  });

  test("🔑 the leave SUCCEEDS and the ADMIN is told — both halves", async () => {
    // ⚠️ *The success without the warning is the silence this task exists to end.*
    // 🚫 Not refused: nothing on this path throws. 🚫 Not the parent: they asked for a leave and got one.
    const append = SVC.slice(SVC.indexOf("for (const a of plan.append) {"), SVC.indexOf("return { appended, cancelled };"));
    expect(append).not.toContain("throw");
    expect(append).toContain("if (searchExhausted(fromDate, extDate)) {");
    expect(append).toContain("await notifyAdmins(");
    expect(append).toContain('kind: "makeup_far_out",');
    expect(append).not.toContain("recipientType: \"parent\"");
  });

  test("🔑 a NORMAL make-up warns NOBODY", async () => {
    // A warning that fires every time is not a warning — and this one would land on the admin every leave.
    const landed = await firstFreeWeeklySlot(from, () => false);
    expect(landed).toBe(addDays(from, 7));
    expect(searchExhausted(from, landed)).toBe(false);
    // …and one that skipped a few busy weeks is still normal.
    const busy = new Set([addDays(from, 7), addDays(from, 14)]);
    const after = await firstFreeWeeklySlot(from, (d) => busy.has(d));
    expect(searchExhausted(from, after)).toBe(false);
  });

  test("⚠️ the alert reports HOW FAR — the fact, not a verdict", async () => {
    // 📌 §3: report the fact and let @Porter take a number to the owner. The message decides nothing.
    const msg = formatOutboxMessage(
      { kind: "makeup_far_out", weeks: 27, replaces: "2026-09-01", landedOn: "2027-03-09" } as any,
      {},
      "TH",
    );
    expect(msg).toContain("27");
    expect(msg).toContain("2026-09-01");
    expect(msg).toContain("2027-03-09");
    // 🚫 Not the generic fallback — an unrouted kind would tell an admin nothing at all.
    expect(msg).not.toContain("แจ้งเตือนจากระบบ");
  });

  test("🔻 the comment that outlived its mechanism is corrected", () => {
    // It said the caller's ceiling refuses this — and §12 deleted that caller. For one day the function did
    // exactly what its comment promised it never would.
    // ⚠️ Asserted as the RETRACTION being present rather than the old sentence being absent: the correction
    // quotes the claim it withdraws, so `not.toContain` would fail on my own explanation. (It did.)
    const SLOT = src("src/lib/extension-slot.ts");
    expect(SLOT).toContain("REQ-085 §12` deleted that guard");
    expect(SLOT).toContain("for one day this");
    // …and the claim survives only INSIDE the quotation that withdraws it.
    expect((SLOT.match(/never silently invents a valid-looking date/g) ?? []).length).toBe(1);
    expect(SLOT).toContain('*"the caller\'s ceiling guard');
    // 🚫 And the scan limit itself is untouched — §5.
    expect(SLOT).toContain("export const MAX_EXTENSION_WEEKS_SCANNED = 26;");
  });
});
