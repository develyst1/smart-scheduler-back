// TASK-817 (REQ-123 Phase 1, P2) — an admin records a teacher's advance leave as a DATE RANGE with ONE reason: `POST /teacher-leave-days { teacherId, from, to, reason }` next to the single-day body.
// One row per day in `teacher_leave_days`, all sharing a new nullable `range_id` (migration 0070), ONE transaction, days already recorded SKIPPED and reported, per-day classes in the answer, ONE LINE to the
// teacher for the whole range. Unchanged: the teacher's own door (one day), the act's fork, the lift, the single-day row (written exactly as before, `range_id` NULL).
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import * as v from "../validation";
import * as sched from "../services/scheduler.service";
import * as leaveLib from "./teacher-leave";
import * as lineLib from "./line";
import { formatOutboxMessage } from "./line-message";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { db } from "../db";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const file = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
const T = "11111111-1111-4111-8111-111111111111";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TODAY = "2026-10-17";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); delete process.env.SKIP_AUTH; });
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const post = async (path: string, body: unknown) => {
  const res = await rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};

/** The leave table in memory (insert / read-back), the day's classes, a transaction that DISCARDS its writes if the callback throws, every notice captured. */
const arm = (opts: { already?: Array<{ date: string; reason: string; rangeId?: string | null }> } = {}) => {
  let rows: any[] = (opts.already ?? []).map((a, i) => ({ id: `old-${i}`, teacherId: T, date: a.date, reason: a.reason, createdBy: "earlier", rangeId: a.rangeId ?? null }));
  const sent: any[] = [];
  const trip = (what: string) => () => { throw new Error(`TASK-817 tripwire: ${what}`); };
  setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
  process.env.SKIP_AUTH = "true";
  const insertImpl = ((t: any) => ({ values: (val: any) => ({ onConflictDoNothing: () => ({ returning: async () => {
    expect(getTableName(t)).toBe("teacher_leave_days");
    if (rows.some((r) => r.teacherId === val.teacherId && r.date === val.date)) return [];
    const row = { id: `l-${rows.length + 1}`, ...val }; rows.push(row); return [row];
  } }) }) })) as any;
  spies.push(spyOn(db, "insert").mockImplementation(insertImpl));
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => { const snapshot = rows.map((r) => ({ ...r })); try { return await fn(db); } catch (e) { rows = snapshot; throw e; } }) as any));
  spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ orderBy: async () => [{ id: "b1", date: "x", startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", bookingType: "PRIVATE" }] }) }) })) as any));
  spies.push(spyOn(db.query.teacherLeaveDays, "findFirst").mockImplementation((async (q: any) => {
    const pairs = [q?.where?.(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, val: unknown) => [[c, val]] })].flat(3);
    const w: Record<string, unknown> = {}; for (let i = 0; i < pairs.length; i += 2) w[pairs[i] as string] = pairs[i + 1];
    return rows.find((r) => r.teacherId === w.teacherId && r.date === w.date);
  }) as any));
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: T, nickname: "Ek", lineUserId: "U-ek" })) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { sent.push(o); return { status: "queued" } as any; }) as any));
  // 🚫 a leave record never cancels / moves a booking
  spies.push(spyOn(db, "update").mockImplementation(trip("a leave record updated a row") as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation(trip("a leave record read bookings for a cancel") as any));
  return { get rows() { return rows; }, sent };
};

