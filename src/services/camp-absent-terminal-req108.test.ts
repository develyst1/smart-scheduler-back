// TASK-480 — 🔴 ABSENT is terminal to every SCAN; ABSENT → ATTENDED stays legal for an ADMIN.
// Through EACH door that can reach the camp scan, by value: the answer is the neutral "already", the day is still ABSENT
// afterwards, and nothing is written (so `usedUnits` cannot move). Then the admin's correction, through the real `markDay`.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as campSvc from "./camp.service";
import * as parentSvc from "./parent.service";
import * as duo from "../lib/duo-course";
import { campScanOutcome } from "../lib/camp";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const src = (f: string) => code(readSrc(readFileSync(resolve(root, f), "utf8")));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const TODAY = "2026-09-25";
const DAY = "33333333-3333-4333-8333-333333333333";
const absentDay = { id: DAY, date: TODAY, status: "ABSENT", half: "FULL", units: 2, campPackageId: "cp1", campWeekId: "w1", checkinToken: "ctoken-123456", checkinTokenExpiresAt: new Date(`${TODAY}T23:59:59+07:00`), undoReason: null, markedBy: "coach-kk", package: { studentId: "s1", student: { id: "s1", name: "Feen Full", nickname: "Feen" } } };

/** The DB, faked; every WRITE recorded — the proof that a scan changed nothing is that there were no writes at all. */
const campWorld = () => {
  const writes: any[] = [];
  const marks: any[] = [];
  spies.push(spyOn(db.query.campDays, "findFirst").mockImplementation((async () => ({ ...absentDay })) as any));
  spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async (q: any) => {
    // honour the status the caller asks for (the shop-front lookup asks for PLANNED)
    const asked = q?.where?.({ date: "date", status: "status", campPackageId: "campPackageId" }, { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => ({ [c]: v }) });
    const status = [asked].flat().find((c: any) => c && "status" in c)?.status;
    return status && status !== absentDay.status ? [] : [{ ...absentDay, week: { id: "w1", name: "Camp W1" } }];
  }) as any));
  spies.push(spyOn(db.query.campPackages, "findFirst").mockImplementation((async () => ({ id: "cp1", studentId: "s1", totalUnits: 10, usedUnits: 4, createdAt: new Date("2026-09-01T00:00:00Z") })) as any));
  spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: "s1", parentId: null })) as any)); // the suspension read: a walk-in
  spies.push(spyOn(db, "update").mockImplementation(((t: any) => { writes.push(t); return { set: () => ({ where: async () => {} }) }; }) as any));
  spies.push(spyOn(campSvc, "markDay").mockImplementation((async (...a: any[]) => { marks.push(a); return { package: { days: [], totalUnits: 10, usedUnits: 4 } }; }) as any));
  setSystemTime(new Date(`${TODAY}T11:00:00+07:00`));
  return { writes, marks };
};
const post = (path: string, body: unknown) => rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body) }));

describe("🔴 the pure rule — ABSENT answers 'already', exactly as ATTENDED does", () => {
  test("ABSENT ⇒ already · ATTENDED ⇒ already · PLANNED ⇒ attend", () => {
    const now = new Date(`${TODAY}T11:00:00+07:00`);
    expect(["ABSENT", "ATTENDED", "PLANNED"].map((status) => campScanOutcome({ status, date: TODAY, checkinTokenExpiresAt: absentDay.checkinTokenExpiresAt }, TODAY, now))).toEqual(["already", "already", "attend"]);
  });
});

