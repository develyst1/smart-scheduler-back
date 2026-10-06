// TASK-668 (TASK-644 piece B, second half) — LINK a parent to a child that has NONE: `POST /students/:id/parent { parentId }`.
// It may only ever go from NO parent to one, and that is enforced IN THE WRITE (`… AND parent_id IS NULL RETURNING id`; zero rows ⇒ 409).
// By VALUE, no database: `linkParentToStudent` takes its executor, so a fake executor answers every read and EVALUATES the real built
// conditions (read back through drizzle's `.toSQL()`) against fixture rows. Plus the route/key through the root app, and a SWEEP that
// derives every writer of `students.parent_id` from the source — so a future "move a child" breaks in plain sight.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const { db } = await import("../db");
const realSelect = db.select.bind(db); // taken BEFORE any spy: the fake reads the REAL condition back with it
const { bookings, students, bookingStatus } = await import("../db/schema");
const parent = await import("./parent.service");
const { bangkokNow } = await import("../lib/bangkok-time");
const { ROUTE_ACCESS } = await import("../lib/route-access");
const { ACTION_KEYS, MENU_KEYS } = await import("../lib/permissions");
const { DEV_USER } = await import("../middleware/auth");

const KEY = "action:people.parent-students";
const S1 = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P_OLD = "99999999-9999-4999-8999-999999999999";
const isoPlus = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const TODAY = bangkokNow().date;

// ── the fake executor ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
type StudentRow = { id: string; parentId: string | null; name: string };
type Booking = { studentId: string; coStudentId: string | null; date: string; startTime: string; status: string };
let STUDENT_ROWS: StudentRow[] = [];
let PARENT: { id: string; name: string | null; phone: string | null; archivedAt: Date | null } | null = null;
let KIDS: Array<{ id: string; name: string; nickname: string | null }> = [];
let BOOKINGS: Booking[] = [];
const log: { updates: Array<{ set: Record<string, unknown>; sql: string; matched: number }>; inserts: number; selectsOf: string[] } = { updates: [], inserts: 0, selectsOf: [] };
const reset = () => { STUDENT_ROWS = [{ id: S1, parentId: null, name: "Ari" }]; PARENT = { id: P1, name: "Mom", phone: "0812345678", archivedAt: null }; KIDS = []; BOOKINGS = []; log.updates = []; log.inserts = 0; log.selectsOf = []; };
reset();
const whereVal = (q: any) => q.where({ id: "id" }, { eq: (_c: unknown, v: string) => v }) as string;

function exec() {
  return {
    query: {
      students: { findFirst: async (q: any) => STUDENT_ROWS.find((s) => s.id === whereVal(q)) ?? undefined },
      parents: { findFirst: async (q: any) => (PARENT && PARENT.id === whereVal(q) ? PARENT : undefined) },
    },
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          let value: unknown[];
          if (table === students) { log.selectsOf.push("students"); value = KIDS; } // the family's children (cap + the confirm's list)
          else if (table === bookings) {
            log.selectsOf.push("bookings");
            const { sql, params } = (realSelect().from(bookings).where(cond as any) as any).toSQL();
            expect(sql).toContain('"bookings"."student_id" =');
            expect(sql).toContain('"bookings"."co_student_id" =');
            expect(sql).toContain('"bookings"."date" >=');
            expect(sql).toContain('"bookings"."status" in');
            const [id, , today, ...statuses] = params as string[]; // [id, id, today, ...statuses]
            value = BOOKINGS.filter((b) => (b.studentId === id || b.coStudentId === id) && b.date >= today && statuses.includes(b.status))
              .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
          } else throw new Error("UNEXPECTED SELECT");
          const t: any = { then: (ok: any, ko: any) => Promise.resolve(value).then(ok, ko), orderBy: () => t };
          return t;
        },
      }),
    }),
    update: (table: unknown) => {
      if (table !== students) throw new Error("UNEXPECTED UPDATE of another table");
      return {
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            returning: async (_cols: unknown) => {
              const { sql, params } = (realSelect().from(students).where(cond as any) as any).toSQL();
              const wantsNull = sql.includes('"students"."parent_id" is null'); // the REAL condition decides whether the guard is in the write
              const hit = STUDENT_ROWS.filter((s) => s.id === params[0] && (!wantsNull || s.parentId === null));
              log.updates.push({ set, sql: sql.slice(sql.indexOf(" where ")), matched: hit.length });
              for (const s of hit) Object.assign(s, set);
              return hit.map((s) => ({ id: s.id }));
            },
          }),
        }),
      };
    },
    insert: () => { log.inserts++; throw new Error("UNEXPECTED INSERT — the link sends no notice and writes nothing else"); },
  };
}
const outcome = async (fn: () => Promise<unknown>) => { try { return { ok: await fn() }; } catch (e: any) { return { err: { status: e?.status, code: e?.code, message: e?.message } }; } };
const kid = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, name: `Kid ${i}`, nickname: null }));
const link = (opts: { dryRun?: boolean } = {}) => parent.linkParentToStudent(S1, P1, opts, exec());

