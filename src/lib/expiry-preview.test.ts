// TASK-298 (REQ-085 §11.3) — the expiry warning arrived AFTER the save. The gap is one word wide: **BEFORE.**
//
// 🔑 @Porter's reason is the acceptance criterion, not the rule: **DEF-4 was an expiry preceding the course's
// own last session, and it reached the owner because NOTHING SAID SO. The date was not wrong; it was SILENT.**
// A warning after the write is not silence — but it is the admin learning what they did, not deciding it.
//
// ➕ §5 — and the preview must also say when the date eats the course's remaining LEAVE, because since TASK-299
// made the stored expiry the extension ceiling, **an admin can spend a family's unused quota by moving one
// date**, and the first sign is a leave refused weeks later.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as IMPACT from "./course-expiry-impact";
import { expiryImpact, type ExpiryCandidate } from "./course-expiry-impact";
import { addDays } from "./time";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const START = "2026-09-01";
const week = (n: number) => addDays(START, (n - 1) * 7);

/** A size-6 course: four taught, two still owed. */
const rows: ExpiryCandidate[] = [
  { id: "a", date: week(1), status: "ATTENDED" },
  { id: "b", date: week(2), status: "ATTENDED" },
  { id: "c", date: week(3), status: "SICK_LEAVE" },
  { id: "d", date: week(4), status: "ATTENDED" },
  { id: "e", date: week(5), status: "CONFIRMED" },
  { id: "f", date: week(6), status: "PENDING" },
];

describe("🚫 TASK-298 — it WRITES NOTHING. The property that matters most.", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  const preview = SVC.slice(
    SVC.indexOf("export async function previewCourseExpiry("),
    SVC.indexOf("export async function updateCourseExpiry("),
  );
  const shared = SVC.slice(SVC.indexOf("async function expiryDecision("), SVC.indexOf("export async function previewCourseExpiry("));

  test("🔑 neither the preview nor the answer it reads performs any write", () => {
    // ⚠️ This sits one letter from a PATCH that legitimately writes, so it is asserted as an ABSENCE across
    // both the route body and the shared computation it delegates to.
    for (const [name, body] of [["preview", preview], ["expiryDecision", shared]] as const) {
      expect({
        name,
        writes:
          body.includes(".update(") ||
          body.includes(".insert(") ||
          body.includes(".delete(") ||
          body.includes("db.transaction") ||
          body.includes("recordExpiryChange"),
      }).toEqual({ name, writes: false });
    }
  });

  test("🚫 …and it is not a gate — no throw, no `problem`", () => {
    // REQ-082 AC-4 and §11.3 both say warn-and-save: *the admin may still do it; they may not do it BLIND.*
    expect(preview).not.toContain("throw");
    expect(preview).not.toContain("problem");
  });

  test("🔑 the preview and the PATCH cannot report different warnings — ONE answer, two callers", () => {
    // Asserted by construction rather than by comparing two derivations: both call `expiryDecision`, so there
    // is nothing to keep in step. Three copies of one answer is this project's most frequent defect.
    expect(preview).toContain("await expiryDecision(id, input.expiryDate)");
    expect(SVC).toContain("const { course, impact } = await expiryDecision(id, input.expiryDate);");
    expect(SVC.match(/expiryImpact\(/g)).toHaveLength(2); // the one inside the course's shared answer · 🔻 TASK-568: + the voucher's own shared answer
  });

  test("🚫 the PATCH's response is byte-identical", () => {
    expect(SVC).toContain(
      "return { course: toCourseWithStudent(updated), expiryWarning: impact, previousExpiryDate: from };",
    );
  });
});

describe("TASK-298 — an earlier date NAMES what it cuts; a later one is quiet", () => {
  test("🔑 the LIST, not just the count", () => {
    const impact = expiryImpact(week(4), rows);
    expect(impact.outside.map((s) => s.id)).toEqual(["e", "f"]);
    expect(impact.outsideCount).toBe(2);
    expect(impact.warn).toBe(true);
    // 🚫 A settled session is never "cut off" — week 3's leave already happened.
    expect(impact.outside.map((s) => s.id)).not.toContain("c");
  });

  test("📌 a LATER date returns `warn: false` — the quiet case is a real case, not an edge one", () => {
    // The owner sets a later expiry freely; a preview that always had something to say would be ignored.
    expect(expiryImpact(week(12), rows).warn).toBe(false);
    expect(expiryImpact(week(12), rows).outside).toEqual([]);
  });
});

describe("🔻 TASK-656 follow-up (REQ-112) — the preview answers ONLY the impact: `leaveRoom` and `expiryLeaveRoom` are gone", () => {
  // ⚠️ This describe was TASK-298 §5, "the date that quietly eats the family's remaining leave" — it pinned `expiryLeaveRoom` by value. REQ-112 deleted
  // the leave allowance, so the thing it measured has no subject; the pins are retired with it rather than left asserting a rule nobody holds.
  test("the module no longer exports it, and the service no longer returns it", () => {
    expect(Object.keys(IMPACT)).not.toContain("expiryLeaveRoom");
    const SVC = code(src("src/services/scheduler.service.ts"));
    expect(SVC).not.toMatch(/leaveRoom|expiryLeaveRoom/);
    const shared = SVC.slice(SVC.indexOf("async function expiryDecision("), SVC.indexOf("export async function previewCourseExpiry("));
    expect(shared.match(/findMany\(/g)).toHaveLength(1);
    expect(shared).toContain("impact: expiryImpact(expiryDate, candidates),");
  });
  test("the preview's answer is exactly { expiryWarning }", () => {
    const SVC = code(src("src/services/scheduler.service.ts"));
    expect(SVC).toContain("return { expiryWarning: impact };");
  });
});
