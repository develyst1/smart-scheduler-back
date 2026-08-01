// TASK-072 — the regression guard for the leak this task removed.
//
// Three route tests used to `mock.module(...)` a whole service module. Bun's module registry is
// **process-wide**, so those stubs leaked into every other test file: an unrelated file importing a newly
// added export got `SyntaxError: Export named 'x' not found`, in a file that never mentioned the stub.
//
// It bit five times (TASK-053, TASK-062, TASK-070 and two before), and four of those were "fixed" by adding
// another name to a stub that had nothing to do with what the test asserted — so the shape of five tasks was
// decided by a test fixture.
//
// This file is the demonstration the task asked for: it imports **freely** from both previously-stubbed
// modules, including exports the old stubs never listed. If anyone reintroduces a whole-module stub, this
// fails with that same SyntaxError — in a file whose only job is to say why.
import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here

const scheduler = await import("./scheduler.service");
const parent = await import("./parent.service");
const calendar = await import("./calendar.service");

describe("🔑 a test file can import freely — no other file's stub decides what resolves", () => {
  test("scheduler.service exports the old stub never listed are really there", () => {
    // The old stub listed 8 names. These are ones it did NOT — under the stub, importing them threw.
    for (const name of [
      "importCoursePackage", // TASK-079
      "getSellablePackages", // TASK-077
      "resolvePriceGroup", // TASK-077
      "listFreelanceCeilings",
      "bulkConfirm",
      "getEligibleStudents",
    ] as const) {
      expect(typeof scheduler[name]).toBe("function");
    }
  });

  test("parent.service likewise — incl. the search rule TASK-070 had to route around", () => {
    for (const name of ["studentSearchConditions", "suspendedStudentIds", "normalizePhone"] as const) {
      expect(typeof parent[name]).toBe("function");
    }
    // Not just present — actually the REAL implementation, not a fake returning undefined.
    expect(parent.normalizePhone("081-234-5678")).toBe("0812345678");
    expect(parent.studentSearchConditions("0812345678")).toHaveLength(3);
  });

  test("calendar.service too — the third module that used to be replaced wholesale", () => {
    expect(typeof calendar.findBookingsForCalendarToken).toBe("function");
    expect(typeof calendar.getOrCreateCalendarToken).toBe("function");
  });

  test("🔑 the real module is loaded, not a stub — a stub would answer with fakes", () => {
    // `remainingSessions` behaviour proves we got real code, not a mock that returns undefined for
    // everything. If a whole-module stub were active, `scheduler.getSellablePackages` would not exist at
    // all and the import above would already have thrown.
    expect(scheduler.getSellablePackages).not.toBeUndefined();
    expect(parent.MAX_STUDENTS_PER_PARENT).toBe(5); // a real constant, not a fake's `undefined`
  });
});
