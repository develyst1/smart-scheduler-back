// TASK-650 (QA re-test item 1) — the card's "ขยายได้ถึงสัปดาห์ที่ N" must come from the REAL expiry.
//
// 🔴 The defect: `maxWeek` was `maxWeekFor(size, quota)` — the CAPPED rule the owner deleted. Since TASK-646 the expiry stretches
//    one week per declared pre-start day, so a 4-session course with three of them expires in week 8 and the card said week 5.
//    **The dates were right; the label understated them.**
// 🔑 TASK-646's own cause, one level up: the expiry rule changed and a second READER of the old rule was left behind.
// 🚫 Fixed at the SOURCE, not on the card — fix it on one card and the next screen that shows a week number is wrong again.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LEAVE_QUOTA_BY_SIZE, courseLeaveQuota, maxWeekFor, toCourseSummary, weekOfExpiry } from "./leave";
import { courseExpiry } from "./recurring";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const START = "2026-11-02";
const WEEK = 7 * 24 * 3600 * 1000;
const plus = (d: string, w: number) => new Date(Date.parse(d) + w * WEEK).toISOString().slice(0, 10);
const course = (over: Partial<Parameters<typeof toCourseSummary>[0]> & { size: number }) => ({
  id: "c1", startDate: START, usedSessions: 0, leaveUsed: 0, adminUnlocked: false,
  expiryDate: courseExpiry(START, over.size), ...over,
});

describe("🔴 TASK-650 — an ORDINARY course is untouched: `size + quota`, at EVERY size", () => {
  test("the three card sizes, by value — 4→5 · 6→8 · 10→13 (the owner's own rule)", () => {
    expect(toCourseSummary(course({ size: 4 })).maxWeek).toBe(5);
    expect(toCourseSummary(course({ size: 6 })).maxWeek).toBe(8);
    expect(toCourseSummary(course({ size: 10 })).maxWeek).toBe(13);
  });
  test("…and EVERY size the table knows, derived rather than listed — so a new size cannot be forgotten here", () => {
    for (const size of Object.keys(LEAVE_QUOTA_BY_SIZE).map(Number)) {
      const c = course({ size });
      expect({ size, maxWeek: toCourseSummary(c).maxWeek }).toEqual({ size, maxWeek: maxWeekFor(size, courseLeaveQuota(c)) });
    }
  });
  test("🔑 an OFF-CARD size with its own stored quota still answers for itself (TASK-213's rule, unchanged)", () => {
    const c = course({ size: 8, leaveQuota: 2, expiryDate: courseExpiry(START, 8, 2) });
    expect(toCourseSummary(c).maxWeek).toBe(10); // 8 + 2
  });
});

describe("🔴 TASK-650 — a STRETCHED expiry is reported as the week it really reaches", () => {
  test("🔑 TANYA'S CASE: a 4-session course with 3 declared pre-start days expires in week 8, and the label says 8", () => {
    const stretched = plus(courseExpiry(START, 4), 3); // TASK-646's stretch: one week per declared day
    expect(toCourseSummary(course({ size: 4, expiryDate: stretched })).maxWeek).toBe(8);
  });
  test("…one week per week, at any number — the label tracks the expiry rather than a cap", () => {
    for (const n of [1, 2, 5, 12]) {
      const c = course({ size: 4, expiryDate: plus(courseExpiry(START, 4), n) });
      expect({ n, maxWeek: toCourseSummary(c).maxWeek }).toEqual({ n, maxWeek: 5 + n });
    }
  });
  test("⭐ an ADMIN-EXTENDED expiry becomes honest on the SAME line — it was mislabelled before, for the same reason", () => {
    // 📌 @Sober asked me to say whether this was wrong before. It was: the label never read the expiry, so ANY expiry change —
    // an admin extension included — left the week number at `size + quota`. This is not new work; it is the same line.
    const extended = plus(courseExpiry(START, 10), 4);
    expect(toCourseSummary(course({ size: 10, expiryDate: extended })).maxWeek).toBe(17); // 13 + 4
  });
});