describe("🔴 the door's BODY — a range next to the single day; ambiguity is a 400, never a silent pick", () => {
  const range = (extra: object = {}) => ({ teacherId: T, from: "2026-10-20", to: "2026-10-24", reason: "อบรม", ...extra });
  test("a range parses to `{ teacherId, to, reason, date: from }` — `date` is the first day, so the door's ONE future-only line reads it", () => {
    expect(v.adminTeacherLeaveBody.parse(range())).toEqual({ teacherId: T, to: "2026-10-24", reason: "อบรม", date: "2026-10-20" });
  });
  test("the single-day body is unchanged and stays valid (with and without sessionIds)", () => {
    expect(v.adminTeacherLeaveBody.parse({ teacherId: T, date: "2026-10-20", reason: "อบรม" })).toEqual({ teacherId: T, date: "2026-10-20", reason: "อบรม" });
    expect(v.adminTeacherLeaveBody.safeParse({ teacherId: T, date: "2026-10-20", reason: "อบรม", sessionIds: [T] }).success).toBe(true);
    expect(v.adminTeacherLeave.safeParse({ teacherId: T, date: "2026-10-20", reason: "อบรม" }).success).toBe(true); // the export itself is untouched
  });
  test("one day as a range (from = to) is fine; 31 days is the longest, 32 is refused; from after to is refused", () => {
    expect(v.adminTeacherLeaveBody.safeParse(range({ from: "2026-10-20", to: "2026-10-20" })).success).toBe(true);
    expect(v.adminTeacherLeaveBody.safeParse(range({ from: "2026-10-20", to: "2026-11-19" })).success).toBe(true); // 31 days
    expect(v.adminTeacherLeaveBody.safeParse(range({ from: "2026-10-20", to: "2026-11-20" })).success).toBe(false); // 32 days
    expect(v.adminTeacherLeaveBody.safeParse(range({ from: "2026-10-24", to: "2026-10-20" })).success).toBe(false);
    expect(v.MAX_LEAVE_RANGE_DAYS).toBe(31);
  });
  test("ambiguous bodies are refused: `date` with `from`/`to`; a range with `sessionIds`; `from` without `to`; `to` without `from`", () => {
    expect(v.adminTeacherLeaveBody.safeParse({ ...range(), date: "2026-10-20" }).success).toBe(false);
    expect(v.adminTeacherLeaveBody.safeParse({ teacherId: T, date: "2026-10-20", to: "2026-10-24", reason: "อบรม" }).success).toBe(false);
    expect(v.adminTeacherLeaveBody.safeParse({ teacherId: T, date: "2026-10-20", from: "2026-10-20", reason: "อบรม" }).success).toBe(false);
    expect(v.adminTeacherLeaveBody.safeParse(range({ sessionIds: [T] })).success).toBe(false);
    expect(v.adminTeacherLeaveBody.safeParse({ teacherId: T, from: "2026-10-20", reason: "อบรม" }).success).toBe(false);
    expect(v.adminTeacherLeaveBody.safeParse({ teacherId: T, to: "2026-10-24", reason: "อบรม" }).success).toBe(false);
  });
  test("the reason rule is the single-day one (3–200 characters, trimmed)", () => {
    expect(v.adminTeacherLeaveBody.safeParse(range({ reason: "ab" })).success).toBe(false);
    expect(v.adminTeacherLeaveBody.safeParse(range({ reason: "x".repeat(201) })).success).toBe(false);
  });
});

describe("✅ the owner's APPROVED wording (2026-10-17), verbatim — nothing else may drift", () => {
  const msgs = (b: object) => { const r = v.adminTeacherLeaveBody.safeParse(b); return r.success ? [] : r.error.issues.map((i) => i.message); };
  test("the two door refusals", () => {
    expect(msgs({ teacherId: T, from: "2026-10-24", to: "2026-10-20", reason: "อบรม" })).toContain("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม");
    expect(msgs({ teacherId: T, from: "2026-10-20", to: "2026-11-20", reason: "อบรม" })).toContain("ลาล่วงหน้าได้ไม่เกิน 31 วันต่อครั้ง");
  });
  test("🔑 …and they REACH the admin: the 400's details carry the approved sentence (a union would have swallowed it into «Invalid input»)", async () => {
    process.env.SKIP_AUTH = "true";
    const r1 = await post("/teacher-leave-days", { teacherId: T, from: "2026-10-24", to: "2026-10-20", reason: "อบรม" });
    expect(r1.status).toBe(400);
    expect(r1.body.error.details.map((d: any) => d.message)).toContain("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม");
    const r2 = await post("/teacher-leave-days", { teacherId: T, from: "2026-10-20", to: "2026-11-20", reason: "อบรม" });
    expect(r2.body.error.details.map((d: any) => d.message)).toContain("ลาล่วงหน้าได้ไม่เกิน 31 วันต่อครั้ง");
  });
  test("the writer's backstop", () => {
    expect(code(file("src/lib/teacher-leave.ts"))).toContain('badRequest("ช่วงวันลาไม่ถูกต้อง")');
  });
  test("no Phase-1 «DRAFT» marker is left on the range work (the older, other DRAFT markers in the repo are not ours)", () => {
    for (const f of ["src/lib/teacher-leave.ts", "src/validation.ts", "src/lib/line-message.ts"]) expect({ f, left: file(f).match(/TASK-81[79].*DRAFT|DRAFT.*TASK-81[79]/g) ?? [] }).toEqual({ f, left: [] });
    const I = file("src/lib/line-i18n.ts");
    expect(I).not.toMatch(/ob_tl_(blocked|open_again)_range.*DRAFT/);
    expect(I).toContain("// 🔻 TASK-817 — ✅ APPROVED by the owner 2026-10-17 (REQ-123 Phase 1), COPY-REVIEW-2026-09-29.md, verbatim: the range version of ob_tl_blocked");
  });
});

