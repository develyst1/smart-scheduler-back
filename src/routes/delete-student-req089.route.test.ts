// TASK-364 (`REQ-089 item 3`) — `DELETE /students/:id`: a student with NO history (no course / booking / voucher
// row, ANY status) is hard-deleted; one with history answers `409 STUDENT_HAS_HISTORY` with the counts in the
// Thai sentence. The rule is pure (`studentHistoryRefusal`) so every DoD case is asserted with values; the route
// is exercised with the service spied (the queries are deploy smoke, as for the other people routes).
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.SKIP_AUTH = "true";

const parent = await import("../services/parent.service");
// The ROOT app, not the `api` sub-app: the envelope on a thrown refusal is `onError`'s, and `onError` lives in
// `index.ts` — so this is the body the FE actually receives.
const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const del = (id: string) => app.fetch(new Request(`http://localhost/api/students/${id}`, { method: "DELETE" }));
const { ApiException } = await import("../lib/http");

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
};

describe("🔑 the rule — pure, with values (DoD)", () => {
  test("zero history ⇒ no refusal ⇒ deleted (a suspended family or a walk-in makes no difference: the rule is the three counts)", () => {
    expect(parent.studentHistoryRefusal({ courses: 0, bookings: 0, vouchers: 0 })).toBeNull();
  });

  test("one cancelled booking is history ⇒ 409 STUDENT_HAS_HISTORY with the counts in the sentence", () => {
    const e = parent.studentHistoryRefusal({ courses: 0, bookings: 1, vouchers: 0 })!;
    expect(e).toBeInstanceOf(ApiException);
    expect(e.status).toBe(409);
    expect(e.code).toBe("STUDENT_HAS_HISTORY");
    expect(e.message).toBe("มีประวัติ: คอร์ส 0 · คาบ 1 · บัตร 0 — ระงับแทน");
  });

  test("every table counts on its own — a course alone, a voucher alone", () => {
    expect(parent.studentHistoryRefusal({ courses: 2, bookings: 0, vouchers: 0 })!.message).toContain("คอร์ส 2");
    expect(parent.studentHistoryRefusal({ courses: 0, bookings: 0, vouchers: 3 })!.message).toContain("บัตร 3");
    expect(parent.studentHistoryRefusal({ courses: 1, bookings: 8, vouchers: 1 })!.message).toBe("มีประวัติ: คอร์ส 1 · คาบ 8 · บัตร 1 — ระงับแทน");
  });
});

describe("🔑 the route — `DELETE /students/:id`, the app's envelope on every door", () => {
  const calls: Array<[string, string | null]> = [];
  const spy = spyOn(parent, "deleteStudent").mockImplementation((async (id: string, actor: string | null) => {
    calls.push([id, actor]);
    if (id === "gone") return { deleted: true as const };
    if (id === "busy") throw parent.studentHistoryRefusal({ courses: 1, bookings: 2, vouchers: 0 });
    throw new ApiException(404, "NOT_FOUND", "ไม่พบนักเรียน");
  }) as any);
  afterAll(() => spy.mockRestore());

  test("200 { deleted: true }", async () => {
    const res = await del("gone");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(calls.at(-1)).toEqual(["gone", "dev"]); // the actor is the TOKEN's `sub` (SKIP_AUTH's default admin); no body is read
  });

  test("409 — the sentence the FE shows, in `{ error: { code, message } }`", async () => {
    const res = await del("busy");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "STUDENT_HAS_HISTORY", message: "มีประวัติ: คอร์ส 1 · คาบ 2 · บัตร 0 — ระงับแทน" } });
  });

  test("404 unknown", async () => {
    const res = await del("nobody");
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("NOT_FOUND");
  });
});

describe("🔴 the service — count → refuse or delete in ONE transaction; the FK is mapped, never raw (source)", () => {
  const SVC = code(src("src/services/parent.service.ts"));
  const DEL = region(SVC, "export async function deleteStudent(", "export async function setParentSuspended(");
  const CNT = region(SVC, "export async function countStudentHistory(", "export async function deleteStudent(");

  test("the three tables are counted with NO status filter — a cancelled booking is history", () => {
    for (const t of ["coursePackages", "bookings", "vouchers"]) expect(CNT).toContain(`rows(${t})`);
    expect(CNT).toContain("where(eq(table.studentId, studentId))");
    expect(CNT).not.toContain("status");
  });

  test("one transaction: find → count → refuse or hard delete; no soft-delete column exists on `students`", () => {
    expect(DEL).toContain("db.transaction(async (tx) =>");
    expect(DEL).toContain("countStudentHistory(id, tx)");
    expect(DEL).toContain("if (refusal) throw refusal;");
    expect(DEL).toContain("tx.delete(students).where(eq(students.id, id))");
    const SCHEMA = code(region(src("src/db/schema.ts"), 'export const students = pgTable(\n  "students",', "export const teachers"));
    expect(SCHEMA).not.toMatch(/deletedAt|suspendedAt/);
  });

  test("🔑 the restrict error (23503) is caught in the SERVICE and re-said as the same 409 — `onError` would render it 400 VALIDATION", () => {
    expect(DEL).toContain('if (pgErrorCode(e) !== "23503") throw e;');
    expect(DEL).toContain("throw studentHistoryRefusal(await countStudentHistory(id))");
    expect(DEL).toContain('conflict("STUDENT_HAS_HISTORY"');
    // …and the global mapping is untouched: it is still the 400 it always was, for every OTHER 23503.
    expect(code(src("src/index.ts"))).toContain('if (code === "23503") {\n    return c.json({ error: { code: "VALIDATION", message: "ข้อมูลอ้างอิงไม่ถูกต้อง" } }, 400);');
  });

  test("audit is one log line with actor + name, not a table; the parent's count is LIVE so the slot frees itself", () => {
    expect(DEL).toContain("console.info(`student deleted: ${gone.id} \"${gone.name}\" parent=${gone.parentId ?? \"walk-in\"} by ${actor ?? \"unknown\"}`)");
    const CAP = region(SVC, "export async function assertCanAddStudent(", "export async function createStudentForParent(");
    expect(CAP).toContain("await listStudentsOfParent(parentId, exec)"); // counted at the moment of asking
  });

  test("the route exists, takes the actor from the TOKEN, and `api.ts` now says why this one delete exists", () => {
    const API = src("src/routes/api.ts");
    expect(code(API)).toContain('.delete("/students/:id", async (c) =>\n    c.json(await parent.deleteStudent(c.req.param("id"), actorOf(c))),');
    expect(API).toContain("Nothing is ever deleted; suspend is the off switch —\n  // EXCEPT a student with NO history (TASK-364, REQ-089 item 3)");
  });
});
