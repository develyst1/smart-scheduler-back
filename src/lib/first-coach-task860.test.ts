// 🔻 TASK-860 (REQ-120 F4) — the conversion links, the first coach, the whole-course coach change and the Bonus-100 pick. No database: the pure choosers by value, the queries rendered to SQL by the real dialect, the
// function bodies' wiring by source, and the pick endpoint through spied `db` calls. F4 STORES facts and decides nothing — no date filter, no kind filter anywhere in it.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const fc = await import("./first-coach");
const v = await import("../validation");
const { readSrc } = await import("./read-src");

const SVC = readSrc(await Bun.file(new URL("../services/scheduler.service.ts", import.meta.url)).text());
const JOBS = readSrc(await Bun.file(new URL("../services/jobs.service.ts", import.meta.url)).text());
const API = readSrc(await Bun.file(new URL("../routes/api.ts", import.meta.url)).text());
const MIG = await Bun.file(new URL("../../drizzle/0074_conversion_links_first_coach.sql", import.meta.url)).text();
const JOURNAL = await Bun.file(new URL("../../drizzle/meta/_journal.json", import.meta.url)).text();
const WITNESS = await Bun.file(new URL("./migration-witness.ts", import.meta.url)).text();
const SCHEMA = await Bun.file(new URL("../db/schema.ts", import.meta.url)).text();
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const fnBody = (src: string, start: string, end: string) => { const a = src.indexOf(start); return code(src.slice(a, src.indexOf(end, a + 1))); };
const CREATE_COURSE = fnBody(SVC, "export async function createCoursePackage", "export async function createVoucher");
const CREATE_VOUCHER = fnBody(SVC, "export async function createVoucher", "// ───────────────────────── Overbooking a leave slot");
const TIME_CHANGE = fnBody(SVC, "async function runCourseTeacherTimeChange", "export async function changeCourseTeacherAndTime");
const dialect = new PgDialect();
const T = (id: string, date: string, startTime: string, teacherId: string) => ({ id, date, startTime, teacherId });

describe("🔴 TASK-860 — the previous entitlement: the newer of the child's latest course and voucher, at most ONE", () => {
  const c = { id: "c1", createdAt: "2026-10-01T03:00:00Z" }, vv = { id: "v1", createdAt: "2026-10-05T03:00:00Z" };
  test("none ⇒ both null · a course only ⇒ prevCourseId · a voucher only ⇒ prevVoucherId", () => {
    expect(fc.latestEntitlement(undefined, undefined)).toEqual({ prevCourseId: null, prevVoucherId: null });
    expect(fc.latestEntitlement(c, undefined)).toEqual({ prevCourseId: "c1", prevVoucherId: null });
    expect(fc.latestEntitlement(null, vv)).toEqual({ prevCourseId: null, prevVoucherId: "v1" });
  });
  test("both ⇒ the NEWER by created_at (either kind), a tie goes to the course — never both set", () => {
    expect(fc.latestEntitlement(c, vv)).toEqual({ prevCourseId: null, prevVoucherId: "v1" }); // a voucher after a course
    expect(fc.latestEntitlement({ id: "c2", createdAt: "2026-10-09T03:00:00Z" }, vv)).toEqual({ prevCourseId: "c2", prevVoucherId: null });
    expect(fc.latestEntitlement({ id: "c3", createdAt: "2026-10-05T03:00:00Z" }, vv)).toEqual({ prevCourseId: "c3", prevVoucherId: null });
  });
});

