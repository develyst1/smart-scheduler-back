// SPEC-064 / TASK-185 (REQ-036 Part B) — an ended course accepts no write that adds a session, revives a
// forfeited one, or bills.
//
// 🔴 The DoD asked for the ENUMERATION to be provable, so this test is driven by the router itself: it reads
// `routes/api.ts`, finds every write route, and requires each one to be classified below. **A route added
// later that nobody classified fails this test by omission** — which is the only way an enumeration stays true
// after the person who wrote it moves on. That is the gap Porter named: Part A tested the action, not what can
// be done to the course afterwards.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";

const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const ROUTES = readSrc(await Bun.file(new URL("../routes/api.ts", import.meta.url)).text());
const SVC = stripComments(readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text()));

/** Every write route the router declares, as `METHOD path`. */
// The `\s*` matters: a couple of routes are declared multi-line (`.post(\n  "/path",`), and a regex that
// assumed one line would silently miss them — the same class of omission this whole task is about.
const writeRoutes = [...ROUTES.matchAll(/\.(post|patch|put|delete)\(\s*"([^"]+)"/g)].map(
  (m) => `${m[1]!.toUpperCase()} ${m[2]}`,
);

/**
 * The verdict for every write route. `guarded` = refuses an ended course; `allowed` = a stated decision that
 * it is harmless on one; `unrelated` = cannot touch a course at all.
 */
const VERDICT: Record<string, "guarded" | "allowed" | "unrelated"> = {
  // ── the course-touching writes ──
  "POST /courses/:id/extra-session": "guarded", // 🔴 the money path the owner broke
  "POST /bookings": "guarded", // when `courseId` is set — the chokepoint extras funnel through
  "POST /courses/:id/plan": "guarded", // loudly: a silent 200 "nothing changed" is its own lie
  "POST /courses/:id/plan/preview": "guarded", // a preview that promises what the real call refuses
  "PATCH /bookings/:id": "guarded", // moving a forfeited slot is "revive" with a different verb
  "PATCH /bookings/:id/status": "guarded", // confirm/attend revive; cancel/sick-leave deliberately still allowed
  "PATCH /courses/:id": "guarded", // adminUnlocked on a dead course is meaningless at best
  "POST /bookings/bulk-confirm": "guarded", // it IS `confirm` in a loop — covered by the action-level guard
  "POST /courses/:id/cancel": "guarded", // its own ALREADY_ENDED (the double-cancel case, a different message)

  // ── stated allowances: annotation only, no session added, nothing billed ──
  "PATCH /bookings/:id/note": "allowed", // what a parent told us about a session that already happened
  "PATCH /bookings/:id/badges": "allowed", // a badge on a delivered session is a record, not a change
  "POST /courses/:id/cancel/preview": "allowed", // read-only; it must still say "already ended"
  "POST /rentals": "allowed", // see the task notes — equipment, and a standalone rental has no course at all

  // ── cannot touch an existing course ──
  "POST /students": "unrelated",
  "POST /parents": "unrelated",
  "PATCH /parents/:id": "unrelated",
  "POST /parents/:id/students": "unrelated",
  "POST /parents/:id/suspend": "unrelated",
  "POST /parents/:id/unsuspend": "unrelated",
  "PATCH /students/:id": "unrelated",
  "POST /teacher-link-requests/:id/approve": "unrelated",
  "POST /teacher-link-requests/:id/reject": "unrelated",
  "POST /teachers": "unrelated",
  "PATCH /teachers/availability": "unrelated",
  "PATCH /teachers/type-order": "unrelated",
  "PATCH /teachers/:id": "unrelated",
  "PUT /teachers/:id/budget": "unrelated",
  "POST /teachers/:id/budget/topup": "unrelated",
  "POST /teachers/:id/calendar-link": "unrelated",
  "DELETE /teachers/:id/line-link": "unrelated",
  "POST /teachers/:id/archive": "unrelated",
  "POST /teachers/:id/reactivate": "unrelated",
  "PATCH /teachers/:id/work-days": "unrelated",
  "PATCH /teachers/:id/limit-override": "unrelated",
  "POST /courses/preview": "unrelated", // computes a proposed schedule; writes nothing, no existing course
  "POST /courses/import": "unrelated", // creates a new course — never an ended one
  "POST /vouchers/import": "unrelated",
  "POST /courses": "unrelated", // creates a new course
  "POST /vouchers": "unrelated",
  "POST /badges/types": "unrelated",
  "PATCH /badges/types/:id": "unrelated",
  "POST /badges/values": "unrelated",
  "PATCH /badges/values/:id": "unrelated",
  "PUT /settings/:key": "unrelated",
  "DELETE /settings/:key": "unrelated",
};

