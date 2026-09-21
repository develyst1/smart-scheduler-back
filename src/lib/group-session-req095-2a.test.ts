// TASK-397 (`REQ-095` Stage 2a, SPEC-081) — the GROUP SESSION: migration `0041` (42 = 42, the enum label alone, the
// index REBUILT with `AND group_id IS NULL` — closed shop, predicate witness), the ONE `slotHolder` predicate across
// the five mirrors (and the PAUSED drift it folds), the `type ⇔ kind` pin, the series, seats sold via
// `POST /courses { groupKey }` (extend-on-missing-date, the cap), the swap, the cancel cascade, no freelance draw on a
// seat, the DTO, the grid hiding seats, the coach's folded entry, the 50th key, and NO money on a GROUP row.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { holdsSlot, slotHolderWhere, SLOT_INACTIVE_STATUSES } from "./slot-holder";
import { GROUP_KINDS, OTHER_KINDS, assertKindForType } from "./other-kind";
import { toBookingDTO } from "../db/mappers";
import { renderTodaySchedule, type TodayRow } from "./line-today-schedule";
import { groupReminders, type ReminderSession } from "./daily-reminder";
import { ACTION_REGISTRY, isActionKey } from "./permissions";
import { ROUTE_ACCESS } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { ApiException } from "./http";
import * as v from "../validation";
import * as svc from "../services/scheduler.service";
import { readSrc } from "./read-src";
import { PgDialect } from "drizzle-orm/pg-core";
import { bookings } from "../db/schema";

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
const SCHED = code(src("src/services/scheduler.service.ts"));
const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222";

describe("🔴 the migration — 0041, counted, witnessed by the PREDICATE, the rebuild named closed shop, TRAP 1 for 0042+ (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const JOURNAL = readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8");
  const SQL = readFileSync(resolve(root, "drizzle/0041_group_session.sql"), "utf8").replace(/\r\n/g, "\n");
  const body = SQL.replace(/^--.*$/gm, "");
  test("50 = 50 (TASK-401 added 0042, TASK-403 added 0043, TASK-406 added 0044, TASK-410 added 0045, TASK-411 added 0046, TASK-418 added 0047, TASK-420 added 0048, TASK-428 added 0049): `0041_group_session` is the 42nd file, idx 41; the order 0038 → 0041", () => {
    expect(files.length).toBe(50);
    expect(files[41]).toBe("0041_group_session.sql");
    const j = JSON.parse(JOURNAL) as { entries: Array<{ idx: number; tag: string }> };
    expect(j.entries.length).toBe(50);
    expect(j.entries.slice(38, 42).map((e) => e.tag)).toEqual(["0038_course_rental_marker", "0039_student_archive", "0040_other_schedule", "0041_group_session"]);
  });
  test("the four statements in order: the label ALONE · group_key · group_id (RESTRICT) + its index · the unique index REBUILT with `AND group_id IS NULL` LAST; the label is never USED in the file", () => {
    const order = [
      `ALTER TYPE "booking_type" ADD VALUE IF NOT EXISTS 'GROUP';`,
      'ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "group_key" uuid NULL;',
      'ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "group_id" uuid NULL REFERENCES "bookings"("id") ON DELETE RESTRICT;',
      'CREATE INDEX IF NOT EXISTS "bookings_group_id_idx" ON "bookings" ("group_id");',
      'DROP INDEX "bookings_teacher_slot_uq";',
      `CREATE UNIQUE INDEX "bookings_teacher_slot_uq" ON "bookings" USING btree ("teacher_id","date","start_time") WHERE "bookings"."status" not in ('CANCELLED', 'PENDING_RESCHEDULE', 'SICK_LEAVE', 'PAUSED') AND "bookings"."group_id" IS NULL;`,
    ];
    let at = -1;
    for (const s of order) { const i = body.indexOf(s); expect({ s: s.slice(0, 60), found: i > at }).toEqual({ s: s.slice(0, 60), found: true }); at = i; }
    expect(body.trim().endsWith(order[5]!)).toBe(true);
    // TRAP 1: the label appears ONCE in the code — in its own ADD VALUE — and nowhere else
    expect((body.match(/'GROUP'/g) ?? []).length).toBe(1);
    // the predicate's status list is the same four the application builds from
    for (const s of SLOT_INACTIVE_STATUSES) expect(order[5]).toContain(`'${s}'`);
  });
  test("the header: closed shop for the rebuild (ACCESS EXCLUSIVE, reads AND writes), not CONCURRENTLY, the queueing hazard, TRAP 1 for `0042+`, the cutover order, the predicate witness", () => {
    expect(SQL).toContain("**ACCESS EXCLUSIVE lock on `bookings` for the\n--     REBUILD — writes AND reads block for its duration**");
    expect(SQL).toContain("CLOSED SHOP: the quiet moment, never near 17:30, the morning reminder, or an import");
    expect(SQL).toContain("Deliberately NOT `CREATE INDEX CONCURRENTLY`");
    expect(SQL).toContain("**`0042+` must never use `'GROUP'` in the same run as this file without\n-- the preflight's split**");
    expect(SQL).toContain("THE CUTOVER ORDER: `0038` → `0039` → `0040` → THIS");
    expect(SQL).toContain("`db:verify` expects 42");
    expect(SQL).toContain("WITNESS — the unique index's **PREDICATE**, never its existence");
    expect(SQL).toContain("`drizzle/*.sql` = 41 (0000–0040) and journal tags = 41 before this, newest `0040`, so this is `0041`");
  });
  test("🔑 the witness is the index PREDICATE (`index-predicate`, contains `group_id`), registered; the schema mirrors: the enum label, the two columns, the index's `.where` + `group_id` index, the self-relation", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0041_group_session")!; // 🔻 TASK-401: no longer last — by tag
    expect(w).toMatchObject({ tag: "0041_group_session", probe: { kind: "index-predicate", index: "bookings_teacher_slot_uq", contains: "group_id" }, rerunnable: true });
    expect(w.why).toContain("NOT the index's existence");
    const S = code(src("src/db/schema.ts"));
    expect(S).toMatch(/"OTHER",\s*"GROUP",\s*\]\);/);
    expect(S).toContain('groupKey: uuid("group_key"),');
    expect(S).toContain('groupId: uuid("group_id").references((): AnyPgColumn => bookings.id, { onDelete: "restrict" }),');
    expect(S).toContain(".where(sql`${t.status} not in (${sql.raw(SLOT_INACTIVE_SQL)}) and ${t.groupId} is null`),");
    expect(S).toContain('index("bookings_group_id_idx").on(t.groupId),');
    expect(S).toContain('group: one(bookings, { fields: [bookings.groupId], references: [bookings.id], relationName: "group_seats" }),');
    expect(S).toContain('seats: many(bookings, { relationName: "group_seats" }),');
  });
});

