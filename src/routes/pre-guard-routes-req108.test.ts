// TASK-501 — CLOSE THE CLASS: a route registered in `src/index.ts` ABOVE `app.use("/api/*", <guard>)` runs WITHOUT that guard.
// Hono runs handlers in registration order, so the public routes (registered first, on purpose) never pass `authMiddleware`,
// `accessGuard`, `uuidParamGuard` or `coachRateMask`. TASK-499 was that fact biting: the coach-rate mask (key 59) had never run
// on the public check-in doors, and they answered with the coach's pay. This file makes the fact VISIBLE and ENFORCED:
//  1. the pre-guard route set is DERIVED from `index.ts` + each mounted route file's own declarations — never a hand-kept list;
//  2. every derived route must carry EVIDENCE below (exercised through the root app, or answered only from literals) — a NEW
//     pre-guard route fails here with a message that explains middleware order, until someone looks at what it answers;
//  3. the data-bearing public answers are exercised through the ROOT app and walked, at every depth, for `COACH_RATE_FIELDS`.
// ⚠️ THE LIMIT, stated plainly: a test cannot prove a property of EVERY possible response of a route. What this proves is
// (a) which routes run unguarded — exactly, from the source; (b) that each of them either was exercised here and carried no
// coach-rate field, or answers only object literals built in its own file from named fields (no admin DTO builder in reach
// of the file). A future change INSIDE a service those literals call could still add a field — the literals make that a
// visible edit to a public file, which is the most this kind of guard can honestly promise.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import { toBookingDTO } from "../db/mappers";
import * as sched from "../services/scheduler.service";
import * as campSvc from "../services/camp.service";
import * as lineAdmin from "../lib/line-admin";
import * as parentSvc from "../services/parent.service";
import * as checkinSvc from "../services/checkin.service";
import * as duo from "../lib/duo-course";
import { COACH_RATE_FIELDS } from "../lib/coach-rate-visibility";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const root = resolve(import.meta.dir, "..", "..");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
const read = (f: string) => code(readFileSync(resolve(root, f), "utf8"));

