// TASK-475 (REQ-108) — the shop-front QR self check-in, through the ROOT app (`/api/checkin/shopfront…`).
//
// 🔑 The DB is faked at its reads, and every fake RUNS the service's real `where` callback against recording operators —
// so a fake answers what the code actually ASKED for (the family's ids, today's date, CONFIRMED, PLANNED), never a canned
// list (TASK-466: a spy that ignores `where` cannot see a filter). The settings are read through the REAL `getSetting`.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as parentSvc from "./parent.service";
import * as checkinSvc from "./checkin.service";
import * as campSvc from "./camp.service";
import * as duo from "../lib/duo-course";
import { ShopfrontRateLimit, SHOPFRONT_MISS_LIMIT, SHOPFRONT_TOTAL_LIMIT, SHOPFRONT_WINDOW_MS, clientIp } from "../lib/shopfront-rate-limit";
import { SCHEDULING_WITNESSES } from "../lib/migration-witness";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const src = (f: string) => code(readSrc(readFileSync(resolve(root, f), "utf8")));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const PHONE = "0924912848";
const TODAY = "2026-09-25";
let ipSeq = 0;
const freshIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`; // the limiter is module state — one IP per test

/** Recording operators: `and` flattens, `eq` becomes {col: value}, `isNull` {isNull: col}. */
const ops = { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => ({ [c]: v }), isNull: (c: string) => ({ isNull: c }), asc: (c: string) => c };
const cols = new Proxy({}, { get: (_t, k) => String(k) }) as any;
const conds = (where: any) => [where(cols, ops)].flat(3) as any[];
const valueOf = (cs: any[], col: string) => cs.find((c) => c && col in c)?.[col];

type World = { parent?: any; kids?: any[]; sessions?: any[]; campDays?: any[]; settings?: Record<string, unknown> };
const reads: string[] = [];
const world = (w: World) => {
  reads.length = 0;
  spies.push(spyOn(parentSvc, "findParentByPhone").mockImplementation((async (p: string) => (parentSvc.normalizePhone(p) === PHONE ? w.parent ?? null : null)) as any));
  spies.push(spyOn(db.query.students, "findMany").mockImplementation((async (q: any) => {
    reads.push("students");
    const pid = valueOf(conds(q.where), "parentId");
    return (w.kids ?? []).filter((k) => k.parentId === pid);
  }) as any));
  spies.push(spyOn(duo, "familyRowsWhere").mockImplementation(((ids: string[]) => ({ family: ids })) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async (q: any) => {
    reads.push("bookings");
    const cs = conds(q.where);
    const fam: string[] = valueOf(cs, "family") ?? [];
    return (w.sessions ?? []).filter((b) => b.date === valueOf(cs, "date") && b.status === valueOf(cs, "status") && !b.campWeekDayId && (fam.includes(b.studentId) || fam.includes(b.coStudentId)));
  }) as any));
  spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async (q: any) => {
    reads.push("campDays");
    const cs = conds(q.where);
    return (w.campDays ?? []).filter((d) => d.date === valueOf(cs, "date") && d.status === valueOf(cs, "status"));
  }) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async (q: any) => {
    const key = q.where({ key: "key" }, { eq: (_c: unknown, v: string) => v });
    return w.settings && key in w.settings ? { key, value: w.settings[key] } : undefined;
  }) as any));
};
const post = (path: string, body: unknown, ip = freshIp()) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 172.16.0.1` }, body: JSON.stringify(body) }));
const at = (hm: string) => setSystemTime(new Date(`${TODAY}T${hm}:00+07:00`));

