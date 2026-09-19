// TASK-403 (`REQ-095` Stage 3b + `REQ-096`, SPEC-082) — the 08:15 reminder CONFIRMED-only (one constant, both
// audiences, the seats), the UNDO of a consumed camp day (units back, floored, a reason, no money), the camp DAY's
// check-in QR (lazy token, 23:59:59 expiry, the public scan through the SAME `markDay`, 410 / 409s), the camp-day
// reminder's SEND PATH behind `camp_reminder_enabled` (default off) with PLACEHOLDER labels. Migration `0043` — 45 = 45.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import { assertDayTransition, campScanOutcome, campTokenExpiry, isUndo, unitsDelta, usedAfter } from "./camp";
import { REMINDABLE, groupReminders, reminderKey, type ReminderSession } from "./daily-reminder";
import { CAMP_REMINDABLE, campReminderKey, campReminderSends, type CampDayInput, type CampWeekInput } from "./camp-reminder";
import { CAMP_NAMES_MAX, formatOutboxMessage } from "./line-message";
import { SETTINGS, resolveSetting } from "./settings";
import { checkinUrl } from "./checkin-token";
import { ROUTE_ACCESS } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import * as v from "../validation";
import * as camp from "../services/camp.service";
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
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const SVC = code(src("src/services/camp.service.ts"));
const JOB = code(src("src/services/jobs.service.ts"));
const D1 = "44444444-4444-4444-8444-444444444444", W1 = "22222222-2222-4222-8222-222222222222", W2 = "22222222-2222-4222-8222-222222222223";
const thrown = (fn: () => unknown) => { try { fn(); return null; } catch (e: any) { return { status: e.status, code: e.code, message: e.message }; } };

afterAll(() => { delete process.env.SKIP_AUTH; });

describe("🔴 the migration — 0043, counted, three NULLABLE adds, the partial unique index LAST = the witness (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const sql = readFileSync(resolve(root, "drizzle/0043_camp_checkin_token.sql"), "utf8");
  test("45 = 45: `0043_camp_checkin_token` is the 44th file, idx 43 (TASK-406 added 0044 after it); the order 0038 → 0043 and 'expects 44' in the header", () => {
    expect(files.length).toBe(45);
    expect(journal.entries.length).toBe(45);
    expect(files[43]).toBe("0043_camp_checkin_token.sql");
    expect(journal.entries[43]).toMatchObject({ idx: 43, tag: "0043_camp_checkin_token" });
    expect(sql).toContain("`0038` → `0039` → `0040` → `0041` → `0042` → THIS");
    expect(sql).toContain("`db:verify` expects 44");
  });
  test("four statements: three `ADD COLUMN IF NOT EXISTS … NULL` on camp_days, then the partial unique index on the token; no enum, no bookings", () => {
    const stmts = sql.split("\n").filter((l) => !l.startsWith("--") && l.trim()).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
    expect(stmts.length).toBe(4);
    expect(stmts.slice(0, 3).map((s) => s.match(/ADD COLUMN IF NOT EXISTS "(\w+)"/)![1])).toEqual(["checkin_token", "checkin_token_expires_at", "undo_reason"]);
    for (const s of stmts.slice(0, 3)) { expect(s.startsWith('ALTER TABLE "camp_days" ADD COLUMN IF NOT EXISTS')).toBe(true); expect(s.endsWith("NULL")).toBe(true); expect(s).not.toContain("DEFAULT"); }
    expect(stmts[3]).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "camp_days_checkin_token_uq" ON "camp_days" ("checkin_token") WHERE "checkin_token" IS NOT NULL');
    expect(stmts.join(";")).not.toMatch(/CREATE TYPE|ALTER TYPE|'GROUP'|"bookings"/);
    expect(sql).toContain("catalog-only");
    expect(sql).toContain("No lock on any hot table");
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0043_camp_checkin_token");
    expect(w).toMatchObject({ tag: "0043_camp_checkin_token", probe: { kind: "index", index: "camp_days_checkin_token_uq" }, rerunnable: true });
    const schema = region(code(src("src/db/schema.ts")), "export const campDays = pgTable(", "export const campWeeksRelations");
    for (const col of ['text("checkin_token")', 'timestamp("checkin_token_expires_at"', 'text("undo_reason")', 'uniqueIndex("camp_days_checkin_token_uq").on(t.checkinToken).where(']) expect(schema).toContain(col);
    // 🚫 the PACKAGE still has no expiry — 0043 touches camp_days only
    expect(sql).not.toContain('"camp_packages"');
  });
});