describe("every write route is classified against the ended-course rule (TASK-185)", () => {
  test("🔴 no write route is unclassified — a new one fails here by omission", () => {
    const unclassified = writeRoutes.filter((r) => !(r in VERDICT));
    expect(unclassified).toEqual([]);
  });

  test("the router really does declare the routes this table claims (no stale entries)", () => {
    const gone = Object.keys(VERDICT).filter((r) => !writeRoutes.includes(r));
    expect(gone).toEqual([]);
  });

  test("the enumeration found the money path", () => {
    expect(writeRoutes).toContain("POST /courses/:id/extra-session");
    expect(VERDICT["POST /courses/:id/extra-session"]).toBe("guarded");
  });
});

describe("the guard is one behaviour, reached from every guarded path", () => {
  const fn = (name: string) => {
    const at = SVC.indexOf(`export async function ${name}`);
    const rest = SVC.slice(at);
    return rest.slice(0, rest.indexOf("\n}\n") + 2);
  };

  test("🔴 addExtraSession refuses before it can reach createBooking", () => {
    const body = fn("addExtraSession");
    expect(body).toContain("assertCourseWritable");
    // The guard must come BEFORE the call that creates (and later bills for) the session.
    expect(body.indexOf("assertCourseWritable")).toBeLessThan(body.indexOf("createBooking("));
  });

  test("createBooking refuses a course-linked booking before opening its transaction", () => {
    const body = fn("createBooking");
    expect(body).toContain("assertCourseWritable(db, input.courseId)");
    expect(body.indexOf("assertCourseWritable")).toBeLessThan(body.indexOf("db.transaction"));
  });

  test("moveBooking resolves the booking's course and refuses on that", () => {
    expect(fn("moveBooking")).toContain("assertBookingCourseWritable");
  });

  test("updateCourse refuses outright", () => {
    expect(fn("updateCourse")).toContain("assertCourseWritable");
  });

  test("🔴 the plan path rejects LOUDLY — a 409, not a silent 200 with no moves", () => {
    expect(fn("applyPlanChange")).toContain('conflict("COURSE_ENDED"');
  });

  test("only the REVIVING status actions are refused — cancel and sick-leave stay possible", () => {
    const body = fn("updateBookingStatus");
    expect(body).toContain('REVIVING = new Set(["confirm", "attend"])');
    expect(body).toContain("REVIVING.has(action)");
    // Enumerated by action, so bulk-confirm (confirm in a loop) is covered by construction.
    expect(body).not.toContain('"cancel", "sick-leave"');
  });

  test("COURSE_ENDED is a DIFFERENT code from ALREADY_ENDED — they mean different things to a user", () => {
    expect(SVC).toContain('conflict("COURSE_ENDED"');
    expect(SVC).toContain('conflict("ALREADY_ENDED"');
  });

  test("the allowed paths do NOT call the guard — 'allowed' is a decision, not an oversight", () => {
    expect(fn("setAttendeeNote")).not.toContain("assertCourseWritable");
    expect(fn("previewCourseEnd")).not.toContain("assertCourseWritable");
  });
});
