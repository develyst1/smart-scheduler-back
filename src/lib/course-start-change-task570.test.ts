// TASK-570 (REQ-110 item 6) — move a NOT-YET-STARTED course's start date; the expiry recomputed the normal way. The plan is pure
// (by value here); the service applies it in one transaction (its wiring pinned by source below).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { courseNotStarted, isStartChangeRefusal, planCourseStartChange, type StartChangeRow } from "./course-start-change";
import { courseBornCeiling } from "./course-plan";
import { courseExpiry } from "./recurring";

const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const TODAY = "2026-10-01";
const C = { startDate: "2026-10-05", size: 4, expiryDate: "2026-11-02", priorSessions: 0 };
const R = (id: string, date: string, status = "PENDING", extra: Partial<StartChangeRow> = {}): StartChangeRow => ({ id, date, status, teacherId: "t1", extendedFromId: null, bookingType: "COURSE_PACKAGE", ...extra });
const four = () => [R("b1", "2026-10-05", "CONFIRMED"), R("b2", "2026-10-12", "CONFIRMED"), R("b3", "2026-10-19", "CONFIRMED"), R("b4", "2026-10-26", "CONFIRMED")];
const noLeave = async () => false;

describe("🔑 'NOT YET STARTED', exactly — and the easy definitions it is NOT", () => {
  test("all sessions today or later ⇒ not started; a session TODAY still counts (it has not been taught yet)", () => {
    expect(courseNotStarted(C, four(), TODAY)).toBe(true);
    expect(courseNotStarted(C, [R("b1", TODAY), R("b2", "2026-10-08")], TODAY)).toBe(true);
  });
  test("🔑 a course whose FIRST session was CANCELLED (in the past) is still NOT started — the family attended nothing, nothing was charged", () => {
    expect(courseNotStarted(C, [R("b0", "2026-09-28", "CANCELLED"), ...four()], TODAY)).toBe(true);
  });
  test("STARTED: a past delivered session · a past NO-SHOW · a past LEAVE · an import's prior sessions — each has run the course's time", () => {
    expect(courseNotStarted(C, [R("b0", "2026-09-28", "ATTENDED"), ...four()], TODAY)).toBe(false);
    expect(courseNotStarted(C, [R("b0", "2026-09-28", "NO_SHOW"), ...four()], TODAY)).toBe(false);
    expect(courseNotStarted(C, [R("b0", "2026-09-28", "SICK_LEAVE"), ...four()], TODAY)).toBe(false);
    expect(courseNotStarted({ ...C, priorSessions: 2 }, four(), TODAY)).toBe(false);
  });
});

