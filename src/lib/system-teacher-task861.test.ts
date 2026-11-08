// 🔻 TASK-861 (REQ-120 F5) — the ONE system teacher "No Teacher": bookable only for OTHER, untouchable by every teacher write, and out of everything that measures, pays or messages a coach. No database: the migration by text, the guard and the
// writes through spied `db` calls, the exclusions by value where a fake read is cheap and by source where the read is deep. Each pin must fail when its line is removed (system-teacher-task861.mutations.json).
import { afterAll, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const st = await import("./system-teacher");
const svc = await import("../services/scheduler.service");
const calendarSvc = await import("../services/calendar.service");
const linkSvc = await import("../services/teacher-link.service");
const dailySvc = await import("../services/daily-report.service");
const campSvc = await import("../services/camp.service");
const jobs = await import("../services/jobs.service");
const lineLib = await import("./line");
const { toTeacherDTO } = await import("../db/mappers");
const { isSetupIncomplete, reconcileTeacherDrift } = await import("./ops-client");
const { readSrc } = await import("./read-src");

const file = async (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const MIG = await file("../../drizzle/0075_system_teacher.sql");
const JOURNAL = await file("../../drizzle/meta/_journal.json");
const WITNESS = await file("./migration-witness.ts");
const SCHEMA = await file("../db/schema.ts");
const SVC = code(readSrc(await file("../services/scheduler.service.ts")));
const OTHERSERIES = code(readSrc(await file("../services/other-series.service.ts")));
const SRC = async (p: string) => code(readSrc(await file(p)));

const SYS = { id: "sys-1", nickname: "No Teacher", name: "No Teacher", type: "FREELANCE", isSystem: true, active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], lineUserId: null };
const REAL = { id: "t-1", nickname: "Bank", name: "Bank", type: "FULL_TIME", isSystem: false, active: true, archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], lineUserId: "U1" };

describe("🔴 TASK-861 — the migration: one column, one idempotent row, the partial unique index LAST = the witness", () => {
  test("the column is NOT NULL DEFAULT false; the row is inserted ONLY WHERE NOT EXISTS (… is_system) — a re-run inserts nothing", () => {
    expect(MIG).toContain('ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "is_system" boolean NOT NULL DEFAULT false;');
    expect(MIG).toContain(`INSERT INTO "teachers" ("name", "nickname", "type", "active", "archived", "is_system")\nSELECT 'No Teacher', 'No Teacher', 'FREELANCE', true, false, true\nWHERE NOT EXISTS (SELECT 1 FROM "teachers" WHERE "is_system");`);
    expect(MIG.replace(/^--.*$/gm, "")).not.toMatch(/line_user_id|DELETE|TRUNCATE|DROP/); // line_user_id stays NULL; nothing destroyed
  });
  test("exactly one row may carry the flag (a partial unique index), and it is the LAST object of the file = the witness", () => {
    expect(MIG).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "teachers_one_system_uq" ON "teachers" ("is_system") WHERE "is_system";');
    expect(MIG.trimEnd().split("\n").pop()).toContain("teachers_one_system_uq");
    expect(JOURNAL).toContain('"tag": "0075_system_teacher"');
    expect(WITNESS).toContain('probe: { kind: "index", index: "teachers_one_system_uq" }');
  });
  test("the schema declares the column and the same index", () => {
    expect(SCHEMA).toContain('isSystem: boolean("is_system").notNull().default(false),');
    expect(SCHEMA).toContain('uniqueIndex("teachers_one_system_uq").on(t.isSystem).where(sql`${t.isSystem}`)');
  });
  test("the teacher DTO carries `isSystem` (default false) — the screens decide by the flag, never the name", () => {
    expect(toTeacherDTO({ ...SYS, teacherSubjects: [] }).isSystem).toBe(true);
    expect(toTeacherDTO({ ...REAL, isSystem: undefined, teacherSubjects: [] }).isSystem).toBe(false);
    expect(code(readSrc(JOURNAL))).not.toContain("No Teacher");
  });
});

