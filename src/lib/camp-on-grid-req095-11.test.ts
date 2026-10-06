// TASK-418 (`REQ-095 §11`, SPEC-085 A + B) — camp ON the teacher grid: migration `0047` (the day object, the week's
// window, `bookings.camp_week_day_id` + its partial index as the witness, the SHARE lock named), the 4th kind `CAMP`
// (the type ⇔ kind pin knows it; the HUMAN validators do not), the pure window rules + the wanted set + the diff + the
// reminder fold (by value), the ONE `syncCampDayRows` by VALUE through a fake tx (insert / delete / clash rollback /
// CONFIRMED at birth / a closed week holds nothing), the lifecycle by source (five callers, `edited_at`), the per-day
// swap route, `CAMP_ROW_OWNED` at every human row write (a table), the reminder fold, no money by absence. 56 = 56.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import { CAMP_WINDOW_BOUNDS, CAMP_WINDOW_DEFAULT, assertCampWindow, campSlotDiff, foldCampRows, wantedCampSlots, windowHours } from "./camp";
import { CAMP_KIND, HUMAN_OTHER_KINDS, OTHER_KINDS, assertKindForType, isOtherKind } from "./other-kind";
import { groupReminders, type ReminderSession } from "./daily-reminder";
import { ROUTE_ACCESS, TEACHER_ALLOWED } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import * as v from "../validation";
import * as camp from "../services/camp.service";
import * as sched from "../services/scheduler.service";
import { readSrc } from "./read-src";
import { bangkokNow } from "./bangkok-time";

// 🔻 TASK-666 — the DATE BOMB defused. The camp day was the literal `2026-10-05`, and the camp sync SKIPS a past day by design
// (`camp.service.ts`, TASK-445), so this file went red the day after. It is now computed from Bangkok TODAY (the same `bangkokNow()`
// the code reads): the first MONDAY at least 30 days ahead — always in the future, and the same weekday as the old literal, so
// nothing that reads the day of the week moves. Its neighbours and its DD-MM-YYYY form are DERIVED from it, never typed.
const isoPlus = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const CAMP_DAY = ((d) => isoPlus(d, (8 - new Date(`${d}T00:00:00Z`).getUTCDay()) % 7))(isoPlus(bangkokNow().date, 30));
const CAMP_FRIDAY = isoPlus(CAMP_DAY, 4); // was `2026-10-09` — the week's Friday

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
const SCHED = code(src("src/services/scheduler.service.ts"));
const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222", W1 = "33333333-3333-4333-8333-333333333333", D1 = "44444444-4444-4444-8444-444444444444";
const thrown = (fn: () => unknown) => { try { fn(); return null; } catch (e: any) { return { status: e.status, code: e.code, message: e.message }; } };
afterAll(() => { delete process.env.SKIP_AUTH; });

