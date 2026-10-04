// TASK-647 (QA F2, TEST-077) — `teacherNotified` must be COUNTED, not hard-coded.
//
// 🔴 The defect: `notifyTeacherOfLeaveDay` threw away `enqueueLine`'s result and returned a constant `1`, so a coach with no
//    LINE link was reported to the admin as TOLD. The admin then does not phone a coach who was told nothing.
// 🔑 Why every check passed: the server test asserted the SKIPPED row exists; @Fern's test fed her screen a mocked `0`.
//    **Each half was tested against its own idea of the contract; the SEAM was never tested.**
//    ⇒ the last describe here is that missing test: the SERVER's real answer, fed to the shape HER screen reads.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sched from "../services/scheduler.service";
import * as lineLib from "./line";
import * as leaveLib from "./teacher-leave"; // TASK-561's own writer — stubbed; it is not what this file is about
import type { NotifyResult } from "./line";
import { db } from "../db";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SCHED = code("src/services/scheduler.service.ts");
const TEACHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DATE = "2026-12-01";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** The REAL `enqueueLine` rule, in one line: no LINE id ⇒ a SKIPPED row. Everything here goes through it. */
const realEnqueueAnswer = (lineUserId: string | null): NotifyResult =>
  lineUserId ? { channel: "line", status: "queued" } : { channel: "line", status: "skipped", reason: "no link" };

/** Drive the ADMIN's two doors over a fake tx; `lineUserId: null` is @Tanya's unlinked coach (`qatt75b`, `Bank`). */
const arm = (lineUserId: string | null, opts: { alreadyRecorded?: boolean } = {}) => {
  const rows: any[] = [];
  const teacher = { id: TEACHER, nickname: "Bank", name: "Bank", lineUserId };
  const tx: any = {
    query: {
      teachers: { findFirst: async () => teacher },
      teacherLeaveDays: { findFirst: async () => (opts.alreadyRecorded ? { teacherId: TEACHER, date: DATE } : undefined), findMany: async () => [] },
      bookings: { findMany: async () => [], findFirst: async () => null },
      appSettings: { findMany: async () => [], findFirst: async () => null },
    },
    insert: () => ({ values: () => Object.assign(Promise.resolve(), { returning: async () => [{ id: "l1", teacherId: TEACHER, date: DATE }], onConflictDoNothing: () => Object.assign(Promise.resolve(), { returning: async () => (opts.alreadyRecorded ? [] : [{ id: "l1", teacherId: TEACHER, date: DATE }]) }) }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: Object.assign(async () => {}, { returning: async () => [{ id: "l1" }] }) }),
    select: () => { const q: any = { from: () => q, where: () => q, limit: async () => [], innerJoin: async () => [] }; return q; },
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  // the leave DAY itself is recorded by TASK-561's own lib against the real `db` — stubbed, because none of the claims here
  // are about the row it writes. 🔑 What is NOT stubbed is the thing under test: `enqueueLine` and the number read off it.
  spies.push(spyOn(leaveLib, "recordAdvanceLeave").mockImplementation((async () => ({ leave: { teacherId: TEACHER, date: DATE }, alreadyRecorded: !!opts.alreadyRecorded, bookings: [] })) as any));
  spies.push(spyOn(leaveLib, "liftAdvanceLeave").mockImplementation((async () => ({ lifted: 1, date: DATE })) as any));
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => teacher) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
  // 🔑 the fake answers with the REAL rule, so what the service reads is what the outbox would have recorded
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { const r = realEnqueueAnswer(o.recipientLineUserId ?? null); rows.push({ ...o, status: r.status }); return r; }) as any));
  return { rows };
};