const PARENT = { id: "p1", phone: PHONE, suspendedAt: null };
const KIDS = [{ id: "s1", parentId: "p1", name: "Feen Full", nickname: "Feen" }, { id: "s2", parentId: "p1", name: "Pun Full", nickname: "Pun" }];
const session = (id: string, studentId: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, date: TODAY, startTime: `${start}:00`, endTime: `${end}:00`, status: "CONFIRMED", studentId, coStudentId: null, campWeekDayId: null,
  student: KIDS.find((k) => k.id === studentId), coStudent: null, teacher: { nickname: "KK" }, subject: { name: "Private BALLET" }, ...extra,
});

describe("🔴 guard 2 — ONLY the children with something check-in-able NOW; never the family list", () => {
  test("Feen's class is in the window, Pun's is this evening ⇒ Feen alone, and Pun's name appears nowhere", async () => {
    world({ parent: PARENT, kids: KIDS, sessions: [session("b1", "s1", "16:00", "17:00"), session("b2", "s2", "19:00", "20:00")] });
    at("15:45");
    const r = await post("/checkin/shopfront/lookup", { phone: PHONE });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ children: [{ name: "Feen", items: [{ kind: "session", bookingId: "b1", date: TODAY, startTime: "16:00", endTime: "17:00", program: "Private BALLET", teacher: "Teacher KK" }] }] });
    expect(JSON.stringify(body)).not.toContain("Pun");
  });
  test("a DUO row is ONE entry, named through the ONE rule", async () => {
    world({ parent: PARENT, kids: KIDS, sessions: [session("b1", "s1", "16:00", "17:00", { coStudentId: "s2", coStudent: KIDS[1] })] });
    at("16:10");
    const body = (await (await post("/checkin/shopfront/lookup", { phone: PHONE })).json()) as any;
    expect(body.children.map((c: any) => c.name)).toEqual(["Feen & Pun"]);
  });
});

describe("🔴 no PII before a match — every kind of 'nothing' is INDISTINGUISHABLE (same body, same reads)", () => {
  const cases: Array<[string, World, string]> = [
    ["an unknown number", { kids: KIDS, sessions: [session("b1", "s1", "16:00", "17:00")] }, "0800000000"],
    ["a family with nothing now", { parent: PARENT, kids: KIDS, sessions: [session("b1", "s1", "19:00", "20:00")] }, PHONE],
    ["a SUSPENDED household (❓4)", { parent: { ...PARENT, suspendedAt: new Date("2026-09-01") }, kids: KIDS, sessions: [session("b1", "s1", "16:00", "17:00")] }, PHONE],
    ["an ARCHIVED holder (invisible to findParentByPhone)", { parent: null, kids: KIDS, sessions: [session("b1", "s1", "16:00", "17:00")] }, PHONE],
  ];
  for (const [what, w, phone] of cases) {
    test(what, async () => {
      world(w);
      at("16:10");
      const r = await post("/checkin/shopfront/lookup", { phone });
      expect({ what, status: r.status, text: await r.text() }).toEqual({ what, status: 200, text: '{"children":[]}' });
      expect({ what, reads: [...reads] }).toEqual({ what, reads: ["students", "bookings", "campDays"] }); // the same reads, match or not
    });
  }
  test("a body that is not phone-shaped is a 400 — it says nothing about customers", async () => {
    world({});
    expect((await post("/checkin/shopfront/lookup", { phone: "hello" })).status).toBe(400);
  });
});

describe("✅ guard 1 — the live window through the REAL setting read (early + K5's late); only CONFIRMED is asked for", () => {
  test("a class that ended 10 minutes ago: late 0 ⇒ nothing; late 30 ⇒ listed", async () => {
    world({ parent: PARENT, kids: KIDS, sessions: [session("b1", "s1", "16:00", "17:00")] });
    at("17:10");
    expect(await (await post("/checkin/shopfront/lookup", { phone: PHONE })).json()).toEqual({ children: [] });
    for (const s of spies.splice(0)) s.mockRestore();
    world({ parent: PARENT, kids: KIDS, sessions: [session("b1", "s1", "16:00", "17:00")], settings: { checkin_late_minutes: 30 } });
    at("17:10");
    expect(((await (await post("/checkin/shopfront/lookup", { phone: PHONE })).json()) as any).children.length).toBe(1);
  });
  test("a settled row is never offered: the lookup asks for CONFIRMED only (ATTENDED / NO_SHOW never come back)", async () => {
    world({ parent: PARENT, kids: KIDS, sessions: [session("b1", "s1", "16:00", "17:00", { status: "NO_SHOW" }), session("b2", "s1", "16:00", "17:00", { status: "ATTENDED" })] });
    at("16:10");
    expect(await (await post("/checkin/shopfront/lookup", { phone: PHONE })).json()).toEqual({ children: [] });
  });
});

