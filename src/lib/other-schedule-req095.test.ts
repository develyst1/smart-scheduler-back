// TASK-394 (`REQ-095` Stage 1, SPEC-080) — ECA · Free/KOL on the OTHER booking: migration `0040` (41 = 41, the HOT
// `bookings` lock named), the three fields round-tripping create → DTO, the lesson types refusing them, the ONE
// `teacherRates` map (a stray id ⇒ 400), the dedicated edit route (no move, no notice), the SERIES all-or-nothing
// naming the clashing date, the 49th key, `Heads : n` in the coach's reminder (PLACEHOLDER, by form), and NO money.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { OTHER_KINDS, assertRatesOnBooking, isOtherKind } from "./other-kind";
import { toBookingDTO } from "../db/mappers";
import { renderTodaySchedule, type TodayRow } from "./line-today-schedule";
import { ACTION_REGISTRY, isActionKey } from "./permissions";
import { ROUTE_ACCESS } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { ApiException } from "./http";
import * as v from "../validation";
import * as svc from "../services/scheduler.service";
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
const SCHED = code(src("src/services/scheduler.service.ts"));
const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222", T3 = "33333333-3333-4333-8333-333333333333";
const base = { teacherId: T1, subjectId: T1, date: "2026-09-20", startTime: "10:00", bookingType: "OTHER", otherTitle: "ECA Skate Club" };

describe("🔴 the migration — 0040, counted, witnessed, the HOT `bookings` lock named (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const JOURNAL = readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8");
  const SQL = readFileSync(resolve(root, "drizzle/0040_other_schedule.sql"), "utf8").replace(/\r\n/g, "\n");
  const body = SQL.replace(/^--.*$/gm, "");
  test("41 = 41: `0040_other_schedule` is the 41st file, idx 40, the last; the order 0038 → 0039 → 0040", () => {
    expect(files.length).toBe(41);
    expect(files.at(-1)).toBe("0040_other_schedule.sql");
    const j = JSON.parse(JOURNAL) as { entries: Array<{ idx: number; tag: string }> };
    expect(j.entries.length).toBe(41);
    expect(j.entries.slice(38).map((e) => e.tag)).toEqual(["0038_course_rental_marker", "0039_student_archive", "0040_other_schedule"]);
  });
  test("five nullable column adds in order — four on `bookings`, `booking_teachers.rate_minor` LAST; all IF NOT EXISTS; no DEFAULT / NOT NULL; no enum", () => {
    expect((SQL.match(/--> statement-breakpoint/g) ?? []).length).toBe(4);
    const order = [
      'ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "other_kind" text NULL;',
      'ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "head_count" integer NULL;',
      'ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "teacher_rate_minor" integer NULL;',
      'ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "rate_posted_at" timestamptz NULL;',
      'ALTER TABLE "booking_teachers" ADD COLUMN IF NOT EXISTS "rate_minor" integer NULL;',
    ];
    let at = -1;
    for (const s of order) { const i = body.indexOf(s); expect({ s, found: i > at }).toEqual({ s, found: true }); at = i; }
    expect(body.trim().endsWith(order[4]!)).toBe(true);
    expect((body.match(/ALTER TABLE|CREATE /g) ?? []).length).toBe(5);
    expect(body).not.toMatch(/DEFAULT|NOT NULL|CREATE TYPE|ADD VALUE/);
  });
  test("the header: `bookings` IS THE HOT TABLE — ACCESS EXCLUSIVE per statement, catalog-only, the queueing hazard and the forbidden windows named; the cutover order; one run", () => {
    expect(SQL).toContain("**`bookings` IS THE HOT TABLE**");
    expect(SQL).toContain("**ACCESS EXCLUSIVE on `bookings`** for the duration of that statement");
    expect(SQL).toContain("no table rewrite, no backfill");
    expect(SQL).toContain("THE QUEUEING HAZARD IS REAL HERE");
    expect(SQL).toContain("never\n--     during the 17:30 end-of-day job, the morning reminder, or an import");
    expect(SQL).toContain("THE CUTOVER ORDER: `0038` → `0039` → THIS");
    expect(SQL).toContain("`db:verify`\n-- expects 41");
    expect(SQL).toContain("ONE run, ONE transaction, five statements");
    expect(SQL).toContain("`drizzle/*.sql` = 40 (0000–0039) and journal tags = 40 before this, newest `0039`, so this is `0040`");
  });
  test("🔑 the witness is the LAST column, `booking_teachers.rate_minor`, registered last; the schema mirrors all five", () => {
    const w = SCHEDULING_WITNESSES.at(-1)!;
    expect(w).toMatchObject({ tag: "0040_other_schedule", probe: { kind: "column", table: "booking_teachers", column: "rate_minor" }, rerunnable: true });
    const S = code(src("src/db/schema.ts"));
    for (const line of ['otherKind: text("other_kind"),', 'headCount: integer("head_count"),', 'teacherRateMinor: integer("teacher_rate_minor"),', 'ratePostedAt: timestamp("rate_posted_at", { withTimezone: true }),', 'rateMinor: integer("rate_minor"),']) expect(S).toContain(line);
  });
});

