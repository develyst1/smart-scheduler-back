// TASK-476 — the two PUBLIC token pages (`POST /api/checkin`, `POST /api/checkin/camp`) refuse a SUSPENDED household, as the
// LINE path does (`isSuspendedLineParent`, REQ-019 / TASK-048): the same rule, the same words, FIRST (no data back).
// Through the ROOT app; the student → parent reads are faked by id (the fakes run the real `where`).
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as campSvc from "./camp.service";
import * as lineAdmin from "../lib/line-admin";
import { tb } from "../lib/line-i18n";
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
const SUSPENDED = new Date("2026-09-01T00:00:00Z");
const idOf = (q: any) => q.where({ id: "id" }, { eq: (_c: unknown, v: string) => v });
/** students s1 (family p1), s2 (family p2), s9 (walk-in, no parent); `suspended` = the families that are. */
const households = (suspended: string[]) => {
  const kids: Record<string, any> = { s1: { id: "s1", parentId: "p1" }, s2: { id: "s2", parentId: "p2" }, s9: { id: "s9", parentId: null } };
  spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async (q: any) => kids[idOf(q)]) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async (q: any) => ({ id: idOf(q), suspendedAt: suspended.includes(idOf(q)) ? SUSPENDED : null })) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
};
const post = (path: string, token: string) => rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));

describe("🔴 `/checkin` — a suspended household's token is refused, FIRST; an active one is unchanged", () => {
  const scan = (row: Record<string, unknown>) => {
    const attended: string[] = [];
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => ({ id: "b1", date: TODAY, startTime: "16:00:00", endTime: "17:00:00", status: "CONFIRMED", checkinToken: "token-123456", checkinTokenExpiresAt: new Date(`${TODAY}T17:00:59+07:00`), studentId: "s1", coStudentId: null, voucherId: null, ...row })) as any));
    spies.push(spyOn(sched, "updateBookingStatus").mockImplementation((async (id: string) => { attended.push(id); return { booking: { id } }; }) as any));
    spies.push(spyOn(lineAdmin, "awardCrmPoints").mockImplementation((async () => {}) as any));
    setSystemTime(new Date(`${TODAY}T16:10:00+07:00`));
    return attended;
  };
  test("suspended ⇒ 400 with the LINE path's own words, and NO attend", async () => {
    households(["p1"]);
    const attended = scan({});
    const r = await post("/checkin", "token-123456");
    expect(r.status).toBe(400);
    expect((await r.json()) as any).toMatchObject({ error: { message: tb("suspended_notice") } });
    expect(attended).toEqual([]);
  });
  test("suspended and already ATTENDED ⇒ still refused — no booking, no remaining handed back", async () => {
    households(["p1"]);
    scan({ status: "ATTENDED" });
    const r = await post("/checkin", "token-123456");
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).not.toContain("booking");
  });
  // 🔨 TASK-489 — MOVED. This pinned the defect: "either family refuses the row" told family A "your account is suspended"
  // (false about A, a disclosure about B). Sober's (ii): a DUO row is refused only when EVERY household on it is suspended.
  test("a DUO row: only the CO-student's household suspended ⇒ checked in (TASK-489 (ii); both suspended ⇒ refused)", async () => {
    households(["p2"]);
    const attended = scan({ coStudentId: "s2" });
    expect((await post("/checkin", "token-123456")).status).toBe(200);
    expect(attended).toEqual(["b1"]);
  });
  test("an ACTIVE household ⇒ checked in exactly as before", async () => {
    households([]);
    const attended = scan({});
    expect((await post("/checkin", "token-123456")).status).toBe(200);
    expect(attended).toEqual(["b1"]);
  });
  test("a walk-in with no parent is never blocked (the existing carve-out)", async () => {
    households(["p1", "p2"]);
    const attended = scan({ studentId: "s9" });
    expect((await post("/checkin", "token-123456")).status).toBe(200);
    expect(attended).toEqual(["b1"]);
  });
});

describe("🔴 `/checkin/camp` — it had the SAME gap; now refused the same way", () => {
  const day = (studentId: string) => {
    const marked: string[] = [];
    spies.push(spyOn(db.query.campDays, "findFirst").mockImplementation((async () => ({ id: "cd1", date: TODAY, status: "PLANNED", checkinToken: "ctoken-123456", checkinTokenExpiresAt: new Date(`${TODAY}T23:59:59+07:00`), campPackageId: "cp1", package: { studentId } })) as any));
    spies.push(spyOn(campSvc, "markDay").mockImplementation((async (id: string) => { marked.push(id); return { package: { days: [], totalUnits: 2, usedUnits: 1 } }; }) as any));
    setSystemTime(new Date(`${TODAY}T10:00:00+07:00`));
    return marked;
  };
  test("suspended ⇒ 400 with the same words, and the day is NOT marked", async () => {
    households(["p1"]);
    const marked = day("s1");
    const r = await post("/checkin/camp", "ctoken-123456");
    expect(r.status).toBe(400);
    expect((await r.json()) as any).toMatchObject({ error: { message: tb("suspended_notice") } });
    expect(marked).toEqual([]);
  });
  test("active ⇒ marked as before", async () => {
    households([]);
    const marked = day("s1");
    await post("/checkin/camp", "ctoken-123456");
    expect(marked).toEqual(["cd1"]);
  });
});

describe("🔑 by source: ONE rule, not a second reading of 'suspended'", () => {
  // TASK-489 — the session page asks EVERY household on the row (a DUO token is shared); camp has one child, so any = every.
  test("both pages ask `blockedBySuspension` over each child's parent (session: EVERY household; camp: its one) — and neither page reads `suspendedAt` itself", () => {
    const P = src("src/services/parent.service.ts");
    expect(P).toContain("for (const id of studentIds) if (blockedBySuspension(await findParentOfStudent(id, exec))) return true;");
    expect(P).toContain("for (const id of studentIds) if (!blockedBySuspension(await findParentOfStudent(id, exec))) return false;");
    const C = src("src/services/checkin.service.ts"), K = src("src/services/camp.service.ts");
    expect(C).toContain('if (await everyHouseholdSuspended(duoStudentIds(row))) throw badRequest(tb("suspended_notice"));');
    expect(C).not.toContain("anyHouseholdSuspended");
    expect(K).toContain('throw badRequest(tb("suspended_notice"));');
    for (const [f, s] of [["checkin", C], ["camp", K]] as const) expect({ f, reads: /suspendedAt|isSuspended\(/.test(s) }).toEqual({ f, reads: false });
    // FIRST: before the ATTENDED "already" answer, so a suspended household gets no data back
    expect(C.indexOf("everyHouseholdSuspended(")).toBeLessThan(C.indexOf('if (row.status === "ATTENDED")'));
    expect(K.indexOf("anyHouseholdSuspended(")).toBeLessThan(K.indexOf("campScanOutcome(d, today"));
  });
});