// ── the act ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("🔴 TASK-668 — the link, by value (real conditions, fake executor)", () => {
  test("a parentless child ⇒ LINKED: the row now holds the parent; ONE update, setting `parentId` and nothing else; the write carries `parent_id IS NULL`", async () => {
    reset(); KIDS = kid(2);
    expect(await outcome(link)).toEqual({ ok: { dryRun: false, linked: true, studentId: S1, parentId: P1, familyCount: 3 } });
    expect(STUDENT_ROWS[0]!.parentId).toBe(P1);
    expect(log.updates).toHaveLength(1);
    expect(log.updates[0]!.set).toEqual({ parentId: P1 });
    expect(log.updates[0]!.sql).toBe(' where ("students"."id" = $1 and "students"."parent_id" is null)');
  });
  test("🔴 a child that ALREADY has a parent ⇒ 409 STUDENT_ALREADY_HAS_PARENT, and the row is UNCHANGED (the guard is in the write, not in a read)", async () => {
    reset(); STUDENT_ROWS[0]!.parentId = P_OLD; KIDS = kid(1);
    const r = await outcome(link);
    expect(r).toEqual({ err: { status: 409, code: "STUDENT_ALREADY_HAS_PARENT", message: "นักเรียนคนนี้ผูกกับผู้ปกครองแล้ว — รีเฟรชหน้าเพื่อดูข้อมูลล่าสุด" } });
    expect(STUDENT_ROWS[0]!.parentId).toBe(P_OLD);
    expect(log.updates.map((u) => u.matched)).toEqual([0]); // the write WAS attempted and matched zero rows: the database decided
  });
  test("an ARCHIVED family ⇒ refused (PARENT_ARCHIVED), nothing written", async () => {
    reset(); PARENT!.archivedAt = new Date();
    expect(await outcome(link)).toEqual({ err: { status: 409, code: "PARENT_ARCHIVED", message: "ผู้ปกครองรายนี้ถูกเก็บแล้ว — คืนสถานะก่อน" } });
    expect(log.updates).toEqual([]);
  });
  test("a family at 5 children ⇒ refused with the cap's own sentence (linking a 6th is adding one), nothing written", async () => {
    reset(); KIDS = kid(5);
    expect(await outcome(link)).toEqual({ err: { status: 400, code: "VALIDATION", message: "เพิ่มนักเรียนได้สูงสุด 5 คนต่อเบอร์" } });
    expect(log.updates).toEqual([]);
    reset(); KIDS = kid(4); // …and 4 is fine: the 5th
    expect((await outcome(link)) as any).toMatchObject({ ok: { linked: true, familyCount: 5 } });
  });
  test("a missing STUDENT ⇒ 404; a missing PARENT ⇒ 404; nothing written", async () => {
    reset(); STUDENT_ROWS = [];
    expect(await outcome(link)).toEqual({ err: { status: 404, code: "NOT_FOUND", message: "ไม่พบนักเรียน" } });
    reset(); PARENT = null;
    expect(await outcome(link)).toEqual({ err: { status: 404, code: "NOT_FOUND", message: "ไม่พบผู้ปกครอง" } });
    expect(log.updates).toEqual([]);
  });
  test("🔑 the ORDER: 404 ⇒ archived ⇒ cap ⇒ the write — each earlier refusal wins over a later one", async () => {
    reset(); STUDENT_ROWS = []; PARENT = null; // both missing ⇒ the student first
    expect(((await outcome(link)) as any).err.message).toBe("ไม่พบนักเรียน");
    reset(); PARENT!.archivedAt = new Date(); KIDS = kid(5); // archived AND full ⇒ archived
    expect(((await outcome(link)) as any).err.code).toBe("PARENT_ARCHIVED");
    reset(); STUDENT_ROWS[0]!.parentId = P_OLD; KIDS = kid(5); // has a parent AND the family is full ⇒ the cap, not the 409 (the write is last)
    expect(((await outcome(link)) as any).err.message).toBe("เพิ่มนักเรียนได้สูงสุด 5 คนต่อเบอร์");
    expect(log.updates).toEqual([]);
  });
  test("🔴 it sends NO notice: the executor's `insert` is never called (no outbox row, no admin alert) and only `students` is ever updated", async () => {
    reset(); KIDS = kid(1);
    await outcome(link);
    expect(log.inserts).toBe(0);
    expect(log.updates).toHaveLength(1); // the fake throws on any other table
  });
  test("pinned by SOURCE too: the function mentions no outbox, no admin alert, no LINE push", () => {
    const body = region(PS, "export async function linkParentToStudent(", "\n}\n");
    expect(body).not.toMatch(/enqueueLine|notifyAdmins|notificationOutbox|pushMessage|outbox/i);
    expect(body).toContain("isNull(students.parentId)");
  });
});