describe("🔑 the kinds + the rates map — pure, with values", () => {
  test("`OTHER_KINDS` = ECA · FREE · KOL, a code list; `isOtherKind`", () => {
    expect([...OTHER_KINDS]).toEqual(["ECA", "FREE", "KOL"]);
    expect(isOtherKind("KOL")).toBe(true);
    expect(isOtherKind("CAMP")).toBe(false);
    expect(isOtherKind(null)).toBe(false);
  });
  test("`assertRatesOnBooking`: a rate for a teacher on the booking passes; a stray id ⇒ 400 naming it; no map ⇒ nothing", () => {
    expect(() => assertRatesOnBooking({ [T1]: 50000, [T2]: 40000 }, [T1, T2])).not.toThrow();
    expect(() => assertRatesOnBooking(undefined, [T1])).not.toThrow();
    try { assertRatesOnBooking({ [T1]: 50000, [T3]: 1 }, [T1, T2]); throw new Error("did not throw"); } catch (e: any) { expect(e.status).toBe(400); expect(e.message).toBe(`อัตราค่าสอนของครูที่ไม่ได้อยู่ในรายการ: ${T3}`); }
  });
});

describe("🔴 validation — the three fields on OTHER; refused on every lesson type; the edit and the series shapes", () => {
  test("OTHER accepts `otherKind` / `headCount` / `teacherRates`; an unknown kind, a negative count, a negative rate ⇒ refused", () => {
    expect(v.createBooking.safeParse({ ...base, otherKind: "ECA", headCount: 12, teacherRates: { [T1]: 50000 } }).success).toBe(true);
    expect(v.createBooking.safeParse({ ...base, otherKind: "CAMP" }).success).toBe(false);
    expect(v.createBooking.safeParse({ ...base, headCount: -1 }).success).toBe(false);
    expect(v.createBooking.safeParse({ ...base, teacherRates: { [T1]: -5 } }).success).toBe(false);
    expect(v.createBooking.safeParse({ ...base, headCount: 0 }).success).toBe(true);
  });
  test("🚫 the four lesson types REFUSE each of the three — refused, not dropped", () => {
    const student = { id: T1 };
    for (const bookingType of ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"]) {
      const extra = bookingType === "COURSE_PACKAGE" ? { courseId: T1 } : bookingType === "VOUCHER" ? { voucherId: T1 } : {};
      const ok = { ...base, bookingType, student, otherTitle: undefined, ...extra };
      expect({ bookingType, ok: v.createBooking.safeParse(ok).success }).toEqual({ bookingType, ok: true });
      for (const field of [{ otherKind: "ECA" }, { headCount: 3 }, { teacherRates: { [T1]: 1 } }]) {
        const r = v.createBooking.safeParse({ ...ok, ...field });
        expect({ bookingType, field, ok: r.success }).toEqual({ bookingType, field, ok: false });
        expect((r as any).error.issues.some((i: any) => i.message === "ฟิลด์นี้ใช้ได้เฉพาะการจองประเภท “อื่นๆ”")).toBe(true);
      }
    }
  });
  test("`editOtherBooking`: at least one field; `otherSeries`: 1–60 unique dates, no duplicate / repeated-primary extras, no `endTime` (derived)", () => {
    expect(v.editOtherBooking.safeParse({}).success).toBe(false);
    expect(v.editOtherBooking.safeParse({ headCount: 5 }).success).toBe(true);
    const series = { title: "KOL day", otherKind: "KOL", headCount: 8, teacherId: T1, additionalTeacherIds: [T2], teacherRates: { [T1]: 1, [T2]: 2 }, startTime: "10:00", dates: ["2026-10-01", "2026-10-08"] };
    expect(v.otherSeries.safeParse(series).success).toBe(true);
    expect(v.otherSeries.safeParse({ ...series, dates: [] }).success).toBe(false);
    expect(v.otherSeries.safeParse({ ...series, dates: Array.from({ length: 61 }, (_, i) => `2026-10-${String((i % 28) + 1).padStart(2, "0")}`) }).success).toBe(false);
    expect(v.otherSeries.safeParse({ ...series, dates: ["2026-10-01", "2026-10-01"] }).success).toBe(false);
    expect(v.otherSeries.safeParse({ ...series, additionalTeacherIds: [T1] }).success).toBe(false);
    expect(Object.keys((v.otherSeries as any).shape ?? (v.otherSeries as any)._def.schema.shape)).not.toContain("endTime");
  });
});