describe("🔴 TASK-861 — the booking rule: ONLY an OTHER may use the system teacher; every other door refuses by default", () => {
  const exec = (row: any) => ({ query: { teachers: { findFirst: async () => row } } });
  test("a lesson / trial / course / voucher on the system teacher ⇒ 400 SYSTEM_TEACHER_NOT_BOOKABLE, with the approved archived-teacher sentence", async () => {
    await expect(svc.assertTeacherBookable(exec(SYS), SYS.id, "2026-11-10")).rejects.toMatchObject({ status: 400, code: "SYSTEM_TEACHER_NOT_BOOKABLE", message: "ครู No Teacher ถูกปิดการใช้งานแล้ว" });
    await expect(svc.assertTeacherBookable(exec(SYS), SYS.id, "2026-11-10", { allowLeave: true })).rejects.toMatchObject({ code: "SYSTEM_TEACHER_NOT_BOOKABLE" });
  });
  test("an OTHER (allowSystem) is accepted, and skips the workday / leave / FREELANCE-budget checks the system teacher has no data for", async () => {
    const e: any = exec({ ...SYS, workDays: [] }); // would be refused as «not working today» if the checks ran
    expect((await svc.assertTeacherBookable(e, SYS.id, "2026-11-10", { allowSystem: true })).id).toBe(SYS.id);
  });
  test("the mayUseSystemTeacher rule is `OTHER` and nothing else", () => {
    expect(["OTHER"].map(st.mayUseSystemTeacher)).toEqual([true]);
    for (const t of ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER", "GROUP", undefined, null, ""]) expect(st.mayUseSystemTeacher(t as any)).toBe(false);
  });
  test("a real teacher is unaffected (the flag is the only thing read)", async () => {
    const e: any = { query: { teachers: { findFirst: async () => REAL } }, select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
    expect((await svc.assertTeacherBookable(e, REAL.id, "2026-11-10", { allowLeave: true })).id).toBe(REAL.id);
  });
  test("by source: the inserter passes allowSystem ONLY for an OTHER; the booking-row doors (edit, swap, move, resume) pass it for an OTHER row; every other door passes NOTHING (group moves, additional coaches, the plan move, TASK-838's act)", () => {
    expect(SVC.match(/allowSystem: mayUseSystemTeacher\(input\.bookingType\)/g)).toHaveLength(2);
    expect(SVC.match(/allowSystem: mayUseSystemTeacher\((current|b)\.bookingType\)/g)).toHaveLength(4);
    expect(SVC.match(/allowSystem/g)).toHaveLength(8); // the option type · the guard · 2 inserter calls · 4 row-aware doors — and NOTHING else passes it
  });
  test("the refusing doors are pinned by their exact calls (no options): TASK-838's act, the start-date move, additional coaches, the two group-row moves", () => {
    for (const call of [
      "await assertTeacherBookable(tx, m.to.teacherId, m.to.date);",
      "if (m.from !== m.to) await assertTeacherBookable(tx, m.teacherId, m.to);",
      "await assertTeacherBookable(exec, teacherId, booking!.date);",
      "await assertTeacherBookable(tx, input.teacherId, g.date);",
      "await assertTeacherBookable(tx, input.teacherId, group.date);",
    ]) expect(SVC).toContain(call);
  });
  test("an OTHER series' primary may be the system teacher (a park-fee series); an EXTRA coach may not", () => {
    expect(OTHERSERIES).toContain("await assertTeacherBookable(tx, input.to, r.date, { allowSystem: !onExtra });");
  });
});

describe("🔴 TASK-861 — the system teacher cannot be edited, archived, paused, budgeted, linked to LINE, given a calendar feed, a work-day set or leave: 409 SYSTEM_TEACHER", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterAll(() => { for (const s of spies) s.mockRestore(); });
  const stub = () => {
    const writes: string[] = [];
    spies.push(
      spyOn(db.query.teachers, "findFirst").mockImplementation((async () => SYS) as any),
      spyOn(db.query.teacherLinkRequests, "findFirst").mockImplementation((async () => ({ id: "r1", teacherId: SYS.id, lineUserId: "Ux", status: "PENDING" })) as any),
      spyOn(db, "update").mockImplementation((() => { writes.push("update"); return { set: () => ({ where: async () => [] }) }; }) as any),
      spyOn(db, "insert").mockImplementation((() => { writes.push("insert"); return { values: async () => [] }; }) as any),
      spyOn(db, "delete").mockImplementation((() => { writes.push("delete"); return { where: async () => [] }; }) as any),
    );
    return writes;
  };
  const done = () => { for (const s of spies.splice(0)) s.mockRestore(); };
  const viewer: any = { isSuperAdmin: true, actions: [] };
  const refused = { status: 409, code: "SYSTEM_TEACHER", message: "ครู No Teacher ถูกปิดการใช้งานแล้ว" };
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["edit", () => svc.updateTeacher(SYS.id, { nickname: "x" }, viewer)],
    ["archive", () => svc.archiveTeacher(SYS.id, viewer)],
    ["reactivate", () => svc.reactivateTeacher(SYS.id, viewer)],
    ["budget", () => svc.setFreelanceBudget(SYS.id, { monthlyBudgetMinor: 1000, rateMinor: 100 }, viewer)],
    ["top-up", () => svc.topUpFreelanceBudget(SYS.id, 1000, viewer)],
    ["pause (availability)", () => svc.setAvailability({ teacherId: SYS.id, active: false })],
    ["work days", () => svc.setTeacherWorkDays(SYS.id, [1, 2])],
    ["limit override", () => svc.setLimitOverride(SYS.id, true)],
    ["calendar feed", () => calendarSvc.getOrCreateCalendarToken(SYS.id)],
    ["LINE unlink", () => linkSvc.unlinkTeacherLine(SYS.id)],
    ["LINE link (approve a request)", () => linkSvc.approveTeacherLinkRequest("r1", { teacherId: SYS.id })],
    ["leave (the admin door's guard)", () => st.assertTeacherMayHaveLeave(SYS.id)],
  ];
  for (const [name, run] of cases) {
    test(`${name} ⇒ 409 SYSTEM_TEACHER and nothing is written`, async () => {
      const writes = stub();
      try { await expect(run()).rejects.toMatchObject(refused); expect(writes).toEqual([]); } finally { done(); }
    });
  }
  test("a REAL teacher passes the same guard (assertNotSystemTeacher reads the flag only)", async () => {
    await expect(st.assertNotSystemTeacher({ query: { teachers: { findFirst: async () => REAL } } }, REAL.id)).resolves.toBeUndefined();
    await expect(st.assertNotSystemTeacher({ query: { teachers: { findFirst: async () => undefined } } }, "nope")).resolves.toBeUndefined(); // unknown ⇒ the caller's own not-found
  });
  test("a whole-TYPE pause never reaches the system teacher (the where carries `is_system = false`), by source", async () => {
    expect(SVC).toContain("await db.update(teachers).set({ active: input.active }).where(and(eq(teachers.type, input.type), eq(teachers.isSystem, false)));");
    expect(SVC).toContain("(t, { eq, and: a }) => a(eq(t.type, input.type), eq(t.isSystem, false))");
  });
  test("the admin leave route asks the guard FIRST, before the act (by source)", async () => {
    const API = await SRC("../routes/api.ts");
    const a = API.indexOf('.post("/teacher-leave-days"');
    const guard = API.indexOf("await assertTeacherMayHaveLeave(teacherId);", a);
    expect(guard).toBeGreaterThan(a);
    expect(guard).toBeLessThan(API.indexOf("svc.reportTeacherLeave(teacherId, input", a));
  });
  test("the user ⇄ teacher link refuses it (a sign-in identity is never the system teacher), and LINE nickname claims never match it — by source", async () => {
    expect(await SRC("../services/user.service.ts")).toContain("if (t.isSystem) throw SYSTEM_TEACHER(t.nickname);");
    const L = await SRC("../services/teacher-link.service.ts");
    expect(L.match(/\.from\(teachers\)\.where\(eq\(teachers\.isSystem, false\)\)/g)).toHaveLength(2);
  });
});