// ── the confirm's read (dryRun) ────────────────────────────────────────────────────────────────────────────────────────────────────
describe("🔑 TASK-668 — `dryRun`: the confirm's read — same guards, NO write", () => {
  const b = (status: string, date: string, startTime = "10:00:00", who: "student" | "co" = "student"): Booking =>
    who === "student" ? { studentId: S1, coStudentId: null, date, startTime, status } : { studentId: "33333333-3333-4333-8333-333333333333", coStudentId: S1, date, startTime, status };
  test("returns the family, its children's NAMES and the child's upcoming OWED sessions (count + next date); the write never happens", async () => {
    reset(); KIDS = [{ id: "k1", name: "Ari", nickname: "Ari" }, { id: "k2", name: "Bee", nickname: null }];
    BOOKINGS = [b("CONFIRMED", isoPlus(TODAY, 9)), b("PAUSED", isoPlus(TODAY, 3), "11:00:00"), b("PENDING_RESCHEDULE", isoPlus(TODAY, 5))];
    expect(await outcome(() => link({ dryRun: true }))).toEqual({ ok: {
      dryRun: true,
      parent: { id: P1, name: "Mom", phone: "0812345678" },
      children: [{ id: "k1", name: "Ari", nickname: "Ari" }, { id: "k2", name: "Bee", nickname: null }],
      upcoming: { count: 3, next: isoPlus(TODAY, 3) },
    } });
    expect(log.updates).toEqual([]);
    expect(STUDENT_ROWS[0]!.parentId).toBeNull();
  });
  test("no upcoming sessions ⇒ count 0, next null; a family with no children ⇒ an empty list", async () => {
    reset();
    expect(((await outcome(() => link({ dryRun: true }))) as any).ok).toMatchObject({ children: [], upcoming: { count: 0, next: null } });
  });
  test("🔴 'upcoming' = EXACTLY the archive refusal's owed set: for every booking status, a future row counts iff it is in ARCHIVE_BLOCKING_STATUSES", async () => {
    for (const status of bookingStatus.enumValues) {
      reset(); BOOKINGS = [b(status, isoPlus(TODAY, 4))];
      const counted = ((await outcome(() => link({ dryRun: true }))) as any).ok.upcoming.count;
      expect({ status, counted }).toEqual({ status, counted: (parent.ARCHIVE_BLOCKING_STATUSES as readonly string[]).includes(status) ? 1 : 0 });
    }
  });
  test("a PAST row never counts; today counts; a DUO row where the child is the CO-student counts", async () => {
    reset(); BOOKINGS = [b("CONFIRMED", isoPlus(TODAY, -1)), b("CONFIRMED", TODAY), b("PAUSED", isoPlus(TODAY, 2), "10:00:00", "co")];
    expect(((await outcome(() => link({ dryRun: true }))) as any).ok.upcoming).toEqual({ count: 2, next: TODAY });
  });
  test("the same refusals as the act: archived · full · missing — and a child that already has a parent ⇒ 409 (advisory; the real write stays the authority)", async () => {
    reset(); PARENT!.archivedAt = new Date();
    expect(((await outcome(() => link({ dryRun: true }))) as any).err.code).toBe("PARENT_ARCHIVED");
    reset(); KIDS = kid(5);
    expect(((await outcome(() => link({ dryRun: true }))) as any).err.message).toBe("เพิ่มนักเรียนได้สูงสุด 5 คนต่อเบอร์");
    reset(); STUDENT_ROWS = [];
    expect(((await outcome(() => link({ dryRun: true }))) as any).err.status).toBe(404);
    reset(); STUDENT_ROWS[0]!.parentId = P_OLD;
    expect(((await outcome(() => link({ dryRun: true }))) as any).err.code).toBe("STUDENT_ALREADY_HAS_PARENT");
    expect(log.updates).toEqual([]);
  });
  test("pinned by SOURCE: the preview reads the SAME named set as the archive refusal", () => {
    const body = region(PS, "export async function linkParentToStudent(", "\n}\n");
    expect(body).toContain("inArray(bookings.status, [...ARCHIVE_BLOCKING_STATUSES])");
    expect(body).toContain("if (opts.dryRun) {");
  });
});

