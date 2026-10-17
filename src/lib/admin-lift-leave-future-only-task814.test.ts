// TASK-814 (REQ-123 §4, BE half) — the admin's `DELETE /teacher-leave-days/:teacherId/:date` lifts a FUTURE leave day ONLY. Before: the door had no date check, so one call could delete a today/past row
// (whose classes were already cancelled and families told). Now it asks THE predicate the record door and the act fork on (`isAdvanceLeave`), at the route, BEFORE the lift.
// Pinned by value through the ROOT app: future ⇒ 200 + the row gone + `teacherNotified`; today / past ⇒ 400, the row KEPT, the teacher not told; and in NEITHER case does a booking row change.
// The teacher's own lift (`/teachers/me/leave/:date`) is unchanged. The refusal WORDING is the owner's APPROVED text (2026-10-17), pinned verbatim.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import * as lineLib from "./line";
import * as ownScope from "./own-scope";
import { db } from "../db";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const API = code(readSrc(readFileSync(resolve(root, "src/routes/api.ts"), "utf8")).replace(/\r\n/g, "\n"));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); delete process.env.SKIP_AUTH; });
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const del = async (path: string) => {
  const res = await rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "DELETE" }));
  return { status: res.status, body: (await res.json()) as any };
};
const T = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-10-17", PAST = "2026-10-10", TOMORROW = "2026-10-18", FUTURE = "2026-10-24";
const APPROVED_TH = "ยกเลิกได้เฉพาะวันลาล่วงหน้า (วันถัดไปเป็นต้นไป) — วันลาของวันนี้หรือวันที่ผ่านมาแล้วยกเลิกไม่ได้"; // the owner's text, 2026-10-17 (COPY-REVIEW-2026-09-29.md)
const trip = (what: string) => () => { throw new Error(`TASK-814 tripwire: ${what}`); };

/** The leave table in memory; the notice captured; nothing that could touch a booking is reachable. */
const arm = () => {
  const rows: any[] = [PAST, TODAY, TOMORROW, FUTURE].map((date, i) => ({ id: `l-${i}`, teacherId: T, date, reason: "ลา", createdBy: "x" }));
  const sent: any[] = [];
  const deleted: string[] = [];
  setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
  process.env.SKIP_AUTH = "true";
  spies.push(spyOn(db, "delete").mockImplementation(((t: any) => ({ where: () => ({ returning: async () => {
    expect(getTableName(t)).toBe("teacher_leave_days");
    deleted.push("call");
    return [{ id: "gone" }];
  } }) })) as any));
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: T, nickname: "Ek", lineUserId: "U-ek" })) as any));
  spies.push(spyOn(lineLib, "enqueueLine").mockImplementation((async (o: any) => { sent.push(o); return { status: "queued" } as any; }) as any));
  // 🚫 nothing in a lift may touch a booking: no update, no insert, no transaction, no booking read
  spies.push(spyOn(db, "update").mockImplementation(trip("a lift updated a row") as any));
  spies.push(spyOn(db, "insert").mockImplementation(trip("a lift inserted a row") as any));
  spies.push(spyOn(db, "transaction").mockImplementation(trip("a lift opened a transaction") as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation(trip("a lift read bookings") as any));
  return { rows, sent, deleted };
};

describe("🔴 TASK-814 — the admin LIFT door, through the ROOT app: future only", () => {
  for (const [label, date] of [["tomorrow", TOMORROW], ["a later week", FUTURE]] as const) {
    test(`✅ ${label} ⇒ 200, the row is deleted, the teacher is told once (teacherNotified 1)`, async () => {
      const { sent, deleted } = arm();
      const r = await del(`/teacher-leave-days/${T}/${date}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ lifted: date, teacherNotified: 1 });
      expect(deleted).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ recipientType: "teacher", payload: { kind: "teacher_leave_lifted", date } });
    });
  }
  for (const [label, date] of [["TODAY", TODAY], ["a PAST day", PAST]] as const) {
    test(`🔴 ${label} ⇒ 400, the row is KEPT (no delete), the teacher is NOT told, no booking row changes`, async () => {
      const { sent, deleted } = arm();
      const r = await del(`/teacher-leave-days/${T}/${date}`);
      expect(r.status).toBe(400);
      expect(deleted).toEqual([]); // 🔑 the refusal is BEFORE the lift — not a rollback
      expect(sent).toEqual([]);
    });
  }
  test("📋 the refusal is the owner's APPROVED Thai text, verbatim — and carries no «copy pending» marker", async () => {
    arm();
    const r = await del(`/teacher-leave-days/${T}/${TODAY}`);
    expect(r.body.error.message).toBe(APPROVED_TH);
    expect(JSON.stringify(r.body)).not.toContain("copy pending");
  });
  test("an unknown FUTURE day is still the approved 404 (the lift's own answer), not the new refusal", async () => {
    arm();
    spies.push(spyOn(db, "delete").mockImplementation((() => ({ where: () => ({ returning: async () => [] }) })) as any));
    const r = await del(`/teacher-leave-days/${T}/${FUTURE}`);
    expect(r.status).toBe(404);
  });
});

describe("🔑 TASK-814 — ONE predicate, at the route; the teacher's own lift is untouched", () => {
  const at = API.indexOf('.delete("/teacher-leave-days/:teacherId/:date"');
  const DOOR = API.slice(at, API.indexOf("\n  })", at));
  test("the door asks `isAdvanceLeave` on the path's date — 🚫 not a second date comparison — and BEFORE the lift", () => {
    expect(at).toBeGreaterThan(0);
    expect(DOOR).toContain('if (!isAdvanceLeave(c.req.valid("param").date)) throw badRequest(LIFT_FUTURE_ONLY_MESSAGE);');
    expect(DOOR).not.toMatch(/new Date\(|> *today|Date\.parse/);
    expect(DOOR.indexOf("isAdvanceLeave")).toBeLessThan(DOOR.indexOf("svc.liftTeacherLeave"));
    expect(DOOR).toContain('svc.liftTeacherLeave(c.req.valid("param").teacherId, c.req.valid("param").date, { onBehalf: true })');
  });
  test("the message is declared ONCE, below the import block (not between two imports), as the approved text", () => {
    expect([...API.matchAll(/const LIFT_FUTURE_ONLY_MESSAGE = /g)]).toHaveLength(1);
    expect(API).toContain(`const LIFT_FUTURE_ONLY_MESSAGE = "${APPROVED_TH}";`);
    const at = API.indexOf("const LIFT_FUTURE_ONLY_MESSAGE");
    const lastImport = [...API.matchAll(/^import .*$/gm)].map((m) => m.index!).pop()!;
    expect(at).toBeGreaterThan(lastImport);
    expect(API).not.toContain("COPY_PENDING");
  });
  test("the teacher's OWN lift keeps working on its own door — no date check there (a same-day own lift is not this task)", () => {
    const own = API.slice(API.indexOf('.delete("/teachers/me/leave/:date"'), API.indexOf('.delete("/teachers/me/leave/:date"') + 400);
    expect(own).toContain('svc.liftOwnLeave(assertLinked(c.get("user")), c.req.valid("param").date)');
    expect(own).not.toContain("isAdvanceLeave");
  });
  test("by value: the teacher's own lift of a day still goes through (the admin guard is not on it)", async () => {
    const { deleted } = arm();
    spies.push(spyOn(ownScope, "assertLinked").mockImplementation((() => T) as any));
    const r = await del(`/teachers/me/leave/${TODAY}`);
    expect(r.status).toBe(200);
    expect(deleted).toHaveLength(1);
  });
});
