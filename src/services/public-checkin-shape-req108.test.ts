// TASK-499 — the PUBLIC check-in answers (no login: the token page, the shop-front single and batch) carry the booking by ALLOW-LIST.
// Before: the whole admin DTO — the COACH'S PAY (`rate`; the key-59 mask is registered after these routes and never ran on them),
// an ADMIN'S USERNAME (`discount.actor`), staff's `note`, the course's internals, the child's CRM fields. Pinned here:
//  · by KEY SET, deep, through the ROOT app, on all three doors (a `null` is a KEY — so "null instead of absent" fails; Fern's
//    TASK-478 lesson: `toEqual` treats an undefined value as absent, a key set does not);
//  · by VALUE: none of the leaked values appears anywhere in the body;
//  · 🔑 the key-59 promise checked where the mask does NOT run: no `COACH_RATE_FIELDS` name at any depth of any public answer;
//  · the ADMIN DTO unchanged, by value.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import { toBookingDTO } from "../db/mappers";
import * as sched from "./scheduler.service";
import * as lineAdmin from "../lib/line-admin";
import * as parentSvc from "./parent.service";
import * as checkinSvc from "./checkin.service";
import * as duo from "../lib/duo-course";
import { COACH_RATE_FIELDS } from "../lib/coach-rate-visibility";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const root = resolve(import.meta.dir, "..", "..");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const TODAY = "2026-09-25";
const BID = "49949949-9499-4499-8499-499499499499";
const PHONE = "0811111111";
/** A course row carrying everything the admin DTO would hand out: a coach rate, a discount WITH an admin's name, a staff note, CRM. */
const ROW = (status: string) => ({
  id: BID, date: TODAY, startTime: "16:00:00", endTime: "17:00:00", status, bookingType: "COURSE_PACKAGE",
  checkinToken: "token-123456", checkinTokenExpiresAt: new Date(`${TODAY}T17:00:59+07:00`), studentId: "s9", coStudentId: null, voucherId: null, courseId: "c1",
  campWeekDayId: null, groupId: null, note: "staff: mum paid late, chase", attendeeNote: null, teacherRateMinor: 45000,
  discountKind: "PERCENT", discountValue: 10, discountReason: "friend", discountActor: "admin-dong",
  student: { id: "s9", name: "Feen Full", nickname: "Feen", crmPoints: 120, crmLevel: 3, parentId: null }, coStudent: null,
  teacher: { id: "t1", name: "Coach KK", nickname: "KK", type: "FREELANCE" }, subject: { id: "sub", name: "Private BALLET" },
  course: { id: "c1", size: 4, usedSessions: 2, leaveUsed: 1, classRateMinor: 50000, expiryDate: "2026-11-06", startDate: "2026-09-01" },
  badges: [], additionalTeachers: [], rental: null,
});
const PUBLIC_BOOKING = { date: "string", endTime: "string", startTime: "string", student: { name: "string" }, subject: { name: "string" }, teacher: { nickname: "string" } };
const REMAINING = { total: "number", unit: "string", used: "number" };
/** The deep KEY SET of a JSON value: every key, sorted, with the type of each leaf (`null` stays a key: typeof null = "object"). */
const shape = (v: any): any => (Array.isArray(v) ? v.map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])])) : v === null ? "null" : typeof v);
const allKeys = (v: any): string[] => (Array.isArray(v) ? v.flatMap(allKeys) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...allKeys(x)]) : []);
const LEAKED = /"rate"|effectiveMinor|45000|50000|"discount"|admin-dong|"note"|mum paid late|"course"|leaveUsed|crmPoints|crmLevel|perks|priorityBooking|FREELANCE|"type"/;

