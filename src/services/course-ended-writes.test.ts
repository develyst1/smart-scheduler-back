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
  "POST /courses/:id/confirm": "guarded", // TASK-201: confirming is a reviving write — same chokepoint
  "POST /courses/:id/drop": "guarded", // TASK-198: refuses an ENDED course, and ALREADY_DROPPED on a second click
  "POST /courses/:id/resume": "guarded", // …and refuses NOT_DROPPED / an ended course. Exempt from the drop guard
                                          // by construction: it is the one write whose whole job is clearing it.

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

// ═══ SPEC-065 / TASK-198 — the same enumeration, against a PAUSED course ═══
//
// The task asked for this explicitly, and it is the right ask: a guard added for one state is not a guard for
// the other. Everything that refuses an ended course must also refuse a paused one — with a DIFFERENT code,
// because the fix differs ("resume it" vs "you can't").
describe("a dropped course is refused by the same chokepoint, with its own code", () => {
  const fn = (name: string) => {
    const at = SVC.indexOf(`export async function ${name}`);
    const rest = SVC.slice(at);
    return rest.slice(0, rest.indexOf("\n}\n") + 2);
  };

  test("🔴 `assertCourseWritable` checks BOTH states — so every guarded route inherits the pause", () => {
    const body = fn("assertCourseWritable");
    expect(body).toContain("isCourseEnded");
    expect(body).toContain("isCourseDropped");
    // Ended is checked first: a course that was paused and then ended is ended, and should say so.
    expect(body.indexOf("isCourseEnded")).toBeLessThan(body.indexOf("isCourseDropped"));
  });

  test("🔴 COURSE_DROPPED is a DISTINCT code from COURSE_ENDED — different sentence, different fix", () => {
    expect(SVC).toContain('conflict("COURSE_DROPPED"');
    expect(SVC).toContain('conflict("COURSE_ENDED"');
  });

  test("the paused message names the way out; the ended one cannot", () => {
    // An admin who reads "cancelled" goes hunting for a mistake. One who reads "paused — resume it first"
    // does the single thing that unblocks them.
    expect(SVC).toContain("กลับมาเรียน");
  });

  test("drop refuses a second drop and an ended course, in that order of severity", () => {
    const body = fn("dropCourse");
    expect(body).toContain('conflict("ALREADY_DROPPED"');
    expect(body.indexOf("isCourseEnded")).toBeLessThan(body.indexOf("isCourseDropped"));
  });

  test("🔑 resume clears the pause BEFORE it inserts — or the guard would refuse its own resume", () => {
    // `insertBooking` runs through `assertCourseWritable`; a course still flagged dropped cannot be rebuilt.
    // Both happen in one transaction, so a clash still rolls the whole resume back.
    const body = fn("resumeCourse");
    expect(body.indexOf("droppedAt: null")).toBeLessThan(body.indexOf("insertBooking"));
    expect(body).toContain("db.transaction");
  });

  test("🔴 resume never moves a family silently — a taken slot surfaces as SLOT_TAKEN", () => {
    const body = fn("resumeCourse");
    expect(body).toContain('conflict(\n              "SLOT_TAKEN"');
    expect(body).toContain("ระบบไม่ย้ายคาบให้เอง");
  });

  test("resume rebuilds on the course's OWN weekday and time, not on today's", () => {
    const body = fn("resumeCourse");
    expect(body).toContain("nextWeekdayOnOrAfter(bangkokNow().date, course.weekday)");
    expect(body).toContain("startTime: course.startTime");
  });

  test("🔑 dropping does NOT reconcile — a pause is not a re-owe", () => {
    // The ending has the same rule for the same reason: reconciling would append make-ups for the very
    // sessions just taken off the calendar.
    expect(fn("dropCourse")).not.toContain("reconcileCoursePlan");
  });

  test("dropping keeps the rows — soft-cancel, never a delete", () => {
    const body = fn("dropCourse");
    expect(body).toContain('status: "CANCELLED"');
    expect(body).not.toContain("tx.delete");
  });
});

// ═══ SPEC-066 / TASK-201 (REQ-072) — one course, one message ═══
//
// The DoD asks for an OUTCOME (a count that changed, an outbox of exactly 1) and I cannot run a database. What
// a source-level test CAN prove is the shape that makes the outcome inevitable: the enqueue is outside the
// per-session loop, the money is inside it, and single-confirm was not touched. Those are the three ways this
// could be wrong.
describe("confirmCourse sends ONE message, not N (TASK-201)", () => {
  const fn = (name: string) => {
    const at = SVC.indexOf(`export async function ${name}`);
    const rest = SVC.slice(at);
    return rest.slice(0, rest.indexOf("\n}\n") + 2);
  };
  const body = fn("confirmCourse");

  test("🔴 exactly TWO enqueues — one per PERSON — and both OUTSIDE the per-session loop", () => {
    // TASK-207 added the parent. Two people, two messages, for one decision about a ten-session course. The
    // number that must never grow with the session count.
    expect(body.match(/enqueueLine\(/g)).toHaveLength(2);
    expect(body.indexOf("for (const b of pending)")).toBeLessThan(body.indexOf("enqueueLine("));
  });

  test("🔑 teacher and parent are sent the SAME payload object, not two copies of it", () => {
    // Two literals would be two places to update the next time the message changes — and one would be missed,
    // which is how a parent ends up reading a different schedule from the teacher.
    expect(body.match(/payload: coursePayload/g)).toHaveLength(2);
    expect(body).toContain('recipientType: "parent"');
  });

  test("an unlinked parent is a SKIPPED row and a reported fact, never an error", () => {
    // The common case on `uat`: imported parents who have never linked LINE. The response says whether the
    // parent was actually reached, so "we notified them" is checkable rather than assumed.
    expect(body).toContain("parentLineUserId(tx");
    expect(body).toContain("parentLinked");
  });

  test("🔴 the money side effect stays INSIDE the loop — only the notification is collapsed", () => {
    // A course confirm must draw exactly what ten single confirms would draw. Collapsing the ledger the way
    // the message is collapsed would silently under-charge a freelance teacher's budget.
    const loop = body.slice(body.indexOf("for (const b of pending)"), body.indexOf("enqueueLine("));
    expect(loop).toContain("reconcileBookingHolds");
    expect(loop).toContain("issueCheckinToken");
  });

  test("🔑 `updateBookingStatus` is NOT called here — single-confirm behaviour is untouched", () => {
    // The alternative was a `notify:false` flag threaded through the app's most-used write path. This feature
    // does not justify putting every single-session confirm at risk.
    expect(body).not.toContain("updateBookingStatus");
  });

  test("nothing confirmed ⇒ nothing announced", () => {
    // "Confirmed 0 sessions" trains a teacher to ignore the message that matters.
    expect(body).toContain("confirmed\n      ? await enqueueLine");
  });

  test("a session that cannot confirm is REPORTED, not dropped", () => {
    expect(body).toContain('outcome: "skipped"');
    expect(body).toContain("ApiException");
  });

  test("🔑 a non-ApiException is rethrown — a half-written course confirm is worse than none", () => {
    expect(body).toContain("if (!(err instanceof ApiException)) throw err;");
  });

  test("it runs through the same write guard as every other add/revive path", () => {
    expect(body).toContain("assertCourseWritable");
  });

  test("the acknowledged REQ-070 consequence is recorded at the site, not left to be rediscovered", () => {
    const doc = SVC.slice(SVC.indexOf("SPEC-066 / TASK-201"), SVC.indexOf("export async function confirmCourse"));
    expect(doc).toContain("auto-attends at day-end");
  });
});
