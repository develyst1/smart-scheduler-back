// SPEC-063 / TASK-184 — `toSessionRow` may not silently drop a DTO field again.
//
// The type annotation is the real guard (a dropped field is now a compile error). This test covers the half a
// type cannot: that the mapper actually READS the column rather than declaring a field it always fills with
// null — which would type-check perfectly and be exactly as broken for the person using the editor.
import { describe, expect, test } from "bun:test";

const SRC = await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text();
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const FN = code(SRC.slice(SRC.indexOf("const toSessionRow = ")));
const BODY = FN.slice(0, FN.indexOf("});") + 3);

describe("toSessionRow carries the attendee note (TASK-184)", () => {
  test("🔴 it reads the column — not a hardcoded null that would type-check just as well", () => {
    expect(BODY).toContain("attendeeNote: b.attendeeNote ?? null");
  });

  test("🔴 the mapper is TYPED to the DTO — that is what makes the next dropped field a compile error", () => {
    // This was `(b: any) => ({…})`, an allow-list tied to nothing, which is how TASK-178's note reached the
    // booking DTO and never the plan: the per-session editor could save a note it could not show, and staff
    // overwrite what they cannot see. Fourth compiler-silent allow-list in this feature set.
    expect(BODY).toContain("): PlanSessionRow => ({");
  });

  test("the fields the plan already relied on are still there (regression)", () => {
    for (const f of ["id:", "date:", "startTime:", "status:", "bookingType:", "teacher:", "subject:"]) {
      expect(BODY).toContain(f);
    }
  });
});
