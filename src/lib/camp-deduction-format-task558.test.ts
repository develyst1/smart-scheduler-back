// TASK-558 (REQ-110 item 12) — the day-end camp-deduction notice in the CUSTOMER's own format. A REFORMAT: same kind, same
// sender, same recipient (the family only). The four lines are Khwan's, verbatim:
//   🏕️ BALANCE CAMP / Student: โมล่า / Date: 28-09-2026 / Remaining: 0 / 0.5 days
// 🔑 Every figure comes from what the sender ALREADY carries — `notifyCampDeductions` puts `studentName`, `date`, `remainingDays`
// and `totalDays` in the payload (TASK-443). No sender change: this file drives the REAL sender into the REAL renderer.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { renderCampDeduction } from "./camp-deduction";
import * as camp from "../services/camp.service";
import * as familyLink from "./family-link";
import * as lineLib from "./line";

const root = resolve(import.meta.dir, "..", "..");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** One camp day through the real day-end pass; returns the payload it enqueued (the family's one row). */
const sentPayload = async (pkg: { totalUnits: number; usedUnits: number; nickname: string | null; name: string }, date: string) => {
  const tx: any = {
    query: { campDays: { findMany: async () => [{ id: "d1", campPackageId: "p1", date, status: "ATTENDED",
      package: { id: "p1", studentId: "s1", totalUnits: pkg.totalUnits, usedUnits: pkg.usedUnits, student: { id: "s1", name: pkg.name, nickname: pkg.nickname } } }] } },
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async () => ["U-family"]) as any));
  const sends: any[] = [];
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { sends.push(o); return { status: "queued" } as any; }) as any));
  await camp.notifyCampDeductions(tx, date);
  expect(sends.map((s) => [s.recipientType, s.recipientLineUserId])).toEqual([["parent", "U-family"]]); // 🚫 recipient unchanged: the family only
  return sends[0].payload;
};

describe("🔴 TASK-558 — the camp-deduction notice in Khwan's format, every figure from the sender's own payload", () => {
  test("🔑 Khwan's OWN example, by value, end to end: a half-day package (1 unit), its only half-day consumed ⇒ `0 / 0.5 days`", async () => {
    const payload = await sentPayload({ totalUnits: 1, usedUnits: 1, nickname: "โมล่า", name: "Mola Full" }, "2026-09-28");
    const expected = "🏕️ BALANCE CAMP\nStudent: โมล่า\nDate: 28-09-2026\nRemaining: 0 / 0.5 days";
    for (const lang of ["TH", "EN"] as const) expect(formatOutboxMessage(payload, {} as any, lang, "parent")).toBe(expected); // English only: identical in both
  });
  test("the SHAPE: four lines, this order, `Label: value` with NO space before the colon, `DD-MM-YYYY`, ` / ` between the figures", () => {
    const lines = renderCampDeduction({ studentName: "โมล่า", date: "2026-09-28", remainingDays: 0, totalDays: 0.5 }).split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe("🏕️ BALANCE CAMP");
    expect(lines[1]).toMatch(/^Student: \S/);
    expect(lines[2]).toMatch(/^Date: \d{2}-\d{2}-\d{4}$/);
    expect(lines[3]).toMatch(/^Remaining: \d+(\.5)? \/ \d+(\.5)? days$/);
    expect(lines.join("\n")).not.toContain(" : "); // 🚫 NOT the house `Label : ` style — the customer's format differs on purpose
  });
  test("📌 halves and zeros are the NORMAL case: units → days as the sender computes them (AM/PM = 0.5, FULL = 1)", async () => {
    const cases: Array<[number, number, string]> = [
      [1, 1, "Remaining: 0 / 0.5 days"],   // her example: nothing left of a half day
      [3, 0, "Remaining: 1.5 / 1.5 days"], // a half remaining
      [4, 4, "Remaining: 0 / 2 days"],     // zero of a whole number — `0`, never blank
      [10, 3, "Remaining: 3.5 / 5 days"],  // `5`, never `5.0`
    ];
    for (const [totalUnits, usedUnits, line] of cases) {
      for (const s of spies.splice(0)) s.mockRestore();
      const out = formatOutboxMessage(await sentPayload({ totalUnits, usedUnits, nickname: "โมล่า", name: "x" }, "2026-09-28"), {} as any, "TH", "parent");
      expect({ totalUnits, usedUnits, line: out.split("\n")[3] }).toEqual({ totalUnits, usedUnits, line });
    }
  });
  test("🚫 English only stays pinned where a reader would 'fix' it: the renderer names the rule and has no `t()` / `lang`", () => {
    const R = readFileSync(resolve(root, "src/lib/camp-deduction.ts"), "utf8");
    expect(R).toContain('do not "harmonise" it, and do not add `t()`');
    expect(R.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/\bt\(|\blang\b|line-i18n/);
  });
});
