// SPEC-068 / TASK-215 — an off-card import must actually SAVE.
//
// 🔴 Why this file exists: TASK-213 put `leaveQuota` on the *preview* schema and not on the *save* schema, so
// zod stripped it from every import. The form asked for the quota, the admin typed it, and the server refused
// the course as if the field had been left blank. **Nothing errored** — a field absent from a schema simply
// ceases to exist. My TASK-213 tests all passed because they tested the pure rule (`decideImportSize`) and
// never the round trip through the schema that feeds it. Fern found it by following the data.
//
// So these tests follow the VALUE from request body to service input, and one of them pins the two schemas
// against each other so the halves can never drift apart again.
import { describe, expect, test } from "bun:test";
import { importCoursePackage, importCoursePreview } from "./validation";
import { decideImportSize } from "./lib/import-size";

const body = (extra: Record<string, unknown> = {}) => ({
  student: { id: "11111111-1111-4111-8111-111111111111" },
  teacherId: "22222222-2222-4222-8222-222222222222",
  subjectId: "33333333-3333-4333-8333-333333333333",
  size: 8,
  leaveQuota: 2,
  usedSessions: 3,
  startDate: "2026-09-06",
  startTime: "10:00",
  ...extra,
});

describe("🔴 the off-card round trip (TASK-215)", () => {
  test("the SAVE schema keeps `leaveQuota` — the field that was silently stripped", () => {
    const parsed = importCoursePackage.parse(body());
    expect(parsed.leaveQuota).toBe(2);
  });

  test("🔑 and the value that survives is the one the rule then accepts — end to end", () => {
    // The two halves in one assertion: what the schema yields is what `decideImportSize` says yes to. Either
    // half alone passed while the feature was broken.
    const parsed = importCoursePackage.parse(body());
    expect(decideImportSize(parsed.size, parsed.leaveQuota)).toEqual({ ok: true, leaveQuota: 2 });
  });

  test("a quota of 0 survives too — `0` is a real answer, not a missing one", () => {
    expect(importCoursePackage.parse(body({ leaveQuota: 0 })).leaveQuota).toBe(0);
  });

  test("a card size still needs nothing extra", () => {
    const parsed = importCoursePackage.parse(body({ size: 10, leaveQuota: undefined }));
    expect(decideImportSize(parsed.size, parsed.leaveQuota).ok).toBe(true);
  });
});

describe("expiry is optional on save — the other half of TASK-213 that never landed", () => {
  test("omitting it parses (the server then computes the default)", () => {
    expect(importCoursePackage.parse(body()).expiryDate).toBeUndefined();
  });

  test("a date the admin typed is still carried through", () => {
    expect(importCoursePackage.parse(body({ expiryDate: "2026-12-01" })).expiryDate).toBe("2026-12-01");
  });
});

describe("🔑 the preview and the save schema must agree", () => {
  // The gap was exactly this: one schema learned a field and the other did not. A test that names both is the
  // cheapest thing that would have caught it.
  test("every field the preview accepts is also accepted on save", () => {
    for (const field of Object.keys(importCoursePreview.shape)) {
      expect(Object.keys(importCoursePackage.shape)).toContain(field);
    }
  });

  test("both parse the same off-card shape without stripping the quota", () => {
    const preview = importCoursePreview.parse({
      size: 8,
      leaveQuota: 2,
      usedSessions: 3,
      startDate: "2026-09-06",
    });
    expect(preview.leaveQuota).toBe(importCoursePackage.parse(body()).leaveQuota);
  });
});