describe("🔴 the migration — 0047, counted, the day table + the window + the link + the partial index LAST = the witness; the SHARE lock named (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const sql = readFileSync(resolve(root, "drizzle/0047_camp_week_days.sql"), "utf8").replace(/\r\n/g, "\n");
  test("56 = 56: `0047_camp_week_days` is the 48th file, idx 47 (TASK-420 added 0048 after it); 'expects 48'", () => {
    expect(files.length).toBe(66); // TASK-497: +0059 · 🔻 TASK-540: +0060 · 🔻 TASK-556: +0061 · 🔻 TASK-561: +0062 · 🔻 TASK-568: +0063 · 🔻 TASK-573: +0064 · 🔻 TASK-690: +0065
    expect(journal.entries.length).toBe(66); // TASK-497: +0059 · 🔻 TASK-540: +0060 · 🔻 TASK-556: +0061 · 🔻 TASK-561: +0062 · 🔻 TASK-568: +0063 · 🔻 TASK-573: +0064 · 🔻 TASK-690: +0065
    expect(files[47]).toBe("0047_camp_week_days.sql");
    expect(journal.entries[47]).toMatchObject({ idx: 47, tag: "0047_camp_week_days" });
    expect(sql).toContain("`db:verify` expects 48");
  });
  test("six statements in order: the table (uuid[] NOT NULL DEFAULT '{}', time × 2, edited_at, UNIQUE week+date) · its index · the two NULL window columns · the NULL FK on bookings RESTRICT · the partial index LAST; the SHARE lock on bookings said; no enum", () => {
    const stmts = sql.split("\n").filter((l) => !l.startsWith("--") && l.trim()).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
    expect(stmts.length).toBe(6);
    expect(stmts[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "camp_week_days" \(/);
    expect(stmts[0]).toContain(`"teacher_ids"   uuid[] NOT NULL DEFAULT '{}'`);
    expect(stmts[0]).toContain(`"edited_at"     timestamptz NULL`);
    expect(stmts[0]).toContain(`CONSTRAINT "camp_week_days_week_date_uq" UNIQUE ("camp_week_id", "date")`);
    expect(stmts[0]).toContain(`REFERENCES "camp_weeks"("id") ON DELETE RESTRICT`);
    expect(stmts[1]).toBe('CREATE INDEX IF NOT EXISTS "camp_week_days_week_idx" ON "camp_week_days" ("camp_week_id")');
    expect(stmts[2]).toBe('ALTER TABLE "camp_weeks" ADD COLUMN IF NOT EXISTS "window_start" time NULL');
    expect(stmts[3]).toBe('ALTER TABLE "camp_weeks" ADD COLUMN IF NOT EXISTS "window_end" time NULL');
    expect(stmts[4]).toBe('ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "camp_week_day_id" uuid NULL REFERENCES "camp_week_days"("id") ON DELETE RESTRICT');
    expect(stmts[5]).toBe('CREATE INDEX IF NOT EXISTS "bookings_camp_week_day_idx" ON "bookings" ("camp_week_day_id") WHERE "camp_week_day_id" IS NOT NULL');
    expect(stmts.join(";")).not.toMatch(/CREATE TYPE|ALTER TYPE|'GROUP'|DEFAULT now\(\)"|CONCURRENTLY/);
    expect(sql).toContain("SHARE lock for its one scan");
    expect(sql).toContain("WRITES to `bookings` wait");
    expect(SCHEDULING_WITNESSES.find((x) => x.tag === "0047_camp_week_days")).toMatchObject({ probe: { kind: "index", index: "bookings_camp_week_day_idx" }, rerunnable: true });
    const schema = code(src("src/db/schema.ts"));
    expect(schema).toContain('campWeekDayId: uuid("camp_week_day_id").references((): AnyPgColumn => campWeekDays.id, { onDelete: "restrict" }),');
    expect(schema).toContain('windowStart: time("window_start"),');
    expect(region(schema, "export const campWeekDays = pgTable(", "\n);")).toContain('uniqueIndex("camp_week_days_week_date_uq").on(t.campWeekId, t.date)');
    expect(schema).toContain("campWeekDay: one(campWeekDays, { fields: [bookings.campWeekDayId], references: [campWeekDays.id] }),");
  });
});

describe("🔴 the kinds — CAMP is the 4th; the type ⇔ kind pin knows it; the three HUMAN validators refuse it (CAMP only via the sync)", () => {
  test("by value", () => {
    expect([...OTHER_KINDS]).toEqual(["ECA", "FREE", "KOL", "CAMP"]);
    expect([...HUMAN_OTHER_KINDS]).toEqual(["ECA", "FREE", "KOL"]);
    expect(CAMP_KIND).toBe("CAMP");
    expect(isOtherKind("CAMP")).toBe(true);
    expect(() => assertKindForType("OTHER", "CAMP")).not.toThrow();
    expect(thrown(() => assertKindForType("GROUP", "CAMP"))).toMatchObject({ status: 400 });
    for (const shape of [v.otherSeries, v.editOtherBooking]) {
      const ok = (shape as any).safeParse({ title: "x", otherKind: "CAMP", headCount: 1, teacherId: T1, startTime: "10:00", dates: [CAMP_DAY] });
      expect(ok.success).toBe(false);
    }
    expect(v.editOtherBooking.safeParse({ otherKind: "ECA" }).success).toBe(true);
    expect(code(src("src/validation.ts"))).not.toContain("z.enum(OTHER_KINDS)");
    expect((code(src("src/validation.ts")).match(/z\.enum\(HUMAN_OTHER_KINDS\)/g) ?? []).length).toBe(4); // 🔻 TASK-428: + the series header PATCH
  });
});

describe("🔴 the pure rules — the window, the wanted set, the diff, the reminder fold (by value)", () => {
  test("the default 10:00–15:00; the bounds; whole hours; start < end; the hours of a window", () => {
    expect(CAMP_WINDOW_DEFAULT).toEqual({ start: "10:00", end: "15:00" });
    expect(CAMP_WINDOW_BOUNDS).toEqual({ earliest: "06:00", latest: "22:00" });
    expect(() => assertCampWindow("10:00", "15:00")).not.toThrow();
    expect(() => assertCampWindow("06:00", "22:00")).not.toThrow();
    for (const [s, e] of [["10:30", "15:00"], ["10:00", "15:30"], ["05:00", "15:00"], ["10:00", "23:00"], ["15:00", "10:00"], ["10:00", "10:00"]]) expect({ s, e, r: thrown(() => assertCampWindow(s!, e!)) }).toMatchObject({ s, e, r: { status: 400 } });
    expect(windowHours("10:00", "15:00")).toEqual(["10:00", "11:00", "12:00", "13:00", "14:00"]);
    expect(windowHours("10:00:00", "12:00:00")).toEqual(["10:00", "11:00"]); // the DB's HH:MM:SS
    expect(windowHours("10:00", "10:00")).toEqual([]);
  });
  test("the wanted set = teachers × hours; no teacher ⇒ none; the diff inserts the missing and removes the surplus", () => {
    // 🔻 TASK-454 — each coach brings their OWN window now; same-window coaches are the case this test always had.
    const win = (ids: string[], start: string, end: string) => wantedCampSlots(ids.map((teacherId) => ({ teacherId, start, end })));
    expect([...win([T1, T2], "10:00", "12:00")].sort()).toEqual([`${T1}|10:00`, `${T1}|11:00`, `${T2}|10:00`, `${T2}|11:00`]);
    expect(win([], "10:00", "15:00").size).toBe(0);
    const existing = new Map([[`${T1}|10:00`, "r1"], [`${T1}|11:00`, "r2"], [`${T2}|10:00`, "r3"]]);
    const d = campSlotDiff(win([T1], "10:00", "13:00"), existing);
    expect(d.insert).toEqual([`${T1}|12:00`]);
    expect(d.remove).toEqual(["r3"]); // T2 dropped
    expect(campSlotDiff(win([T1], "10:00", "12:00"), existing)).toEqual({ insert: [], remove: ["r3"] });
    expect(campSlotDiff(new Set(), existing).remove.sort()).toEqual(["r1", "r2", "r3"]);
  });
  test("the fold: a coach's camp hours of one day become ONE row spanning the window; other rows untouched; two days stay two", () => {
    const row = (o: any) => ({ startTime: "10:00", endTime: "11:00", campWeekDayId: D1, otherKind: "CAMP", ...o });
    const rows = [row({ startTime: "12:00", endTime: "13:00" }), row({}), row({ startTime: "11:00", endTime: "12:00" }), row({ startTime: "10:00", endTime: "11:00", campWeekDayId: null, otherKind: "ECA" }), row({ campWeekDayId: "other-day", startTime: "14:00", endTime: "15:00" })];
    const out = foldCampRows(rows);
    expect(out.length).toBe(3);
    expect(out[0]).toMatchObject({ startTime: "10:00", endTime: "13:00", campWeekDayId: D1 });
    expect(out[1]).toMatchObject({ otherKind: "ECA", startTime: "10:00", endTime: "11:00" });
    expect(out[2]).toMatchObject({ campWeekDayId: "other-day", startTime: "14:00", endTime: "15:00" });
    expect(rows[0]!.endTime).toBe("13:00"); // the fold copies, never mutates the input (the first camp row is the seed's clone)
  });
  test("through `groupReminders`: five CONFIRMED camp hours ⇒ ONE coach row `Camp A` 10:00-15:00; a PENDING one is out first (REQ-096)", () => {
    const S = (startTime: string, status = "CONFIRMED"): ReminderSession => ({ id: startTime, date: CAMP_DAY, startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`, status, bookingType: "OTHER", title: "Camp A", otherKind: "CAMP", campWeekDayId: D1, teacherId: T1, teacherLineUserId: "Ut1", studentId: null, studentName: "Camp A", parentId: null, parentLineUserId: null, subjectName: null });
    const groups = groupReminders([S("10:00"), S("11:00"), S("12:00"), S("13:00"), S("14:00"), S("15:00", "PENDING")]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.recipientType).toBe("teacher");
    expect(groups[0]!.rows.length).toBe(1);
    expect(groups[0]!.rows[0]).toMatchObject({ startTime: "10:00", endTime: "15:00", title: "Camp A", bookingType: "OTHER" });
  });
});

describe("🔴 THE ONE SYNC by VALUE through a fake tx — insert the missing (CONFIRMED, the day link), delete the surplus, a clash ⇒ 409 naming date · hour · teacher and NOTHING kept, a closed week holds nothing", () => {
  const fakeTx = (o: { week: any; day: any; existing: { id: string; teacherId: string; startTime: string }[]; clashAt?: string }) => {
    const log: any[] = [];
    let n = 0;
    const tx: any = {
      log,
      query: { teacherLeaveDays: { findFirst: async () => undefined }, /* TASK-561: no advance leave in this fixture */
        campWeekDays: { findFirst: async () => ({ ...o.day, week: o.week }) },
        teachers: { findFirst: async ({ where }: any) => { const probe: string[] = []; where({ id: "id" }, { eq: (_: any, v: string) => { probe.push(v); return null; } }); return { id: probe[0], nickname: probe[0] === T1 ? "เอก" : "บี" }; }, findMany: async () => [{ id: T1, nickname: "เอก" }, { id: T2, nickname: "บี" }] }, // 🔻 TASK-445: the names are read BEFORE the inserts (the catch touches no tx after a clash)
        bookings: { findFirst: async () => null },
        // 🔻 TASK-454: the day's COACHES are rows now (hours + rate); NULL hours resolve to the day's window.
        campWeekDayTeachers: { findMany: async () => (o.day.teacherIds ?? []).map((teacherId: string) => ({ campWeekDayId: o.day.id, teacherId, startTime: null, endTime: null, rateMinor: 0 })) },
      },
      select: () => ({ from: () => ({ where: async () => o.existing }) }),
      delete: () => ({ where: async (w: any) => { log.push(["delete", w]); }, }),
      update: () => ({ set: (patch: any) => ({ where: async () => { log.push(["update", patch]); } }) }),
    };
    const ins = spyOn(sched, "insertBooking").mockImplementation((async (_tx: any, studentId: any, input: any) => {
      if (o.clashAt && input.startTime === o.clashAt) throw new ApiException(409, "SLOT_TAKEN", "taken");
      log.push(["insert", studentId, input]); return `new-${++n}`;
    }) as any);
    return { tx, log, restore: () => ins.mockRestore() };
  };
  const week = { id: W1, name: "Camp A", status: "OPEN" };
  test("insert what is missing, delete what is surplus — each new row CONFIRMED, OTHER/CAMP, the week's name, no student, then linked to the day", async () => {
    const f = fakeTx({ week, day: { id: D1, date: CAMP_DAY, teacherIds: [T1], startTime: "10:00:00", endTime: "13:00:00" }, existing: [{ id: "old-1", teacherId: T1, startTime: "10:00:00" }, { id: "old-2", teacherId: T2, startTime: "10:00:00" }] });
    try {
      const r = await camp.syncCampDayRows(f.tx, D1);
      expect(r).toEqual({ inserted: 2, deleted: 1, onLeave: [] });
      const inserts = f.log.filter((l) => l[0] === "insert");
      expect(inserts.map((l) => l[2].startTime)).toEqual(["11:00", "12:00"]);
      for (const [, studentId, input] of inserts) { expect(studentId).toBeNull(); expect(input).toMatchObject({ teacherId: T1, subjectId: null, date: CAMP_DAY, bookingType: "OTHER", otherTitle: "Camp A", otherKind: "CAMP", status: "CONFIRMED" }); expect(input.headCount).toBeUndefined(); expect(input.teacherRates).toEqual({ [T1]: 0 }); } // 🔻 TASK-443: the coach's DAY rate rides the row (0 = no rate row)
      expect(f.log.filter((l) => l[0] === "update" && l[1].campWeekDayId).map((l) => l[1].campWeekDayId)).toEqual([D1, D1]);
      expect(f.log.filter((l) => l[0] === "update" && "teacherRateMinor" in l[1]).map((l) => l[1])).toEqual([{ teacherRateMinor: 0 }]); // 🔻 TASK-443: the kept rows re-stamped, one update per coach on the day
      expect(f.log.filter((l) => l[0] === "delete").length).toBe(1);
    } finally { f.restore(); }
  });
  test("a clash ⇒ 409 SLOT_TAKEN naming the date, the hour and the teacher's nickname — the error propagates so the CALLER's tx rolls back", async () => {
    const f = fakeTx({ week, day: { id: D1, date: CAMP_DAY, teacherIds: [T1], startTime: "10:00:00", endTime: "12:00:00" }, existing: [], clashAt: "11:00" });
    try {
      const e = await camp.syncCampDayRows(f.tx, D1).then(() => null, (e) => ({ status: e.status, code: e.code, message: e.message }));
      expect(e).toEqual({ status: 409, code: "SLOT_TAKEN", message: `วันที่ ${CAMP_DAY} 11:00 ครูเอก มีคาบแล้ว — ไม่ได้บันทึกอะไร` });
    } finally { f.restore(); }
  });
  test("🔻 TASK-581: a CLOSED week syncs EXACTLY as an open one (its coaches keep their blocks — Close gates new bookings only); no teacher ⇒ every row deleted", async () => {
    const at = (status: string) => fakeTx({ week: { ...week, status }, day: { id: D1, date: CAMP_DAY, teacherIds: [T1], startTime: "10:00:00", endTime: "15:00:00" }, existing: [{ id: "old-1", teacherId: T1, startTime: "10:00:00" }] });
    const results: any[] = [];
    for (const status of ["OPEN", "CLOSED"]) {
      const f = at(status);
      try { results.push([await camp.syncCampDayRows(f.tx, D1), f.log]); } finally { f.restore(); }
    }
    for (const r of results) r[1] = JSON.parse(JSON.stringify(r[1], function (k, v) { return this[k] instanceof Date ? "<now>" : v; })); // a write's `new Date()` differs by ms
    expect(results[1]).toEqual(results[0]); // by value: the same result and the same writes
    expect(results[1][0]).toMatchObject({ deleted: 0 }); // the existing block KEPT on a closed week
    const g = fakeTx({ week, day: { id: D1, date: CAMP_DAY, teacherIds: [], startTime: "10:00:00", endTime: "15:00:00" }, existing: [{ id: "old-1", teacherId: T1, startTime: "10:00:00" }] });
    try { expect(await camp.syncCampDayRows(g.tx, D1)).toEqual({ inserted: 0, deleted: 1, onLeave: [] }); } finally { g.restore(); }
  });
});

describe("🔴 the lifecycle by source — ONE sync, its callers, `edited_at`, the per-day swap, the DTOs; the reminder fold wired; no money", () => {
  test("createWeek: one tx — the week, a day row per date (the week's teachers + window), the sync per day; the window validated first", () => {
    const C = region(SVC, "export async function createWeek(", "export async function updateWeek(");
    expect(C).toContain("assertCampWindow(ws, we);");
    expect(C).toContain("await tx.insert(campWeekDays).values({ campWeekId: row!.id, date, startTime: ws, endTime: we }).returning();");
    // 🔻 TASK-454 — the week's roster seeds the day's coach ROWS (each on the day's window, stored NULL)
    expect(C).toContain("await setDayTeachers(tx, d!.id, (input.teacherIds ?? []).map((teacherId) => ({ teacherId })));");
    expect(C).toContain("for (const teacherId of (await syncCampDayRows(tx, d!.id)).onLeave) onLeave.push({ date, teacherId });"); // 🔻 TASK-561: + the on-leave LIST
    expect((C.match(/db\.transaction\(/g) ?? []).length).toBe(1);
  });
  test("updateWeek: 🔻 TASK-581 — CLOSE / OPEN cascade NOTHING (no delete, no re-sync); a teacher/window change ⇒ ONLY the days with `edited_at IS NULL` re-derived; no dates edit exists", () => {
    const U = region(code(SVC), "export async function updateWeek(", "export async function weekDays(");
    const TX = region(U, "const [updated] = await db.transaction(", "return [u];");
    expect(TX).not.toMatch(/"CLOSED"|"OPEN"|status|deleteCampDayRows|\.delete\(/); // inside the tx the status is read by NOTHING
    expect(U).toContain('if (input.status !== undefined) { patch.status = input.status; patch.closedAt = input.status === "CLOSED" ? new Date() : null; }'); // the flip: the week row only
    expect(U).toContain("if (input.teacherIds !== undefined || input.windowStart !== undefined || input.windowEnd !== undefined) {");
    expect(U).toContain("a(e(d.campWeekId, id), nul(d.editedAt))");
    expect(U).toContain("for (const teacherId of (await syncCampDayRows(tx, d.id)).onLeave) onLeave.push({ date: d.date, teacherId });"); // 🔻 TASK-561
    expect(v.updateCampWeek.safeParse({ startDate: CAMP_DAY }).success).toBe(false); // Finding B — no dates edit
    expect(v.updateCampWeek.safeParse({ windowStart: "09:00", windowEnd: "16:00" }).success).toBe(true);
    expect(v.createCampWeek.safeParse({ name: "A", startDate: CAMP_DAY, endDate: CAMP_FRIDAY, windowStart: "9:00" }).success).toBe(false); // HH:MM
  });
  test("the per-day swap: 🔻 TASK-581 a CLOSED week is swapped like an open one (no 409), a date outside 404, the window validated, `edited_at` stamped, the ONE sync; the route + its access row; not in TEACHER_ALLOWED", () => {
    const P = region(SVC, "export async function updateWeekDay(", "export async function listPackages(");
    expect(code(P)).not.toMatch(/CAMP_WEEK_CLOSED|w\.status/);
    expect(P).toContain('if (!d) throw notFound("ไม่พบวันแคมป์");');
    expect(P).toContain("assertCampWindow(start, end);");
    expect(P).toContain("editedAt: new Date()");
    expect(P).toContain("return syncCampDayRows(tx, d.id);");
    expect((SVC.match(/syncCampDayRows\(tx, /g) ?? []).length).toBe(3); // createWeek · updateWeek (re-derive) · the per-day swap — 🔻 TASK-581: the reopen re-sync is gone
    expect(code(src("src/routes/camp.ts"))).toContain('.patch("/weeks/:id/days/:date", zValidator("json", v.updateCampWeekDay), async (c) => {'); // 🔻 TASK-443: + `assertMayEditCoachRate` before the service
    expect(code(src("src/routes/camp.ts"))).toContain('return c.json(await camp.updateWeekDay(c.req.param("id"), c.req.param("date"), c.req.valid("json")));');
    expect((ROUTE_ACCESS as any)["PATCH /camp/weeks/:id/days/:date"]).toEqual({ menus: ["menu:camp"], action: "action:camp.week-open" });
    expect(TEACHER_ALLOWED.has("PATCH /camp/weeks/:id/days/:date")).toBe(false);
    expect(v.updateCampWeekDay.safeParse({}).success).toBe(false);
    expect(v.updateCampWeekDay.safeParse({ teacherIds: [T1] }).success).toBe(true);
  });
  test("the DTOs: the week's effective window; each day's teachers/window/editedAt on the roster; the booking DTO's `campWeekDayId` + `campWeekId`; the shared relation set carries the day", () => {
    expect(SVC).toContain("windowStart: hm(w.windowStart) ?? CAMP_WINDOW_DEFAULT.start, windowEnd: hm(w.windowEnd) ?? CAMP_WINDOW_DEFAULT.end,");
    // 🔻 TASK-454 — the DTO carries each coach's own window; `teacherIds` survives ONE deploy as a DERIVED view of it
    expect(SVC).toContain("const teachers = campDayTeachers(d);");
    expect(SVC).toContain("teacherIds: teachers.map((t) => t.teacherId),");
    expect(region(SVC, "export async function weekDays(", "const toDayDTO")).toContain("...toDayDTO(d) };");
    const M = code(src("src/db/mappers.ts"));
    expect(M).toContain("campWeekDayId: b.campWeekDayId ?? null,");
    expect(M).toContain("campWeekId: b.campWeekDay?.campWeekId ?? null,");
    expect(SCHED).toContain("  group: true,\n  campWeekDay: true,\n} as const;");
  });
  test("the reminder fold is wired in the builder (before grouping) and the job carries the two keys; no money on a camp row by absence", () => {
    expect(code(src("src/lib/daily-reminder.ts"))).toContain("const live = foldCampRows(sessions.filter((s) => REMINDABLE.has(s.status)));");
    const J = code(src("src/services/jobs.service.ts"));
    expect(J).toContain("campWeekDayId: r.campWeekDayId ?? null,");
    expect(J).toContain("otherKind: r.otherKind ?? null,");
    // no price, no rate, no head count on the derived row ⇒ the day-end's OTHER post returns false (`otherPriceMinor == null && otherPriceItemId == null`)
    const S = region(SVC, "export async function syncCampDayRows(", "export async function updateWeekDay("); // 🔻 TASK-581: `deleteCampDayRows` removed (its only caller was the close)
    expect(S).not.toMatch(/otherPriceMinor|otherPriceItemId|headCount|recordSale|recordRevenue/); // 🔻 TASK-443: `teacherRates` now rides the row (a RATE, not a PRICE — the OTHER post still answers false)
    expect(J).toContain("if (b.otherPriceMinor == null && b.otherPriceItemId == null) return false;");
    // the freelance hold: OTHER rows return early
    expect(SCHED).toContain('if (booking?.bookingType === "OTHER") return;');
  });
});

describe("🔴 CAMP_ROW_OWNED — every human write on a derived row is refused INSIDE the service (the row is in hand): a table of eleven, by value and by source", () => {
  test("the guard by value", () => {
    expect(() => sched.assertNotCampRow({ campWeekDayId: null })).not.toThrow();
    expect(() => sched.assertNotCampRow(null)).not.toThrow();
    expect(thrown(() => sched.assertNotCampRow({ campWeekDayId: D1 }))).toEqual({ status: 409, code: "CAMP_ROW_OWNED", message: "บล็อกแคมป์แก้ที่สัปดาห์แคมป์" });
  });
  test("by source: the eleven services call `assertNotCampRow(` on the loaded row — status · move · other-edit · group-teacher · note · pause · resume · badges · rental record · rental paid · rental removed", () => {
    const sites: Record<string, [string, string, string]> = {
      updateBookingStatus: ["src/services/scheduler.service.ts", "export async function updateBookingStatus(", "assertNotCampRow(current);"],
      moveBooking: ["src/services/scheduler.service.ts", "export async function moveBooking(", "assertNotCampRow(current);"],
      editOtherBooking: ["src/services/scheduler.service.ts", "export async function editOtherBooking(", "assertNotCampRow(current);"],
      swapGroupTeacher: ["src/services/scheduler.service.ts", "export async function swapGroupTeacher(", "assertNotCampRow(current);"],
      setAttendeeNote: ["src/services/scheduler.service.ts", "export async function setAttendeeNote(", "assertNotCampRow(row);"],
      pauseBooking: ["src/services/scheduler.service.ts", "export async function pauseBooking(", "assertNotCampRow(current);"],
      resumeBooking: ["src/services/scheduler.service.ts", "export async function resumeBooking(", "assertNotCampRow(current);"],
      setBookingBadges: ["src/services/badge.service.ts", "export async function setBookingBadges(", "assertNotCampRow(booking);"],
      recordBookingRental: ["src/services/rental.service.ts", "export async function recordBookingRental(", "assertNotCampRow(booking);"],
      payBookingRental: ["src/services/rental.service.ts", "export async function payBookingRental(", "assertNotCampRow(await db.query.bookings.findFirst("],
      removeBookingRental: ["src/services/rental.service.ts", "export async function removeBookingRental(", "assertNotCampRow(await db.query.bookings.findFirst("],
    };
    for (const [name, [file, head, line]] of Object.entries(sites)) {
      const S = code(src(file));
      const at = S.indexOf(head); expect({ name, found: at >= 0 }).toEqual({ name, found: true });
      const body = S.slice(at, S.indexOf("\nexport ", at + 10) > 0 ? S.indexOf("\nexport ", at + 10) : undefined);
      expect({ name, guarded: body.includes(line) }).toEqual({ name, guarded: true });
    }
    // the guard is a pure check on the row, never a second read
    expect(region(SCHED, "export function assertNotCampRow(", "\n}\n")).not.toMatch(/await|db\./);
  });
  test("through the ROOT app (the service throws it): `PATCH /bookings/:id/status` on a camp row ⇒ the 409 envelope; the day-end is not a human write (`cutCampDays` untouched)", async () => {
    process.env.SKIP_AUTH = "true";
    const s = spyOn(sched, "updateBookingStatus").mockImplementation((async () => { sched.assertNotCampRow({ campWeekDayId: D1 }); }) as any);
    try {
      const r = await rootApp.fetch(new Request(`http://localhost/api/bookings/${D1}/status`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", reasonCode: "ADMIN_ERROR" }) }));
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: { code: "CAMP_ROW_OWNED", message: "บล็อกแคมป์แก้ที่สัปดาห์แคมป์" } });
    } finally { s.mockRestore(); }
    expect(region(SVC, "export async function cutCampDays(", "\n}\n")).not.toContain("campWeekDay"); // the kids' cut is the kids'
  });
});