describe("🔴 REQ-096 — the 08:15 reminder is CONFIRMED-only: ONE constant, both audiences, the GROUP seats", () => {
  const S = (status: string, id = status): ReminderSession => ({ id, date: "2026-10-05", startTime: "10:00", status, teacherId: "t1", teacherLineUserId: "Ut1", studentId: "s-" + id, studentName: "น้อง" + id, parentId: "p-" + id, parentLineUserId: "Up" + id, parentLineUserIds: ["Up" + id], subjectName: "Freeskate" });
  test("by value: REMINDABLE = {CONFIRMED}; a PENDING and an EXTENDED row today ⇒ no entry for the coach nor the family; a CONFIRMED ⇒ one each", () => {
    expect([...REMINDABLE]).toEqual(["CONFIRMED"]);
    const groups = groupReminders([S("PENDING"), S("EXTENDED"), S("CONFIRMED"), S("SICK_LEAVE"), S("CANCELLED")]);
    expect(groups.map((g) => g.recipientType).sort()).toEqual(["parent", "teacher"]);
    const coach = groups.find((g) => g.recipientType === "teacher")!;
    expect(coach.rows.length).toBe(1);
    expect(groups.find((g) => g.recipientType === "parent")!.personId).toBe("p-CONFIRMED");
    expect(groupReminders([S("PENDING"), S("EXTENDED")])).toEqual([]);
  });
  test("by source: the seats filter reads the SAME set; no second list anywhere in the job; the day-end select is still CONFIRMED-only and byte-frozen", () => {
    expect(JOB).toContain('seats: r.bookingType === "GROUP" ? (r.seats ?? []).filter((x: any) => REMINDABLE.has(x.status))');
    expect(JOB).not.toMatch(/new Set\(\["PENDING"|REMINDABLE_SEAT|"EXTENDED"/);
    expect(JOB).toContain('eq(bookings.status, "CONFIRMED")');
    expect(code(src("src/lib/daily-reminder.ts"))).toContain('export const REMINDABLE = new Set(["CONFIRMED"]);');
  });
});

describe("🔴 the UNDO — ATTENDED | ABSENT → PLANNED: units back, floored at 0, a reason at the boundary, no money (value + source)", () => {
  test("the transition and the arithmetic by value", () => {
    expect(isUndo("ATTENDED", "PLANNED")).toBe(true); expect(isUndo("ABSENT", "PLANNED")).toBe(true);
    expect(isUndo("CANCELLED", "PLANNED")).toBe(false); expect(isUndo("PLANNED", "ATTENDED")).toBe(false);
    expect(() => assertDayTransition("ATTENDED", "PLANNED", "2026-10-01", "2026-10-05")).not.toThrow(); // a past day undoes
    expect(() => assertDayTransition("ABSENT", "PLANNED", "2026-10-05", "2026-10-05")).not.toThrow();
    expect(thrown(() => assertDayTransition("CANCELLED", "PLANNED", "2026-10-06", "2026-10-05"))).toMatchObject({ status: 409, code: "CAMP_DAY_TRANSITION" });
    expect(unitsDelta("ATTENDED", "PLANNED", 2)).toBe(-2);
    expect(unitsDelta("ABSENT", "PLANNED", 1)).toBe(-1);
    expect(usedAfter(4, -2)).toBe(2);
    expect(usedAfter(1, -2)).toBe(0); // 🔑 the floor — a row that was mis-counted never goes negative
    expect(usedAfter(0, 2)).toBe(2);
    expect(usedAfter(undefined as any, -1)).toBe(0);
  });
  test("validation: PLANNED needs a reason (3..200); a mark refuses one; the three marks still pass", () => {
    expect(v.markCampDay.safeParse({ status: "PLANNED", reason: "บันทึกผิดคน" }).success).toBe(true);
    expect(v.markCampDay.safeParse({ status: "PLANNED" }).success).toBe(false);
    expect(v.markCampDay.safeParse({ status: "PLANNED", reason: "ab" }).success).toBe(false);
    expect(v.markCampDay.safeParse({ status: "PLANNED", reason: "x".repeat(201) }).success).toBe(false);
    expect(v.markCampDay.safeParse({ status: "ATTENDED", reason: "ไม่ควรมี" }).success).toBe(false);
    for (const s of ["ATTENDED", "ABSENT", "CANCELLED"]) expect(v.markCampDay.safeParse({ status: s }).success).toBe(true);
  });
  test("the service by source: the reason stored on the undo and cleared by a mark; `usedAfter` on the package; the day-end's rows undo alike; no sale", () => {
    const M = region(SVC, "export async function markDay(", "export async function getDayCheckinQr(");
    expect(M).toContain("const undo = isUndo(d.status, status);");
    expect(M).toContain('if (undo && !reason) throw badRequest("การยกเลิกการบันทึกต้องระบุเหตุผล");');
    expect(M).toContain("undoReason: undo ? reason : null");
    expect(M).toContain("usedUnits: usedAfter(p?.usedUnits ?? 0, delta)");
    expect(M).not.toContain("markedBy ==="); // only `status` is read — the cut's "end-of-day" rows and a staff mark are the same to it
    expect(M).not.toMatch(/recordSale|sales\b|refund/);
    expect((SVC.match(/recordSale\(/g) ?? []).length).toBe(1); // still the ONE post, in the sale
    expect(SVC).toContain("undoReason: d.undoReason ?? null"); // the day row carries it back
  });
});

describe("🔴 the check-in QR — lazy token, the whole date, the public scan through the SAME `markDay` (value + source)", () => {
  test("the expiry is 23:59:59 Bangkok of the day's date; ONE url helper serves both routes", () => {
    expect(campTokenExpiry("2026-10-05").toISOString()).toBe("2026-10-05T16:59:59.000Z");
    const saved = process.env.PUBLIC_CHECKIN_BASE_URL;
    try {
      process.env.PUBLIC_CHECKIN_BASE_URL = "https://liff.example/";
      expect(checkinUrl("/checkin/camp?token=abc")).toBe("https://liff.example/checkin/camp?token=abc");
      delete process.env.PUBLIC_CHECKIN_BASE_URL;
      expect(checkinUrl("/checkin?token=abc")).toBe("/checkin?token=abc");
    } finally { if (saved !== undefined) process.env.PUBLIC_CHECKIN_BASE_URL = saved; else delete process.env.PUBLIC_CHECKIN_BASE_URL; }
    expect(code(src("src/lib/checkin-token.ts"))).toContain("url: checkinUrl(`/checkin?token=${token}`),");
    expect(SVC).toContain("url: checkinUrl(`/checkin/camp?token=${token}`)");
  });
  test("the scan rule by value: ATTENDED ⇒ already (even expired); CANCELLED 409; expired 410; another date 409 CAMP_DAY_NOT_TODAY; PLANNED and ABSENT ⇒ attend", () => {
    const now = new Date("2026-10-05T03:00:00Z"), today = "2026-10-05", live = new Date("2026-10-05T16:59:59+07:00"), dead = new Date("2026-10-04T16:59:59+07:00");
    expect(campScanOutcome({ status: "ATTENDED", date: today, checkinTokenExpiresAt: dead }, today, now)).toBe("already");
    expect(campScanOutcome({ status: "PLANNED", date: today, checkinTokenExpiresAt: live }, today, now)).toBe("attend");
    expect(campScanOutcome({ status: "ABSENT", date: today, checkinTokenExpiresAt: live }, today, now)).toBe("attend");
    expect(thrown(() => campScanOutcome({ status: "CANCELLED", date: today, checkinTokenExpiresAt: live }, today, now))).toMatchObject({ status: 409, code: "CAMP_DAY_TRANSITION" });
    expect(thrown(() => campScanOutcome({ status: "PLANNED", date: "2026-10-04", checkinTokenExpiresAt: dead }, today, now))).toEqual({ status: 410, code: "CAMP_TOKEN_EXPIRED", message: "โทเคนเช็คอินหมดอายุแล้ว" });
    expect(thrown(() => campScanOutcome({ status: "PLANNED", date: "2026-10-06", checkinTokenExpiresAt: new Date("2026-10-06T16:59:59+07:00") }, today, now))).toMatchObject({ status: 409, code: "CAMP_DAY_NOT_TODAY" });
  });
  test("by source: minted only when absent (never at redeem); the scan attends through `markDay(…, \"ATTENDED\", \"checkin-qr\")`; no CRM points; the public route beside the session's with its own codes", () => {
    const Q = region(SVC, "export async function getDayCheckinQr(", "export async function checkinCampByToken(");
    expect(Q).toContain("if (!token) {");
    expect(Q).toContain("token = generateCheckinToken();");
    expect(Q).toContain("expiresAt = campTokenExpiry(d.date);");
    const P = region(SVC, "export async function planDays(", "export async function redeemDays(");
    expect(P).not.toMatch(/checkinToken|generateCheckinToken/);
    const C = region(SVC, "export async function checkinCampByToken(", "const dayDTO");
    expect(C).toContain("const outcome = campScanOutcome(d, today, new Date());");
    expect(C).toContain('if (outcome === "already") return { already: true, day: dayDTO(d) };');
    expect(C).toContain('await markDay(d.id, "ATTENDED", "checkin-qr");');
    expect(SVC).not.toMatch(/awardCrmPoints|CRM_POINT_RULES/);
    const RT = src("src/routes/checkin.ts");
    expect(code(RT)).toContain('.post("/checkin/camp", zValidator("json", checkinBody), async (c) => c.json(await camp.checkinCampByToken(c.req.valid("json").token)))');
    expect(RT).toContain("TWO ROUTES, TWO\n * CODES, ON PURPOSE");
    expect(RT).toContain("410 CAMP_TOKEN_EXPIRED");
    // the session's own expiry answer is untouched
    expect(code(src("src/services/checkin.service.ts"))).toContain('throw badRequest("โทเคนเช็คอินหมดอายุแล้ว");');
    expect((ROUTE_ACCESS as any)["GET /camp/days/:id/checkin"]).toEqual({ menus: ["menu:camp"] });
  });
});

describe("🔴 the camp-day reminder — the pure builder by value, the words by VALUE (TASK-405), the flag OFF by default, the job's gate (source)", () => {
  const weeks: CampWeekInput[] = [
    { id: W1, name: "Camp A", status: "OPEN", teachers: [{ id: "t1", lineUserId: "Ut1" }, { id: "t2", lineUserId: null }] },
    { id: W2, name: "Camp B", status: "CLOSED", teachers: [{ id: "t1", lineUserId: "Ut1" }] },
  ];
  const day = (o: Partial<CampDayInput>): CampDayInput => ({ dayId: "d", weekId: W1, half: "AM", status: "PLANNED", studentId: "s1", studentName: "น้องเอ", parentId: "p1", parentLineUserIds: ["Up1a", "Up1b"], ...o });
  const days = [
    day({ dayId: "d1" }),
    day({ dayId: "d2", half: "FULL", studentId: "s2", studentName: "น้องบี", parentId: "p1" }),
    day({ dayId: "d3", half: "PM", studentId: "s3", studentName: "น้องซี", parentId: "p2", parentLineUserIds: [] }),
    day({ dayId: "d4", status: "ATTENDED", studentId: "s4", studentName: "น้องดี", parentId: "p3", parentLineUserIds: ["Up3"] }),
    day({ dayId: "d5", status: "CANCELLED", studentId: "s5", studentName: "น้องอี", parentId: "p4", parentLineUserIds: ["Up4"] }),
    day({ dayId: "d6", weekId: W2, studentId: "s6", studentName: "น้องเอฟ", parentId: "p5", parentLineUserIds: ["Up5"] }),
  ];
  const sends = campReminderSends(days, weeks, "2026-10-05");
  test("only PLANNED days count; a CLOSED week sends nothing; the teacher gets the head count by half; the unlinked teacher is a SKIPPED row", () => {
    expect([...CAMP_REMINDABLE]).toEqual(["PLANNED"]);
    const t1 = sends.find((s) => s.recipientType === "teacher" && s.personId === "t1")!;
    expect(t1.payload).toEqual({ kind: "camp_reminder", audience: "teacher", rows: [{ weekName: "Camp A", date: "2026-10-05", names: ["น้องเอ", "น้องบี", "น้องซี"], total: 3, am: 1, pm: 1, full: 1 }] }); // TASK-405: + date, names
    expect(t1.lineUserId).toBe("Ut1");
    const t2 = sends.find((s) => s.recipientType === "teacher" && s.personId === "t2")!;
    expect(t2.lineUserId).toBeNull();
    expect(sends.filter((s) => s.recipientType === "teacher").length).toBe(2);
    expect(sends.some((s) => JSON.stringify(s.payload).includes("Camp B"))).toBe(false);
  });
  test("a two-device family gets TWO sends with two keys (one row per child in each); an unlinked parent is one SKIPPED row; ATTENDED / CANCELLED / closed-week children are absent", () => {
    const p1 = sends.filter((s) => s.recipientType === "parent" && s.personId === "p1");
    expect(p1.map((s) => s.lineUserId)).toEqual(["Up1a", "Up1b"]);
    expect(new Set(p1.map((s) => s.key)).size).toBe(2);
    for (const s of p1) expect(s.payload).toEqual({ kind: "camp_reminder", audience: "parent", rows: [{ child: "น้องเอ", weekName: "Camp A", date: "2026-10-05", half: "AM" }, { child: "น้องบี", weekName: "Camp A", date: "2026-10-05", half: "FULL" }] });
    const p2 = sends.filter((s) => s.recipientType === "parent" && s.personId === "p2");
    expect(p2.length).toBe(1); expect(p2[0]!.lineUserId).toBeNull();
    expect(sends.filter((s) => ["p3", "p4", "p5"].includes(s.personId)).length).toBe(0);
  });
  test("🔑 the keys carry their own prefix — a family with a session AND a camp day today gets both messages", () => {
    expect(campReminderKey("parent", "p1", "2026-10-05", "Up1a", "Up1a")).toBe("camp-reminder:parent:p1:2026-10-05");
    expect(campReminderKey("parent", "p1", "2026-10-05", "Up1b", "Up1a")).toBe("camp-reminder:parent:p1:2026-10-05:Up1b");
    expect(campReminderKey("parent", "p1", "2026-10-05", "Up1a", "Up1a")).not.toBe(reminderKey("parent", "p1", "2026-10-05"));
    expect(campReminderKey("teacher", "t1", "2026-10-05", "Ut1", "Ut1")).toBe("camp-reminder:teacher:t1:2026-10-05");
  });
  test("🔴 TASK-405 — the words by VALUE (the owner's, via Porter): the teacher block, TH and EN, under the TODAY'S SCHEDULE title", () => {
    const teacher = sends.find((s) => s.personId === "t1")!.payload;
    expect(formatOutboxMessage(teacher as any, {}, "EN", "teacher")).toBe(
      "⏱️TODAY'S SCHEDULE:\n\nCamp : Camp A\nDate : 05-10-2026\nStudents : 3 (Full 1 · AM 1 · PM 1)\n  - น้องเอ\n  - น้องบี\n  - น้องซี",
    );
    expect(formatOutboxMessage(teacher as any, {}, "TH", "teacher")).toBe(
      "⏱️TODAY'S SCHEDULE:\n\nแคมป์ : Camp A\nDate : 05-10-2026\nStudents : 3 (Full 1 · AM 1 · PM 1)\n  - น้องเอ\n  - น้องบี\n  - น้องซี",
    );
  });
  test("🔴 TASK-405 — the parent block by VALUE: Student / Camp / Date / Time, one block per child, the three halves in both languages", () => {
    const parent = sends.find((s) => s.personId === "p1")!.payload;
    expect(formatOutboxMessage(parent as any, {}, "EN", "parent")).toBe(
      "⏱️TODAY'S SCHEDULE:\n\nStudent : น้องเอ\nCamp : Camp A\nDate : 05-10-2026\nTime : Morning (AM)\n\nStudent : น้องบี\nCamp : Camp A\nDate : 05-10-2026\nTime : Full day",
    );
    expect(formatOutboxMessage(parent as any, {}, "TH", "parent")).toBe(
      "⏱️TODAY'S SCHEDULE:\n\nStudent : น้องเอ\nแคมป์ : Camp A\nDate : 05-10-2026\nช่วง : ช่วงเช้า\n\nStudent : น้องบี\nแคมป์ : Camp A\nDate : 05-10-2026\nช่วง : เต็มวัน",
    );
    const pm = { kind: "camp_reminder", audience: "parent", rows: [{ child: "น้องซี", weekName: "Camp A", date: "2026-10-05", half: "PM" }] };
    expect(formatOutboxMessage(pm as any, {}, "EN", "parent")).toContain("Time : Afternoon (PM)");
    expect(formatOutboxMessage(pm as any, {}, "TH", "parent")).toContain("ช่วง : ช่วงบ่าย");
  });
  test("🔴 TASK-405 — the +n rule by VALUE: 13 children ⇒ 12 names then `  +1`; 12 ⇒ all, no +; two weeks ⇒ two blocks; `Kids` absent everywhere", () => {
    const names = Array.from({ length: 13 }, (_, i) => `เด็ก${i + 1}`);
    const row = (n: number) => ({ weekName: "Camp X", date: "2026-10-05", names: names.slice(0, n), total: n, am: 0, pm: 0, full: n });
    const thirteen = formatOutboxMessage({ kind: "camp_reminder", audience: "teacher", rows: [row(13)] } as any, {}, "EN", "teacher");
    expect(thirteen.split("\n").filter((l) => l.startsWith("  - ")).length).toBe(12);
    expect(thirteen.endsWith("  - เด็ก12\n  +1")).toBe(true);
    expect(thirteen).not.toContain("เด็ก13");
    const twelve = formatOutboxMessage({ kind: "camp_reminder", audience: "teacher", rows: [row(12)] } as any, {}, "EN", "teacher");
    expect(twelve.split("\n").filter((l) => l.startsWith("  - ")).length).toBe(12);
    expect(twelve).not.toMatch(/\n  \+\d+/);
    expect(CAMP_NAMES_MAX).toBe(12);
    const two = formatOutboxMessage({ kind: "camp_reminder", audience: "teacher", rows: [row(2), { ...row(1), weekName: "Camp Y" }] } as any, {}, "EN", "teacher");
    expect(two.split("\n\n").length).toBe(3); // the title + two blocks
    expect(two).toContain("Camp : Camp Y");
    // 🔑 the owner's word: Students, never Kids — in the table and in the renderer
    const I = src("src/lib/line-i18n.ts");
    expect(code(I)).not.toMatch(/Kids/); // REQ-087: the date is DD-MM-YYYY (the one helper, TASK-344), the owner's sketch wrote DD/MM/YYYY
    expect(region(code(src("src/lib/line-message.ts")), 'case "camp_reminder": {', 'case "course_confirmed": {')).not.toMatch(/Kids|cp_title|cp_teacher_line|cp_parent_line/);
    expect(I).not.toMatch(/cp_title|cp_teacher_line|cp_parent_line|PLACEHOLDER — MINE, and the owner has NOT seen it\.\*\* The camp-day reminder/);
    for (const k of ["cp_camp:", "cp_students:", "cp_time:", "cp_half_full:", "cp_half_am:", "cp_half_pm:"]) expect(I).toContain(k);
    expect(I).toContain('cp_students: { TH: "Students", EN: "Students" },');
    expect(I).toContain('cp_camp: { TH: "แคมป์", EN: "Camp" },');
    expect(I).toContain('cp_time: { TH: "ช่วง", EN: "Time" },');
    // the builder carries the names on the teacher row ONLY; the parent row names its own child
    const B = code(src("src/lib/camp-reminder.ts"));
    expect(B).toContain("names: mine.map((d) => d.studentName)");
    expect(B).toContain("g.rows.push({ child: d.studentName, weekName: w.name, date, half: d.half });");
  });
  test("the flag: `camp_reminder_enabled` off | on, default off; the job reads it ONCE and enqueues NOTHING when off (source)", () => {
    expect(SETTINGS.camp_reminder_enabled).toMatchObject({ type: "enum", default: "off", options: ["off", "on"] });
    expect(resolveSetting("camp_reminder_enabled", undefined).value).toBe("off");
    expect(resolveSetting("camp_reminder_enabled", "on").value).toBe("on");
    expect(SETTINGS.camp_reminder_enabled.parse("maybe")).toBeNull();
    const R = region(JOB, "const campEnabled = (await getSetting(\"camp_reminder_enabled\")).value === \"on\";", "await db.insert(jobRuns).values({\n    job: REMINDER_JOB,");
    expect(R).toContain("if (campEnabled) {");
    const gated = region(R, "if (campEnabled) {", "\n  }\n");
    expect(gated).toContain("const { days, weeks } = await campReminderInputs(runDate);");
    expect(gated).toContain("const campSends = campReminderSends(days, weeks, runDate);");
    expect(gated).toContain("idempotencyKey: g.key,");
    expect((R.match(/enqueueLine\(/g) ?? []).length).toBe(1);
    expect(JOB).toContain("campEnabled, campReminded, campSkipped, campAlready };");
    // the camp block sits AFTER the session sends, and the session select is untouched
    expect(JOB.indexOf("const campEnabled")).toBeGreaterThan(JOB.indexOf("const due = dueSends(sends, alreadyKeyed);"));
    expect(JOB).not.toContain('"EXTENDED"');
    const IN = region(SVC, "export async function campReminderInputs(", "\n}\n");
    expect(IN).toContain('e(w.status, "OPEN")');
    expect(IN).toContain("familyLineUserIdsBulk(parentIds)");
    expect(IN).not.toContain("bookings");
  });
});

describe("🔴 the routes through the ROOT app — the undo's 400 before the service, the reason reaches it; the QR; the public scan's envelopes", () => {
  test("PATCH /api/camp/days/:id: PLANNED without a reason ⇒ 400 (no service call); with one ⇒ the service gets it; a mark carries null", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(camp, "markDay").mockImplementation((async (...a: any[]) => { calls.push(a); return { package: { id: "p", days: [] } }; }) as any);
    try {
      const patch = (body: any) => rootApp.fetch(new Request(`http://localhost/api/camp/days/${D1}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      expect((await patch({ status: "PLANNED" })).status).toBe(400);
      expect(calls.length).toBe(0);
      expect((await patch({ status: "PLANNED", reason: "บันทึกผิดคน" })).status).toBe(200);
      expect(calls.at(-1)).toEqual([D1, "PLANNED", expect.anything(), "บันทึกผิดคน"]);
      expect((await patch({ status: "ABSENT" })).status).toBe(200);
      expect(calls.at(-1)![3]).toBeNull();
    } finally { s.mockRestore(); }
  });
  test("GET /api/camp/days/:id/checkin ⇒ the payload; POST /api/checkin/camp (no JWT) ⇒ { already, day } and the 410 / 409 envelopes by value", async () => {
    process.env.SKIP_AUTH = "true";
    const q = spyOn(camp, "getDayCheckinQr").mockImplementation((async (id: string) => ({ dayId: id, token: "tok-1234567890", url: "/checkin/camp?token=tok-1234567890", expiresAt: "2026-10-05T16:59:59.000Z", studentName: "น้องเอ", date: "2026-10-05", half: "AM" })) as any);
    const c = spyOn(camp, "checkinCampByToken").mockImplementation((async (token: string) => {
      if (token === "expired-token") throw new ApiException(410, "CAMP_TOKEN_EXPIRED", "โทเคนเช็คอินหมดอายุแล้ว");
      if (token === "tomorrow-token") throw new ApiException(409, "CAMP_DAY_NOT_TODAY", "วันแคมป์นี้คือวันที่ 2026-10-06 — เช็คอินได้เฉพาะวันนั้น");
      return { already: token === "already-token", day: { dayId: D1, status: "ATTENDED" } };
    }) as any);
    try {
      const qr = await rootApp.fetch(new Request(`http://localhost/api/camp/days/${D1}/checkin`));
      expect(qr.status).toBe(200);
      expect(await qr.json()).toMatchObject({ dayId: D1, token: "tok-1234567890", half: "AM" });
      const post = (token: string) => rootApp.fetch(new Request("http://localhost/api/checkin/camp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));
      expect(await (await post("fresh-token-1")).json()).toEqual({ already: false, day: { dayId: D1, status: "ATTENDED" } });
      expect(await (await post("already-token")).json()).toEqual({ already: true, day: { dayId: D1, status: "ATTENDED" } });
      const gone = await post("expired-token");
      expect(gone.status).toBe(410);
      expect(await gone.json()).toEqual({ error: { code: "CAMP_TOKEN_EXPIRED", message: "โทเคนเช็คอินหมดอายุแล้ว" } });
      const early = await post("tomorrow-token");
      expect(early.status).toBe(409);
      expect(((await early.json()) as any).error.code).toBe("CAMP_DAY_NOT_TODAY");
      expect((await post("short")).status).toBe(400); // the body shape, before the service
    } finally { q.mockRestore(); c.mockRestore(); }
  });
});