describe("🔴 the DTO — `other` for an OTHER, `null` for a lesson; the rates keyed by teacher from BOTH sources", () => {
  const row = (over: Record<string, any> = {}) => ({
    id: "b1", date: "2026-09-20", startTime: "10:00:00", endTime: "11:00:00", bookingType: "OTHER", status: "PENDING", student: null,
    teacher: { id: T1, name: "ครูหนึ่ง", nickname: "หนึ่ง", type: "FULL_TIME" }, subject: null, otherTitle: "ECA Skate Club", ...over,
  });
  test("by value: kind, headCount, the primary's rate from `bookings`, each extra's from its row; `ratePostedAt` null", () => {
    const dto: any = toBookingDTO(row({ otherKind: "ECA", headCount: 12, teacherRateMinor: 50000, ratePostedAt: null, additionalTeachers: [{ teacherId: T2, rateMinor: 40000, teacher: { id: T2, name: "ครูสอง", nickname: "สอง", type: "FREELANCE" } }] }));
    expect(dto.other).toEqual({ kind: "ECA", headCount: 12, teacherRates: { [T1]: 50000, [T2]: 40000 }, ratePostedAt: null });
    expect(dto.teachers.map((t: any) => t.id)).toEqual([T1, T2]); // the ONE accessor still answers the list
  });
  test("an OTHER made before 0040 ⇒ `other` with nulls and an empty map; a lesson ⇒ `other: null`", () => {
    expect((toBookingDTO(row()) as any).other).toEqual({ kind: null, headCount: null, teacherRates: {}, ratePostedAt: null });
    expect((toBookingDTO(row({ bookingType: "SINGLE_SESSION", student: { id: "s", name: "S" }, otherTitle: null, headCount: 5 })) as any).other).toBeNull();
  });
  test("the hand-built loader carries `teacherId` + `rateMinor` so the list path reads the same (source)", () => {
    const L = region(SCHED, "async function additionalTeachersByBooking(", "\n}\n");
    expect(L).toContain("teacherId: bookingTeachers.teacherId, rateMinor: bookingTeachers.rateMinor, teacher: teachers");
    expect(L).toContain("list.push({ teacher: r.teacher, teacherId: r.teacherId, rateMinor: r.rateMinor ?? null });");
  });
});