describe("🔑 TASK-650 — the inverse itself, and what it refuses to do", () => {
  test("it is the inverse of `courseExpiry`: round-trips at every size", () => {
    for (const size of Object.keys(LEAVE_QUOTA_BY_SIZE).map(Number)) {
      expect({ size, w: weekOfExpiry(START, courseExpiry(START, size), 0) }).toEqual({ size, w: maxWeekFor(size, LEAVE_QUOTA_BY_SIZE[size]!) });
    }
  });
  test("⚠️ an expiry OFF a week boundary rounds UP — the label promises a ceiling, and a ceiling rounded down is a promise we do not keep", () => {
    const threeAndAHalf = new Date(Date.parse(START) + 3.5 * WEEK).toISOString().slice(0, 10);
    expect(weekOfExpiry(START, threeAndAHalf, 0)).toBe(5); // inside week 5, not the end of week 4
  });
  test("🔻 the label is the STORED expiry's week, ALWAYS — the FLOOR is gone; the base is only the fallback for a missing / unparseable expiry", () => {
    // CORRECTED, not deleted. The old claim: "🚫 it never reports LESS than the course's own base ceiling" (an expiry behind the base was "a data fault, not
    // a label's job"). It changed because the owner APPROVED «ใช้ได้ถึงสัปดาห์ที่ {week}» — "VALID until" — which makes the floor FALSE: a course whose expiry
    // was moved EARLIER (or an import with its own) was told it is valid until a week it will never reach (Tanya's "six courses still reading 13").
    expect(weekOfExpiry(START, plus(START, 0), 5)).toBe(1); // an expiry EARLIER than the base ⇒ the earlier week (week 1 = the start itself)
    expect(weekOfExpiry(START, plus(START, 2), 5)).toBe(3); // …and a middling one reads its own week, not the base
    expect(weekOfExpiry(START, courseExpiry(START, 4), 5)).toBe(5); // an ordinary course ⇒ unchanged
    expect(weekOfExpiry(START, null, 5)).toBe(5); // a missing expiry ⇒ the base
    expect(weekOfExpiry(START, "not-a-date", 5)).toBe(5); // an unparseable one ⇒ the base
  });
  test("🚫 `maxWeekFor` itself is untouched — `courseExpiry` still builds the BASE from it at creation", () => {
    expect(maxWeekFor(4, 1)).toBe(5);
    expect(code("src/lib/recurring.ts")).toContain("const weekNumber = maxWeekFor(size, quota ?? LEAVE_QUOTA_BY_SIZE[size] ?? 0);");
    // …and the summary now reads the stored expiry instead
    expect(code("src/lib/leave.ts")).toContain("const maxWeek = weekOfExpiry(c.startDate, c.expiryDate, maxWeekFor(c.size, quota));");
  });
});

describe("⭐ TASK-650 — the SEAM, as TASK-647's test did it: the server's number through the card's own string", () => {
  // The card prints: "ใช้ไป {used}/{quota} · ขยายได้ถึงสัปดาห์ที่ {week}" — Team B's, and it must not have to change.
  const cardUsage = (s: { leaveUsed: number; leaveQuota: number; maxWeek: number }) =>
    `ใช้ไป ${s.leaveUsed}/${s.leaveQuota} · ขยายได้ถึงสัปดาห์ที่ ${s.maxWeek}`;

  test("🔴 Tanya's course: the week the card prints is the week the MAKE-UPS actually reach", () => {
    const declared = 3;
    const expiryDate = plus(courseExpiry(START, 4), declared); // what TASK-646 writes on the path
    const lastMakeup = plus(plus(START, 3), declared); // the plan's last session, then one make-up per declared day
    const summary = toCourseSummary(course({ size: 4, expiryDate }));
    // the make-up falls inside the week the card now advertises…
    const weekOfLastMakeup = Math.ceil((Date.parse(lastMakeup) - Date.parse(START)) / WEEK) + 1;
    expect(summary.maxWeek).toBeGreaterThanOrEqual(weekOfLastMakeup);
    // …and the string itself says so
    expect(cardUsage(summary)).toBe("ใช้ไป 0/1 · ขยายได้ถึงสัปดาห์ที่ 8");
  });
  test("🚫 and for an ordinary course the card's string is BYTE-IDENTICAL to what it printed before this change", () => {
    const summary = toCourseSummary(course({ size: 6, leaveUsed: 1 }));
    expect(cardUsage(summary)).toBe("ใช้ไป 1/2 · ขยายได้ถึงสัปดาห์ที่ 8"); // 🔑 invisible to a course with nothing declared
  });
});
