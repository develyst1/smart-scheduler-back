// TASK-573 — item 6's three backend gaps (@Fern's findings from TASK-571). §1 blocks the item.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ATTENTION_CHECKS, isAwaitingReconfirm } from "./attention";
import { toCourseSummary } from "./leave";
import { toBookingDTO, toPublicCheckinBooking } from "../db/mappers";
import { previewCourseStart } from "../services/scheduler.service";
import { ROUTE_ACCESS } from "./route-access";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fnBody = (s: string, head: string) => { const a = s.indexOf(head); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf("\n}\n", a)); };
const S = code("src/services/scheduler.service.ts");

describe("🔴 §1 — a moved, un-reconfirmed course shows FROM THE MOMENT OF THE MOVE (the 12th check)", () => {
  const moved = { id: "c1", startDate: "2026-10-26", reconfirmNeededSince: new Date("2026-10-01T03:00:00Z"), endedAt: null, droppedAt: null, student: { nickname: "มะลิ" } };
  test("by value: the mark + something pending + a live course ⇒ shown; each way it CLEARS ⇒ not shown", () => {
    expect(isAwaitingReconfirm(moved, 4)).toBe(true);
    expect(isAwaitingReconfirm({ ...moved, reconfirmNeededSince: null }, 4)).toBe(false); // never moved-after-confirm (a normal unconfirmed course is not this card)
    expect(isAwaitingReconfirm(moved, 0)).toBe(false); // everything re-confirmed (a course confirm, or one session at a time)
    expect(isAwaitingReconfirm({ ...moved, endedAt: new Date() }, 4)).toBe(false); // ended
    expect(isAwaitingReconfirm({ ...moved, droppedAt: new Date() }, 4)).toBe(false); // paused
  });
  test("🔑 the card for a course moved THREE WEEKS out — no date window: it answers the moment the move is written", async () => {
    const check = ATTENTION_CHECKS.find((c) => c.key === "courses_awaiting_reconfirm")!;
    const r = await check.run({ today: "2026-10-01", load: { reconfirmCandidates: async () => [{ course: moved, pendingCount: 4 }, { course: { ...moved, id: "c2" }, pendingCount: 0 }] } } as any);
    expect(r).toEqual({ count: 1, items: [{ id: "c1", label: "2026-10-26 · มะลิ · 4" }] });
    expect(check.namesPeopleInDigest).toBeFalsy(); // 🔐 the digest carries the COUNT; the panel names the course (REQ-020's list unchanged)
  });
  test("the MOVE writes the mark (only when it un-confirmed something); a course CONFIRM clears it when nothing is left pending", () => {
    expect(fnBody(S, "export async function changeCourseStart(")).toContain("...(plan.needsReconfirm ? { reconfirmNeededSince: new Date() } : {})");
    const confirm = fnBody(S, "export async function confirmCourse(");
    expect(confirm).toContain("if (pending.length === confirmed) await tx.update(coursePackages).set({ reconfirmNeededSince: null }).where(eq(coursePackages.id, id));");
  });
});