// ── the route and the key ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("🔴 TASK-668 — the route, through the ROOT app (service spied)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  const saved = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, saved); });
  const rootApp = async () => (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
  const post = async (path: string, body: unknown) => (await rootApp()).fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const setUser = (u: { isSuperAdmin: boolean; grants: Iterable<string>; teacherId?: string | null }) => { process.env.SKIP_AUTH = "true"; Object.assign(DEV_USER as any, { isSuperAdmin: u.isSuperAdmin, grants: new Set(u.grants), teacherId: u.teacherId ?? null }); };
  const calls: unknown[][] = [];
  const spy = () => { calls.length = 0; spies.push(spyOn(parent, "linkParentToStudent").mockImplementation((async (...a: unknown[]) => { calls.push(a); return { ok: true }; }) as any)); };
  const WITH_KEY = [...MENU_KEYS, ...ACTION_KEYS];
  const WITHOUT_KEY = [...MENU_KEYS, ...ACTION_KEYS.filter((k) => k !== KEY)];

  test("the route is mapped to the EXISTING key `action:people.parent-students` — the same one as adding a child to a family; no new key", () => {
    expect(ROUTE_ACCESS["POST /students/:id/parent"]).toEqual(ROUTE_ACCESS["POST /parents/:id/students"]);
    expect(ROUTE_ACCESS["POST /students/:id/parent"]!.action).toBe(KEY);
    expect(ACTION_KEYS.filter((k) => k.includes("parent-students"))).toEqual([KEY]);
  });
  test("with the key ⇒ 200 and the service gets (student path id, parentId, { dryRun }); `dryRun: true` is passed through", async () => {
    setUser({ isSuperAdmin: false, grants: WITH_KEY }); spy();
    expect((await post(`/students/${S1}/parent`, { parentId: P1 })).status).toBe(200);
    expect(calls.at(-1)).toEqual([S1, P1, { dryRun: undefined }]);
    expect((await post(`/students/${S1}/parent`, { parentId: P1, dryRun: true })).status).toBe(200);
    expect(calls.at(-1)).toEqual([S1, P1, { dryRun: true }]);
  });
  test("🔴 without the key ⇒ 403 and the service is never called; a LINKED teacher account ⇒ 403 SCOPE_TEACHER", async () => {
    setUser({ isSuperAdmin: false, grants: WITHOUT_KEY }); spy();
    const r = await post(`/students/${S1}/parent`, { parentId: P1 });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
    setUser({ isSuperAdmin: false, grants: WITH_KEY, teacherId: S1 });
    const t = await post(`/students/${S1}/parent`, { parentId: P1 });
    expect(t.status).toBe(403);
    expect(((await t.json()) as any).error.code).toBe("SCOPE_TEACHER");
    expect(calls).toEqual([]);
  });
  test("the body names ONLY the family: no `parentId` / a junk one / a non-uuid path id ⇒ 400, the service never called; a stray `from`/`studentId` key is ignored, never passed", async () => {
    setUser({ isSuperAdmin: true, grants: [] }); spy();
    expect((await post(`/students/${S1}/parent`, {})).status).toBe(400);
    expect((await post(`/students/${S1}/parent`, { parentId: "not-a-uuid" })).status).toBe(400);
    expect((await post(`/students/not-a-uuid/parent`, { parentId: P1 })).status).toBe(400);
    expect((await post(`/students/${S1}/parent`, { parentId: P1, dryRun: "yes" })).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await post(`/students/${S1}/parent`, { parentId: P1, fromParentId: P_OLD, studentId: "x" })).status).toBe(200);
    expect(calls.at(-1)).toEqual([S1, P1, { dryRun: undefined }]);
  });
});

