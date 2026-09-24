// TASK-436 (`REQ-097` Finding A, built; the `uat` regression) — the coach pair on a TEACHER change. What the read found: (1)
// DELIVERY is clean — the REAL worker path (`processOutboxOnce` → `bookingContext` → the `teacher_*` renderer → `pushMessage`)
// renders and SENDS a `teacher_unassigned` row for a Private and a DUO session; (2) the GATE is clean — `teacherChanged` is
// independent of `override`, the notice-days refusal answers 409 before any write; (3) the DOOR was it — `moveBooking`
// (`PATCH /bookings/:id`, the Move-session popup) never told a coach. Now BOTH doors send the ONE pair through
// `sendTeacherReassigned` (old ⇒ `teacher_unassigned`, new ⇒ `teacher_assigned`), in the write's tx; a date / time / note /
// rate-only move stays silent (REQ-101 §5 ruling B); an unlinked coach gets the SKIPPED row.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as lineLib from "./line";
import * as lineClient from "./line-client";
import * as lineLang from "./line-lang";
import * as sched from "../services/scheduler.service";
import { processOutboxOnce } from "../services/outbox.service";
import { formatOutboxMessage } from "./line-message";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const SCHED = code(src("src/services/scheduler.service.ts"));
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", T2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

describe("🔴 suspect 1 — DELIVERY is clean: the REAL worker path renders and sends `teacher_unassigned` (Private + DUO), marks SENT", () => {
  const chain = (result: any) => { const q: any = { from: () => q, where: () => q, orderBy: () => q, limit: () => q, then: (res: any, rej: any) => Promise.resolve(result).then(res, rej) }; return q; };
  const run = async (row: any) => {
    const outbox = [{ id: "n1", bookingId: "b-1", recipientType: "teacher", recipientLineUserId: "Uold", channel: "line", status: "PENDING", attempts: 0, payload: { kind: "teacher_unassigned", bookingId: "b-1" }, createdAt: new Date() }];
    spies.push(spyOn(db, "select").mockImplementation((() => chain(outbox)) as any));
    const updates: any[] = [];
    spies.push(spyOn(db, "update").mockImplementation((() => ({ set: (p: any) => ({ where: async () => { updates.push(p); } }) })) as any));
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => row) as any));
    spies.push(spyOn(lineLang, "resolveBotLang").mockImplementation((async () => "TH") as any));
    const pushed: any[] = [];
    spies.push(spyOn(lineClient, "pushMessage").mockImplementation((async (to: string, msgs: any[]) => { pushed.push([to, msgs[0].text]); }) as any));
    const r = await processOutboxOnce();
    return { r, pushed, updates };
  };
  const priv = { id: "b-1", date: "2026-09-27", startTime: "11:00:00", endTime: "12:00:00", bookingType: "COURSE_PACKAGE", otherTitle: null, student: { id: "s", name: "พอ ชิตวร", nickname: null }, coStudent: null, teacher: { id: T1, nickname: "Bank" }, subject: { name: "Private SURFSKATE" }, additionalTeachers: [] };
  test("the customer's Private session — the exact bytes of the message that stopped arriving", async () => {
    const { r, pushed, updates } = await run(priv);
    expect(r).toEqual({ sent: 1, failed: 0, retry: 0, errors: [] }); // 🔻 TASK-450: the run now carries the DISTINCT reasons it saw (none here)
    expect(pushed).toEqual([["Uold", "📤 คาบสอนนี้ถูกย้ายออกจากตารางของคุณแล้ว\nนักเรียน: พอ ชิตวร\nวิชา: Private SURFSKATE\nเวลา: 27-09-2026 11:00-12:00"]]);
    expect(updates[0]).toMatchObject({ status: "SENT", attempts: 1, error: null });
  });
  test("a DUO session — `A & B` on the student line, still SENT (TASK-425's fold does not break the renderer)", async () => {
    const { r, pushed } = await run({ ...priv, coStudent: { id: "s2", name: "Praochompoo", nickname: "Prao" } });
    expect(r.sent).toBe(1);
    expect(pushed[0]![1]).toContain("นักเรียน: พอ ชิตวร & Prao");
  });
  test("by source: the render sits OUTSIDE the per-row try — a throw there would stall the whole batch (worth knowing, not the cause: the render does not throw on these shapes)", () => {
    const P = region(code(src("src/services/outbox.service.ts")), "export async function processOutboxOnce(", "\n}\n");
    expect(P.indexOf("const text = formatOutboxMessage(")).toBeLessThan(P.indexOf("try {"));
    expect(formatOutboxMessage({ kind: "teacher_unassigned", bookingId: "b" } as any, {}, "TH", "teacher")).toBe("📤 คาบสอนนี้ถูกย้ายออกจากตารางของคุณแล้ว"); // an empty context still renders the title
  });
});