// ───────────────────────── 1. the table, DERIVED from the source ─────────────────────────
type Stmt = { kind: string; path: string; id?: string; at: number };
const INDEX = read("src/index.ts");
const importsOf = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)) for (const n of m[1]!.split(",")) out[n.trim().split(/\s+as\s+/).pop()!] = m[2]!;
  return out;
};
const IMPORTS = importsOf(INDEX);
const STMTS: Stmt[] = [...INDEX.matchAll(/app\.(route|use|get|post|patch|put|delete)\(\s*"([^"]*)"\s*(?:,\s*([\w.]+))?/g)].map((m) => ({ kind: m[1]!, path: m[2]!, id: m[3], at: m.index! }));
/** The `/api/*` guards, in the order `index.ts` registers them. */
const GUARDS = STMTS.filter((s) => s.kind === "use" && s.path === "/api/*").map((s) => ({ name: s.id!, at: s.at }));
const fileOf = (id: string) => `src/${IMPORTS[id]!.replace(/^\.\//, "")}.ts`;
/** Every route a mounted file declares (`.get("/x"` …), prefixed with its mount path. */
const routesOf = (prefix: string, file: string) =>
  [...read(file).matchAll(/\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)].map((m) => `${m[1]!.toUpperCase()} ${(prefix === "/" ? "" : prefix) + m[2]!}`);
type Unguarded = { route: string; file: string | null; skipped: string[] };
/** Every route under `/api` registered ABOVE at least one `/api/*` guard — and which guards it therefore never passes. */
const PRE_GUARD: Unguarded[] = STMTS.filter((s) => s.kind !== "use" && (s.path === "/api" || s.path.startsWith("/api/")))
  .flatMap((s) => {
    const skipped = GUARDS.filter((g) => g.at > s.at).map((g) => g.name);
    if (!skipped.length) return [];
    if (s.kind === "route") return routesOf(s.path, fileOf(s.id!)).map((route) => ({ route, file: fileOf(s.id!), skipped }));
    return [{ route: `${s.kind.toUpperCase()} ${s.path}`, file: "src/index.ts", skipped }];
  });

// ───────────────────────── 2. the evidence each unguarded route must carry ─────────────────────────
/** 🔑 Per-route knowledge that someone has to WRITE when they add a pre-guard route — that is the point of this table. */
const EVIDENCE: Record<string, { how: "exercised" | "literal"; why: string }> = {
  "GET /api/openapi.json": { how: "exercised", why: "🔴 PUBLIC ON PURPOSE — another team uses it (owner, 2026-09-26, TASK-509; the reason sits at its registration in index.ts — do not guard it). A hand-written, PARTIAL schema (17 paths, 7 schemas): route names, shapes, the bearer scheme; no customer data, no host; walked below — names no coach-rate field" },
  "GET /api/docs": { how: "literal", why: "🔴 PUBLIC ON PURPOSE — another team uses it (owner, 2026-09-26, TASK-509). The Swagger UI page for the document above (its script/style from cdn.jsdelivr.net); no data of its own" },
  "POST /api/auth/login": { how: "literal", why: "`{ token, user }` — the signing-in user's OWN record (`userDTO`), no booking or course" },
  "POST /api/webhooks/line": { how: "literal", why: "`{ ok: true }` / the signature refusal; LINE's own signature is the credential" },
  "POST /api/checkin": { how: "exercised", why: "TASK-499: `toPublicCheckinBooking`, an allow-list — walked below" },
  "POST /api/checkin/camp": { how: "exercised", why: "`{ already, day, credit }` — camp's own narrow shape — walked below" },
  "POST /api/checkin/shopfront/lookup": { how: "exercised", why: "`{ children: [{ name, items }] }`, built field by field — walked below" },
  "POST /api/checkin/shopfront": { how: "exercised", why: "relays the token page's allow-listed answer — walked below" },
  "POST /api/checkin/shopfront/batch": { how: "exercised", why: "one row per item, each the single answer — walked below" },
  "GET /api/calendar/:file": { how: "literal", why: "an ICS TEXT feed, each line written field by field in `lib/ics.ts`" },
  "POST /api/register/status": { how: "literal", why: "`{ ok, linked, phone (masked), childCount }`" },
  "POST /api/register/unlink": { how: "literal", why: "`{ ok, unlinked, cleared }`" },
  "POST /api/register/lookup": { how: "literal", why: "`{ ok, outcome, phone (masked), children: childView }` — childView = { id, name, nickname }" },
  "POST /api/register/link": { how: "literal", why: "`{ ok, outcome, isNew, children: childView, canAddMore }`" },
  "POST /api/register/create": { how: "literal", why: "`{ ok, … }` literals" },
};
const TEACH = (u: Unguarded) => [
  "",
  `🔴 ${u.route} is registered in src/index.ts ABOVE app.use("/api/*", …) for: ${u.skipped.join(", ")}.`,
  "   Hono runs handlers in REGISTRATION ORDER — so NONE of those guards run for this route:",
  "     · authMiddleware — no login is checked;   · accessGuard — no menu/action permission is checked (it fails closed only where it runs);",
  "     · uuidParamGuard — a malformed :id reaches the database;   · coachRateMask — key 59 does NOT hide the coach's rate (TASK-499: a",
  "       public door answered with what we pay the coach, because of exactly this).",
  "   Its answers go out EXACTLY as built. Build them from an ALLOW-LIST (see `toPublicCheckinBooking` in db/mappers.ts), never from an",
  "   admin DTO — then add this route to EVIDENCE in src/routes/pre-guard-routes-req108.test.ts, saying how you know what it answers.",
].join("\n");

describe("🔴 the unguarded routes, DERIVED from `index.ts` — every one must carry evidence", () => {
  test("the four `/api/*` guards, in registration order (read from the source)", () => {
    expect(GUARDS.map((g) => g.name)).toEqual(["authMiddleware", "accessGuard", "uuidParamGuard", "coachRateMask"]);
  });
  test("not vacuous: the derivation finds the public check-in doors, and each skips ALL FOUR guards", () => {
    expect(PRE_GUARD.find((u) => u.route === "POST /api/checkin")?.skipped).toEqual(["authMiddleware", "accessGuard", "uuidParamGuard", "coachRateMask"]);
    expect(PRE_GUARD.length).toBeGreaterThanOrEqual(15);
  });
  test("🔑 every unguarded route has evidence — a NEW one fails here, with the reason middleware order matters", () => {
    const missing = PRE_GUARD.filter((u) => !(u.route in EVIDENCE));
    if (missing.length) throw new Error(missing.map(TEACH).join("\n"));
  });
  test("no stale evidence: every entry names a route that really is unguarded (so the table cannot drift into fiction)", () => {
    const derived = new Set(PRE_GUARD.map((u) => u.route));
    expect(Object.keys(EVIDENCE).filter((r) => !derived.has(r))).toEqual([]);
  });
  test("the failure message teaches the mechanism and names the skipped guards", () => {
    const msg = TEACH({ route: "POST /api/new-public-thing", file: "src/routes/x.ts", skipped: ["authMiddleware", "coachRateMask"] });
    expect(msg).toContain("REGISTRATION ORDER");
    expect(msg).toContain("for: authMiddleware, coachRateMask");
    expect(msg).toContain("key 59 does NOT hide the coach's rate");
  });
});

// ───────────────────────── 3a. the "literal" routes: answered only from object literals, no admin DTO in reach ─────────────────────────
const ADMIN_DTO = /\b(toBookingDTO|loadBookingDTO|toCourseDTO|toCourseSummary|toVoucherDTO|studentRef|rateFacts|bookingProvenance|toCampPackageDTO)\b/;
describe("✅ the routes that answer from LITERALS — by source, file by file", () => {
  test("each literal-evidenced route's file names no admin DTO builder, and every `c.json(` it makes is an object literal or a named document", () => {
    const files = [...new Set(PRE_GUARD.filter((u) => EVIDENCE[u.route]?.how === "literal").map((u) => u.file!))];
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const s = read(f);
      expect({ f, dto: s.match(ADMIN_DTO)?.[0] ?? null }).toEqual({ f, dto: null });
      for (const m of s.matchAll(/c\.json\(\s*([^\s,)]+)/g)) expect({ f, arg: m[1] }).toEqual({ f, arg: m[1]!.startsWith("{") || m[1] === "openApiDocument" ? m[1] : "an object literal" });
      for (const k of COACH_RATE_FIELDS) expect({ f, k, named: new RegExp(`\\b${k}\\b`).test(s) }).toEqual({ f, k, named: false });
    }
  });
  test("the ICS feed's writer names no coach-rate field and no admin DTO", () => {
    const ics = read("src/lib/ics.ts");
    expect(ics.match(ADMIN_DTO)?.[0] ?? null).toBeNull();
    for (const k of COACH_RATE_FIELDS) expect({ k, named: new RegExp(`\\b${k}\\b`).test(ics) }).toEqual({ k, named: false });
  });
});

