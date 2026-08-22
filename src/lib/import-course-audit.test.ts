import { describe, expect, test } from "bun:test";
import { auditImportedCourses, auditSummary, type AuditCourseInput } from "./import-course-audit";

const row = (o: Partial<AuditCourseInput> & { id: string }): AuditCourseInput => ({
  nickname: "น้องเอ",
  size: 10,
  priorSessions: 4,
  usedSessions: 4,
  source: "IMPORT",
  liveCount: 6,
  extendedCount: 0,
  ...o,
});

describe("import course audit (TASK-166) — it measures, it never corrects", () => {
  test("a clean import does not appear at all", () => {
    // 10 bought, 4 taught elsewhere, 6 scheduled here — exactly right.
    expect(auditImportedCourses([row({ id: "c1" })])).toEqual([]);
  });

  test("🔴 the give-away case: one leave produced 4 phantoms ⇒ reported as over, with the count", () => {
    const [f] = auditImportedCourses([row({ id: "c1", liveCount: 11, extendedCount: 5 })]);
    expect(f!.delta).toBe(5);
    expect(f!.direction).toBe("over");
    expect(f!.planSize).toBe(6);
    expect(f!.suggestion).toContain("5");
  });

  test("over by more than there are EXTENDED rows ⇒ says a human must look, not 'remove N'", () => {
    // The surplus is hand-placed or delivered sessions. No automated correction may touch those, and a
    // suggestion that implied otherwise would be the most dangerous line in the report.
    const [f] = auditImportedCourses([row({ id: "c1", liveCount: 9, extendedCount: 1 })]);
    expect(f!.suggestion).toContain("ต้องให้คนตรวจสอบ");
  });

  test("🔴 the back-fill drift case: someone attended after the import ⇒ surfaced, not silent", () => {
    // `prior_sessions` is back-filled from `used_sessions`, which has already grown by one attendance — so the
    // plan believes it owes less than it does and will quietly under-append the family's next make-up. It lands
    // here as "over" with no EXTENDED rows to blame, which is exactly the shape that sends it to a human.
    const [f] = auditImportedCourses([row({ id: "c1", priorSessions: 5, usedSessions: 5, liveCount: 6 })]);
    expect(f!.planSize).toBe(5);
    expect(f!.delta).toBe(1);
    expect(f!.suggestion).toContain("ต้องให้คนตรวจสอบ");
  });

  test("a plan holding FEWER sessions than it should is reported too (under)", () => {
    const [f] = auditImportedCourses([row({ id: "c1", liveCount: 4 })]);
    expect(f!.delta).toBe(-2);
    expect(f!.direction).toBe("under");
    expect(f!.suggestion).toContain("prior_sessions");
  });

  test("🔴 a SALE course can never appear, whatever its numbers", () => {
    const rows = [
      row({ id: "s1", source: "SALE", priorSessions: 0, liveCount: 7 }),
      row({ id: "s2", source: "SALE", priorSessions: 0, liveCount: 13 }),
    ];
    expect(auditImportedCourses(rows)).toEqual([]);
  });

  test("worst first — the owner reads the biggest give-away at the top", () => {
    const found = auditImportedCourses([
      row({ id: "small", liveCount: 7, extendedCount: 1 }),
      row({ id: "big", liveCount: 11, extendedCount: 5 }),
    ]);
    expect(found.map((f) => f.id)).toEqual(["big", "small"]);
  });

  test("summary is counts only — scale before names", () => {
    const found = auditImportedCourses([
      row({ id: "a", liveCount: 11, extendedCount: 5 }),
      row({ id: "b", liveCount: 8, extendedCount: 2 }),
      row({ id: "c", liveCount: 4 }),
    ]);
    expect(auditSummary(found)).toEqual({ affected: 3, over: 2, under: 1, phantomSessions: 7 });
  });

  test("an empty database is a clean report, not a crash", () => {
    expect(auditImportedCourses([])).toEqual([]);
    expect(auditSummary([])).toEqual({ affected: 0, over: 0, under: 0, phantomSessions: 0 });
  });
});