describe("✅ camp — PLANNED only (❓3: a wall QR never overturns a staff-marked absence), consumed by camp's own act", () => {
  test("today's PLANNED day is listed as a camp item; an ABSENT day is not", async () => {
    world({ parent: PARENT, kids: KIDS, campDays: [
      { id: "cd1", date: TODAY, status: "PLANNED", half: "FULL", package: { studentId: "s2", student: KIDS[1] } },
      { id: "cd2", date: TODAY, status: "ABSENT", half: "AM", package: { studentId: "s1", student: KIDS[0] } },
    ] });
    at("10:00");
    expect(await (await post("/checkin/shopfront/lookup", { phone: PHONE })).json()).toEqual({ children: [{ name: "Pun", items: [{ kind: "camp", campDayId: "cd1", date: TODAY, half: "FULL" }] }] });
  });
});

describe("🔴 the act — re-validated against the phone's CURRENT list, then the SAME act as every other path", () => {
  const act = () => {
    const calls: any[] = [];
    spies.push(spyOn(checkinSvc, "getCheckinQr").mockImplementation((async (id: string) => { calls.push(["getCheckinQr", id]); return { token: `tok-${id}` }; }) as any));
    spies.push(spyOn(checkinSvc, "checkinByToken").mockImplementation((async (t: string, s: string) => { calls.push(["checkinByToken", t, s]); return { already: false, booking: { id: "b1" } }; }) as any));
    spies.push(spyOn(campSvc, "getDayCheckinQr").mockImplementation((async (id: string) => { calls.push(["getDayCheckinQr", id]); return { token: `ctok-${id}` }; }) as any));
    spies.push(spyOn(campSvc, "checkinCampByToken").mockImplementation((async (t: string, s: string) => { calls.push(["checkinCampByToken", t, s]); return { already: false }; }) as any));
    return calls;
  };
  test("a session in the list ⇒ getCheckinQr → checkinByToken(…, 'shopfront-qr'), and its answer is returned as is", async () => {
    world({ parent: PARENT, kids: KIDS, sessions: [session("11111111-1111-4111-8111-111111111111", "s1", "16:00", "17:00")] });
    const calls = act();
    at("16:05");
    const r = await post("/checkin/shopfront", { phone: PHONE, bookingId: "11111111-1111-4111-8111-111111111111" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ already: false, booking: { id: "b1" } });
    expect(calls).toEqual([["getCheckinQr", "11111111-1111-4111-8111-111111111111"], ["checkinByToken", "tok-11111111-1111-4111-8111-111111111111", "shopfront-qr"]]);
  });
  test("🔴 a bookingId NOT in this phone's list ⇒ 409 NOT_CHECKINABLE, and NOTHING is checked in (a bookingId alone is never enough)", async () => {
    world({ parent: PARENT, kids: KIDS, sessions: [session("11111111-1111-4111-8111-111111111111", "s1", "16:00", "17:00")] });
    const calls = act();
    at("16:05");
    const r = await post("/checkin/shopfront", { phone: PHONE, bookingId: "22222222-2222-4222-8222-222222222222" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "NOT_CHECKINABLE", message: "ไม่มีคลาสให้เช็คอินในขณะนี้ / No class to check in right now" } }); // neutral — no name
    expect(calls).toEqual([]);
  });
  test("a camp day in the list ⇒ getDayCheckinQr → checkinCampByToken(…, 'shopfront-qr')", async () => {
    world({ parent: PARENT, kids: KIDS, campDays: [{ id: "33333333-3333-4333-8333-333333333333", date: TODAY, status: "PLANNED", half: "FULL", package: { studentId: "s1", student: KIDS[0] } }] });
    const calls = act();
    at("10:00");
    expect((await post("/checkin/shopfront", { phone: PHONE, campDayId: "33333333-3333-4333-8333-333333333333" })).status).toBe(200);
    expect(calls).toEqual([["getDayCheckinQr", "33333333-3333-4333-8333-333333333333"], ["checkinCampByToken", "ctok-33333333-3333-4333-8333-333333333333", "shopfront-qr"]]);
  });
  test("🔑 by source: the service does NOT implement attend — no updateBookingStatus, no markDay, no write of its own", () => {
    const S = src("src/services/shopfront-checkin.service.ts");
    expect(S).toContain("const qr = await getCheckinQr(input.bookingId);\n    return checkinByToken(qr.token, \"shopfront-qr\");");
    expect(S).toContain("const qr = await getDayCheckinQr(input.campDayId);\n    return checkinCampByToken(qr.token, \"shopfront-qr\");");
    expect(S).not.toMatch(/updateBookingStatus|markDay|\.update\(|\.insert\(|status: "ATTENDED"/);
    // …and it is the SAME pair the LINE button uses
    const W = src("src/services/line-webhook.service.ts");
    expect(W).toContain("const qr = await getCheckinQr(b.id);");
    expect(W).toContain('const result = await checkinByToken(qr.token, "line");');
  });
});

describe("✅ guard 4 — the rate limit counts MISSES per IP; a busy desk is never refused", () => {
  test("pure: 5 misses ⇒ refused; matches cost nothing; the window slides; another IP is untouched", () => {
    const rl = new ShopfrontRateLimit();
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) rl.record("desk", t0 + i, false); // thirty real families in the rush
    expect(rl.blocked("desk", t0 + 31)).toBe(false);
    for (let i = 0; i < SHOPFRONT_MISS_LIMIT; i++) rl.record("guesser", t0 + i, true);
    expect(rl.blocked("guesser", t0 + 10)).toBe(true);
    expect(rl.blocked("desk", t0 + 10)).toBe(false);
    expect(rl.blocked("guesser", t0 + SHOPFRONT_WINDOW_MS + 10)).toBe(false); // the oldest miss left the window
    for (let i = 0; i < SHOPFRONT_TOTAL_LIMIT; i++) rl.record("hammer", t0 + i, false);
    expect(rl.blocked("hammer", t0 + 100)).toBe(true); // the ceiling behind it
  });
  test("through the route: the 6th lookup after 5 misses from one IP is a 429; the same IP is not reset by a 'refresh'", async () => {
    world({ kids: KIDS });
    const ip = freshIp();
    for (let i = 0; i < SHOPFRONT_MISS_LIMIT; i++) expect((await post("/checkin/shopfront/lookup", { phone: `08000000${10 + i}` }, ip)).status).toBe(200);
    const r = await post("/checkin/shopfront/lookup", { phone: PHONE }, ip);
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error.code).toBe("RATE_LIMITED");
    expect((await post("/checkin/shopfront/lookup", { phone: PHONE }, freshIp())).status).toBe(200);
  });
  test("🔴 through the route: a busy desk — 12 MATCHING lookups from one IP (shop Wi-Fi) — is never refused (break-and-watch J found this unpinned)", async () => {
    world({ parent: PARENT, kids: KIDS, sessions: [session("b1", "s1", "16:00", "17:00")] });
    at("15:50");
    const ip = freshIp();
    for (let i = 0; i < SHOPFRONT_MISS_LIMIT + 7; i++) expect({ i, status: (await post("/checkin/shopfront/lookup", { phone: PHONE }, ip)).status }).toEqual({ i, status: 200 });
  });
  test("the IP is the FIRST X-Forwarded-For hop (nginx's), as the webhook reads it", () => {
    expect(clientIp("203.0.113.9, 172.16.0.1")).toBe("203.0.113.9");
    expect(clientIp(undefined, "198.51.100.2")).toBe("198.51.100.2");
    expect(clientIp(undefined)).toBe("unknown");
  });
});

