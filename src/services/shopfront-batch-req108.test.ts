// TASK-490 (REQ-108, Khwan's ask) — the shop QR checks in 2+ children in one go: `POST /api/checkin/shopfront/batch`.
// 🔑 A batch is N of the SINGLE request and nothing else (`shopfrontCheckinOne` in routes/checkin.ts): per item the limiter
// is asked, the item is re-validated against the phone's CURRENT list, the same act runs, and the answer is the single
// route's own status + body. Pinned here: one result per item in order · partial success reported per item · a batch of one
// equal to the single call · the rate limit costing a batch exactly N · a stated maximum · the four nothings unchanged.
// The lookup's reads are faked at the DB (the fakes run the real `where`); the act is stubbed per token so each item's
// outcome is chosen — the act itself is the single path's, pinned in shopfront-checkin-req108 / duo-suspension-req108.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import { ApiException } from "../lib/http";
import { tb } from "../lib/line-i18n";
import * as parentSvc from "./parent.service";
import * as checkinSvc from "./checkin.service";
import * as campSvc from "./camp.service";
import * as duo from "../lib/duo-course";
import { SHOPFRONT_MISS_LIMIT } from "../lib/shopfront-rate-limit";
import { SHOPFRONT_BATCH_MAX } from "../routes/checkin";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const PHONE = "0924912848", SUSPENDED_PHONE = "0935555555", UNKNOWN_PHONE = "0990000000", EMPTY_PHONE = "0947777777";
const TODAY = "2026-09-25";
let ipSeq = 0;
const freshIp = () => `10.49.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`; // the limiter is module state — one IP per test
const id = (n: number) => `4904904${n}-0490-4490-8490-490490490490`.slice(0, 36);
const [B1, B2, B3, B4, C1] = [1, 2, 3, 4, 5].map(id) as [string, string, string, string, string];

const ops = { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => ({ [c]: v }), isNull: (c: string) => ({ isNull: c }), asc: (c: string) => c };
const cols = new Proxy({}, { get: (_t, k) => String(k) }) as any;
const conds = (where: any) => [where(cols, ops)].flat(3) as any[];
const valueOf = (cs: any[], col: string) => cs.find((c) => c && col in c)?.[col];