describe("🔴 the act, by value through the ROOT app — one row per day, ONE range_id, one transaction", () => {
  test("a 5-day range ⇒ 200: FIVE rows sharing one uuid `rangeId`, one reason, the admin as author; per-day answer; ONE notice for the whole range; nothing cancelled", async () => {
    const st = arm();
    const r = await post("/teacher-leave-days", { teacherId: T, from: "2026-10-20", to: "2026-10-24", reason: "อบรม" });
    expect(r.status).toBe(200);
    expect(st.rows.map((x) => x.date)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
    expect(new Set(st.rows.map((x) => x.rangeId)).size).toBe(1);
    expect(st.rows[0].rangeId).toMatch(UUID);
    expect(st.rows.every((x) => x.reason === "อบรม" && x.teacherId === T)).toBe(true);
    expect(r.body).toMatchObject({ mode: "advance-range", cancelled: 0, bookingIds: [], familiesNotified: 0, from: "2026-10-20", to: "2026-10-24", recordedDays: 5, alreadyRecordedDays: 0, teacherNotified: 1, rangeId: st.rows[0].rangeId });
    expect(r.body.days).toHaveLength(5);
    expect(r.body.days.map((d: any) => [d.date, d.alreadyRecorded])).toEqual([["2026-10-20", false], ["2026-10-21", false], ["2026-10-22", false], ["2026-10-23", false], ["2026-10-24", false]]);
    expect(r.body.days[0].bookings).toEqual([{ id: "b1", date: "x", startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", bookingType: "PRIVATE" }]);
    // ONE notice, not five: the whole range, to that teacher only
    expect(st.sent).toHaveLength(1);
    expect([st.sent[0].recipientType, st.sent[0].recipientLineUserId]).toEqual(["teacher", "U-ek"]);
    expect(st.sent[0].payload).toEqual({ kind: "teacher_leave_recorded", date: "2026-10-20", to: "2026-10-24", classes: 5, actor: expect.anything() });
  });

  test("days ALREADY recorded are SKIPPED (their own reason and range stay) and reported; the new days share one id; the teacher is told once", async () => {
    const st = arm({ already: [{ date: "2026-10-21", reason: "เดิม", rangeId: null }, { date: "2026-10-23", reason: "เดิม2", rangeId: "99999999-9999-4999-8999-999999999999" }] });
    const r = await post("/teacher-leave-days", { teacherId: T, from: "2026-10-20", to: "2026-10-24", reason: "ใหม่ๆ" });
    expect(r.status).toBe(200);
    expect(r.body.days.map((d: any) => [d.date, d.alreadyRecorded])).toEqual([["2026-10-20", false], ["2026-10-21", true], ["2026-10-22", false], ["2026-10-23", true], ["2026-10-24", false]]);
    expect([r.body.recordedDays, r.body.alreadyRecordedDays]).toEqual([3, 2]);
    expect(st.rows).toHaveLength(5);
    expect(st.rows.find((x) => x.date === "2026-10-21")).toMatchObject({ reason: "เดิม", rangeId: null }); // the first record stands
    expect(st.rows.find((x) => x.date === "2026-10-23")).toMatchObject({ reason: "เดิม2", rangeId: "99999999-9999-4999-8999-999999999999" });
    const fresh = st.rows.filter((x) => x.reason === "ใหม่ๆ");
    expect(fresh.map((x) => x.date)).toEqual(["2026-10-20", "2026-10-22", "2026-10-24"]);
    expect(new Set(fresh.map((x) => x.rangeId)).size).toBe(1);
    expect(st.sent).toHaveLength(1);
  });

  test("EVERY day already there ⇒ nothing written, no `rangeId`, the teacher is NOT told again", async () => {
    const st = arm({ already: [{ date: "2026-10-20", reason: "เดิม" }, { date: "2026-10-21", reason: "เดิม" }] });
    const r = await post("/teacher-leave-days", { teacherId: T, from: "2026-10-20", to: "2026-10-21", reason: "ซ้ำ" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rangeId: null, recordedDays: 0, alreadyRecordedDays: 2, teacherNotified: 0 });
    expect(st.rows).toHaveLength(2);
    expect(st.sent).toEqual([]);
  });

  test("🔴 TODAY or the past anywhere at the start ⇒ 400 at the door (the SAME future-only line), NOTHING written, nobody told — the writer is never reached", async () => {
    const st = arm();
    const writer = spyOn(leaveLib, "recordAdvanceLeaveRange");
    spies.push(writer);
    for (const from of [TODAY, "2026-10-10"]) {
      const r = await post("/teacher-leave-days", { teacherId: T, from, to: "2026-10-24", reason: "อบรม" });
      expect(r.status).toBe(400);
    }
    expect(writer).not.toHaveBeenCalled();
    expect(st.rows).toEqual([]);
    expect(st.sent).toEqual([]);
  });

  test("the single-day body is unchanged: the same `advance` answer, the row WITHOUT a rangeId, one notice with no `to`", async () => {
    const st = arm();
    const r = await post("/teacher-leave-days", { teacherId: T, date: "2026-10-21", reason: "อบรม" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: "advance", cancelled: 0, alreadyRecorded: false, teacherNotified: 1 });
    expect(st.rows).toHaveLength(1);
    expect("rangeId" in st.rows[0]).toBe(false); // written exactly as before — the column stays NULL
    expect(st.sent[0].payload).toEqual({ kind: "teacher_leave_recorded", date: "2026-10-21", classes: 1, actor: expect.anything() });
  });
});

describe("🔴 the writer, directly — a failing day rolls the transaction back (the real ONE-transaction property)", () => {
  test("`reportTeacherLeaveRange` runs the whole write inside `db.transaction`; a throw on day 3 leaves nothing", async () => {
    const st = arm();
    let calls = 0;
    // make the 3rd INSERT fail
    spies.push(spyOn(db, "insert").mockImplementation(((t: any) => ({ values: (val: any) => ({ onConflictDoNothing: () => ({ returning: async () => {
      if (++calls === 3) throw new Error("db down on day 3");
      const row = { id: `l-${st.rows.length + 1}`, ...val }; st.rows.push(row); return [row];
    } }) }) })) as any));
    await expect(sched.reportTeacherLeave(T, { date: "2026-10-20", to: "2026-10-24", reason: "อบรม" }, "admin", { onBehalf: true })).rejects.toThrow("db down on day 3");
    expect(st.rows).toEqual([]); // 🔑 the transaction discarded days 1–2
    expect(st.sent).toEqual([]);
  });
});

describe("⭐ the ONE LINE to the teacher — the Date line shows the span, the blocked line says «those days» (✅ APPROVED wording)", () => {
  const ctx = { date: "", startTime: "", endTime: "" };
  const render = (payload: any, lang: "TH" | "EN") => formatOutboxMessage(payload, ctx as any, lang, "teacher");
  test("a RANGE: `Date: dd-mm-yyyy – dd-mm-yyyy`, the range blocked line (TH + EN), the classes line, Recorded by", () => {
    const p = { kind: "teacher_leave_recorded", date: "2026-10-20", to: "2026-10-24", classes: 3, actor: "Admin D" };
    expect(render(p, "EN")).toBe("🗓️ LEAVE RECORDED\nDate: 20-10-2026 – 24-10-2026\nNo new class will be booked on those days.\nThe 3 class(es) that already booked, still on. \nRecorded by: Admin D");
    expect(render(p, "TH")).toContain("Date: 20-10-2026 – 24-10-2026");
    expect(render(p, "TH")).toContain("ช่วงวันนั้นจะไม่มีการจองคาบใหม่กับคุณ");
  });
  test("a SINGLE day is byte-identical to today (no `to`, or `to` = the same day)", () => {
    const one = { kind: "teacher_leave_recorded", date: "2026-10-22", classes: 2, actor: "Admin D" };
    expect(render(one, "EN")).toBe("🗓️ LEAVE RECORDED\nDate: 22-10-2026\nNo new class will be booked.\nThe 2 class(es) that already booked, still on. \nRecorded by: Admin D");
    expect(render({ ...one, to: "2026-10-22" }, "EN")).toBe(render(one, "EN"));
  });
  test("the LIFTED notice: a single day is untouched; (🔻 TASK-819) a lifted RANGE shows the span and the range open-again line", () => {
    const l = { kind: "teacher_leave_lifted", date: "2026-10-22", actor: "Admin D" };
    expect(render({ ...l, to: "2026-10-22" }, "EN")).toBe(render(l, "EN"));
    expect(render({ ...l, to: "2026-10-24" }, "EN")).toBe("🗓️ LEAVE CANCELLED\nDate: 22-10-2026 – 24-10-2026\nBookings with you are open again on those days.\nRecorded by: Admin D");
  });
});

describe("🔑 by source and by shape — one day writer, the fork and the lift untouched, the migration", () => {
  const LIB = code(file("src/lib/teacher-leave.ts"));
  const SVC = code(file("src/services/scheduler.service.ts"));
  test("the range writer goes through THE day writer (`recordAdvanceLeave`) — the one future-only check; no second predicate", () => {
    const W = region(LIB, "export async function recordAdvanceLeaveRange(", "\n}\n");
    expect(W).toContain("await recordAdvanceLeave(exec, teacherId, { date, reason: input.reason, rangeId }, actor)");
    expect(W).not.toMatch(/isAdvanceLeave\(|new Date\(|bangkokNow/);
    expect(LIB).toContain("...(input.rangeId ? { rangeId: input.rangeId } : {})"); // a single-day row is written exactly as before
  });
  test("the service: the range branch sits BEFORE the act's fork; the act itself still forks ONCE; the range is ONE transaction + ONE notice", () => {
    const ACT = region(SVC, "export async function reportTeacherLeave(", "export const reportOwnLeave");
    expect(ACT.indexOf("if (input.to !== undefined) return reportTeacherLeaveRange(")).toBeGreaterThan(0);
    expect(ACT.indexOf("if (input.to !== undefined)")).toBeLessThan(ACT.indexOf("if (isAdvanceLeave(input.date))"));
    expect((ACT.match(/isAdvanceLeave\(/g) ?? []).length).toBe(1);
    const R = region(SVC, "async function reportTeacherLeaveRange(", "\n}\n");
    expect(R).toContain("await db.transaction(async (tx) => {"); // 🔻 TASK-826: the SAME transaction also takes the leaver off co-taught classes (and remembers it)
    expect(R).toContain("const r = await recordAdvanceLeaveRange(tx, teacherId, input, actor);");
    expect((R.match(/notifyTeacherOfLeaveDay\(/g) ?? []).length).toBe(1);
    expect(R).toContain("opts.onBehalf && fresh > 0");
  });
  test("the lift and the teacher's own door are untouched (no `to`, no rangeId)", () => {
    expect(region(SVC, "export async function liftTeacherLeave(", "\n}\n")).not.toMatch(/rangeId|range/);
    expect(v.teacherLeave.safeParse({ date: "2026-10-20", to: "2026-10-24", reason: "อบรม" }).success).toBe(true); // zod strips the unknown key…
    expect((v.teacherLeave.parse({ date: "2026-10-20", to: "2026-10-24", reason: "อบรม" }) as any).to).toBeUndefined(); // …so the teacher's own door can never carry a range
  });
  test("the door: the POST validates the new body and its future-only line is the SAME one (reads `input.date`)", () => {
    const API = code(file("src/routes/api.ts"));
    expect(API).toContain('.post("/teacher-leave-days", zValidator("json", v.adminTeacherLeaveBody)');
    expect(API).toContain("if (!isAdvanceLeave(input.date)) throw ADMIN_LEAVE_FUTURE_ONLY();");
  });
  test("migration 0070: one nullable uuid column, IF NOT EXISTS, no data written; journal idx 70; the witness probes the column; the schema declares it", () => {
    const sql = file("drizzle/0070_teacher_leave_range.sql");
    expect(code(sql.replace(/^--.*$/gm, ""))).toContain('ALTER TABLE "teacher_leave_days" ADD COLUMN IF NOT EXISTS "range_id" uuid;');
    expect(sql.replace(/^--.*$/gm, "")).not.toMatch(/INSERT|UPDATE|DELETE|NOT NULL|DEFAULT/i);
    const journal = JSON.parse(file("drizzle/meta/_journal.json"));
    expect(journal.entries.find((e: any) => e.tag === "0070_teacher_leave_range")).toMatchObject({ idx: 70, tag: "0070_teacher_leave_range", breakpoints: true });
    expect(SCHEDULING_WITNESSES.find((w) => w.tag === "0070_teacher_leave_range")).toMatchObject({ tag: "0070_teacher_leave_range", probe: { kind: "column", table: "teacher_leave_days", column: "range_id" }, rerunnable: true });
    expect(code(file("src/db/schema.ts"))).toContain('rangeId: uuid("range_id"),');
  });
});