describe("🔴 the plan — the SAME rows MOVED, weekly from the new start, in the plan's own order; nothing created or cancelled", () => {
  test("by value: one week later — each row a week on, applied LAST-FIRST (no row lands on a sibling still there); CONFIRMED ⇒ PENDING + re-confirm", async () => {
    const p = await planCourseStartChange(C, four(), "2026-10-12", TODAY, noLeave);
    if (isStartChangeRefusal(p)) throw new Error(p.message);
    expect(p.moves.map((m) => [m.id, m.from, m.to, m.toStatus])).toEqual([
      ["b1", "2026-10-05", "2026-10-12", "PENDING"], ["b2", "2026-10-12", "2026-10-19", "PENDING"], ["b3", "2026-10-19", "2026-10-26", "PENDING"], ["b4", "2026-10-26", "2026-11-02", "PENDING"],
    ]);
    expect(p.order).toEqual(["b4", "b3", "b2", "b1"]); // later ⇒ the last row leaves its date before b3 needs it
    expect(p.needsReconfirm).toBe(true);
  });
  test("earlier ⇒ applied FIRST-FIRST; a PENDING course stays PENDING and needs no re-confirm", async () => {
    const pending = four().map((r) => ({ ...r, status: "PENDING" }));
    const p = await planCourseStartChange(C, pending, "2026-10-01", TODAY, noLeave);
    if (isStartChangeRefusal(p)) throw new Error(p.message);
    expect(p.order).toEqual(["b1", "b2", "b3", "b4"]);
    expect([p.needsReconfirm, p.moves.every((m) => m.toStatus === "PENDING")]).toEqual([false, true]);
  });
  test("🔑 BORN LINKED by construction: a declared leave keeps its week, its MAKE-UP keeps its link and stays last — no new row, no lost link", async () => {
    const rows = [R("b1", "2026-10-05"), R("L2", "2026-10-12", "SICK_LEAVE", { plannedAtCreation: true }), R("b3", "2026-10-19"), R("b4", "2026-10-26"), R("m2", "2026-11-02", "EXTENDED", { extendedFromId: "L2" })];
    const p = await planCourseStartChange({ ...C, expiryDate: "2026-11-09" }, rows, "2026-10-19", TODAY, noLeave);
    if (isStartChangeRefusal(p)) throw new Error(p.message);
    expect(p.moves.map((m) => [m.id, m.to, m.toStatus])).toEqual([["b1", "2026-10-19", "PENDING"], ["L2", "2026-10-26", "SICK_LEAVE"], ["b3", "2026-11-02", "PENDING"], ["b4", "2026-11-09", "PENDING"], ["m2", "2026-11-16", "EXTENDED"]]);
    expect(p.moves.map((m) => m.id).sort()).toEqual(rows.map((r) => r.id).sort()); // the same rows — nothing created, nothing dropped
  });
  test("✅ TASK-561's block: a week on the teacher's ADVANCE leave is SKIPPED (the make-up's rule) and named", async () => {
    const onLeave = async (t: string, d: string) => t === "t1" && d === "2026-10-19";
    const p = await planCourseStartChange(C, four(), "2026-10-12", TODAY, onLeave);
    if (isStartChangeRefusal(p)) throw new Error(p.message);
    expect(p.moves.map((m) => m.to)).toEqual(["2026-10-12", "2026-10-26", "2026-11-02", "2026-11-09"]);
    expect(p.skipped).toEqual([{ teacherId: "t1", date: "2026-10-19" }]);
  });
});

describe("🔴 the expiry — recomputed THE NORMAL WAY (creation's own formula), and never before the course's own last session", () => {
  test("a fresh course: exactly `courseBornCeiling(courseExpiry(new start, size), last session, declared absences)`", async () => {
    const p = await planCourseStartChange(C, four(), "2026-10-12", TODAY, noLeave);
    if (isStartChangeRefusal(p)) throw new Error(p.message);
    expect(p.expiryDate).toBe(courseBornCeiling(courseExpiry("2026-10-12", 4), "2026-11-02", 0));
  });
  test("with a make-up already in the plan: the expiry covers it (the stretch rule) — never a course ending before its own session", async () => {
    const rows = [...four(), R("m1", "2026-11-02", "EXTENDED", { extendedFromId: "b9" })];
    const p = await planCourseStartChange({ ...C, expiryDate: "2026-11-02" }, rows, "2026-10-12", TODAY, noLeave);
    if (isStartChangeRefusal(p)) throw new Error(p.message);
    const lastMove = p.moves.at(-1)!.to;
    expect(p.expiryDate >= lastMove).toBe(true);
  });
  test("🔑 two ADVANCE leaves with their make-ups: creation's formula falls SHORT of the last make-up — the expiry is that session, not before it", async () => {
    const rows = [R("b1", "2026-10-05"), R("L2", "2026-10-12", "SICK_LEAVE"), R("L3", "2026-10-19", "SICK_LEAVE"), R("b4", "2026-10-26"),
      R("m2", "2026-11-02", "EXTENDED", { extendedFromId: "L2" }), R("m3", "2026-11-09", "EXTENDED", { extendedFromId: "L3" })];
    const p = await planCourseStartChange({ ...C, expiryDate: "2026-11-09" }, rows, "2026-10-12", TODAY, noLeave);
    if (isStartChangeRefusal(p)) throw new Error(p.message);
    const born = courseBornCeiling(courseExpiry("2026-10-12", 4), "2026-11-02", 0);
    expect(p.moves.at(-1)!.to).toBe("2026-11-16");
    expect(born < "2026-11-16").toBe(true); // the formula alone would end the course before m3
    expect(p.expiryDate).toBe("2026-11-16");
  });
});