// ── the writer sweep ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SRC_ROOT = resolve(import.meta.dir, "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const PRODUCT = walk(SRC_ROOT).filter((p) => p.endsWith(".ts") && !/\.(test|mutations)\.ts$/.test(p)).map((p) => relative(SRC_ROOT, p).replaceAll("\\", "/"));
const text = (rel: string) => readFileSync(join(SRC_ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "").replace(/\s\/\/\s.*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); if (a < 0) throw new Error(`region start missing: ${from}`); const b = s.indexOf(to, a + from.length); return s.slice(a, b < 0 ? undefined : b); };
const PS = code(text("services/parent.service.ts"));
/** Every `.insert(students)` / `.update(students)` statement in the product source that carries `parentId`, keyed `file → kind`. */
const writers = () => {
  const found: string[] = [];
  for (const rel of PRODUCT) {
    const s = code(text(rel));
    for (const m of s.matchAll(/\.(insert|update)\(\s*(?:schema\.)?students\s*\)/g)) {
      const stmt = s.slice(m.index!, s.indexOf(";", m.index!) < 0 ? undefined : s.indexOf(";", m.index!));
      // what the statement WRITES, not what it filters on: the `.set(…)` of an update (the parent-restore cascade's WHERE names
      // `parentId` and is not a write of it), the `.values(…)` of an insert.
      const written = m[1] === "update"
        ? stmt.slice(Math.max(stmt.indexOf(".set("), 0), stmt.includes(".where(") ? stmt.indexOf(".where(") : undefined)
        : stmt.slice(Math.max(stmt.indexOf(".values("), 0));
      if (/\bparentId\b/.test(written)) found.push(`${rel} ${m[1]}`);
    }
  }
  return found.sort();
};

describe("🔴 TASK-668 — the writer SWEEP: `students.parent_id` is written only by creation, the import exemption, the seed — and this act", () => {
  test("derived from the source: exactly these statements carry `parentId` (a future 'move a child' or 'unlink' appears here, in plain sight)", () => {
    expect(writers()).toEqual([
      "db/seed.ts insert", //                  the dev seed
      "services/parent.service.ts insert", //  createStudentForParent (a child created under a family)
      "services/parent.service.ts update", //  THIS act — linkParentToStudent, and nothing else
      "services/scheduler.service.ts insert", // resolveStudentId — the inline new student (booking path; the IMPORT exemption)
    ]);
  });
  test("…and the ONE update that sets `parentId` is this act's, with its guard in the same statement", () => {
    const body = region(PS, "export async function linkParentToStudent(", "\n}\n");
    expect(body).toContain(".set({ parentId })");
    expect(body).toContain(".where(and(eq(students.id, studentId), isNull(students.parentId)))");
    expect(body).toContain(".returning({ id: students.id })");
    expect(PS.match(/\.set\(\{ parentId/g)?.length).toBe(1);
  });
  test("the student EDIT can never move a child: its six-field allow-list does not hold `parentId`", () => {
    const edit = region(PS, "export async function updateStudent(", "\n}\n");
    expect(edit).toContain('for (const k of ["name", "nickname", "gender", "birthDate", "nationality", "note"] as const)');
    expect(edit).not.toMatch(/parentId|parent_id/);
  });
  test("no raw-SQL assignment of `parent_id` anywhere in the product source", () => {
    const hits = PRODUCT.filter((rel) => /\bparent_id\s*=|set\s+parent_id/i.test(code(text(rel))));
    expect(hits).toEqual([]);
  });
  test("the sweep sees the files it claims to (a harness guard: it cannot go quietly vacuous)", () => {
    expect(PRODUCT.length).toBeGreaterThan(100);
    for (const f of ["services/parent.service.ts", "services/scheduler.service.ts", "db/seed.ts"]) expect(PRODUCT).toContain(f);
  });
});