describe("🔴 TASK-860 — conversionLinks: the SQL of the three reads, and what it returns", () => {
  /** A fake tx that builds each query with the REAL drizzle builder (so the dialect renders it) and answers from a queue. */
  const fakeTx = (answers: any[][]) => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      select: (cols: any) => ({
        from: (t: any) => ({
          where: (w: any) => ({
            orderBy: (...o: any[]) => ({
              limit: async (n: number) => {
                const q = (db as any).select(cols).from(t).where(w).orderBy(...o).limit(n).toSQL();
                captured.push({ sql: q.sql, params: q.params });
                return answers.shift() ?? [];
              },
            }),
          }),
        }),
      }),
    };
    return { tx, captured };
  };
  test("trial read: the child's ATTENDED FIRST_TRIAL on/before today that NO course and NO voucher references yet, the latest first, one row", async () => {
    const { tx, captured } = fakeTx([[{ id: "t9" }], [], []]);
    const r = await fc.conversionLinks(tx, "stu-1", "2026-11-08");
    expect(r).toEqual({ fromTrialBookingId: "t9", prevCourseId: null, prevVoucherId: null });
    const q = captured[0]!.sql;
    expect(q).toContain('"bookings"."student_id" = $1');
    expect(q).toContain('"bookings"."booking_type" = $2');
    expect(q).toContain('"bookings"."status" = $3');
    expect(q).toContain('"bookings"."date" <= $4');
    expect(captured[0]!.params.slice(0, 4)).toEqual(["stu-1", "FIRST_TRIAL", "ATTENDED", "2026-11-08"]);
    expect(q).toContain("not exists (select 1 from course_packages c where c.from_trial_booking_id =");
    expect(q).toContain("not exists (select 1 from vouchers v where v.from_trial_booking_id =");
    expect(q).toContain('order by "bookings"."date" desc, "bookings"."start_time" desc, "bookings"."id" desc limit $');
  });
  test("a PENDING / NO_SHOW / CANCELLED trial is never selected (the status is the one literal ATTENDED); no row ⇒ null", async () => {
    const { tx, captured } = fakeTx([[], [], []]);
    expect((await fc.conversionLinks(tx, "s", "2026-11-08")).fromTrialBookingId).toBeNull();
    expect(captured[0]!.params).toContain("ATTENDED");
    for (const bad of ["PENDING", "NO_SHOW", "CANCELLED", "CONFIRMED"]) expect(captured[0]!.params).not.toContain(bad);
  });
  test("previous reads: the child's latest course (primary OR co-student) and latest voucher by created_at, desc — no kind, source, program or date filter", async () => {
    const { tx, captured } = fakeTx([[], [{ id: "c1", createdAt: "2026-10-01T03:00:00Z" }], [{ id: "v1", createdAt: "2026-10-05T03:00:00Z" }]]);
    const r = await fc.conversionLinks(tx, "stu-1", "2026-11-08");
    expect(r).toEqual({ fromTrialBookingId: null, prevCourseId: null, prevVoucherId: "v1" });
    expect(captured[1]!.sql).toContain('"course_packages"."student_id" = $1 or "course_packages"."co_student_id" = $2');
    expect(captured[1]!.sql).toContain('order by "course_packages"."created_at" desc, "course_packages"."id" desc');
    expect(captured[2]!.sql).toContain('"vouchers"."student_id" = $1');
    expect(captured[2]!.sql).toContain('order by "vouchers"."created_at" desc, "vouchers"."id" desc');
    for (const i of [1, 2]) expect(captured[i]!.sql).not.toMatch(/source|subject|expiry|ended_at|dropped_at/);
  });
  test("a course after a course ⇒ prevCourseId (across programs); a voucher after a voucher ⇒ prevVoucherId", async () => {
    expect(await fc.conversionLinks(fakeTx([[], [{ id: "c1", createdAt: "2026-10-01T03:00:00Z" }], []]).tx, "s", "2026-11-08")).toEqual({ fromTrialBookingId: null, prevCourseId: "c1", prevVoucherId: null });
    expect(await fc.conversionLinks(fakeTx([[], [], [{ id: "v1", createdAt: "2026-10-01T03:00:00Z" }]]).tx, "s", "2026-11-08")).toEqual({ fromTrialBookingId: null, prevCourseId: null, prevVoucherId: "v1" });
  });
  test("a failing read FAILS the sale: no try/catch around the reads (the error reaches the caller)", async () => {
    const tx = { select: () => { throw new Error("read failed"); } };
    await expect(fc.conversionLinks(tx, "s", "2026-11-08")).rejects.toThrow("read failed");
    expect(code(await Bun.file(new URL("./first-coach.ts", import.meta.url)).text())).not.toMatch(/\btry\s*\{/);
  });
});