describe("🔴 §2 — the preview is the ACT's own plan, run without writes (TASK-546's shape)", () => {
  afterEach(() => setSystemTime());
  const today = () => setSystemTime(new Date("2026-10-01T10:00:00+07:00")); // the plan's "today" is the Bangkok clock: pinned
  test("ONE shared read: the preview and the act both call `planStartChange`; the reads and refusals live only there", () => {
    const shared = fnBody(S, "async function planStartChange(");
    expect(shared).toContain("await assertCourseWritable(tx, id);");
    expect(shared).toContain("planCourseStartChange(");
    expect(fnBody(S, "export async function previewCourseStart(")).toContain("await planStartChange(exec, id, input);");
    expect(fnBody(S, "export async function changeCourseStart(")).toContain("await planStartChange(tx, id, input);");
    expect(fnBody(S, "export async function changeCourseStart(")).not.toContain("planCourseStartChange(");
  });
  test("🔑 it WRITES NOTHING — driven through a READ-ONLY exec (no update / insert / transaction exist on it), by value", async () => {
    today();
    const course = { id: "c1", startDate: "2026-10-05", size: 4, expiryDate: "2026-11-02", priorSessions: 0, endedAt: null, droppedAt: null };
    const rows = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, date: `2026-10-${String(5 + 7 * (i - 1)).padStart(2, "0")}`, status: "CONFIRMED", teacherId: "t1", extendedFromId: null, bookingType: "COURSE_PACKAGE" }));
    const readOnly = { query: { coursePackages: { findFirst: async () => course }, bookings: { findMany: async () => rows }, teacherLeaveDays: { findFirst: async () => undefined } } };
    const p = await previewCourseStart("c1", { startDate: "2026-10-12" }, readOnly);
    expect(p.moves.map((m) => [m.id, m.to, m.toStatus])).toEqual([["b1", "2026-10-12", "PENDING"], ["b2", "2026-10-19", "PENDING"], ["b3", "2026-10-26", "PENDING"], ["b4", "2026-11-02", "PENDING"]]);
    expect([p.needsReconfirm, p.forecast, p.previousExpiryDate]).toEqual([true, true, "2026-11-02"]);
    const body = fnBody(S, "export async function previewCourseStart(");
    expect(body).not.toMatch(/\.update\(|\.insert\(|\.delete\(|db\.transaction|enqueueLine/);
  });
  test("the SAME gate as the act (derived: equal entries), and the same refusals — a started course refuses the preview too", async () => {
    today();
    expect(ROUTE_ACCESS["POST /courses/:id/start-date/preview"]).toEqual(ROUTE_ACCESS["POST /courses/:id/start-date"]);
    const course = { id: "c1", startDate: "2026-09-01", size: 4, expiryDate: "2026-10-01", priorSessions: 0, endedAt: null, droppedAt: null };
    const readOnly = { query: { coursePackages: { findFirst: async () => course }, bookings: { findMany: async () => [{ id: "b1", date: "2026-09-01", status: "ATTENDED", teacherId: "t1", extendedFromId: null, bookingType: "COURSE_PACKAGE" }] }, teacherLeaveDays: { findFirst: async () => undefined } } };
    await expect(previewCourseStart("c1", { startDate: "2026-12-01" }, readOnly)).rejects.toMatchObject({ status: 409, code: "COURSE_STARTED" });
  });
});

describe("🔴 §3 — `CourseSummary.startDate`, ONE field; public confirmed by value AND source; the scoped answer stated", () => {
  const C = { id: "c1", startDate: "2026-10-05", size: 4, usedSessions: 0, leaveUsed: 0, adminUnlocked: false, expiryDate: "2026-11-02" };
  test("by value, and the key set is the previous 14 + `startDate` — nothing else added", () => {
    const s = toCourseSummary(C, "2026-10-01");
    expect(s.startDate).toBe("2026-10-05");
    expect(Object.keys(s).sort()).toEqual(["adminUnlocked", "dropReason", "droppedAt", "endReason", "endedAt", "expiryDate", "id", "leaveLocked", "leaveQuota", "leaveRemaining", "leaveUsed", "maxWeek", "size", "startDate", "status", "usedSessions"]);
  });
  test("🔒 PUBLIC, by value: the check-in answer is the six-field allow-list — no course, so no `startDate`", () => {
    const dto = toBookingDTO({ id: "b1", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "CONFIRMED", student: { id: "s1", name: "Mali" }, teacher: { id: "t1", nickname: "Ek" }, course: { ...C } });
    expect((dto as any).course.startDate).toBe("2026-10-05"); // the admin DTO carries it …
    const pub = toPublicCheckinBooking(dto)!;
    expect(Object.keys(pub).sort()).toEqual(["date", "endTime", "startTime", "student", "subject", "teacher"]);
    expect(JSON.stringify(pub)).not.toContain("startDate"); // … the public one never does
  });
  test("🔒 PUBLIC, by source: every check-in answer goes out through the allow-list; the parent's LINE course view builds its OWN fields (never spreads the summary)", () => {
    const C2 = code("src/services/checkin.service.ts");
    expect(C2).not.toMatch(/return \{[^}]*booking: (booking|result\.booking)[,}]/);
    const chat = code("src/services/line-webhook.service.ts");
    expect(chat).toContain(".map((c: any) => ({ c, s: toCourseSummary(c) }))"); // the summary is used to FILTER (status)…
    expect(chat).not.toMatch(/\.\.\.s\b|\.\.\.toCourseSummary\(/);
  });
  test("📌 the scoped teacher — stated: they read the SAME booking DTO for their own rows, so they see their course's `startDate` (the dates of the sessions they teach are already theirs)", () => {
    const masked = toBookingDTO({ id: "b1", date: "2026-10-05", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "CONFIRMED", student: { id: "s1", name: "Mali" }, teacher: { id: "t1", nickname: "Ek" }, course: { ...C } }, { provenance: "masked" });
    expect((masked as any).course.startDate).toBe("2026-10-05");
  });
});