describe("🔴 TASK-861 — out of everything that measures, pays or messages a coach", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterAll(() => { for (const s of spies) s.mockRestore(); });
  const done = () => { for (const s of spies.splice(0)) s.mockRestore(); };

  test("the Daily Report: the system teacher is in NO byTeacher line and no hours total; its OTHER block still counts as a row; a real coach on the same day is untouched", async () => {
    const D = "2026-11-10";
    const rows = [
      { status: "CONFIRMED", bookingType: "OTHER", teacherId: SYS.id, teacher: { isSystem: true }, additionalTeachers: [], seats: [], campWeekDay: null },
      { status: "CONFIRMED", bookingType: "OTHER", teacherId: REAL.id, teacher: { isSystem: false }, additionalTeachers: [], seats: [], campWeekDay: null },
      { status: "CONFIRMED", bookingType: "COURSE_PACKAGE", teacherId: REAL.id, teacher: { isSystem: false }, additionalTeachers: [], seats: [], campWeekDay: null },
    ];
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => rows) as any), spyOn(campSvc, "weeksForCalendar").mockImplementation((async () => []) as any));
    try {
      const r: any = await dailySvc.getDailyReportContract(D);
      expect(r.byTeacher.map((t: any) => t.teacherId)).toEqual([REAL.id]);
      expect(r.byTeacher[0].total).toBe(2);
      expect((await dailySvc.getDailyReportContract(D, SYS.id) as any).byTeacher).toEqual([]); // nobody can ask for it as a coach
    } finally { done(); }
  });

  test("the SOM coach roster: the system teacher is not a coach — out of Coach Capacity (by source: the READ filters on the flag before it maps)", async () => {
    const S = await SRC("../services/som-contract.service.ts");
    expect(S).toContain("teachers: teachers.filter((t: any) => !t.isSystem).map((t: any) => ({");
  });

  test("the weekly teacher digest: no row, no skip line and no count for the system teacher; the real teacher is still sent", async () => {
    const week = (id: string, t: any) => ({ id, date: "2026-11-10", startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", bookingType: "OTHER", teacherId: t.id, teacher: t, subject: { name: "Park" }, student: null, coStudent: null, seats: [], additionalTeachers: [] });
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => [week("w1", { id: SYS.id, nickname: "No Teacher", lineUserId: null, isSystem: true }), week("w2", { id: REAL.id, nickname: "Bank", lineUserId: "U1", isSystem: false })]) as any));
    const sends: any[] = [];
    spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { sends.push(o); return { status: "queued" } as any; }) as any));
    spies.push(spyOn(db, "insert").mockImplementation((() => ({ values: async () => [] })) as any));
    try {
      const out = await jobs.runWeeklyTeacherDigestJob("2026-11-10");
      expect(sends.map((s) => s.recipientLineUserId)).toEqual(["U1"]);
      expect(out).toMatchObject({ teachers: 1, sent: 1, skipped: 0 });
    } finally { done(); }
  });

  test("the daily reminder drops the system teacher from the recipients; the day-end settles its OTHER rows like any OTHER (no teacher branch in the day-end) — by source", async () => {
    const J = await SRC("../services/jobs.service.ts");
    expect(J).toContain("teacherId: r.teacher?.isSystem ? null : (r.teacherId ?? null),");
    expect(J).not.toMatch(/runEndOfDayJob[\s\S]{0,6000}isSystem/); // the day-end has no teacher-system special case: its OTHER rows post like any OTHER
  });

  test("lesson availability never lists it; the money-setup checks never call it incomplete; the ops drift report never flags it", async () => {
    expect(SVC).toContain("a(eq(t.archived, false), eq(t.isSystem, false)), // 🔻 TASK-861 (REQ-120 F5): never in a lesson-availability answer");
    expect(SVC).toContain("!d.archived && !d.isSystem;");
    expect(SVC).toContain('teacher?.type === "FREELANCE" && !teacher.isSystem ?');
    expect(isSetupIncomplete({ id: "s", type: "FREELANCE", isSystem: true }, new Set(), new Set())).toBe(false);
    expect(isSetupIncomplete({ id: "f", type: "FREELANCE" }, new Set(), new Set())).toBe(true);
    const drift = reconcileTeacherDrift([{ id: "s", archived: false, type: "FREELANCE", isSystem: true }, { id: "f", archived: false, type: "FREELANCE" }], new Set(), new Set(), new Set());
    expect(drift.missingParty).toEqual(["f"]);
  });

  test("attention: no item about it (the loader drops it); badge breakdown: no «No Teacher» line; camp: never a camp coach (400 SYSTEM_TEACHER_NOT_BOOKABLE)", async () => {
    expect(await SRC("../services/attention.service.ts")).toContain("rows.filter((t) => !t.isSystem)");
    expect(await SRC("../services/badge.service.ts")).toContain(".where(and(inRange, eq(teachers.isSystem, false)))");
    const C = await SRC("../services/camp.service.ts");
    expect(C).toContain("if (sys?.isSystem) throw SYSTEM_TEACHER_NOT_BOOKABLE(sys.nickname);");
    expect(C.indexOf("SYSTEM_TEACHER_NOT_BOOKABLE(sys.nickname)")).toBeLessThan(C.indexOf(".insert(campWeekDayTeachers)"));
  });
});