describe("🔴 the writes (source) — create carries the fields; the edit is not a move; the series is one tx over `insertBooking`, all or nothing; NO money", () => {
  test("`insertBooking` writes the three columns (the primary's rate out of the ONE map); `attachAdditionalTeachers` writes each extra's; `createBooking` refuses a stray rate BEFORE the tx", () => {
    const I = region(SCHED, "async function insertBooking(", "\n}\n");
    expect(I).toContain("otherKind: input.otherKind ?? null,");
    expect(I).toContain("headCount: input.headCount ?? null,");
    expect(I).toContain("teacherRateMinor: input.teacherRates?.[input.teacherId] ?? null,");
    expect(I).not.toContain("ratePostedAt"); // reserved — never written
    const A = region(SCHED, "async function attachAdditionalTeachers(", "\n}\n");
    expect(A).toContain("rateMinor: rates[teacherId] ?? null");
    const C = region(SCHED, "export async function createBooking(", "\n}\n");
    expect(C).toContain("assertRatesOnBooking(input.teacherRates, [input.teacherId, ...(input.additionalTeacherIds ?? [])]);");
    expect(C.indexOf("assertRatesOnBooking(")).toBeLessThan(C.indexOf("db.transaction("));
    expect(C).toContain("await attachAdditionalTeachers(tx, id, input.additionalTeacherIds, input.teacherRates ?? {});");
  });
  test("`editOtherBooking`: 404 · a lesson type ⇒ 400 · the rates checked against the teachers ON the booking · updates `bookings` + each extra's row · NO notification, NO move fields", () => {
    const E = region(SCHED, "export async function editOtherBooking(", "\n}\n");
    expect(E).toContain('if (!current) throw notFound("ไม่พบคาบเรียน");');
    expect(E).toContain('if (current.bookingType !== "OTHER") throw badRequest("ฟิลด์นี้ใช้ได้เฉพาะการจองประเภท “อื่นๆ”");');
    expect(E).toContain("assertRatesOnBooking(input.teacherRates, [current.teacherId, ...extras]);");
    expect(E).toContain("patch.teacherRateMinor = input.teacherRates[current.teacherId];");
    expect(E).toContain("await tx.update(bookingTeachers).set({ rateMinor: input.teacherRates[teacherId] })");
    expect(E).not.toMatch(/enqueueLine|notify|startTime|date:|teacherId:|ratePostedAt/);
  });
  test("`createOtherSeries`: the rates checked first · dates SORTED · ONE `db.transaction` · `insertBooking(tx, null, …OTHER…)` per date + the extras · the FIRST `SLOT_TAKEN` ⇒ 409 naming the date, nothing created · `{ created, bookingIds }`", () => {
    const S = region(SCHED, "export async function createOtherSeries(", "\n}\n");
    expect(S.indexOf("assertRatesOnBooking(")).toBeLessThan(S.indexOf("db.transaction("));
    expect(S).toContain("const dates = [...input.dates].sort();");
    expect((S.match(/db\.transaction\(/g) ?? []).length).toBe(1);
    expect(S).toContain('id = await insertBooking(tx, null, { ...input, bookingType: "OTHER", otherTitle: input.title, date });');
    expect(S).toContain("await attachAdditionalTeachers(tx, id, input.additionalTeacherIds, input.teacherRates ?? {});");
    expect(S).toContain('if (e instanceof ApiException && e.code === "SLOT_TAKEN") throw conflict("SLOT_TAKEN", `วันที่ ${date} ครูไม่ว่าง — ไม่ได้สร้างรายการใด (${e.message})`);');
    expect(S).toContain("return { created: bookingIds.length, bookingIds };");
    expect(S).not.toMatch(/tx\.insert\(bookings\)/); // through insertBooking ONLY — every gate reused
  });
  test("🚫 NO MONEY in any of the new code: no `recordSale` / `recordRental` / `boMovement` / `postBookingSale`; `ratePostedAt` never written anywhere in the service", () => {
    for (const fn of ["export async function editOtherBooking(", "export async function createOtherSeries("]) {
      const F = region(SCHED, fn, "\n}\n");
      expect(F).not.toMatch(/recordSale|recordRental|boMovement|postBookingSale|captureBookingDiscount/);
    }
    expect(SCHED).not.toMatch(/ratePostedAt:|set\(\{[^}]*ratePostedAt/);
  });
});

describe("🔑 the routes through the ROOT app (service spied) + the key", () => {
  const spies: any[] = [];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  afterEach(() => { process.env.SKIP_AUTH = "true"; });
  const json = (method: string, path: string, body: unknown) => rootApp.fetch(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  test("POST /bookings/other-series ⇒ 201 { created, bookingIds }; the clash ⇒ the 409 envelope naming the date, by value", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(svc, "createOtherSeries").mockImplementation((async (input: any) => {
      calls.push(input);
      if (input.dates.includes("2026-10-15")) throw new ApiException(409, "SLOT_TAKEN", "วันที่ 2026-10-15 ครูไม่ว่าง — ไม่ได้สร้างรายการใด (ครูหนึ่ง มี น้องเอ 10:00)");
      return { created: input.dates.length, bookingIds: input.dates.map((d: string) => `b-${d}`) };
    }) as any);
    spies.push(s);
    const body = { title: "ECA Skate Club", otherKind: "ECA", headCount: 12, teacherId: T1, additionalTeacherIds: [T2], teacherRates: { [T1]: 50000, [T2]: 40000 }, startTime: "10:00", dates: ["2026-10-08", "2026-10-01"] };
    const ok = await json("POST", "/api/bookings/other-series", body);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ created: 2, bookingIds: ["b-2026-10-08", "b-2026-10-01"] });
    expect(calls.at(-1)).toMatchObject({ otherKind: "ECA", headCount: 12, teacherRates: { [T1]: 50000, [T2]: 40000 } });
    const clash = await json("POST", "/api/bookings/other-series", { ...body, dates: ["2026-10-01", "2026-10-15"] });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({ error: { code: "SLOT_TAKEN", message: "วันที่ 2026-10-15 ครูไม่ว่าง — ไม่ได้สร้างรายการใด (ครูหนึ่ง มี น้องเอ 10:00)" } });
    expect((await json("POST", "/api/bookings/other-series", { ...body, otherKind: "CAMP" })).status).toBe(400);
  });
  test("PATCH /bookings/:id/other ⇒ { booking }; an empty body ⇒ 400; a lesson type's 400 passes through", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(svc, "editOtherBooking").mockImplementation((async (id: string, input: any) => {
      calls.push([id, input]);
      if (id === "lesson") throw new ApiException(400, "VALIDATION", "ฟิลด์นี้ใช้ได้เฉพาะการจองประเภท “อื่นๆ”");
      return { booking: { id, other: { kind: input.otherKind ?? "ECA", headCount: input.headCount ?? 12, teacherRates: input.teacherRates ?? {}, ratePostedAt: null } } };
    }) as any);
    spies.push(s);
    const ok = await json("PATCH", "/api/bookings/b-1/other", { headCount: 15, teacherRates: { [T1]: 60000 } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).booking.other).toMatchObject({ headCount: 15, teacherRates: { [T1]: 60000 } });
    expect(calls.at(-1)).toEqual(["b-1", { headCount: 15, teacherRates: { [T1]: 60000 } }]);
    expect((await json("PATCH", "/api/bookings/b-1/other", {})).status).toBe(400);
    expect((await json("PATCH", "/api/bookings/lesson/other", { headCount: 1 })).status).toBe(400);
  });
  test("the key: `action:calendar.other-series` (49th) gates exactly the series; the edit is a `booking-edit`; the single OTHER create stays under `book`", () => {
    expect(isActionKey("action:calendar.other-series")).toBe(true);
    expect(ACTION_REGISTRY.find((a) => a.key === "action:calendar.other-series")).toEqual({ key: "action:calendar.other-series", area: "calendar", labelTh: "สร้างตารางอื่นๆ เป็นชุด", labelEn: "Create an Other schedule series" });
    expect(ROUTE_ACCESS["POST /bookings/other-series"]).toEqual({ menus: ["menu:calendar", "menu:bookings"], action: "action:calendar.other-series" });
    expect(ROUTE_ACCESS["PATCH /bookings/:id/other"]!.action).toBe("action:calendar.booking-edit");
    expect(ROUTE_ACCESS["POST /bookings"]!.action).toBe("action:calendar.book");
    expect(Object.entries(ROUTE_ACCESS).filter(([, a]) => a.action === "action:calendar.other-series").map(([k]) => k)).toEqual(["POST /bookings/other-series"]);
  });
});