describe("🔴 suspect 2 — the GATE is clean: `teacherChanged` is independent of `override`; a too-late change answers 409 before any write", () => {
  test("by source", () => {
    const P = region(SCHED, "export async function applyPlanChange(", "\n}\n");
    expect(P).toContain("const teacherChanged = change.teacherId !== undefined && change.teacherId !== b.teacherId;");
    expect(P).toContain("if (teacherChanged && !(change.override ?? false)) {");
    expect(P.indexOf('throw conflict("TEACHER_CHANGE_TOO_LATE"')).toBeLessThan(P.indexOf("await tx.update(bookings).set(patch)"));
    expect(P).toContain("if (teacherChanged) await sendTeacherReassigned(tx, b.id, b.teacherId, newTeacherId);");
    expect(P.indexOf("await tx.update(bookings).set(patch)")).toBeLessThan(P.indexOf("await sendTeacherReassigned("));
  });
});

describe("🔴 suspect 3 — the DOOR: `moveBooking` on a teacher change now sends the pair; date/time-only silent; the ONE helper for both doors", () => {
  const row = { id: "b-1", status: "CONFIRMED", courseId: "c-1", coStudentId: null, teacherId: T1, subjectId: "sub", date: "2026-09-27", startTime: "11:00:00", campWeekDayId: null };
  const fakeTx = () => ({
    query: {
      teachers: { findFirst: async ({ where }: any) => { const probe: string[] = []; where({ id: "id" }, { eq: (_: any, v: string) => { probe.push(v); return null; } }); const id = probe[0]!; return { id, nickname: id === T1 ? "Bank" : "Nok", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME", lineUserId: id === T1 ? "Uold" : "Unew" }; } },
      bookings: { findFirst: async () => ({ ...row, teacher: { id: T1 }, student: null, coStudent: null, subject: null, course: null, badges: [], additionalTeachers: [], rental: null, seats: [], group: null, campWeekDay: null }), findMany: async () => [] },
      bookingTeachers: { findMany: async () => [] },
    },
    update: () => ({ set: () => ({ where: async () => {} }) }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
    delete: () => ({ where: async () => {} }),
    insert: () => ({ values: async () => {} }),
  });
  const arm = () => {
    const notices: any[] = [];
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => row) as any));
    spies.push(spyOn(db.query.coursePackages, "findFirst").mockImplementation((async () => ({ id: "c-1", endedAt: null, droppedAt: null })) as any));
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(fakeTx())) as any));
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { notices.push(o); return { status: "queued" } as any; }) as any));
    spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
    const chain = (result: any) => { const q: any = { from: () => q, where: () => q, leftJoin: () => q, innerJoin: () => q, orderBy: () => q, limit: () => q, offset: () => q, groupBy: () => q, then: (res: any, rej: any) => Promise.resolve(result).then(res, rej) }; return q; };
    spies.push(spyOn(db, "select").mockImplementation((() => chain([])) as any)); // the post-tx DTO reload's batch reads
    return notices;
  };
  const swallow = (e: any) => { if (!/reconcile|holds|undefined|loadBookingDTO|toBookingDTO/.test(String(e?.message ?? e))) throw e; };
  test("a TEACHER change ⇒ `teacher_unassigned` to the old coach's LINE + `teacher_assigned` to the new, both on the row, in that order", async () => {
    const notices = arm();
    await sched.moveBooking("b-1", { teacherId: T2 }).catch(swallow);
    expect(notices.map((n) => [n.recipientType, n.recipientLineUserId, n.bookingId, n.payload.kind])).toEqual([["teacher", "Uold", "b-1", "teacher_unassigned"], ["teacher", "Unew", "b-1", "teacher_assigned"]]);
  });
  test("a date / time / note / rate-only move ⇒ nothing; the SAME teacher sent again ⇒ nothing", async () => {
    const notices = arm();
    await sched.moveBooking("b-1", { date: "2026-10-04", startTime: "14:00", note: "x" }).catch(swallow);
    await sched.moveBooking("b-1", { classRateMinor: 300 }).catch(swallow);
    await sched.moveBooking("b-1", { teacherId: T1 }).catch(swallow);
    expect(notices).toEqual([]);
  });
  test("by source: ONE helper for BOTH doors — the plan edit and the move call `sendTeacherReassigned`; no inline `teacher_unassigned` enqueue remains; the pair rides the write's tx", () => {
    const H = region(SCHED, "export async function sendTeacherReassigned(", "\n}\n");
    expect(H).toContain('payload: { kind: "teacher_unassigned", bookingId }');
    expect(H).toContain('payload: { kind: "teacher_assigned", bookingId }');
    // 🔻 TASK-453 — a THIRD door: resolving a clash by moving the Private to another coach is a teacher change, and
    // it tells the same pair through the same helper rather than writing a third notice.
    expect((SCHED.match(/sendTeacherReassigned\(/g) ?? []).length).toBe(4);
    expect((SCHED.match(/kind: "teacher_unassigned"/g) ?? []).length).toBe(1); // only inside the helper
    const M = region(SCHED, "export async function moveBooking(", "\n}\n");
    expect(M).toContain("if (patch.teacherId && patch.teacherId !== current.teacherId) await sendTeacherReassigned(tx, id, current.teacherId, patch.teacherId);");
    expect(M.indexOf("await tx.update(bookings).set(patch)")).toBeLessThan(M.indexOf("await sendTeacherReassigned("));
    // the series swap keeps its own per-row pair (the same two kinds), untouched
    expect((code(src("src/services/other-series.service.ts")).match(/kind: "teacher_unassigned"/g) ?? []).length).toBe(1);
  });
});