describe("🔴 DOOR 1 — the roster QR link (`POST /api/checkin/camp`): the neutral 'already', the day still ABSENT, nothing written", () => {
  test("by value", async () => {
    const w = campWorld();
    const r = await post("/checkin/camp", { token: "ctoken-123456" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.already).toBe(true);
    expect(body.day.status).toBe("ABSENT"); // STILL absent after the call
    expect(w.marks).toEqual([]); // markDay never reached
    expect(w.writes).toEqual([]); // no write at all ⇒ usedUnits cannot have moved
    expect(body.credit).toEqual({ remainingDays: 3, totalDays: 5 }); // 10 units total, 4 used — unchanged (2 units = 1 day)
  });
});

describe("🔴 DOOR 2 — the shop-front QR (`POST /api/checkin/shopfront`): an ABSENT day is never offered, and the act refuses it", () => {
  test("by value: 409 NOT_CHECKINABLE, the neutral sentence, nothing marked, nothing written", async () => {
    const w = campWorld();
    spies.push(spyOn(parentSvc, "findParentByPhone").mockImplementation((async () => ({ id: "p1", suspendedAt: null })) as any));
    spies.push(spyOn(db.query.students, "findMany").mockImplementation((async () => [{ id: "s1", parentId: "p1" }]) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(duo, "familyRowsWhere").mockImplementation(((ids: string[]) => ({ family: ids })) as any));
    const r = await post("/checkin/shopfront", { phone: "0924912848", campDayId: DAY });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe("NOT_CHECKINABLE");
    expect(w.marks).toEqual([]);
    expect(w.writes).toEqual([]);
  });
});

describe("📌 DOOR 3 (named by the task) — LINE has NO camp scan path; the bot's check-in is sessions only", () => {
  test("by source: the bot never calls the camp scan, its token, or `markDay`; the camp reminder carries no check-in link", () => {
    const W = src("src/services/line-webhook.service.ts");
    expect(W).not.toMatch(/checkinCampByToken|campScanOutcome|getDayCheckinQr|markDay\(/);
    expect(src("src/lib/camp-reminder.ts")).not.toMatch(/checkin\/camp|checkinUrl/);
    // …so the only two production callers of the scan rule are the two doors above
    expect(src("src/services/camp.service.ts").match(/campScanOutcome\(/g)?.length).toBe(1);
    expect(src("src/services/shopfront-checkin.service.ts")).toContain("return checkinCampByToken(qr.token, \"shopfront-qr\");");
  });
});

describe("🔑 the ADMIN's door stays OPEN — ABSENT → ATTENDED through the real `markDay`", () => {
  test("a coach who marked the wrong child is corrected: the transition is written, with the admin as the actor", async () => {
    const writes: any[] = [];
    const tx = {
      query: { campDays: { findFirst: async () => ({ ...absentDay }) }, campPackages: { findFirst: async () => ({ id: "cp1", usedUnits: 4 }) } },
      update: () => ({ set: (patch: any) => ({ where: async () => { writes.push(patch); } }) }),
    };
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
    spies.push(spyOn(db.query.campPackages, "findFirst").mockImplementation((async () => ({ id: "cp1", studentId: "s1", totalUnits: 10, usedUnits: 4, createdAt: new Date("2026-09-01T00:00:00Z") })) as any));
    spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => []) as any));
    setSystemTime(new Date(`${TODAY}T11:00:00+07:00`));
    await campSvc.markDay(DAY, "ATTENDED", "admin-dong");
    expect(writes[0]).toMatchObject({ status: "ATTENDED", markedBy: "admin-dong" });
    expect(writes.length).toBe(1); // ABSENT and ATTENDED both consume ⇒ no unit moves on the correction either
  });
  test("by source: the guard lives in `campScanOutcome` ONLY — `assertDayTransition` still allows ABSENT → ATTENDED", () => {
    const L = src("src/lib/camp.ts");
    expect(L).toContain('(from === "ABSENT" && to === "ATTENDED")');
    expect(L).toContain('if (day.status === "ABSENT") return "already";');
  });
});

describe("📌 the SESSION path — checked, not assumed (TASK-474's pin)", () => {
  test("the pin exists and says what it covers: a late scan on a NO_SHOW ⇒ 'too late', no status change", () => {
    const T474 = readFileSync(resolve(root, "src/services/checkin-late-window-req107.test.ts"), "utf8");
    expect(T474).toContain("NO_SHOW inside the late window ⇒ the window's 'too late' answer and NO status change");
    expect(T474).toContain("expect(attended).toEqual([]);");
  });
});