describe("🔴 TASK-647 — the number is what HAPPENED, on both doors", () => {
  test("🔴 @Tanya's case — an UNLINKED coach: `teacherNotified: 0`, and a SKIPPED row to show for it", async () => {
    const { rows } = arm(null);
    const out: any = await sched.reportTeacherLeave(TEACHER, { date: DATE, reason: "ลาป่วย" }, "admin-dong", { onBehalf: true });
    expect(out.teacherNotified).toBe(0);
    expect(rows.map((r) => [r.recipientType, r.status])).toEqual([["teacher", "skipped"]]);
  });
  test("✅ a LINKED coach: `1`, and a QUEUED row", async () => {
    const { rows } = arm("U-bank");
    const out: any = await sched.reportTeacherLeave(TEACHER, { date: DATE, reason: "ลาป่วย" }, "admin-dong", { onBehalf: true });
    expect(out.teacherNotified).toBe(1);
    expect(rows.map((r) => r.status)).toEqual(["queued"]);
  });
  test("⚠️ the LIFT is the same function and is pinned too — unlinked ⇒ 0, linked ⇒ 1", async () => {
    const a = arm(null);
    expect((await sched.liftTeacherLeave(TEACHER, DATE, { onBehalf: true }) as any).teacherNotified).toBe(0);
    expect(a.rows.map((r) => r.status)).toEqual(["skipped"]);
    for (const s of spies.splice(0)) s.mockRestore();
    const b = arm("U-bank");
    expect((await sched.liftTeacherLeave(TEACHER, DATE, { onBehalf: true }) as any).teacherNotified).toBe(1);
    expect(b.rows.map((r) => r.status)).toEqual(["queued"]);
  });
  test("🚫 the teacher's OWN door still tells nobody — `onBehalf: false` sends nothing and counts nothing", async () => {
    const { rows } = arm("U-bank");
    const out: any = await sched.reportOwnLeave(TEACHER, { date: DATE, reason: "ลาป่วย" }, TEACHER);
    expect(out.teacherNotified).toBe(0);
    expect(rows).toEqual([]); // 🔑 zero because nothing was SENT, not because a send failed — the same number, two meanings
  });
});

describe("⭐ TASK-647 — THE TEST THAT DID NOT EXIST: the seam between the server's answer and the screen's states", () => {
  // @Fern's screen reads three states off this one field: `> 0` told · `0` NOT told · absent ⇒ say nothing.
  // 🔑 Each side was tested against its own idea of the contract — hers against a mocked `0`, mine against a SKIPPED row —
  // so nobody tested that the server ever PRODUCES the `0` she renders. That is what this does.
  const screenState = (dto: { teacherNotified?: number }) =>
    dto.teacherNotified === undefined ? "silent" : dto.teacherNotified > 0 ? "told" : "not-told";

  test("🔴 the server's own answer for an UNLINKED coach drives the NOT-TOLD state", async () => {
    arm(null);
    const out: any = await sched.reportTeacherLeave(TEACHER, { date: DATE, reason: "ลาป่วย" }, "admin-dong", { onBehalf: true });
    expect(screenState(out)).toBe("not-told"); // ⇐ the admin is told to phone the coach
  });
  test("✅ …and for a LINKED coach it drives TOLD", async () => {
    arm("U-bank");
    const out: any = await sched.reportTeacherLeave(TEACHER, { date: DATE, reason: "ลาป่วย" }, "admin-dong", { onBehalf: true });
    expect(screenState(out)).toBe("told");
  });
  test("✅ and the teacher's own door stays SILENT — the field is absent, not zero", async () => {
    arm("U-bank");
    const out: any = await sched.reportOwnLeave(TEACHER, { date: DATE, reason: "ลาป่วย" }, TEACHER);
    expect(out.teacherNotified).toBe(0);
    // ⚠️ Stated rather than smoothed over: the own-door answer is 0, which HER screen renders as "not told" — and for the
    // teacher's own leave there is nobody to tell. 🔑 The field cannot distinguish *nothing was sent* from *a send was skipped*.
    // 🚫 Not fixed here: changing the shape is @Fern's screen and @Sober's call. 📌 Flagged in the report instead.
    expect(screenState(out)).toBe("not-told");
  });
});

describe("🔑 TASK-647 — read from the RESULT, never re-derived", () => {
  test("the count comes off `enqueueLine`'s own status, and the teacher row is not consulted a second time", () => {
    expect(SCHED).toContain("const sent = await enqueueLine({ recipientType: \"teacher\", recipientLineUserId: teacher?.lineUserId ?? null, payload });");
    expect(SCHED).toContain('return sent.status === "skipped" ? 0 : 1;');
    const at = SCHED.indexOf("async function notifyTeacherOfLeaveDay(");
    expect(at).toBeGreaterThan(0); // the anchor is checked before it is sliced on
    const FN = SCHED.slice(at, SCHED.indexOf("\n}\n", at));
    expect(FN).not.toMatch(/return 1;/);
    expect((FN.match(/teacher\?\.lineUserId/g) ?? []).length).toBe(1); // 🔑 read ONCE, to send — never again to decide the count
  });
  test("📌 `duplicate` counts as TOLD — the message is already queued for them", () => {
    expect(SCHED).not.toMatch(/status === "queued" \? 1 : 0/); // …which is why the test is on `skipped`, not on `queued`
  });
});