describe("🔴 ONE definition of 'holds the slot' — `lib/slot-holder.ts` across the five mirrors; the second list retired (the PAUSED drift fixed in passing)", () => {
  test("`holdsSlot` by value: a live row holds; a CANCELLED / PENDING_RESCHEDULE / SICK_LEAVE / PAUSED row does not; a SEAT never does whatever its status", () => {
    for (const status of ["PENDING", "CONFIRMED", "EXTENDED", "ATTENDED"]) expect({ status, holds: holdsSlot({ status }) }).toEqual({ status, holds: true });
    for (const status of SLOT_INACTIVE_STATUSES) expect({ status, holds: holdsSlot({ status }) }).toEqual({ status, holds: false });
    expect(holdsSlot({ status: "CONFIRMED", groupId: "g-1" })).toBe(false);
    expect(holdsSlot({ status: "PAUSED", groupId: null })).toBe(false); // 🔴 the drift: the picker's old list had no PAUSED
  });
  test("`slotHolderWhere` renders `status not in (…the four…) and group_id is null`", () => {
    const q = new PgDialect().sqlToQuery(slotHolderWhere(bookings));
    expect(q.sql).toMatch(/"status" not in \(/);
    expect(q.sql).toContain('"group_id" is null');
    expect(q.params).toEqual([...SLOT_INACTIVE_STATUSES]);
  });
  test("🔴 the five mirrors read the ONE predicate: the index (schema), `describeSlotClash`, `assertAdditionalTeacherFree`, `findFreeExtensionDate`, `getSlotAvailability`; no availability read restates a status list; `booking-slot.ts` is gone", () => {
    for (const fn of ["async function describeSlotClash(", "async function assertAdditionalTeacherFree(", "async function findFreeExtensionDate(", "export async function getSlotAvailability("]) {
      const F = region(SCHED, fn, "\n}\n");
      expect({ fn, uses: F.includes("slotHolderWhere(b)") }).toEqual({ fn, uses: true });
      expect({ fn, restates: /nin\(b\.status|notInArray\(b\.status, \[\.\.\.SLOT_(INACTIVE|NON)/.test(F) }).toEqual({ fn, restates: false });
    }
    expect(SCHED).not.toContain("SLOT_NON_BLOCKING");
    expect(existsSync(resolve(root, "src/lib/booking-slot.ts"))).toBe(false);
    expect(code(src("src/lib/slot-holder.ts"))).toContain("and(notInArray(b.status, [...SLOT_INACTIVE_STATUSES]), isNull(b.groupId))");
  });
});

describe("🔑 `type ⇔ kind` — refused both ways; the kinds", () => {
  test("`GROUP_KINDS` = DUO · GROUP; `OTHER_KINDS` unchanged", () => {
    expect([...GROUP_KINDS]).toEqual(["DUO", "GROUP"]);
    expect([...OTHER_KINDS]).toEqual(["ECA", "FREE", "KOL", "CAMP"]); // 🔻 TASK-418: CAMP, the derived 4th kind (the human validators keep HUMAN_OTHER_KINDS)
  });
  test("`assertKindForType`: GROUP needs DUO|GROUP (an ECA or nothing ⇒ 400); OTHER takes ECA|FREE|KOL or nothing (a DUO ⇒ 400); a lesson takes nothing", () => {
    expect(() => assertKindForType("GROUP", "DUO")).not.toThrow();
    expect(() => assertKindForType("GROUP", "GROUP")).not.toThrow();
    expect(() => assertKindForType("GROUP", "ECA")).toThrow(/DUO/);
    expect(() => assertKindForType("GROUP", undefined)).toThrow(/DUO/);
    expect(() => assertKindForType("OTHER", "ECA")).not.toThrow();
    expect(() => assertKindForType("OTHER", undefined)).not.toThrow();
    expect(() => assertKindForType("OTHER", "DUO")).toThrow(/ECA/);
    expect(() => assertKindForType("COURSE_PACKAGE", undefined)).not.toThrow();
    expect(() => assertKindForType("COURSE_PACKAGE", "ECA")).toThrow(/อื่นๆ/);
    // and `insertBooking` asks it on EVERY insert (source)
    expect(region(SCHED, "async function insertBooking(", "\n}\n")).toContain("assertKindForType(input.bookingType, input.otherKind);");
  });
  test("validation: `groupSeries` (DUO ⇒ cap 2; cap 2..12; dates 1–60 unique; extras sane); `groupTeacherSwap`; `createCoursePackage.groupKey`; `POST /bookings` cannot make a GROUP row directly", () => {
    // 🔻 TASK-420: DUO is a COURSE now (`duo` on POST /courses) — a NEW series is GROUP only; `GROUP_KINDS` (readers) unchanged
    const base = { name: "GROUP A", groupKind: "GROUP", seatCap: 6, teacherId: T1, startTime: "10:00", dates: ["2026-10-01", "2026-10-08"] };
    expect(v.groupSeries.safeParse(base).success).toBe(true);
    expect(v.groupSeries.safeParse({ ...base, groupKind: "DUO", seatCap: 2 }).success).toBe(false);
    expect(v.groupSeries.safeParse({ ...base, seatCap: 13 }).success).toBe(false);
    expect(v.groupSeries.safeParse({ ...base, groupKind: "GROUP", seatCap: 13 }).success).toBe(false);
    expect(v.groupSeries.safeParse({ ...base, groupKind: "ECA" }).success).toBe(false);
    expect(v.groupSeries.safeParse({ ...base, dates: ["2026-10-01", "2026-10-01"] }).success).toBe(false);
    expect(v.groupSeries.safeParse({ ...base, additionalTeacherIds: [T1] }).success).toBe(false);
    expect(v.groupTeacherSwap.safeParse({ teacherId: T1, fromHereOn: true }).success).toBe(true);
    expect(v.groupTeacherSwap.safeParse({ teacherId: T1 }).success).toBe(false);
    const course = { student: { id: T1 }, teacherId: T1, subjectId: T1, size: 4, startDate: "2026-09-16", startTime: "10:00" };
    expect(v.createCoursePackage.safeParse({ ...course, groupKey: T2 }).success).toBe(true);
    expect(v.createCoursePackage.safeParse({ ...course, groupKey: "nope" }).success).toBe(false);
    expect(v.createBooking.safeParse({ teacherId: T1, subjectId: T1, date: "2026-09-20", startTime: "10:00", bookingType: "GROUP", otherTitle: "x" }).success).toBe(false);
  });
});

describe("🔴 the writes (source) — the series, seats on the group (extend / cap), the swap, the cancel cascade, no seat draw, no money", () => {
  test("`createGroupSeries`: rates checked first · ONE key minted · dates sorted · ONE tx · `insertBooking` per date as GROUP (name → other_title, cap → head_count, kind) · extras · the first clash ⇒ 409 naming the date", () => {
    const S = region(SCHED, "export async function createGroupSeries(", "\n}\n");
    expect(S.indexOf("assertRatesOnBooking(")).toBeLessThan(S.indexOf("db.transaction("));
    expect(S).toContain("const groupKey = crypto.randomUUID();");
    expect(S).toContain("const dates = [...input.dates].sort();");
    expect((S.match(/db\.transaction\(/g) ?? []).length).toBe(1);
    expect(S).toContain('id = await insertBooking(tx, null, { ...input, bookingType: "GROUP", otherTitle: input.name, otherKind: input.groupKind, headCount: input.seatCap, groupKey, date });');
    expect(S).toContain("await attachAdditionalTeachers(tx, id, input.additionalTeacherIds, input.teacherRates ?? {});");
    expect(S).toContain('throw conflict("SLOT_TAKEN", `วันที่ ${date} ครูไม่ว่าง — ไม่ได้สร้างรายการใด (${e.message})`);');
    expect(S).toContain("return { groupKey, created: bookingIds.length, bookingIds };");
    expect(S).not.toMatch(/tx\.insert\(bookings\)/);
  });
  test("`POST /courses { groupKey }`: the body must MATCH the group (teacher · weekday · start ⇒ 400 GROUP_MISMATCH-sentence), checked BEFORE the tx; each non-absent session takes a seat; the seat carries `groupId`", () => {
    const C = region(SCHED, "export async function createCoursePackage(", "\n}\n");
    expect(C).toContain("if (input.groupKey) await assertCourseMatchesGroup(input.groupKey, input);");
    expect(C.indexOf("assertCourseMatchesGroup(")).toBeLessThan(C.indexOf("db.transaction("));
    expect(C).toContain("const groupId = input.groupKey && !absent ? await seatOnGroup(tx, input.groupKey, s.date) : null;");
    expect(C).toContain("          courseId: course.id,\n          coStudentId, // TASK-420 — known here; the inserter would read it from the course otherwise\n          groupId,");
    const M = region(SCHED, "async function assertCourseMatchesGroup(", "\n}\n");
    expect(M).toContain('if (!same) throw badRequest("คอร์สต้องใช้ครู/วัน/เวลาเดียวกับกลุ่ม");');
    expect(M).toContain("g.teacherId === input.teacherId && hhmm(g.startTime) === hhmm(input.startTime) && weekdayOf(g.date) === weekdayOf(input.startDate)");
  });
  test("`seatOnGroup`: an existing group row ⇒ the CAP (live seats < head_count, else 409 GROUP_FULL naming the date); a missing date ⇒ EXTEND through `insertBooking` with the template's teacher/extras/rates/cap/kind (409 SLOT_TAKEN naming the date)", () => {
    const S = region(SCHED, "async function seatOnGroup(", "\n}\n");
    expect(S).toContain("let row = await groupRowOn(tx, groupKey, date);");
    // 🔴 mutation K passed until this: a missing date must ENTER the extend branch, not be refused before it
    expect(S).toContain("  if (!row) {\n    const t = await groupTemplate(tx, groupKey);");
    expect(S.slice(0, S.indexOf("if (!row) {"))).not.toMatch(/throw/);
    expect(S).not.toMatch(/GROUP_NO_DATE|if \(false\)/);
    expect(S).toContain("const t = await groupTemplate(tx, groupKey);");
    expect(S).toContain('id = await insertBooking(tx, null, { teacherId: t.teacherId, subjectId: null, startTime: hhmm(t.startTime), bookingType: "GROUP", otherTitle: t.otherTitle, otherKind: t.otherKind, headCount: t.headCount, groupKey, teacherRates: rates, date });');
    expect(S).toContain('throw conflict("SLOT_TAKEN", `วันที่ ${date} ครูไม่ว่าง — ขยายกลุ่มไม่ได้ (${e.message})`);');
    // 🔻 TASK-399: the CAP half lives in `assertSeatFree` (shared with the walk-in seat); `seatOnGroup` calls it before returning the row
    expect(S).toContain("await assertSeatFree(tx, row.id, date);\n  return row.id;");
    const F = region(SCHED, "async function assertSeatFree(", "\n}\n");
    expect(F).toContain("inArray(bookings.status, [...COURSE_LIVE_STATUSES])");
    expect(F).toContain('if (live >= cap) throw conflict("GROUP_FULL", `วันที่ ${date} กลุ่มเต็ม (${live}/${cap})`);');
  });
  test("`swapGroupTeacher`: a GROUP row only · the targets by key (from here on | this date) · ONE tx · teacher-bookable per date · the group row moves (23505 ⇒ 409 naming the date, nothing moved) · its holds reconciled · EVERY live seat follows · NO notice", () => {
    const S = region(SCHED, "export async function swapGroupTeacher(", "\n}\n");
    expect(S).toContain('if (current.bookingType !== "GROUP" || !current.groupKey) throw badRequest("ฟิลด์นี้ใช้ได้เฉพาะการจองประเภท “กลุ่ม”");');
    expect(S).toContain("input.fromHereOn ? g(b.date, current.date) : e(b.date, current.date)");
    expect((S.match(/db\.transaction\(/g) ?? []).length).toBe(1);
    expect(S).toContain("await assertTeacherBookable(tx, input.teacherId, g.date);");
    expect(S).toContain('if (pgErrorCode(e) === "23505") throw conflict("SLOT_TAKEN", `วันที่ ${g.date} ครูไม่ว่าง — ไม่ได้ย้ายรายการใด`);');
    expect(S).toContain("await reconcileBookingHolds(tx, g.id, input.teacherId, g.status, false);");
    expect(S).toContain("await tx.update(bookings).set({ teacherId: input.teacherId }).where(and(eq(bookings.groupId, g.id), inArray(bookings.status, [...COURSE_LIVE_STATUSES])));");
    expect(S).not.toMatch(/enqueueLine|notify/);
  });
  test("the cancel CASCADE: a GROUP row's cancel first cancels every live seat (status + note + the course's make-up via `reconcileCoursePlan`) in the SAME tx, then the group row; GROUP joins the audited-reason set; a seat's own cancel is ordinary", () => {
    const U = region(SCHED, "export async function updateBookingStatus(", "\nexport async function bulkConfirm(");
    expect(U).toContain('if (current.bookingType === "GROUP") await cancelSeatsOfGroup(tx, current.id, cancelReason ?? null);');
    expect(U.indexOf('cancelSeatsOfGroup(tx, current.id')).toBeLessThan(U.indexOf('status: "CANCELLED",'));
    expect(U).toContain('new Set(["SINGLE_SESSION", "VOUCHER", "FIRST_TRIAL", "OTHER", "GROUP"])');
    const C = region(SCHED, "async function cancelSeatsOfGroup(", "\n}\n");
    expect(C).toContain("a(e(b.groupId, groupId), inA(b.status, [...COURSE_LIVE_STATUSES]))");
    expect(C).toContain('await tx.update(bookings).set({ status: "CANCELLED", note: note ?? s.note }).where(eq(bookings.id, s.id));');
    expect(C).toContain("if (s.courseId) await reconcileCoursePlan(tx, s.courseId);");
    expect(C).not.toMatch(/enqueueLine|sendClassCancelledToTeacher/); // the coach is told ONCE, by the group row's own cancel
  });
  test("🔴 a SEAT draws no freelance hour — `reconcileBookingHolds` returns before the ledger read when the row has a `groupId` (the group row holds the hour)", () => {
    const H = region(SCHED, "async function reconcileBookingHolds(", "\n}\n");
    expect(H).toContain("columns: { bookingType: true, groupId: true },");
    expect(H).toContain('if (booking?.bookingType === "OTHER") return;');
    expect(H).toContain("if (booking?.groupId) return;");
    expect(H.indexOf("if (booking?.groupId) return;")).toBeLessThan(H.indexOf("tx.query.boMovement.findMany("));
  });
  test("🚫 NO MONEY on a GROUP row: the day-end revenue sweep's type list has no GROUP (by construction); none of the new functions post; `ratePostedAt` never written", () => {
    const JOB = code(src("src/services/jobs.service.ts"));
    expect(JOB).toContain('inArray(bookings.bookingType, ["FIRST_TRIAL", "SINGLE_SESSION", "OTHER"]),');
    expect((JOB.match(/"GROUP"/g) ?? []).length).toBe(1); // the ONE mention is the reminder's seats mapper — never the sweep
    expect(JOB).toContain('seats: r.bookingType === "GROUP" ?');
    for (const fn of ["export async function createGroupSeries(", "async function seatOnGroup(", "export async function swapGroupTeacher(", "async function cancelSeatsOfGroup("]) {
      expect({ fn, money: /recordSale|recordRental|boMovement|postBookingSale/.test(region(SCHED, fn, "\n}\n")) }).toEqual({ fn, money: false });
    }
    expect(SCHED).not.toMatch(/ratePostedAt:|set\(\{[^}]*ratePostedAt/);
  });
  test("the grid's ONE read hides seats (`isNull(b.groupId)`); the shared relation set carries `seats` + `group` for every other read", () => {
    const G = region(SCHED, "export async function getCalendar(", "\n}\n");
    expect(G).toMatch(/notInArray\(b\.status, \[\.\.\.CALENDAR_HIDDEN_STATUSES\]\),\s*isNull\(b\.groupId\),/);
    expect(SCHED).toContain("  seats: { with: { student: true } },\n  group: true,\n  campWeekDay: true,\n} as const;"); // 🔻 TASK-418: + the camp day (still the ONE set)
  });
});

describe("🔴 the DTO — a GROUP row's `group {…}` with its seats; a seat's `groupId` / `groupName`; a lesson has neither", () => {
  const teacher = { id: T1, name: "ครูหนึ่ง", nickname: "หนึ่ง", type: "FULL_TIME" };
  const groupRow = { id: "g1", date: "2026-10-01", startTime: "10:00:00", endTime: "11:00:00", bookingType: "GROUP", status: "CONFIRMED", student: null, subject: null, teacher, otherTitle: "DUO A+B", otherKind: "DUO", headCount: 2, groupKey: "k-1", teacherRateMinor: 60000, ratePostedAt: null,
    seats: [{ id: "s1", studentId: "st1", status: "CONFIRMED", courseId: "c1", student: { id: "st1", name: "เด็กชายเอ", nickname: "น้องเอ" } }, { id: "s2", studentId: "st2", status: "SICK_LEAVE", courseId: "c2", student: { id: "st2", name: "เด็กหญิงบี", nickname: null } }] };
  test("by value", () => {
    const dto: any = toBookingDTO(groupRow);
    expect(dto.group).toEqual({ key: "k-1", kind: "DUO", priceGroup: "balance-duo", name: "DUO A+B", seatCap: 2, seats: [{ bookingId: "s1", studentId: "st1", studentName: "น้องเอ", status: "CONFIRMED", courseId: "c1" }, { bookingId: "s2", studentId: "st2", studentName: "เด็กหญิงบี", status: "SICK_LEAVE", courseId: "c2" }], teacherRates: { [T1]: 60000 }, ratePostedAt: null });
    expect(dto.other).toBeNull(); // `other` is the OTHER row's fact; a GROUP row answers through `group`
    expect(dto.groupId).toBeNull();
    expect(dto.displayName).toBe("DUO A+B");
    const seat: any = toBookingDTO({ ...groupRow, id: "s1", bookingType: "COURSE_PACKAGE", student: { id: "st1", name: "เด็กชายเอ", nickname: "น้องเอ" }, otherTitle: null, groupId: "g1", group: { id: "g1", otherTitle: "DUO A+B" }, seats: [] });
    expect(seat.group).toBeNull();
    expect(seat.groupId).toBe("g1");
    expect(seat.groupName).toBe("DUO A+B");
    const lesson: any = toBookingDTO({ ...groupRow, bookingType: "SINGLE_SESSION", student: { id: "st1", name: "S" }, otherTitle: null, seats: [], groupKey: null });
    expect(lesson.group).toBeNull();
    expect(lesson.groupId).toBeNull();
    expect(lesson.groupName).toBeNull();
  });
});

describe("📖 the coach's reminder — a GROUP entry with its seats folded under it (`Seats : n/cap`, PLACEHOLDER by form); a seat is NOT its own coach entry; the parent's entry unchanged", () => {
  test("the renderer: `Seats : 2/2` + a line per child, before Remark; a GROUP row never prints `Heads`", () => {
    const row: TodayRow = { date: "2026-10-01", startTime: "10:00", endTime: "11:00", title: "DUO A+B", bookingType: "GROUP", coach: "หนึ่ง", headCount: 2, seats: [{ studentName: "น้องเอ", remaining: "3/4 sessions" }, { studentName: "น้องบี", remaining: null }], attendeeNote: "x" } as any;
    const lines = renderTodaySchedule([row], "TH", "teacher").split("\n");
    const i = lines.findIndex((l) => /^Seats : 2\/2$/.test(l));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe("  - น้องเอ (3/4 sessions)");
    expect(lines[i + 2]).toBe("  - น้องบี");
    expect(lines[i + 3]).toBe("Remark : x");
    expect(lines.join("\n")).not.toMatch(/Heads/);
  });
  test("`groupReminders`: a seat row builds NO teacher entry (its group carries it) but keeps its PARENT entry; the group row builds the teacher entry with `seats`", () => {
    const base: ReminderSession = { id: "g1", date: "2026-10-01", startTime: "10:00:00", status: "CONFIRMED", teacherId: T1, teacherLineUserId: "U-t", studentId: null, studentName: "DUO A+B", parentId: null, parentLineUserId: null, parentLineUserIds: [], bookingType: "GROUP", title: "DUO A+B", headCount: 2, seats: [{ studentName: "น้องเอ", remaining: "3/4 sessions" }] } as any;
    const seat: ReminderSession = { ...base, id: "s1", studentId: "st1", studentName: "น้องเอ", parentId: "p1", parentLineUserId: "U-p", parentLineUserIds: ["U-p"], bookingType: "COURSE_PACKAGE", title: null, headCount: null, seats: null, groupId: "g1" } as any;
    const groups = groupReminders([base, seat]);
    const teacherGroups = groups.filter((g) => g.recipientType === "teacher");
    const parentGroups = groups.filter((g) => g.recipientType === "parent");
    expect(teacherGroups).toHaveLength(1);
    expect(teacherGroups[0]!.rows).toHaveLength(1); // the group row only — the seat is not its own entry
    expect(teacherGroups[0]!.rows[0]!.seats).toEqual([{ studentName: "น้องเอ", remaining: "3/4 sessions" }]);
    expect(parentGroups).toHaveLength(1);
    expect(parentGroups[0]!.rows[0]!.studentName).toBe("น้องเอ"); // the parent still gets their child's class, as before
  });
  test("the job loads a GROUP row's seats (with student + course) in the SAME query and maps them; the label is a PLACEHOLDER; the reminder's own `REMINDABLE` list filters the seats (no second list in the job)", () => {
    const JOB = code(src("src/services/jobs.service.ts"));
    expect(JOB).toContain("seats: { with: { student: true, course: true } },");
    expect(JOB).toContain('seats: r.bookingType === "GROUP" ? (r.seats ?? []).filter((x: any) => REMINDABLE.has(x.status))');
    expect(JOB).not.toMatch(/REMINDABLE_SEAT|new Set\(\["PENDING"/);
    const I18N = readSrc(readFileSync(resolve(root, "src/lib/line-i18n.ts"), "utf8"));
    expect(I18N).toContain("PLACEHOLDER — MINE, the customer has NOT seen it** (TASK-397)");
    expect(code(I18N)).toContain('ob_f_seats: { TH: "Seats", EN: "Seats" },');
  });
});

describe("🔑 the routes through the ROOT app (service spied) + the key", () => {
  const spies: any[] = [];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  afterEach(() => { process.env.SKIP_AUTH = "true"; });
  const json = (method: string, path: string, body: unknown) => rootApp.fetch(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  test("POST /bookings/group-series ⇒ 201 { groupKey, created, bookingIds }; the clash 409 names the date; DUO with cap 3 ⇒ 400", async () => {
    process.env.SKIP_AUTH = "true";
    const s = spyOn(svc, "createGroupSeries").mockImplementation((async (input: any) => {
      if (input.dates.includes("2026-10-15")) throw new ApiException(409, "SLOT_TAKEN", "วันที่ 2026-10-15 ครูไม่ว่าง — ไม่ได้สร้างรายการใด (…)");
      return { groupKey: "k-1", created: input.dates.length, bookingIds: input.dates.map((d: string) => `g-${d}`) };
    }) as any);
    spies.push(s);
    const body = { name: "GROUP A", groupKind: "GROUP", seatCap: 6, teacherId: T1, startTime: "10:00", dates: ["2026-10-01", "2026-10-08"] }; // 🔻 TASK-420: GROUP (DUO retired for creation)
    const ok = await json("POST", "/api/bookings/group-series", body);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ groupKey: "k-1", created: 2, bookingIds: ["g-2026-10-01", "g-2026-10-08"] });
    const clash = await json("POST", "/api/bookings/group-series", { ...body, dates: ["2026-10-15"] });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({ error: { code: "SLOT_TAKEN", message: "วันที่ 2026-10-15 ครูไม่ว่าง — ไม่ได้สร้างรายการใด (…)" } });
    expect((await json("POST", "/api/bookings/group-series", { ...body, groupKind: "DUO", seatCap: 2 })).status).toBe(400); // 🔻 TASK-420: a DUO series is refused
  });
  test("PATCH /bookings/:id/group-teacher ⇒ { moved, booking }; a non-group's 400 and the date-naming 409 pass through", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(svc, "swapGroupTeacher").mockImplementation((async (id: string, input: any) => {
      calls.push([id, input]);
      if (id === "lesson") throw new ApiException(400, "VALIDATION", "ฟิลด์นี้ใช้ได้เฉพาะการจองประเภท “กลุ่ม”");
      if (id === "taken") throw new ApiException(409, "SLOT_TAKEN", "วันที่ 2026-10-08 ครูไม่ว่าง — ไม่ได้ย้ายรายการใด");
      return { moved: 3, booking: { id } };
    }) as any);
    spies.push(s);
    const ok = await json("PATCH", "/api/bookings/g-1/group-teacher", { teacherId: T2, fromHereOn: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ moved: 3, booking: { id: "g-1" } });
    expect(calls.at(-1)).toEqual(["g-1", { teacherId: T2, fromHereOn: true }]);
    expect((await json("PATCH", "/api/bookings/lesson/group-teacher", { teacherId: T2, fromHereOn: false })).status).toBe(400);
    expect((await json("PATCH", "/api/bookings/taken/group-teacher", { teacherId: T2, fromHereOn: true })).status).toBe(409);
    expect((await json("PATCH", "/api/bookings/g-1/group-teacher", { teacherId: T2 })).status).toBe(400);
  });
  test("the key: `action:calendar.group-series` (50th) gates exactly the series; the swap is a `booking-edit`", () => {
    expect(isActionKey("action:calendar.group-series")).toBe(true);
    expect(ACTION_REGISTRY.find((a) => a.key === "action:calendar.group-series")).toEqual({ key: "action:calendar.group-series", area: "calendar", labelTh: "สร้างกลุ่ม DUO/Group เป็นชุด", labelEn: "Create a DUO/Group series" });
    expect(ROUTE_ACCESS["POST /bookings/group-series"]).toEqual({ menus: ["menu:calendar", "menu:bookings"], action: "action:calendar.group-series" });
    expect(ROUTE_ACCESS["PATCH /bookings/:id/group-teacher"]!.action).toBe("action:calendar.booking-edit");
    expect(Object.entries(ROUTE_ACCESS).filter(([, a]) => a.action === "action:calendar.group-series").map(([k]) => k)).toEqual(["POST /bookings/group-series"]);
  });
});
