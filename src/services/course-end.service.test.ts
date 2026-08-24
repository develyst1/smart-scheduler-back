// SPEC-064 / TASK-181 (REQ-036) — the parts of `endCourse` that are claims about what it does NOT do.
//
// R4.3 (used_sessions unchanged) and R4.4 (bo.movement count identical) can't be proven without a database,
// and the honest guard from here is that the function contains no such write at all. Same approach as
// TASK-178/180: comments are stripped first, so the file can explain the money decision at length without a
// test passing on prose.
import { describe, expect, test } from "bun:test";

const SRC = await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text();
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const FN = code(SRC.slice(SRC.indexOf("export async function endCourse")));
const BODY = FN.slice(0, FN.indexOf("\n}\n") + 2);

describe("endCourse — what it must not do (TASK-181)", () => {
  test("🔴 R4.4: it never touches the books — no sale, no movement, no reversal", () => {
    // Money is a later human decision; recording the reason enum is what makes an ADMIN_ERROR sale findable
    // when that decision is taken.
    for (const forbidden of ["recordSale", "boMovement", "bo.movement", "refund"]) {
      expect(BODY).not.toContain(forbidden);
    }
  });

  test("🔴 R4.3: it never writes usedSessions — a forfeit is not a consumption", () => {
    expect(BODY).not.toContain("usedSessions");
    expect(BODY).not.toContain("usedHours");
  });

  test("🔴 it never calls the reconciler — that is what would re-owe the forfeited sessions", () => {
    expect(BODY).not.toContain("reconcileCoursePlan");
  });

  test("it notifies nobody — ending a course is not a schedule change to push", () => {
    for (const forbidden of ["enqueue", "notify", "outbox"]) expect(BODY).not.toContain(forbidden);
  });

  test("R4.5: a second call refuses with ALREADY_ENDED rather than cancelling another batch", () => {
    expect(BODY).toContain("ALREADY_ENDED");
    expect(BODY).toContain("isCourseEnded(course)");
  });

  test("the coded 400s are raised in the SERVICE, not left to the route", () => {
    expect(BODY).toContain("REASON_REQUIRED");
    expect(BODY).toContain("INVALID_REASON");
    expect(BODY).toContain("isEndReason");
  });

  test("all-or-nothing: everything happens inside one transaction", () => {
    expect(BODY).toContain("db.transaction");
    // The refusals are thrown INSIDE it, so a refused call rolls back rather than relying on an early return.
    expect(BODY.indexOf("db.transaction")).toBeLessThan(BODY.indexOf("ALREADY_ENDED"));
  });

  test("it records who and why, not just that it happened", () => {
    for (const field of ["endedAt", "endReason", "endNote", "endedBy"]) expect(BODY).toContain(field);
  });
});

describe("previewCourseEnd — the dialog's numbers come from the server (R2)", () => {
  const PREV = code(SRC.slice(SRC.indexOf("export async function previewCourseEnd")));
  const BODY2 = PREV.slice(0, PREV.indexOf("\n}\n") + 2);

  test("🔴 it writes nothing — no update, no insert, no delete, no transaction", () => {
    for (const forbidden of [".update(", ".insert(", ".delete(", "transaction"]) {
      expect(BODY2).not.toContain(forbidden);
    }
  });

  test("it counts with the SAME `endableSessions` the ending uses — the preview cannot promise a different number", () => {
    expect(BODY2).toContain("endableSessions");
  });

  test("it reports an already-ended course rather than offering to end it again", () => {
    expect(BODY2).toContain("alreadyEnded");
  });
});