describe("🔑 provenance — WHERE each check-in came from (`bookings.checkin_source`, migration 0056)", () => {
  test("every attend path passes its source; the column is written on ATTEND only, and a cancel does not touch it", () => {
    const S = src("src/services/scheduler.service.ts");
    // 🔻 TASK-488 — the provenance is a CHANNEL + an ACTOR now (the legacy column still written beside them, until its drop)
    expect(S).toContain('await tx.update(bookings).set({ status: "ATTENDED", checkinSource: legacySourceOf(checkinSource), checkinChannel: checkinSource?.channel ?? null, checkinActor: checkinSource?.actor ?? null }).where(eq(bookings.id, id));');
    // the claim the old count stood for, pinned directly: the CANCEL branch touches none of the three
    const cancel = S.slice(S.indexOf('} else if (action === "cancel") {'), S.indexOf('} else if (action === "sick-leave"'));
    expect(cancel).not.toMatch(/checkinSource|checkinChannel|checkinActor/);
    expect(src("src/services/checkin.service.ts")).toContain('await updateBookingStatus(row.id, "attend", undefined, false, undefined, { channel: source });');
    expect(src("src/routes/api.ts")).toContain("svc.updateBookingStatus(c.req.param(\"id\"), action, reason, override, reasonCode, { channel: \"staff\", actor: actorOf(c) })");
    expect(src("src/services/jobs.service.ts")).toContain('set({ status: "ATTENDED", checkinSource: "end-of-day", checkinChannel: "end-of-day", checkinActor: null })');
    expect(src("src/services/camp.service.ts")).toContain('await markDay(d.id, "ATTENDED", { channel: source });');
  });
  test("by value: checkinByToken hands its source to the ONE attend function", async () => {
    const got: any[] = [];
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => ({ id: "b1", date: TODAY, startTime: "16:00:00", endTime: "17:00:00", status: "CONFIRMED", checkinToken: "tok", checkinTokenExpiresAt: new Date(`${TODAY}T17:00:59+07:00`), studentId: "s1", coStudentId: null, voucherId: null })) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: "s1", parentId: null })) as any)); // TASK-476 — the suspension read
    const sched = await import("./scheduler.service");
    spies.push(spyOn(sched, "updateBookingStatus").mockImplementation((async (...a: any[]) => { got.push(a); return { booking: { id: "b1" } }; }) as any));
    const la = await import("../lib/line-admin");
    spies.push(spyOn(la, "awardCrmPoints").mockImplementation((async () => {}) as any));
    at("16:05");
    await (await import("./checkin.service")).checkinByToken("tok", "shopfront-qr");
    expect(got).toEqual([["b1", "attend", undefined, false, undefined, { channel: "shopfront-qr" }]]); // 🔻 TASK-488 — a channel, NO actor
  });
  test("the migration: 0056, the column is its only object and its witness; the rejection of `note` is written down", () => {
    const sql = readFileSync(resolve(root, "drizzle/0056_booking_checkin_source.sql"), "utf8");
    expect(sql).toContain('ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "checkin_source" text;');
    expect(sql).toContain("the admin's cancel reason OVERWRITES it");
    expect(SCHEDULING_WITNESSES.find((w) => w.tag === "0056_booking_checkin_source")?.probe).toEqual({ kind: "column", table: "bookings", column: "checkin_source" });
  });
});
