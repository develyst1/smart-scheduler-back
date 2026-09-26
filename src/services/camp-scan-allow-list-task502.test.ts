// TASK-502 — the public camp scan (`POST /checkin/camp`, no JWT) answers with ONE allow-list literal on BOTH paths.
//
// Its day used to be an element of the ADMIN package DTO, relayed as-is. Clean today, but the admin DTO can gain two things
// a family must never see: a per-coach day RATE (REQ-104) and the marker's identity (`provenance`: markedBy / markChannel /
// markActor). These tests run the REAL `toPackageDTO` (only the database is faked), with a stored day row that already
// carries a rate and a staff marker, so the day the admin DTO starts copying either one, these pins say whether the scan
// still refuses it. Break-and-watch in TASK-502's report.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import { campDays, campPackages } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { COACH_RATE_FIELDS } from "../lib/coach-rate-visibility";
import { readSrc } from "../lib/read-src";
import * as camp from "./camp.service";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const TODAY = bangkokNow().date;
const S1 = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const D1 = "33333333-3333-4333-8333-333333333333";
const D2 = "44444444-4444-4444-8444-444444444444";
const W1 = "55555555-5555-4555-8555-555555555555";
const TOKEN = "camp-token-502";
const KEYS = ["date", "dayId", "half", "status", "undoReason", "units", "weekId", "weekName"]; // sorted

// The STORED rows — deliberately carrying what must never reach a family: a coach rate and a staff marker.
const row = (status: string) => ({
  id: D1, campPackageId: P1, campWeekId: W1, date: TODAY, half: "AM", units: 1, status, undoReason: null,
  checkinToken: TOKEN, checkinTokenExpiresAt: null,
  markedBy: "staff", markChannel: "admin", markActor: "u-staff-1", markedAt: new Date(),
  teacherRates: { t1: 50000 }, rateMinor: 50000,
  week: { id: W1, name: "Week 1" },
});
const PKG = { id: P1, studentId: S1, kind: "FULL", plan: "FULL_WEEK", totalUnits: 10, usedUnits: 3, saleId: null, note: null, discountKind: null, createdBy: "u-staff-1", createdAt: new Date("2026-09-01T03:00:00Z") };

/** The database around ONE scan of D1: the day by token, the child (a walk-in — no household), the mark's tx, the package. */
function world(status: "PLANNED" | "ATTENDED") {
  const d = row(status);
  const other = { ...row("PLANNED"), id: D2, date: "2099-01-01", checkinToken: null };
  spies.push(spyOn(db.query.campDays, "findFirst").mockImplementation((async () => d) as any));
  spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: S1, parentId: null })) as any));
  spies.push(spyOn(db.query.campPackages, "findFirst").mockImplementation((async () => PKG) as any));
  spies.push(spyOn(db.query.campPackages, "findMany").mockImplementation((async () => [PKG]) as any));
  spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => [d, other]) as any));
  const tx = {
    query: { campDays: { findFirst: async () => d } },
    update: (table: unknown) => {
      if (table !== campDays && table !== campPackages) throw new Error("unexpected write in the camp mark");
      return { set: (v: any) => ({ where: async () => { if (table === campDays) Object.assign(d, v); } }) };
    },
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
}

/** Every key, at any depth. */
const keysDeep = (v: unknown, out: string[] = []): string[] => {
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
  return out;
};

describe("🔴 TASK-502 — the public camp scan answers ONE allow-listed shape, on both paths", () => {
  test("🔑 FRESH scan: the day is exactly the 8 keys (by key set), from the real admin DTO, nulls included", async () => {
    world("PLANNED");
    const r = await camp.checkinCampByToken(TOKEN);
    expect(Object.keys(r.day).sort()).toEqual(KEYS);
    expect(r).toEqual({
      already: false,
      day: { dayId: D1, weekId: W1, weekName: "Week 1", date: TODAY, half: "AM", units: 1, status: "ATTENDED", undoReason: null },
      credit: { remainingDays: 3.5, totalDays: 5 },
    });
  });

  test("🔑 ALREADY scanned: the SAME 8 keys — it now carries `weekName` (the page renders it; it used to be an empty line)", async () => {
    world("ATTENDED");
    const r = await camp.checkinCampByToken(TOKEN);
    expect(Object.keys(r.day).sort()).toEqual(KEYS);
    expect(r.day).toEqual({ dayId: D1, weekId: W1, weekName: "Week 1", date: TODAY, half: "AM", units: 1, status: "ATTENDED", undoReason: null });
    expect(r.already).toBe(true);
  });

  test("🚫 no coach-rate field (`COACH_RATE_FIELDS`, any depth) and no marker identity in either answer — the mask does not run here", async () => {
    const answers: unknown[] = [];
    world("PLANNED"); answers.push(await camp.checkinCampByToken(TOKEN));
    for (const s of spies.splice(0)) s.mockRestore();
    world("ATTENDED"); answers.push(await camp.checkinCampByToken(TOKEN));
    for (const a of answers) {
      const keys = keysDeep(a);
      for (const k of COACH_RATE_FIELDS) expect(keys).not.toContain(k);
      for (const k of ["markedBy", "markChannel", "markActor", "markedAt", "checkinToken", "studentName"]) expect(keys).not.toContain(k);
    }
    expect(COACH_RATE_FIELDS.length).toBeGreaterThan(0); // the walk has something to walk
  });

  test("📌 by source: the day is a LITERAL — no spread in the one place that builds the answer", () => {
    const src = readSrc(readFileSync(resolve(import.meta.dir, "camp.service.ts"), "utf8"));
    const a = src.indexOf("const scanAnswer = ");
    expect(a).toBeGreaterThan(-1);
    const dayLine = src.slice(a).split("\n").find((l) => l.trimStart().startsWith("day: {"))!;
    expect(dayLine).not.toContain("...");
    const fn = src.slice(src.indexOf("export async function checkinCampByToken("), a);
    expect(fn.match(/return scanAnswer\(/g)).toHaveLength(2); // both paths, one builder
    expect(fn).not.toContain("day:"); // …and no path builds its own
  });

  test("🔑 the ADMIN package DTO is UNCHANGED — pinned by value (a leak fix must not narrow the admin's own view)", async () => {
    world("ATTENDED");
    const day = { dayId: D1, weekId: W1, weekName: "Week 1", date: TODAY, half: "AM", units: 1, status: "ATTENDED", undoReason: null };
    const base = { id: P1, studentId: S1, kind: "FULL", plan: "FULL_WEEK", totalUnits: 10, usedUnits: 3, plannedUnits: 1, saleId: null, note: null, discount: null, createdBy: "u-staff-1", createdAt: "2026-09-01T03:00:00.000Z" };
    const other = { dayId: D2, weekId: W1, weekName: "Week 1", date: "2099-01-01", half: "AM", units: 1, status: "PLANNED", undoReason: null };
    const plain = (await camp.listPackages(S1)).packages[0] as any;
    expect({ ...plain, credit: undefined }).toEqual({ ...base, credit: undefined, days: [day, other] });
    const full = (await camp.listPackages(S1, { provenance: "raw" })).packages[0] as any;
    expect(full.days[0]).toEqual({ ...day, markedBy: "staff", markChannel: "admin", markActor: "u-staff-1" }); // the admin still sees who marked it
  });
});
