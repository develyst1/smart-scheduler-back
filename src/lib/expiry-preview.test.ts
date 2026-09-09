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
import { expiryImpact, expiryLeaveRoom, type ExpiryCandidate } from "./course-expiry-impact";
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
    expect(SVC.match(/expiryImpact\(/g)).toHaveLength(1); // the one inside the shared answer
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

describe("🔑 TASK-298 §5 — the date that quietly eats the family's remaining leave", () => {
  // The plan still owes week 6, so a leave taken later needs a make-up in week 7 or 8 (quota 2).
  test("🔴 a date that eats the room is DISTINGUISHABLE from one that does not", () => {
    // ⚠️ A warning that fires either way is not a warning — so both sides are asserted.
    const tight = expiryLeaveRoom(week(6), rows, 2); // exactly the plan's end
    const roomy = expiryLeaveRoom(week(8), rows, 2);
    expect({ roomFor: tight.roomFor, all: tight.roomForAll }).toEqual({ roomFor: 0, all: false });
    expect({ roomFor: roomy.roomFor, all: roomy.roomForAll }).toEqual({ roomFor: 2, all: true });
  });

  test("…and PARTIAL room is reported as the number it is, not rounded to a verdict", () => {
    // 🔑 Numbers on the wire, the sentence on the screen — the same division that lets `ExpiryWarningAlert`
    // compute nothing.
    const half = expiryLeaveRoom(week(7), rows, 2);
    expect(half).toEqual({
      remainingLeave: 2,
      planEnd: week(6),
      neededFor: week(8),
      roomFor: 1,
      roomForAll: false,
    });
  });

  test("🔑 quota SPENT ⇒ nothing to warn about", () => {
    // ⚠️ The case that keeps this honest: a family with no leave left loses nothing, so an earlier date must
    // not raise a leave warning on top of the session one it already raises.
    const spent = expiryLeaveRoom(week(6), rows, 0);
    expect({ roomFor: spent.roomFor, all: spent.roomForAll, needed: spent.neededFor }).toEqual({
      roomFor: 0,
      all: true,
      needed: week(6),
    });
  });

  test("nothing still owed ⇒ no make-up can be appended ⇒ the date takes nothing away", () => {
    const settled: ExpiryCandidate[] = [{ id: "a", date: week(1), status: "ATTENDED" }];
    expect(expiryLeaveRoom(week(1), settled, 2)).toEqual({
      remainingLeave: 2,
      planEnd: null,
      neededFor: null,
      roomFor: 2,
      roomForAll: true,
    });
  });

  test("⚠️ the boundary is INCLUSIVE, exactly as the session impact reads it", () => {
    // A make-up landing ON the expiry is inside it — `exceedsExtensionCeiling` is `date > ceiling`. A boundary
    // meaning one thing here and another there is worse than no warning.
    expect(expiryLeaveRoom(week(7), rows, 1).roomForAll).toBe(true);
    expect(expiryLeaveRoom(addDays(week(7), -1), rows, 1).roomForAll).toBe(false);
  });

  test("🔑 §5 needed NO second data path — the same rows and course row answer both questions", () => {
    // @Sober asked to be told if it did. It does not: `expiryDecision` loads once and hands the same
    // `candidates` to both, and the quota comes off the course row the session impact already required.
    const SVC = code(src("src/services/scheduler.service.ts"));
    const shared = SVC.slice(SVC.indexOf("async function expiryDecision("), SVC.indexOf("export async function previewCourseExpiry("));
    expect(shared.match(/findMany\(/g)).toHaveLength(1);
    expect(shared).toContain("impact: expiryImpact(expiryDate, candidates),");
    expect(shared).toContain("expiryLeaveRoom(");
    expect(shared).toContain("Math.max(0, courseLeaveQuota(course) - course.leaveUsed),");
  });
});