describe("🔴 refusals, each in words an admin can act on — never a silent nothing", () => {
  test("a start in the past · a STARTED course · a course with nothing to move", async () => {
    expect(await planCourseStartChange(C, four(), "2026-09-30", TODAY, noLeave)).toMatchObject({ code: "START_IN_PAST" });
    const started = await planCourseStartChange(C, [R("b0", "2026-09-28", "ATTENDED"), ...four()], "2026-10-12", TODAY, noLeave);
    expect(started).toMatchObject({ code: "COURSE_STARTED" });
    expect((started as any).message).toContain("ย้ายคาบรายคาบ"); // what to do instead
    expect(await planCourseStartChange(C, [R("b0", "2026-10-05", "CANCELLED")], "2026-10-12", TODAY, noLeave)).toMatchObject({ code: "NOTHING_TO_MOVE" });
  });
});

describe("🔴 the service applies the plan in ONE transaction — and what it does NOT touch (by source)", () => {
  const S = code("src/services/scheduler.service.ts");
  // 🔻 TASK-573 §2 — the reads + refusals were LIFTED into `planStartChange` (shared with the preview): the slice covers it too.
  const F = S.slice(S.indexOf("async function planStartChange("), S.indexOf("export async function resumeCourse("));
  test("an ENDED / PAUSED course refuses first; the ONE leave reader is injected; every new date passes the create gate; a clash refuses the whole move", () => {
    expect(F.indexOf("await assertCourseWritable(tx, id);")).toBeLessThan(F.indexOf("planCourseStartChange("));
    expect(F).toContain("async (teacherId, date) => !!(await teacherLeaveOn(tx, teacherId, date)),");
    expect(F).toContain("if (m.from !== m.to) await assertTeacherBookable(tx, m.teacherId, m.to);");
    expect(F).toContain('if (pgErrorCode(e) === "23505") throw conflict("SLOT_TAKEN",');
    expect(F).toContain("for (const rowId of plan.order) {");
  });
  test("🔑 the expiry recompute is RECORDED — with the admin as actor (a person asked; TASK-556's Undo must not read it as a make-up's stretch)", () => {
    expect(F).toContain("await recordExpiryChange(tx, { courseId: id, from: course.expiryDate, to: plan.expiryDate, actor: actor ?? null });");
  });
  test("🚫 NOT touched: no row created, no row cancelled, no message sent, no sale / refund / counter — only dates, a re-confirm status, and the holds", () => {
    expect(F).not.toMatch(/insertBooking\(|\.insert\(bookings\)|"CANCELLED"|enqueueLine|notifyAdmins|recordSale|reverseBookingSale|boMovement|usedSessions|leaveUsed/);
    expect(F).toContain("await reconcileBookingHolds(tx, m.id, m.teacherId, m.toStatus, false);");
    // 🔑 the ONE row write: the date, plus (only for a CONFIRMED row) the re-confirm fields — a row's LINK is never touched
    expect(F).toContain("await tx.update(bookings).set({ date: m.to, ...reconfirm }).where(eq(bookings.id, m.id));");
    expect(F).toContain("const reconfirm = m.toStatus !== m.status ? { status: m.toStatus, confirmedAt: null, checkinToken: null, checkinTokenExpiresAt: null } : {};");
    expect(F).not.toMatch(/\.set\(\{[^}]*extendedFromId/); // read (to plan), never written
    expect((F.match(/\.update\(bookings\)/g) ?? []).length).toBe(1);
  });
});