describe("🔴 TASK-860 — the links are written at the SALE only, in its own transaction, before the insert", () => {
  test("createCoursePackage and createVoucher each read the links ONCE with the primary child, before their insert, and spread them into it", () => {
    for (const [name, body, table] of [["course", CREATE_COURSE, "coursePackages"], ["voucher", CREATE_VOUCHER, "vouchers"]] as const) {
      expect(body.match(/conversionLinks\(tx, studentId, bangkokNow\(\)\.date\)/g)).toHaveLength(1);
      const read = body.indexOf("conversionLinks("), ins = body.indexOf(`.insert(${table})`);
      expect([name, read > 0 && read < ins]).toEqual([name, true]);
      expect(body.slice(ins, ins + 200)).toContain("...links");
    }
  });
  test("the DUO co-student gets no links: only `studentId` is passed, never `coStudentId`", () => {
    expect(CREATE_COURSE).not.toMatch(/conversionLinks\([^)]*coStudentId/);
  });
  test("an IMPORT writes no links: the two import inserts (source: \"IMPORT\") do not touch the links", () => {
    expect(code(SVC).match(/conversionLinks\(/g)).toHaveLength(2); // the two sales, nothing else
    for (const m of code(SVC).matchAll(/source: "IMPORT"/g)) {
      const around = code(SVC).slice(Math.max(0, m.index! - 1500), m.index! + 300);
      expect(around).not.toMatch(/\.\.\.links|fromTrialBookingId|prevCourseId|prevVoucherId/);
    }
  });
});

describe("🔴 TASK-860 — the first coach: the earliest ATTENDED row's own teacher, stamped at day-end", () => {
  test("pickFirstCoachRow: the earliest by (date, start time); a tie takes the lowest id; an empty list ⇒ null", () => {
    const rows = [T("b1", "2026-10-05", "10:00", "tB"), T("b2", "2026-10-05", "09:00", "tA"), T("b3", "2026-10-04", "17:00", "tC")]; // the earlier start has the HIGHER id on purpose
    expect(fc.pickFirstCoachRow(rows)!.teacherId).toBe("tC"); // the earlier DAY beats the earlier hour
    expect(fc.pickFirstCoachRow(rows.slice(0, 2))!.teacherId).toBe("tA"); // same day: the earlier start
    expect(fc.pickFirstCoachRow([T("z", "2026-10-05", "09:00", "tZ"), T("a", "2026-10-05", "09:00", "tA2")])!.id).toBe("a"); // tie ⇒ lowest id
    expect(fc.pickFirstCoachRow([T("a", "2026-10-05", "09:00", "tA2"), T("z", "2026-10-05", "09:00", "tZ")])!.id).toBe("a"); // …whatever the input order
    expect(fc.pickFirstCoachRow([])).toBeNull();
  });
  test("stampFirstCoach: ONE update … from per table — the first ATTENDED row (distinct on, ordered date, start_time, id), only where first_teacher_id IS NULL, the row's own teacher_id", async () => {
    const seen: string[] = [];
    const exec = { execute: async (q: any) => { seen.push(dialect.sqlToQuery(q).sql); return seen.length === 1 ? [{ id: "c1" }, { id: "c2" }] : [{ id: "v1" }]; } };
    expect(await fc.stampFirstCoach(exec)).toEqual({ courses: 2, vouchers: 1 });
    expect(seen).toHaveLength(2);
    for (const [i, t, key] of [[0, "course_packages", "course_id"], [1, "vouchers", "voucher_id"]] as const) {
      const q = seen[i]!.replace(/\s+/g, " ");
      expect(q).toContain(`update ${t}`);
      expect(q).toContain(`distinct on (${key}) ${key}, teacher_id from bookings where status = 'ATTENDED' and ${key} is not null order by ${key}, date, start_time, id`);
      expect(q).toContain("first_teacher_id is null");
      expect(q).not.toContain("booking_teachers"); // the additional teachers don't count
    }
  });
  test("a second run is a no-op: the update touches only rows still NULL, so nothing is returned (and nothing is overwritten)", async () => {
    const exec = { execute: async () => [] };
    expect(await fc.stampFirstCoach(exec)).toEqual({ courses: 0, vouchers: 0 });
  });
  test("the job runs it ONCE, after the statuses settle (after the auto-attend transaction, before the revenue posting)", () => {
    const body = JOBS.slice(JOBS.indexOf("export async function runEndOfDayJob"));
    expect(code(body).match(/stampFirstCoach\(db\)/g)).toHaveLength(1);
    const at = code(body).indexOf("stampFirstCoach(db)");
    expect(at).toBeGreaterThan(code(body).indexOf("const marked = await db.transaction"));
    expect(at).toBeLessThan(code(body).indexOf("const attended = await db"));
  });
});

describe("🔴 TASK-860 — a WHOLE-course teacher change is recorded; a time-only act and a cover are not", () => {
  const moves = [{ from: { teacherId: "tA" } }, { from: { teacherId: "tA" } }];
  test("isWholeCourseTeacherChange: a new teacher ⇒ true; the same teacher (time only) ⇒ false; any moved row with another coach ⇒ true", () => {
    expect(fc.isWholeCourseTeacherChange(moves, "tB")).toBe(true);
    expect(fc.isWholeCourseTeacherChange(moves, "tA")).toBe(false);
    expect(fc.isWholeCourseTeacherChange([{ from: { teacherId: "tA" } }, { from: { teacherId: "tB" } }], "tA")).toBe(true);
    expect(fc.isWholeCourseTeacherChange([], "tA")).toBe(false);
  });
  test("the act stamps coachChangedAt + latestTeacherId in the SAME update as the schedule move (a second change overwrites latest); nothing else in the service writes them (a cover writes nothing, Khwan 5A)", () => {
    expect(TIME_CHANGE).toContain("...(isWholeCourseTeacherChange(plan.moves, input.teacherId) ? { coachChangedAt: new Date(), latestTeacherId: input.teacherId } : {})");
    expect(code(SVC).match(/coachChangedAt/g)).toHaveLength(1);
    expect(code(SVC).match(/latestTeacherId/g)).toHaveLength(1);
  });
});

describe("🔴 TASK-860 — PUT /courses/:id/bonus100-pick: three refusals and one success", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterAll(() => { for (const s of spies) s.mockRestore(); });
  const stub = (row: any) => {
    const updates: any[] = [];
    spies.push(
      spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: async () => (row ? [row] : []) }) })) as any),
      spyOn(db, "update").mockImplementation((() => ({ set: (s: any) => ({ where: async () => { updates.push(s); } }) })) as any),
    );
    return updates;
  };
  const done = () => { for (const s of spies.splice(0)) s.mockRestore(); };
  test("no coach change ⇒ 409 NO_COACH_CHANGE, nothing written", async () => {
    const u = stub({ id: "c1", coachChangedAt: null, firstTeacherId: "tA", latestTeacherId: null });
    try { await expect(fc.setBonus100Pick("c1", "FIRST", "admin")).rejects.toMatchObject({ status: 409, code: "NO_COACH_CHANGE" }); expect(u).toEqual([]); } finally { done(); }
  });
  test("the latest coach is the first coach ⇒ 409 SAME_COACH, nothing written", async () => {
    const u = stub({ id: "c1", coachChangedAt: new Date(), firstTeacherId: "tA", latestTeacherId: "tA" });
    try { await expect(fc.setBonus100Pick("c1", "LATEST", "admin")).rejects.toMatchObject({ status: 409, code: "SAME_COACH" }); expect(u).toEqual([]); } finally { done(); }
  });
  test("no such course ⇒ 404 · a pick outside FIRST / LATEST / SHARE ⇒ 400 at the validator", async () => {
    stub(null);
    try { await expect(fc.setBonus100Pick("nope", "FIRST", "admin")).rejects.toMatchObject({ status: 404 }); } finally { done(); }
    for (const bad of ["first", "BOTH", "", undefined, 1]) expect(v.bonus100Pick.safeParse({ pick: bad }).success).toBe(false);
    for (const ok of ["FIRST", "LATEST", "SHARE"]) expect(v.bonus100Pick.safeParse({ pick: ok }).success).toBe(true);
  });
  test("success: stamps the pick, who (the actor) and when; a changed coach with a different latest teacher passes", async () => {
    const u = stub({ id: "c1", coachChangedAt: new Date(), firstTeacherId: "tA", latestTeacherId: "tB" });
    try {
      const r = await fc.setBonus100Pick("c1", "SHARE", "sober");
      expect(u).toHaveLength(1);
      expect(u[0]).toMatchObject({ bonus100Pick: "SHARE", bonus100PickBy: "sober" });
      expect(u[0].bonus100PickAt).toBeInstanceOf(Date);
      expect(r).toMatchObject({ id: "c1", bonus100Pick: "SHARE", bonus100PickBy: "sober" });
    } finally { done(); }
  });
  test("the route is wired under the same actor rule: validator, the actor from the token, the service in lib/first-coach", () => {
    expect(API).toContain('.put("/courses/:id/bonus100-pick", zValidator("json", v.bonus100Pick)');
    expect(API).toContain('firstCoach.setBonus100Pick(c.req.param("id"), c.req.valid("json").pick, actorOf(c))');
  });
});

