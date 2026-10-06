// TASK-667 (Porter, 2026-10-06) — the archive refusal answers ONE question: "does this record still OWE somebody a class?"
// Live (PENDING · CONFIRMED · EXTENDED) + a move awaiting the parent (PENDING_RESCHEDULE) + a hold (PAUSED) ⇒ refused;
// SICK_LEAVE / CANCELLED ⇒ allowed; a PAST row never counts. By VALUE, no database: `db.select` is answered by a fake that
// EVALUATES the real built condition (read back through drizzle's `.toSQL()`) against fixture rows, so the REAL refusal path —
// the student's and the parent's — runs over the REAL condition.
import { afterEach, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const { bookings, students } = await import("../db/schema");
const realSelect = db.select.bind(db); // taken BEFORE any spy, so the fake can read the real condition back
const parent = await import("./parent.service");
const { COURSE_LIVE_STATUSES } = await import("../lib/course-plan");
const { bangkokNow } = await import("../lib/bangkok-time");

const S1 = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const isoPlus = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const TODAY = bangkokNow().date;
const FUTURE = isoPlus(TODAY, 7);
const PAST = isoPlus(TODAY, -7);

type Row = { studentId: string; coStudentId: string | null; date: string; status: string };
let ROWS: Row[] = [];
const seen: string[] = [];

/** The bookings count, computed from the REAL condition: `(studentId in ids or coStudentId in ids) and date >= today and status in (…)`. */
function evalCount(cond: unknown): number {
  const { sql, params } = (realSelect().from(bookings).where(cond as any) as any).toSQL();
  seen.push(sql.slice(sql.indexOf(" where ")));
  expect(sql).toContain('"bookings"."student_id" in');
  expect(sql).toContain('"bookings"."co_student_id" in');
  expect(sql).toContain('"bookings"."date" >=');
  expect(sql).toContain('"bookings"."status" in');
  // params are [...ids (student), ...ids (co-student), today, ...statuses]
  const ids = new Set<string>(); let i = 0;
  while (typeof params[i] === "string" && /^[0-9a-f-]{36}$/.test(params[i])) ids.add(params[i++]);
  const today = params[i++] as string; // ids appear twice (student, co-student); the Set already holds them
  if (/^[0-9a-f-]{36}$/.test(today)) throw new Error("unexpected param order");
  const statuses = new Set(params.slice(i) as string[]);
  return ROWS.filter((r) => (ids.has(r.studentId) || (r.coStudentId !== null && ids.has(r.coStudentId))) && r.date >= today && statuses.has(r.status)).length;
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); ROWS = []; seen.length = 0; });
function fakeDb(kids: Array<{ id: string }> = [{ id: S1 }]) {
  spies.push(spyOn(db, "select").mockImplementation(((..._a: unknown[]) => ({
    from: (table: unknown) => ({
      where: (cond: unknown) => {
        const value = table === bookings ? [{ n: evalCount(cond) }] : table === students ? kids : [];
        const thenable: any = { then: (ok: any, ko: any) => Promise.resolve(value).then(ok, ko), orderBy: () => thenable };
        return thenable;
      },
    }),
  })) as any));
  spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: S1, archivedAt: null, parentId: P1 })) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => ({ id: P1, archivedAt: null })) as any));
  // Past the refusal = the WRITE starts. Neither write is wanted here: a sentinel proves the refusal let it through.
  spies.push(spyOn(db, "update").mockImplementation((() => { throw new Error("ALLOWED"); }) as any));
  spies.push(spyOn(db, "transaction").mockImplementation((async () => { throw new Error("ALLOWED"); }) as any));
}
const row = (status: string, date = FUTURE, who: "student" | "co" = "student"): Row =>
  who === "student" ? { studentId: S1, coStudentId: null, date, status } : { studentId: "33333333-3333-4333-8333-333333333333", coStudentId: S1, date, status };

const outcome = async (fn: () => Promise<unknown>) => {
  try { await fn(); return "ALLOWED?"; } catch (e: any) { return e?.message === "ALLOWED" ? "allowed" : e?.code ?? e?.message; }
};