describe("📖 the coach's reminder — `Heads : n` for an OTHER entry, PLACEHOLDER (pinned by FORM, not bytes)", () => {
  const other: TodayRow = { date: "2026-09-20", startTime: "10:00", endTime: "11:00", title: "ECA Skate Club", bookingType: "OTHER", coach: "หนึ่ง", headCount: 12 } as any;
  test("with a count ⇒ a `<label> : 12` line BEFORE `Remark`; without ⇒ no such line (a lesson never has one); `0` prints", () => {
    const withHeads = renderTodaySchedule([{ ...other, attendeeNote: "นำสเก็ตมาเอง" } as any], "TH", "teacher").split("\n");
    const heads = withHeads.findIndex((l) => /^Heads : 12$/.test(l));
    expect(heads).toBeGreaterThan(-1);
    expect(withHeads[heads + 1]).toBe("Remark : นำสเก็ตมาเอง");
    const none = renderTodaySchedule([{ ...other, headCount: null } as any], "TH", "teacher");
    expect(none).not.toMatch(/Heads/);
    expect(renderTodaySchedule([{ ...other, headCount: 0 } as any], "TH", "teacher")).toContain("Heads : 0");
    const lesson = renderTodaySchedule([{ ...other, bookingType: "SINGLE_SESSION", studentName: "Aiwa", subjectName: "Freeskate", title: null, headCount: null } as any], "TH", "teacher");
    expect(lesson).not.toMatch(/Heads/);
  });
  test("the label is a PLACEHOLDER — the i18n comment says so, and the job maps `headCount` off the row it already holds (source)", () => {
    const I18N = readSrc(readFileSync(resolve(root, "src/lib/line-i18n.ts"), "utf8"));
    expect(I18N).toContain("PLACEHOLDER — MINE, and the customer has NOT seen it** (TASK-394");
    expect(code(I18N)).toContain('ob_f_heads: { TH: "Heads", EN: "Heads" },');
    expect(code(src("src/services/jobs.service.ts"))).toContain("headCount: r.headCount ?? null,");
    expect(code(src("src/lib/line-today-schedule.ts"))).toContain('...(r?.headCount != null ? [`${t("ob_f_heads", TEMPLATE_LANG)} : ${r.headCount}`] : []),');
  });
});