describe("🔴 TASK-860 — the migration, the schema and the witness agree", () => {
  const courseCols = ["from_trial_booking_id", "prev_course_id", "prev_voucher_id", "first_teacher_id", "coach_changed_at", "latest_teacher_id", "bonus100_pick", "bonus100_pick_by", "bonus100_pick_at"];
  const voucherCols = ["from_trial_booking_id", "prev_course_id", "prev_voucher_id", "first_teacher_id"];
  test("every column is in the migration (nullable, IF NOT EXISTS) AND in the schema", () => {
    const [courseSql, voucherSql] = [MIG.slice(MIG.indexOf('ALTER TABLE "course_packages"'), MIG.indexOf('ALTER TABLE "vouchers"')), MIG.slice(MIG.indexOf('ALTER TABLE "vouchers"'), MIG.indexOf("-- at most ONE"))];
    for (const c of courseCols) { expect(courseSql).toContain(`ADD COLUMN IF NOT EXISTS "${c}"`); expect(SCHEMA).toContain(`"${c}"`); }
    for (const c of voucherCols) expect(voucherSql).toContain(`ADD COLUMN IF NOT EXISTS "${c}"`);
    expect(MIG.replace(/^--.*$/gm, "")).not.toMatch(/ADD COLUMN[^,;]*NOT NULL|DROP COLUMN|RENAME|\bINSERT\b|\bUPDATE\b/); // additive only, no data written
  });
  test("the FKs: trial/prev ⇒ SET NULL, teachers ⇒ RESTRICT", () => {
    expect(MIG.match(/"from_trial_booking_id" uuid REFERENCES "bookings"\("id"\) ON DELETE SET NULL/g)).toHaveLength(2);
    expect(MIG.match(/"prev_course_id" uuid REFERENCES "course_packages"\("id"\) ON DELETE SET NULL/g)).toHaveLength(2);
    expect(MIG.match(/"prev_voucher_id" uuid REFERENCES "vouchers"\("id"\) ON DELETE SET NULL/g)).toHaveLength(2);
    expect(MIG.match(/"(first|latest)_teacher_id" uuid REFERENCES "teachers"\("id"\) ON DELETE RESTRICT/g)).toHaveLength(3);
  });
  test("at most one previous entitlement (a CHECK per table), a closed pick set, one trial converts once per table (partial unique index, the LAST object = the witness)", () => {
    expect(MIG).toContain('CHECK ("prev_course_id" IS NULL OR "prev_voucher_id" IS NULL)');
    expect(MIG.match(/CHECK \("prev_course_id" IS NULL OR "prev_voucher_id" IS NULL\)/g)).toHaveLength(2);
    expect(MIG).toContain(`CHECK ("bonus100_pick" IS NULL OR "bonus100_pick" IN ('FIRST', 'LATEST', 'SHARE'))`);
    expect(MIG).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "course_from_trial_uq" ON "course_packages" ("from_trial_booking_id") WHERE "from_trial_booking_id" IS NOT NULL;');
    expect(MIG.trimEnd().endsWith('WHERE "from_trial_booking_id" IS NOT NULL;')).toBe(true);
    expect(MIG.trimEnd().split("\n").pop()).toContain('"voucher_from_trial_uq" ON "vouchers"');
    expect(SCHEMA).toContain('check("course_prev_one_chk"');
    expect(SCHEMA).toContain('check("voucher_prev_one_chk"');
    expect(SCHEMA).toContain('check("course_bonus100_pick_chk"');
  });
  test("registered: the journal entry (idx 74) and the witness probe on the LAST index", () => {
    expect(JOURNAL).toContain('"tag": "0074_conversion_links_first_coach"');
    expect(WITNESS).toContain('tag: "0074_conversion_links_first_coach"');
    expect(WITNESS).toContain('probe: { kind: "index", index: "voucher_from_trial_uq" }');
  });
});