const REFUSED = ["PENDING", "CONFIRMED", "EXTENDED", "PENDING_RESCHEDULE", "PAUSED"];
const ALLOWED = ["SICK_LEAVE", "CANCELLED"];

describe("🔴 TASK-667 — archiving a STUDENT: refused exactly when a class is still OWED", () => {
  for (const s of REFUSED) test(`a future ${s} ⇒ 409 STUDENT_HAS_LIVE_SESSIONS`, async () => {
    fakeDb(); ROWS = [row(s)];
    expect(await outcome(() => parent.archiveStudent(S1, "admin"))).toBe("STUDENT_HAS_LIVE_SESSIONS");
  });
  for (const s of ALLOWED) test(`a future ${s} ⇒ allowed (not owed)`, async () => {
    fakeDb(); ROWS = [row(s)];
    expect(await outcome(() => parent.archiveStudent(S1, "admin"))).toBe("allowed");
  });
  test("a PAST PENDING_RESCHEDULE ⇒ allowed (the date rule unchanged)", async () => {
    fakeDb(); ROWS = [row("PENDING_RESCHEDULE", PAST)];
    expect(await outcome(() => parent.archiveStudent(S1, "admin"))).toBe("allowed");
  });
  test("a future PAUSED on a DUO row where the child is the CO-student ⇒ refused (TASK-420 unchanged)", async () => {
    fakeDb(); ROWS = [row("PAUSED", FUTURE, "co")];
    expect(await outcome(() => parent.archiveStudent(S1, "admin"))).toBe("STUDENT_HAS_LIVE_SESSIONS");
  });
  test("the refusal sentence counts the owed rows (unchanged wording)", async () => {
    fakeDb(); ROWS = [row("PENDING_RESCHEDULE"), row("PAUSED"), row("CONFIRMED"), row("SICK_LEAVE"), row("CANCELLED")];
    await expect(parent.archiveStudent(S1, "admin")).rejects.toMatchObject({ status: 409, code: "STUDENT_HAS_LIVE_SESSIONS", message: "มีคาบเรียนข้างหน้า 3 คาบ — ยกเลิก/ย้ายก่อน" });
  });
});

describe("🔴 TASK-667 — archiving a PARENT (the whole household): the same owed set", () => {
  for (const s of REFUSED) test(`a future ${s} on a child ⇒ 409 PARENT_HAS_SESSIONS`, async () => {
    fakeDb(); ROWS = [row(s)];
    expect(await outcome(() => parent.archiveParent(P1, "admin"))).toBe("PARENT_HAS_SESSIONS");
  });
  for (const s of ALLOWED) test(`a future ${s} ⇒ allowed`, async () => {
    fakeDb(); ROWS = [row(s)];
    expect(await outcome(() => parent.archiveParent(P1, "admin"))).toBe("allowed");
  });
  test("a PAST PENDING_RESCHEDULE ⇒ allowed", async () => {
    fakeDb(); ROWS = [row("PENDING_RESCHEDULE", PAST)];
    expect(await outcome(() => parent.archiveParent(P1, "admin"))).toBe("allowed");
  });
});

describe("the set itself — named, and `COURSE_LIVE_STATUSES` untouched (it drives the plan and the badge)", () => {
  test("ARCHIVE_BLOCKING_STATUSES = the live set + PENDING_RESCHEDULE + PAUSED, and nothing else", () => {
    expect([...parent.ARCHIVE_BLOCKING_STATUSES]).toEqual(["PENDING", "CONFIRMED", "EXTENDED", "PENDING_RESCHEDULE", "PAUSED"]);
  });
  test("COURSE_LIVE_STATUSES is still exactly PENDING · CONFIRMED · EXTENDED", () => {
    expect([...COURSE_LIVE_STATUSES]).toEqual(["PENDING", "CONFIRMED", "EXTENDED"]);
  });
  test("the fake really read the real condition (a guard on this test's own harness)", async () => {
    fakeDb(); ROWS = [row("CONFIRMED")];
    await outcome(() => parent.archiveStudent(S1, "admin"));
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('"bookings"."status" in');
  });
});
