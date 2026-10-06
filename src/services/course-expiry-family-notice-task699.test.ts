// TASK-699 (REQ-112, owner ruling 2026-10-07 via @Porter) — the FAMILY is told when an ADMIN changes a course's expiry, LONGER or SHORTER.
// Driven THROUGH the real `updateCourseExpiry` over a fake transaction; what is asserted is what the outbox would hold. The family is the ONLY audience (no coach, no admin),
// ONE notice per household account, a NEW kind (never `course_confirmed`), inside the SAME transaction as the write.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as lineLib from "../lib/line";
import * as family from "../lib/family-link";
import { formatOutboxMessage } from "../lib/line-message";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

type Course = { id: string; studentId: string; coStudentId: string | null; size: number; expiryDate: string; endedAt: Date | null; droppedAt: Date | null };
const base = (over: Partial<Course> = {}): Course => ({ id: "c1", studentId: "s1", coStudentId: null, size: 6, expiryDate: "2026-12-02", endedAt: null, droppedAt: null, ...over });

/** The world: one course, its rows; `writes` is every table write in order; the outbox is what `enqueueLine` was asked to send. `failAt` makes the audit write throw (⇒ the transaction rolls back). */
function world(course: Course, opts: { accounts?: string[]; failAudit?: boolean } = {}) {
  const w: any = { course: { ...course }, expiryChanges: [] as any[], outbox: [] as any[], txOpen: false, committed: false };
  const tx: any = {
    query: {
      coursePackages: { findFirst: async () => w.course },
      bookings: { findFirst: async () => ({ id: "b1", courseId: course.id, bookingType: "COURSE_PACKAGE" }) },
    },
    update: () => ({ set: (set: any) => ({ where: async () => { Object.assign(w.course, set); } }) }),
    insert: (_t: any) => ({ values: async (v: any) => { if (opts.failAudit) throw new Error("audit write failed"); w.expiryChanges.push(v); } }),
  };
  // a REAL transaction rolls back when its callback throws: snapshot, restore, and DROP what was enqueued inside it
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => {
    const snap = { course: { ...w.course }, expiryChanges: [...w.expiryChanges], outbox: [...w.outbox] };
    w.txOpen = true;
    try { const r = await fn(tx); w.committed = true; return r; } catch (e) { w.course = snap.course; w.expiryChanges = snap.expiryChanges; w.outbox = snap.outbox; throw e; } finally { w.txOpen = false; }
  }) as any));
  spies.push(spyOn(db.query.coursePackages, "findFirst").mockImplementation((async () => ({ ...w.course, student: { id: "s1", name: "Mali", nickname: "Mali" } })) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
  spies.push(spyOn(family, "householdLineUserIds").mockImplementation((async () => opts.accounts ?? ["U-mum"]) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (row: any, _exec: any) => { w.outbox.push({ ...row, inTx: w.txOpen }); return { status: "queued" } as any; }) as any));
  return w;
}
const kindsOf = (w: any) => w.outbox.map((o: any) => o.payload?.kind);
const run = (id: string, to: string) => sched.updateCourseExpiry(id, { expiryDate: to }, "admin-dong");

describe("🔴 TASK-699 — an admin's edit tells the FAMILY: longer OR shorter, ONE notice, no direction branch", () => {
  test("LONGER ⇒ ONE parent row for the household account, kind `course_expiry_changed`, { from, to } correct", async () => {
    const w = world(base());
    await run("c1", "2026-12-16");
    expect(w.outbox).toHaveLength(1);
    expect(w.outbox[0]).toMatchObject({ recipientType: "parent", recipientLineUserId: "U-mum", payload: { kind: "course_expiry_changed", courseId: "c1", from: "2026-12-02", to: "2026-12-16" } });
  });
  test("SHORTER ⇒ the SAME notice (a date moved EARLIER is told too)", async () => {
    const w = world(base());
    await run("c1", "2026-11-18");
    expect(w.outbox).toHaveLength(1);
    expect(w.outbox[0].payload).toMatchObject({ kind: "course_expiry_changed", from: "2026-12-02", to: "2026-11-18" });
  });
  test("a DUO course reaches BOTH households, each ONCE (the helper de-duplicates)", async () => {
    const w = world(base({ coStudentId: "s2" }), { accounts: ["U-mum", "U-dad"] });
    await run("c1", "2026-12-16");
    expect(w.outbox.map((o: any) => o.recipientLineUserId).sort()).toEqual(["U-dad", "U-mum"]);
    expect((family.householdLineUserIds as any).mock.calls[0][1]).toEqual(["s1", "s2"]);
  });
  test("NO linked account ⇒ ONE skipped row (the family could not be reached — one fact)", async () => {
    const w = world(base(), { accounts: [] });
    await run("c1", "2026-12-16");
    expect(w.outbox).toHaveLength(1);
    expect(w.outbox[0]).toMatchObject({ recipientType: "parent", recipientLineUserId: null });
  });
  test("🚫 no teacher row, no admin row — the family is the ONLY audience", async () => {
    const w = world(base());
    await run("c1", "2026-12-16");
    expect(w.outbox.filter((o: any) => o.recipientType !== "parent")).toHaveLength(0);
  });
});