const PARENTS: Record<string, any> = {
  [PHONE]: { id: "p1", suspendedAt: null },
  [SUSPENDED_PHONE]: { id: "p3", suspendedAt: new Date("2026-09-01T00:00:00Z") },
  [EMPTY_PHONE]: { id: "p4", suspendedAt: null },
};
const KIDS = [
  { id: "s1", parentId: "p1", name: "Feen Full", nickname: "Feen" }, { id: "s2", parentId: "p1", name: "Pun Full", nickname: "Pun" },
  { id: "s3", parentId: "p1", name: "Tam Full", nickname: "Tam" },
  { id: "s5", parentId: "p3", name: "Mew Full", nickname: "Mew" }, { id: "s6", parentId: "p4", name: "Ohm Full", nickname: "Ohm" },
];
const session = (bid: string, studentId: string, start = "16:00", end = "17:00") => ({
  id: bid, date: TODAY, startTime: `${start}:00`, endTime: `${end}:00`, status: "CONFIRMED", studentId, coStudentId: null, campWeekDayId: null,
  student: KIDS.find((k) => k.id === studentId), coStudent: null, teacher: { nickname: "KK" }, subject: { name: "BALLET" },
});
/** Feen, Pun, Tam (p1) each have a class now; Mew's family (p3) is suspended and also has one; Ohm (p4) has nothing now. */
const SESSIONS = [session(B1, "s1"), session(B2, "s2"), session(B3, "s3"), session(B4, "s5"), session(id(6), "s6", "19:00", "20:00")];
type Outcome = "ok" | "late" | "boom";
/** The world, and the act stubbed per id; returns the ACT calls in order (what actually reached `checkinByToken`). */
const world = (outcomes: Record<string, Outcome> = {}) => {
  const acts: string[] = [];
  spies.push(spyOn(parentSvc, "findParentByPhone").mockImplementation((async (p: string) => PARENTS[parentSvc.normalizePhone(p)] ?? null) as any));
  spies.push(spyOn(db.query.students, "findMany").mockImplementation((async (q: any) => KIDS.filter((k) => k.parentId === valueOf(conds(q.where), "parentId"))) as any));
  spies.push(spyOn(duo, "familyRowsWhere").mockImplementation(((ids: string[]) => ({ family: ids })) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async (q: any) => {
    const cs = conds(q.where); const fam: string[] = valueOf(cs, "family") ?? [];
    return SESSIONS.filter((b) => b.date === valueOf(cs, "date") && fam.includes(b.studentId));
  }) as any));
  spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => [{ id: C1, date: TODAY, half: "AM", status: "PLANNED", package: { studentId: "s1", student: KIDS[0] } }]) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(checkinSvc, "getCheckinQr").mockImplementation((async (b: string) => ({ token: `tok-${b}` })) as any));
  spies.push(spyOn(checkinSvc, "checkinByToken").mockImplementation((async (t: string, source: string) => {
    const b = t.slice(4); acts.push(b);
    const o = outcomes[b] ?? "ok";
    if (o === "late") throw new ApiException(400, checkinSvc.CHECKIN_TOO_LATE, tb("checkin_too_late"));
    if (o === "boom") throw new Error("connection reset");
    return { already: false, booking: { id: b }, source };
  }) as any));
  spies.push(spyOn(campSvc, "getDayCheckinQr").mockImplementation((async (d: string) => ({ token: `ctok-${d}` })) as any));
  spies.push(spyOn(campSvc, "checkinCampByToken").mockImplementation((async (t: string) => { acts.push(t.slice(5)); return { already: false, day: { dayId: t.slice(5) } }; }) as any));
  setSystemTime(new Date(`${TODAY}T16:05:00+07:00`));
  return acts;
};
const post = (path: string, body: unknown, ip: string) =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 172.16.0.1` }, body: JSON.stringify(body) }));
const batch = async (phone: string, items: Array<Record<string, string>>, ip = freshIp()) => {
  const r = await post("/checkin/shopfront/batch", { phone, items }, ip);
  return { status: r.status, body: (await r.json()) as any };
};
const NOT_CHECKINABLE = { error: { code: "NOT_CHECKINABLE", message: "ไม่มีคลาสให้เช็คอินในขณะนี้ / No class to check in right now" } };

describe("🔴 partial failure — one result PER ITEM, in the order asked; never all-or-nothing, never one overall outcome", () => {
  test("three ticked, the middle one's window closed ⇒ 1st and 3rd checked in, the 2nd refused with ITS OWN reason", async () => {
    const acts = world({ [B2]: "late" });
    const { status, body } = await batch(PHONE, [{ bookingId: B1 }, { bookingId: B2 }, { bookingId: B3 }]);
    expect(status).toBe(200);
    expect(body).toEqual({ results: [
      { bookingId: B1, status: 200, body: { already: false, booking: { id: B1 }, source: "shopfront-qr" } },
      { bookingId: B2, status: 400, body: { error: { code: "CHECKIN_TOO_LATE", message: tb("checkin_too_late") } } },
      { bookingId: B3, status: 200, body: { already: false, booking: { id: B3 }, source: "shopfront-qr" } },
    ] });
    expect(acts).toEqual([B1, B2, B3]); // the third was still attempted after the second failed
  });
  test("the FIRST fails ⇒ the other two still go through (a failure early in the list blocks nothing after it)", async () => {
    const acts = world({ [B1]: "late" });
    const { body } = await batch(PHONE, [{ bookingId: B1 }, { bookingId: B2 }, { bookingId: B3 }]);
    expect(body.results.map((r: any) => r.status)).toEqual([400, 200, 200]);
    expect(acts).toEqual([B1, B2, B3]);
  });
  test("an UNEXPECTED error on one child ⇒ that row is the app's own 500 envelope; the children before AND after are reported", async () => {
    const errs = spyOn(console, "error").mockImplementation(() => {}); spies.push(errs);
    world({ [B2]: "boom" });
    const { status, body } = await batch(PHONE, [{ bookingId: B1 }, { bookingId: B2 }, { bookingId: B3 }]);
    expect(status).toBe(200);
    expect(body.results.map((r: any) => [r.bookingId, r.status])).toEqual([[B1, 200], [B2, 500], [B3, 200]]);
    expect(body.results[1].body).toEqual({ error: { code: "INTERNAL", message: "เกิดข้อผิดพลาดภายในระบบ" } });
  });
  test("the order is the order ASKED, not the list's (reversed in ⇒ reversed out), and a session and a camp day mix", async () => {
    const acts = world();
    const { body } = await batch(PHONE, [{ bookingId: B3 }, { campDayId: C1 }, { bookingId: B1 }]);
    expect(body.results.map((r: any) => r.bookingId ?? r.campDayId)).toEqual([B3, C1, B1]);
    expect(acts).toEqual([B3, C1, B1]);
  });
});

describe("🔑 a batch cannot do anything a single check-in cannot — every item re-validated against the phone's CURRENT list", () => {
  test("an id NOT in this phone's list, between two good ones ⇒ that row is the single route's NOT_CHECKINABLE, and it never reaches the act", async () => {
    const acts = world();
    const { body } = await batch(PHONE, [{ bookingId: B1 }, { bookingId: B4 }, { bookingId: B2 }]); // B4 = another family's class
    expect(body.results[1]).toEqual({ bookingId: B4, status: 409, body: NOT_CHECKINABLE });
    expect(acts).toEqual([B1, B2]);
  });
  test("a class not in its window yet (Ohm's, at 19:00) ⇒ NOT_CHECKINABLE, nothing checked in", async () => {
    const acts = world();
    const { body } = await batch(EMPTY_PHONE, [{ bookingId: id(6) }]);
    expect(body.results).toEqual([{ bookingId: id(6), status: 409, body: NOT_CHECKINABLE }]);
    expect(acts).toEqual([]);
  });
});

describe("🔴 the four indistinguishable nothings — a batch is NOT a fifth way to learn about a family", () => {
  test("unknown number · suspended household · a family with nothing now · a listed family asking for ids it does not hold ⇒ the SAME body", async () => {
    world();
    const items = [{ bookingId: B4 }, { bookingId: id(6) }];
    const bodies = [];
    for (const phone of [UNKNOWN_PHONE, SUSPENDED_PHONE, EMPTY_PHONE]) bodies.push((await batch(phone, items)).body);
    // p1 holds neither B4 (p3's) nor id(6) (p4's)
    bodies.push((await batch(PHONE, items)).body);
    const want = { results: items.map((i) => ({ ...i, status: 409, body: NOT_CHECKINABLE })) };
    for (const b of bodies) expect(b).toEqual(want);
    expect(JSON.stringify(bodies)).not.toMatch(/Mew|Ohm|Feen|p3|p4|s5|s6/); // no name, no id beyond what was sent
  });
});

describe("✅ a batch of ONE is the single call — same status, same body, same cost to the limiter", () => {
  const pair = async (outcomes: Record<string, Outcome>, phone: string, item: Record<string, string>) => {
    world(outcomes);
    const single = await post("/checkin/shopfront", { phone, ...item }, freshIp());
    const one = await batch(phone, [item]);
    return { single: { status: single.status, body: await single.json() }, one };
  };
  for (const [what, outcomes, phone, item] of [
    ["a success", {}, PHONE, { bookingId: B1 }],
    ["a refusal from the act (too late)", { [B1]: "late" }, PHONE, { bookingId: B1 }],
    ["a miss (not in the list)", {}, PHONE, { bookingId: B4 }],
    ["an unknown number", {}, UNKNOWN_PHONE, { bookingId: B1 }],
    ["a camp day", {}, PHONE, { campDayId: C1 }],
  ] as const) {
    test(what, async () => {
      const { single, one } = await pair(outcomes as Record<string, Outcome>, phone, item);
      expect(one.status).toBe(200);
      expect(one.body).toEqual({ results: [{ ...item, status: single.status, body: single.body }] });
    });
  }
});

describe("⚠️ the rate limit — a batch costs EXACTLY what N single requests cost; it is no way round the limit", () => {
  test(`${SHOPFRONT_MISS_LIMIT} misses in ONE batch ⇒ the rest of that batch is 429 item by item, and the IP's next single request is 429`, async () => {
    const acts = world();
    const ip = freshIp();
    const strangers = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ bookingId: `99999999-0490-4490-8490-49049049049${n}` }));
    const { body } = await batch(PHONE, strangers, ip);
    expect(body.results.map((r: any) => r.status)).toEqual([409, 409, 409, 409, 409, 429, 429]);
    expect(body.results[6].body.error.code).toBe("RATE_LIMITED");
    expect((await post("/checkin/shopfront", { phone: PHONE, bookingId: B1 }, ip)).status).toBe(429);
    expect((await post("/checkin/shopfront/lookup", { phone: PHONE }, ip)).status).toBe(429);
    expect(acts).toEqual([]);
  });
  test("a busy desk is still never refused: matches cost nothing — a full batch of good items, then more, from one IP", async () => {
    world();
    const ip = freshIp();
    for (let round = 0; round < 3; round++) {
      const { body } = await batch(PHONE, [{ bookingId: B1 }, { bookingId: B2 }, { bookingId: B3 }, { campDayId: C1 }], ip);
      expect(body.results.map((r: any) => r.status)).toEqual([200, 200, 200, 200]);
    }
  });
  test(`bounded: at most ${SHOPFRONT_BATCH_MAX} items; ${SHOPFRONT_BATCH_MAX + 1} ⇒ 400 and NOTHING runs · empty ⇒ 400 · a duplicate ⇒ 400`, async () => {
    const acts = world();
    expect(SHOPFRONT_BATCH_MAX).toBe(10);
    const many = Array.from({ length: SHOPFRONT_BATCH_MAX + 1 }, (_, n) => ({ bookingId: `88888888-0490-4490-8490-4904904904${String(n).padStart(2, "0")}` }));
    expect((await batch(PHONE, many)).status).toBe(400);
    expect((await batch(PHONE, [])).status).toBe(400);
    expect((await batch(PHONE, [{ bookingId: B1 }, { bookingId: B1 }])).status).toBe(400);
    expect((await batch(PHONE, [{ bookingId: B1, campDayId: C1 }])).status).toBe(400); // one of the two, per item — as the single body
    expect(acts).toEqual([]);
  });
});

describe("🔑 by source: ONE path — both routes run `shopfrontCheckinOne`; the batch has no act of its own", () => {
  test("the batch calls the single request's function per item and nothing else that checks in; errors through the app's ONE envelope", () => {
    const S = code(readSrc(readFileSync(resolve(root, "src/routes/checkin.ts"), "utf8")));
    const batchRoute = S.slice(S.indexOf('.post("/checkin/shopfront/batch"'));
    expect(batchRoute).toContain("await shopfrontCheckinOne(ip, { phone, ...item })");
    expect(batchRoute).toContain("...errorEnvelope(e)");
    expect(batchRoute).not.toMatch(/checkinByToken|checkinCampByToken|shopfront\.shopfrontCheckin|updateBookingStatus|markDay|Promise\.all/);
    expect(S).toContain('.post("/checkin/shopfront", zValidator("json", shopfrontCheckinBody), async (c) => c.json(await shopfrontCheckinOne(ipOf(c), c.req.valid("json"))))');
    const I = code(readFileSync(resolve(root, "src/index.ts"), "utf8"));
    expect(I).toContain("const { status, body } = errorEnvelope(err);");
  });
});