// ───────────────────────── 3b. the "exercised" routes: through the ROOT app, walked at every depth ─────────────────────────
const TODAY = "2026-09-25";
const BID = "50150150-1501-4501-8501-501501501501", CID = "50150150-1501-4501-8501-501501501502";
const PHONE = "0811111111";
const ROW = (status: string) => ({
  id: BID, date: TODAY, startTime: "16:00:00", endTime: "17:00:00", status, bookingType: "COURSE_PACKAGE", checkinToken: "token-123456",
  checkinTokenExpiresAt: new Date(`${TODAY}T17:00:59+07:00`), studentId: "s9", coStudentId: null, voucherId: null, courseId: "c1", campWeekDayId: null, groupId: null,
  note: "staff note", teacherRateMinor: 45000, discountKind: "PERCENT", discountValue: 10, discountReason: "x", discountActor: "admin-dong",
  student: { id: "s9", name: "Feen Full", nickname: "Feen", crmPoints: 120, crmLevel: 3, parentId: null }, coStudent: null,
  teacher: { id: "t1", name: "Coach KK", nickname: "KK", type: "FREELANCE" }, subject: { id: "sub", name: "Private BALLET" },
  course: { id: "c1", size: 4, usedSessions: 2, leaveUsed: 1, classRateMinor: 50000, expiryDate: "2026-11-06", startDate: "2026-09-01" }, badges: [], additionalTeachers: [], rental: null,
});
/** Every KEY at every depth of a JSON answer. */
const allKeys = (v: any): string[] => (Array.isArray(v) ? v.flatMap(allKeys) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...allKeys(x)]) : []);
const world = () => {
  const row = ROW("CONFIRMED");
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => row) as any));
  spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: "s9", parentId: null })) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(sched, "updateBookingStatus").mockImplementation((async () => ({ booking: toBookingDTO({ ...row, status: "ATTENDED" }) })) as any));
  spies.push(spyOn(lineAdmin, "awardCrmPoints").mockImplementation((async () => null) as any));
  spies.push(spyOn(parentSvc, "findParentByPhone").mockImplementation((async () => ({ id: "p1", suspendedAt: null })) as any));
  spies.push(spyOn(db.query.students, "findMany").mockImplementation((async () => [{ id: "s9", parentId: "p1", name: "Feen Full", nickname: "Feen" }]) as any));
  spies.push(spyOn(duo, "familyRowsWhere").mockImplementation(((ids: string[]) => ({ family: ids })) as any));
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => [{ ...row }]) as any));
  spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => [{ id: CID, date: TODAY, half: "AM", status: "PLANNED", package: { studentId: "s9", student: { name: "Feen Full", nickname: "Feen" } } }]) as any));
  spies.push(spyOn(checkinSvc, "getCheckinQr").mockImplementation((async () => ({ token: "token-123456" })) as any));
  // camp: the day by token, and the package the mark returns (the admin package DTO — the walk must not find a rate in the public answer)
  spies.push(spyOn(db.query.campDays, "findFirst").mockImplementation((async () => ({ id: CID, date: TODAY, half: "AM", units: 1, status: "PLANNED", campPackageId: "cp1", campWeekId: "w1", checkinToken: "ctoken-123456", checkinTokenExpiresAt: new Date(`${TODAY}T23:59:59+07:00`), package: { studentId: "s9" } })) as any));
  // ⚠️ The day element is the ADMIN package DTO's (`toPackageDTO` — exactly its keys today), RELAYED by the public scan with no
  // allow-list: clean today because that element carries no rate; named in TASK-501's report as the next instance of the class.
  spies.push(spyOn(campSvc, "markDay").mockImplementation((async () => ({ package: { totalUnits: 10, usedUnits: 3, days: [{ dayId: CID, weekId: "w1", weekName: "Week 1", date: TODAY, half: "AM", units: 1, status: "ATTENDED", undoReason: null }] } })) as any));
  spies.push(spyOn(campSvc, "getDayCheckinQr").mockImplementation((async () => ({ token: "ctoken-123456" })) as any));
  setSystemTime(new Date(`${TODAY}T16:10:00+07:00`));
};
let ip = 0;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await rootApp.fetch(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": `10.51.0.${++ip}` }, body: body ? JSON.stringify(body) : undefined }));
  return { status: r.status, body: (await r.json()) as any };
};
const PROBES: Record<string, () => Promise<{ status: number; body: any }>> = {
  "GET /api/openapi.json": () => call("GET", "/api/openapi.json"),
  "POST /api/checkin": () => call("POST", "/api/checkin", { token: "token-123456" }),
  "POST /api/checkin/camp": () => call("POST", "/api/checkin/camp", { token: "ctoken-123456" }),
  "POST /api/checkin/shopfront/lookup": () => call("POST", "/api/checkin/shopfront/lookup", { phone: PHONE }),
  "POST /api/checkin/shopfront": () => call("POST", "/api/checkin/shopfront", { phone: PHONE, bookingId: BID }),
  "POST /api/checkin/shopfront/batch": () => call("POST", "/api/checkin/shopfront/batch", { phone: PHONE, items: [{ bookingId: BID }, { campDayId: CID }] }),
};
describe("🔑 the EXERCISED routes — key 59's promise checked WHERE THE MASK DOES NOT RUN", () => {
  test("every exercised-evidence route has a probe, and no probe is for a route that isn't unguarded", () => {
    const exercised = PRE_GUARD.filter((u) => EVIDENCE[u.route]?.how === "exercised").map((u) => u.route).sort();
    expect(Object.keys(PROBES).sort()).toEqual(exercised);
  });
  for (const route of Object.keys(PROBES)) {
    test(`${route} — answers 200, from fixtures that DO carry coach rates, and no \`COACH_RATE_FIELDS\` name at any depth`, async () => {
      world();
      const r = await PROBES[route]!();
      expect({ route, status: r.status }).toEqual({ route, status: 200 });
      const keys = allKeys(r.body);
      expect(keys.length).toBeGreaterThan(0);
      expect({ route, found: COACH_RATE_FIELDS.filter((f) => keys.includes(f)) }).toEqual({ route, found: [] });
      expect({ route, leaked: JSON.stringify(r.body).match(/45000|50000|40000|admin-dong/)?.[0] ?? null }).toEqual({ route, leaked: null });
    });
  }
});