describe("🔴 TASK-699 — when NOT", () => {
  test("`from === to` is not a change ⇒ NO row at all", async () => {
    const w = world(base());
    await run("c1", "2026-12-02");
    expect(w.outbox).toHaveLength(0);
    expect(w.expiryChanges).toHaveLength(0); // …exactly as `recordExpiryChange` already treats it
  });
  test("an ENDED course ⇒ NO row (a validity date on a finished course tells the family something false)", async () => {
    const w = world(base({ endedAt: new Date("2026-11-01T00:00:00Z") }));
    await run("c1", "2026-12-16");
    expect(w.outbox).toHaveLength(0);
  });
  test("a DROPPED (paused) course IS told — that is exactly when an admin extends before resuming", async () => {
    const w = world(base({ droppedAt: new Date("2026-11-01T00:00:00Z") }));
    await run("c1", "2026-12-16");
    expect(kindsOf(w)).toEqual(["course_expiry_changed"]);
  });
  test("the audit write failing ⇒ NO row (same transaction — the notice exists iff the write committed)", async () => {
    const w = world(base(), { failAudit: true });
    await expect(run("c1", "2026-12-16")).rejects.toThrow("audit write failed");
    expect(w.outbox).toHaveLength(0);
    expect(w.course.expiryDate).toBe("2026-12-02");
  });
  test("the notice is enqueued INSIDE the transaction, not after it", async () => {
    const w = world(base());
    await run("c1", "2026-12-16");
    expect(w.outbox.every((o: any) => o.inTx === true)).toBe(true);
  });
});

describe("🔴 TASK-699 — NOT the automatic weeks, NOT the re-plans, NOT vouchers (by source: ONE writer)", () => {
  const S = readSrc(readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8")).replace(/\r\n/g, "\n");
  const code = S.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const fn = (name: string, next: string) => { const a = code.indexOf(name); return code.slice(a, code.indexOf(next, a + 10)); };
  test("the kind is raised in exactly ONE place, and it is `updateCourseExpiry`", () => {
    expect(code.split('"course_expiry_changed"').length - 1).toBe(1);
    expect(fn("export async function updateCourseExpiry(", "export async function getCourseExpiryHistory")).toContain('kind: "course_expiry_changed"');
  });
  test("`addLeaveWeek` (T1/T2/T3), `changeCourseStart`, `resumeCourse` and the voucher's writer raise NOTHING of the kind", () => {
    expect(fn("export async function addLeaveWeek(", "\nexport async function ")).not.toContain("course_expiry_changed");
    expect(fn("export async function changeCourseStart(", "\nexport async function ")).not.toContain("course_expiry_changed");
    expect(fn("export async function resumeCourse(", "\nexport async function ")).not.toContain("course_expiry_changed");
  });
  test("by value: `addLeaveWeek` writes no such row (an automatic week rides an event the family already hears about)", async () => {
    const w = world(base());
    const tx: any = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ to: "2026-12-09" }] }) }) }), insert: () => ({ values: async () => {} }), query: { coursePackages: { findFirst: async () => w.course } } };
    await sched.addLeaveWeek(tx, "c1", "T2_COACH_LEAVE");
    expect(w.outbox).toHaveLength(0);
  });
  test("the recipients are the household accounts, through the ONE sender, and never the coach or admin sender", () => {
    const f = fn("export async function updateCourseExpiry(", "export async function getCourseExpiryHistory");
    expect(f).toContain("await enqueueParentCopies(tx, await householdLineUserIds(tx, [course.studentId, course.coStudentId]), {");
    expect(f).not.toMatch(/notifyAdmins|teachersOfBooking|recipientType: "teacher"|recipientType: "admin"/);
    expect(f).not.toContain("course_confirmed");
  });
});

describe("📋 TASK-699 — the words (DRAFT, owner approval pending): exactly the two strings, fields filled; the student and program by the ONE rules", () => {
  const msg = (lang: "TH" | "EN", ctx: any = { studentName: "Mali", subject: "Private Freeskate" }) =>
    formatOutboxMessage({ kind: "course_expiry_changed", courseId: "c1", from: "2026-12-02", to: "2026-12-16", size: 6 } as any, ctx, lang, "parent");
  test("TH", () => {
    expect(msg("TH")).toBe("แจ้งเปลี่ยนวันหมดอายุคอร์สค่ะ: คอร์ส Private Freeskate 6 HR ของ Mali ใช้ได้ถึงวันที่ 16-12-2026 (จากเดิม 02-12-2026) หากมีข้อสงสัย กรุณาติดต่อแอดมินค่ะ");
  });
  test("EN", () => {
    expect(msg("EN")).toBe("Course expiry date changed: Mali's Private Freeskate 6 HR course is now valid until 16-12-2026 (previously 02-12-2026). Please contact Admin if you have any questions.");
  });
  test("a missing student / program renders `-`, never a raw `{placeholder}` or a blank; dates are never raw ISO", () => {
    for (const lang of ["TH", "EN"] as const) {
      const m = formatOutboxMessage({ kind: "course_expiry_changed" } as any, {}, lang, "parent");
      expect(m).not.toMatch(/[{}]/);
      expect(msg(lang)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
  test("marked DRAFT in the dictionary, beside the key", () => {
    const I = readFileSync(resolve(import.meta.dir, "../lib/line-i18n.ts"), "utf8");
    expect(I).toContain("ob_course_expiry_changed");
    expect(I).toMatch(/📋 DRAFT: owner approval pending in @Porter's copy set[^\n]*\n[^\n]*\n\s*ob_course_expiry_changed/);
  });
});