/** The world a check-in runs in: the row by token, a walk-in (no household to be suspended), the attend returning the FULL admin DTO. */
const world = (status: "CONFIRMED" | "ATTENDED") => {
  const row = ROW(status);
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => row) as any));
  spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: "s9", parentId: null })) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(sched, "updateBookingStatus").mockImplementation((async () => ({ booking: toBookingDTO({ ...row, status: "ATTENDED" }) })) as any));
  spies.push(spyOn(lineAdmin, "awardCrmPoints").mockImplementation((async () => null) as any));
  setSystemTime(new Date(`${TODAY}T16:10:00+07:00`));
  return row;
};
/** The shop front around it: this phone's family holds the session now. */
const wall = () => {
  const row = world("CONFIRMED");
  spies.push(spyOn(parentSvc, "findParentByPhone").mockImplementation((async () => ({ id: "p1", suspendedAt: null })) as any));
  spies.push(spyOn(db.query.students, "findMany").mockImplementation((async () => [{ id: "s9", parentId: "p1", name: "Feen Full", nickname: "Feen" }]) as any));
  spies.push(spyOn(duo, "familyRowsWhere").mockImplementation(((ids: string[]) => ({ family: ids })) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => [{ ...row, campWeekDayId: null }]) as any));
  spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => []) as any));
  spies.push(spyOn(checkinSvc, "getCheckinQr").mockImplementation((async () => ({ token: "token-123456" })) as any));
};
let ip = 0;
const post = async (path: string, body: unknown) => {
  const r = await rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.99.0.${++ip}` }, body: JSON.stringify(body) }));
  return { status: r.status, body: (await r.json()) as any, text: "" };
};

describe("🔴 the three PUBLIC doors answer with the allow-list — by KEY SET, deep, through the root app", () => {
  test("the token page, a fresh check-in: `{ already, booking, crmAwarded, remaining }` and the booking's six fields — nothing else", async () => {
    world("CONFIRMED");
    const r = await post("/checkin", { token: "token-123456" });
    expect(r.status).toBe(200);
    expect(shape(r.body)).toEqual({ already: "boolean", booking: PUBLIC_BOOKING, crmAwarded: "number", remaining: REMAINING });
    expect(r.body.booking).toEqual({ date: TODAY, startTime: "16:00", endTime: "17:00", student: { name: "Feen Full" }, subject: { name: "Private BALLET" }, teacher: { nickname: "KK" } });
    expect([r.body.crmAwarded, r.body.remaining]).toEqual([10, { used: 2, total: 4, unit: "sessions" }]); // what the page shows, unchanged
  });
  test("the token page, already checked in: the SAME allow-list (the other return point)", async () => {
    world("ATTENDED");
    const r = await post("/checkin", { token: "token-123456" });
    expect(shape(r.body)).toEqual({ already: "boolean", booking: PUBLIC_BOOKING, remaining: REMAINING });
  });
  test("the shop front, single: the same answer, relayed", async () => {
    wall();
    const r = await post("/checkin/shopfront", { phone: PHONE, bookingId: BID });
    expect(r.status).toBe(200);
    expect(shape(r.body)).toEqual({ already: "boolean", booking: PUBLIC_BOOKING, crmAwarded: "number", remaining: REMAINING });
  });
  test("the shop front, batch: each row's body is the same allow-list (by construction — it relays the single body)", async () => {
    wall();
    const r = await post("/checkin/shopfront/batch", { phone: PHONE, items: [{ bookingId: BID }] });
    expect(shape(r.body)).toEqual({ results: [{ bookingId: "string", status: "number", body: { already: "boolean", booking: PUBLIC_BOOKING, crmAwarded: "number", remaining: REMAINING } }] });
  });
});

describe("🔴 by VALUE — the coach's pay, the admin's name, the staff note, the course, the CRM fields: ABSENT from every public answer", () => {
  test("none of the leaked values appears anywhere in any of the four bodies", async () => {
    const bodies: string[] = [];
    world("CONFIRMED"); bodies.push(JSON.stringify((await post("/checkin", { token: "token-123456" })).body));
    for (const s of spies.splice(0)) s.mockRestore();
    world("ATTENDED"); bodies.push(JSON.stringify((await post("/checkin", { token: "token-123456" })).body));
    for (const s of spies.splice(0)) s.mockRestore();
    wall(); bodies.push(JSON.stringify((await post("/checkin/shopfront", { phone: PHONE, bookingId: BID })).body));
    bodies.push(JSON.stringify((await post("/checkin/shopfront/batch", { phone: PHONE, items: [{ bookingId: BID }] })).body));
    for (const b of bodies) expect({ b, leaked: b.match(LEAKED)?.[0] ?? null }).toEqual({ b, leaked: null });
  });
  test("🔑 key 59's promise, checked WHERE THE MASK DOES NOT RUN: no `COACH_RATE_FIELDS` name at any depth of a public answer", async () => {
    world("CONFIRMED");
    const a = (await post("/checkin", { token: "token-123456" })).body;
    for (const s of spies.splice(0)) s.mockRestore();
    wall();
    const b = (await post("/checkin/shopfront/batch", { phone: PHONE, items: [{ bookingId: BID }] })).body;
    const keys = new Set([...allKeys(a), ...allKeys(b)]);
    expect(COACH_RATE_FIELDS.filter((f) => keys.has(f))).toEqual([]);
    expect(keys.size).toBeGreaterThan(8); // the walk is not vacuous
  });
});

describe("✅ the ADMIN DTO is unchanged — the allow-list is a separate, public-only shape", () => {
  test("`toBookingDTO` still carries rate, discount (with its actor), note, course and the CRM fields, by value", () => {
    const d: any = toBookingDTO(ROW("ATTENDED"));
    expect(d.rate).toEqual({ effectiveMinor: 45000, overrideMinor: 45000, defaultMinor: 50000 });
    expect(d.discount).toEqual({ kind: "PERCENT", value: 10, reason: "friend", actor: "admin-dong" });
    expect(d.note).toBe("staff: mum paid late, chase");
    expect(d.course.usedSessions).toBe(2);
    expect([d.student.crmPoints, d.student.crmLevel, d.student.crmLevelName]).toEqual([120, 3, "น่ารักมาก"]);
    expect(Object.keys(d).length).toBe(33);
  });
  test("by source: the public shape is built in ONE place, used by BOTH of `checkinByToken`'s answers, and is an allow-list literal", () => {
    const M = readFileSync(resolve(root, "src/db/mappers.ts"), "utf8");
    const fn = M.slice(M.indexOf("export const toPublicCheckinBooking"), M.indexOf("    : null;", M.indexOf("export const toPublicCheckinBooking")));
    expect(fn).not.toContain("..."); // no spread: nothing rides along by default
    const C = readFileSync(resolve(root, "src/services/checkin.service.ts"), "utf8");
    expect((C.match(/booking: toPublicCheckinBooking\(/g) ?? []).length).toBe(2);
    expect(C).not.toMatch(/return \{ already: (true|false), booking(,| : result\.booking)/);
  });
});
