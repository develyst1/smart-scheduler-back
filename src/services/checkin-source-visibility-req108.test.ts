// TASK-481 — the provenance is READ: `checkinSource` (sessions) and `markedBy` (camp) — raw and untranslated for an admin,
// `null` for a scoped (linked-teacher) viewer (Sober's ruling B), and `null` by DEFAULT everywhere else (the public scan, the
// mutation responses), because the column can hold an admin's USERNAME.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../db";
import { toBookingDTO } from "../db/mappers";
import * as campSvc from "./camp.service";
import { checkinByToken } from "./checkin.service";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const src = (f: string) => code(readSrc(readFileSync(resolve(root, f), "utf8")));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const ROW = { id: "b1", date: "2026-09-25", startTime: "16:00:00", endTime: "17:00:00", bookingType: "COURSE_PACKAGE", status: "ATTENDED", student: { id: "s1", name: "Feen" }, teacher: { id: "t1", name: "KK", nickname: "KK" }, subject: { id: "sub1", name: "BALLET" }, course: null, additionalTeachers: [], rental: null };

describe("✅ sessions — `toBookingDTO`: raw for an admin read, null otherwise; never a word invented", () => {
  // 🔻 TASK-488 — the read is THREE-state now ("raw" · "masked" · omitted ⇒ ABSENT) and carries the split pair beside the legacy value.
  test("admin read (`provenance: raw`): every stored value rides through UNCHANGED — incl. a username and null", () => {
    for (const v of ["shopfront-qr", "checkin-qr", "line", "end-of-day", "admin-dong", null]) {
      expect({ v, got: toBookingDTO({ ...ROW, checkinSource: v }, { provenance: "raw" }).checkinSource }).toEqual({ v, got: v });
    }
    expect(toBookingDTO({ ...ROW }, { provenance: "raw" }).checkinSource).toBeNull(); // a pre-0056 row: null, not a default word
    expect(toBookingDTO({ ...ROW, checkinChannel: "staff", checkinActor: "admin-dong" }, { provenance: "raw" })).toMatchObject({ checkinChannel: "staff", checkinActor: "admin-dong" });
  });
  test("🔴 a scoped viewer (`masked`) reads null for ALL three; the DEFAULT carries NONE of them (absent, not null)", () => {
    expect(toBookingDTO({ ...ROW, checkinSource: "admin-dong", checkinChannel: "staff", checkinActor: "admin-dong" }, { provenance: "masked" })).toMatchObject({ checkinSource: null, checkinChannel: null, checkinActor: null });
    const def: any = toBookingDTO({ ...ROW, checkinSource: "shopfront-qr", checkinChannel: "shopfront-qr", checkinActor: null });
    for (const k of ["checkinSource", "checkinChannel", "checkinActor"]) expect({ k, present: k in def }).toEqual({ k, present: false });
  });
  test("🔴 the PUBLIC scan's 'already' answer never carries it (a parent never reads an admin's username)", async () => {
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => ({ ...ROW, checkinToken: "tok", checkinTokenExpiresAt: null, studentId: "s1", coStudentId: null, voucherId: null, checkinSource: "admin-dong", checkinChannel: "staff", checkinActor: "admin-dong" })) as any));
    spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: "s1", parentId: null })) as any));
    spies.push(spyOn(db.query.vouchers, "findFirst").mockImplementation((async () => undefined) as any));
    const r: any = await checkinByToken("tok");
    expect(r.already).toBe(true);
    // 🔴 TASK-488 — ABSENT, not null: a parent never sees an actor (not masked, not coarsened — absent), nor the channel
    for (const k of ["checkinSource", "checkinChannel", "checkinActor"]) expect({ k, present: k in r.booking }).toEqual({ k, present: false });
    expect(JSON.stringify(r)).not.toContain("admin-dong");
  });
});

describe("✅ camp — `markedBy` under the SAME rule, surfaced on the package read", () => {
  const world = () => {
    spies.push(spyOn(db.query.campPackages, "findMany").mockImplementation((async () => [{ id: "cp1", studentId: "s1", totalUnits: 10, usedUnits: 4, createdAt: new Date("2026-09-01T00:00:00Z") }]) as any));
    spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => [
      { id: "d1", campPackageId: "cp1", campWeekId: "w1", date: "2026-09-25", half: "FULL", units: 2, status: "ATTENDED", markedBy: "shopfront-qr", week: { name: "W1" } },
      { id: "d2", campPackageId: "cp1", campWeekId: "w1", date: "2026-09-24", half: "FULL", units: 2, status: "ABSENT", markedBy: "admin-dong", week: { name: "W1" } },
      { id: "d3", campPackageId: "cp1", campWeekId: "w1", date: "2026-09-26", half: "FULL", units: 2, status: "PLANNED", markedBy: null, week: { name: "W1" } },
    ]) as any));
  };
  test("admin read: raw, incl. a username and null", async () => {
    world();
    const { packages } = await campSvc.listPackages("s1", { provenance: "raw" });
    expect(packages[0]!.days.map((d: any) => d.markedBy)).toEqual(["shopfront-qr", "admin-dong", null]);
  });
  test("🔴 a scoped viewer: null on every day; the DEFAULT: the keys ABSENT (TASK-488's three-state read)", async () => {
    world();
    expect((await campSvc.listPackages("s1", { provenance: "masked" })).packages[0]!.days.map((d: any) => [d.markedBy, d.markChannel, d.markActor])).toEqual([[null, null, null], [null, null, null], [null, null, null]]);
    world();
    expect((await campSvc.listPackages("s1")).packages[0]!.days.map((d: any) => "markedBy" in d || "markActor" in d)).toEqual([false, false, false]);
  });
});

describe("🔑 by source: EXACTLY the admin reads opt in, each keyed on the viewer's scope", () => {
  test("the calendar grid, the cancelled tray and the booking list pass the three-state read keyed on the scope (TASK-488); the scope comes from the viewer/user", () => {
    const S = src("src/services/scheduler.service.ts");
    const cal = S.slice(S.indexOf("export async function getCalendar("), S.indexOf("export async function getTeachers("));
    expect(cal).toContain("const scope = viewer ? scopeOf({ teacherId: viewer.teacherId ?? null }) : null;");
    expect((cal.match(/provenance: scope \? "masked" : "raw"/g) ?? []).length).toBe(2); // the grid and the tray
    const list = S.slice(S.indexOf("export async function getBookings("));
    expect(list.slice(0, list.indexOf("\n}\n"))).toContain('{ provenance: scope ? "masked" : "raw" }');
    expect(src("src/routes/api.ts")).toContain("svc.getBookings(c.req.valid(\"query\"), scopeOf(c.get(\"user\")))");
    expect(src("src/routes/camp.ts")).toContain('camp.listPackages(c.req.valid("query").studentId, { provenance: scopeOf(c.get("user")) ? "masked" : "raw" })');
  });
  test("🔴 nothing else opts in — every other `toBookingDTO` / package read defaults to null", () => {
    const opted: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith(".ts") && !f.endsWith(".test.ts")) for (const m of code(readFileSync(p, "utf8")).matchAll(/provenance: (!?[\w.()"]+)/g)) opted.push(`${p.slice(root.length + 1).replace(/\\/g, "/")}: ${m[1]}`);
      }
    };
    walk(resolve(root, "src"));
    expect(opted.sort()).toEqual([
      "src/routes/camp.ts: scopeOf(c.get(\"user\"))",
      "src/services/scheduler.service.ts: scope",
      "src/services/scheduler.service.ts: scope",
      "src/services/scheduler.service.ts: scope",
    ]);
  });
});
