// TASK-399 (`REQ-095` Stage 2b, SPEC-081 §3 2b) — the `balance-duo` price group (four items from the same card), the
// price follows the GROUP's kind (`resolvePriceGroup(subjectId, groupKind)`: three branches, FIVE callers — the day-end
// revenue sweep is the one that POSTS), the walk-in seat (`SINGLE_SESSION` + `groupId`: a live GROUP row, the body
// must match, the cap through the SAME count, no extend by construction), the group DTO's `priceGroup`, the
// `--dry-run` on `ensure-sale-items`. No migration (42 = 42).
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GROUP_KIND_PRICE_GROUP, PRICE_GROUPS, SALE_ITEMS, VOUCHER_EXCLUDED_GROUPS, isSellable, listPriceMinor, revenueItemRef, sellablePackages, voucherAllowsProgram } from "./sale-items";
import { toBookingDTO } from "../db/mappers";
import { ApiException } from "./http";
import * as v from "../validation";
import * as svc from "../services/scheduler.service";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const SCHED = code(src("src/services/scheduler.service.ts"));
const JOB = code(src("src/services/jobs.service.ts"));
const T1 = "11111111-1111-4111-8111-111111111111", G1 = "22222222-2222-4222-8222-222222222222";

describe("🔴 the catalogue — `balance-duo` by value, four items from the SAME card/flatMap, voucher-excluded", () => {
  test("the four DUO prices (VAT-incl.) and refs: 1h 1,900 · 4h 6,800 · 6h 9,360 · 10h 14,200", () => {
    expect(PRICE_GROUPS).toContain("balance-duo");
    expect(listPriceMinor("session-balance-duo")).toBe(190000);
    expect(listPriceMinor("course-balance-duo-4")).toBe(680000);
    expect(listPriceMinor("course-balance-duo-6")).toBe(936000);
    expect(listPriceMinor("course-balance-duo-10")).toBe(1420000);
    const duo = SALE_ITEMS.filter((i) => i.externalRef.includes("balance-duo")).map((i) => i.externalRef).sort();
    expect(duo).toEqual(["course-balance-duo-10", "course-balance-duo-4", "course-balance-duo-6", "session-balance-duo"]);
    expect(sellablePackages().filter((p) => p.priceGroup === "balance-duo").map((p) => p.size).sort((a, b) => a - b)).toEqual([1, 4, 6, 10]);
    for (const size of [1, 4, 6, 10]) expect(isSellable("balance-duo", size)).toBe(true);
    // Group = the existing `balance-group` — nothing added there (owner §8)
    expect(listPriceMinor("session-balance-group")).toBe(109000);
    expect(isSellable("balance-group", 4)).toBe(false);
  });
  test("a voucher may not book a DUO (course-only, like the other Balance programs); the kind → price group mapping is ONE object", () => {
    expect(VOUCHER_EXCLUDED_GROUPS.has("balance-duo")).toBe(true);
    expect(voucherAllowsProgram("balance-duo")).toBe(false);
    expect(GROUP_KIND_PRICE_GROUP).toEqual({ DUO: "balance-duo", GROUP: "balance-group" });
    expect(revenueItemRef("SINGLE_SESSION", "balance-duo")).toBe("session-balance-duo");
  });
  test("no hand-written rows: the card is the only place the four prices appear (source)", () => {
    const S = code(src("src/lib/sale-items.ts"));
    expect(S).toContain('"balance-duo": { 1: THB(1900), 4: THB(6800), 6: THB(9360), 10: THB(14200) },');
    expect((S.match(/balance-duo/g) ?? []).length).toBe(5); // the type · PRICE_GROUPS · the mapping · VOUCHER_EXCLUDED · the card
  });
});

describe("🔴 the resolver — three branches by value; FIVE callers by source, the day-end sweep among them", () => {
  test("`resolvePriceGroup`: DUO ⇒ balance-duo, GROUP ⇒ balance-group — no subject read; solo ⇒ the subject's group; no subject ⇒ null", async () => {
    const reads: any[] = [];
    const exec = { query: { subjects: { findFirst: async (q: any) => { reads.push(q); return { priceGroup: "onewheel" }; } } } };
    expect(await svc.resolvePriceGroup(T1, "DUO", exec)).toBe("balance-duo");
    expect(await svc.resolvePriceGroup(T1, "GROUP", exec)).toBe("balance-group");
    expect(reads).toHaveLength(0); // the kind wins WITHOUT touching the subject
    expect(await svc.resolvePriceGroup(T1, null, exec)).toBe("onewheel");
    expect(await svc.resolvePriceGroup(T1, undefined, exec)).toBe("onewheel");
    expect(reads).toHaveLength(2);
    expect(await svc.resolvePriceGroup(null, null, exec)).toBeNull();
  });
  test("`groupKindOf`: a live GROUP row's kind; a lesson / OTHER / unknown id ⇒ null", async () => {
    // 🔴 the OTHER fixture carries a DUO kind on purpose: the TYPE must refuse it, not the kind (mutation I passed until this)
    const rows: Record<string, any> = { g: { bookingType: "GROUP", otherKind: "DUO" }, o: { bookingType: "OTHER", otherKind: "DUO" }, l: { bookingType: "SINGLE_SESSION", otherKind: null } };
    const exec = { query: { bookings: { findFirst: async (q: any) => { const id = JSON.stringify(q.where.toString()); return rows[Object.keys(rows).find((k) => q.where({ id: k }, { eq: (a: any, b: any) => a === b })) ?? ""] ?? null; } } } };
    // the where callback is exercised by hand: pick the row whose id the callback accepts
    const kindOf = async (id: string) => svc.groupKindOf({ query: { bookings: { findFirst: async () => rows[id] ?? null } } }, id);
    expect(await kindOf("g")).toBe("DUO");
    expect(await kindOf("o")).toBeNull();
    expect(await kindOf("l")).toBeNull();
    expect(await kindOf("nope")).toBeNull();
    expect(await svc.groupKindOf(exec, null)).toBeNull();
  });
  test("🔴 FIVE call sites, each naming what it knows — the two `insertBooking` gates, the discount capture, the course create, and the day-end REVENUE SWEEP (the one that posts)", () => {
    const calls = (s: string) => (s.match(/resolvePriceGroup\(/g) ?? []).length;
    expect(calls(SCHED) - 1).toBe(4); // minus the definition
    expect(calls(JOB)).toBe(1);
    const I = region(SCHED, "async function insertBooking(", "\n}\n");
    expect(I).toContain("voucherAllowsProgram(await resolvePriceGroup(input.subjectId, input.groupKind ?? null, exec))");
    expect(I).toContain("isSellable(await resolvePriceGroup(input.subjectId, input.groupKind ?? null, exec), 1)");
    expect(region(SCHED, "async function captureBookingDiscount(", "\n}\n")).toContain("await resolvePriceGroup(input.subjectId, input.groupKind ?? null);");
    const C = region(SCHED, "export async function createCoursePackage(", "\n}\n");
    expect(C).toContain("const courseGroupKind = input.groupKey ? await groupKindOfKey(db, input.groupKey) : null;");
    expect(C).toContain('const priceGroup = await resolvePriceGroup(input.subjectId, input.duo ? "DUO" : courseGroupKind);'); // 🔻 TASK-420: a DUO course prices from the DUO group
    // 🔴 the sweep selects the seat's group and prices by its kind — else a DUO walk-in posts `session-balance-private`
    expect(JOB).toContain("groupId: bookings.groupId,");
    expect(JOB).toContain("const priceGroup = await resolvePriceGroup(b.subjectId, b.groupId ? await groupKindOf(db, b.groupId) : null);");
    // no caller is left on the one-argument form
    expect(SCHED + JOB).not.toMatch(/resolvePriceGroup\((input|b)\.subjectId\)/);
    expect(SCHED).not.toMatch(/resolvePriceGroup\(input\.subjectId, exec\)/);
  });
  test("🔴 by value: a DUO walk-in posts `session-balance-duo` at day-end — the sweep's two-step composed as the job does it", async () => {
    const kind = await svc.groupKindOf({ query: { bookings: { findFirst: async () => ({ bookingType: "GROUP", otherKind: "DUO" }) } } }, G1);
    const group = await svc.resolvePriceGroup(T1, kind, { query: { subjects: { findFirst: async () => ({ priceGroup: "balance-private" }) } } });
    expect(revenueItemRef("SINGLE_SESSION", group)).toBe("session-balance-duo");
    expect(listPriceMinor(revenueItemRef("SINGLE_SESSION", group)!)).toBe(190000); // ฿1,900, not the subject's ฿1,390
    // and a solo session on the same subject still posts the subject's price
    const solo = await svc.resolvePriceGroup(T1, null, { query: { subjects: { findFirst: async () => ({ priceGroup: "balance-private" }) } } });
    expect(revenueItemRef("SINGLE_SESSION", solo)).toBe("session-balance-private");
  });
});

describe("🔴 the walk-in seat — validation, the service (404 / 400 / the SAME cap / no extend), the price by kind", () => {
  test("`groupId` on a SINGLE_SESSION passes; on every other type refused (the walk-in's field, not a course's / a voucher's / an OTHER's)", () => {
    const base = { student: { id: T1 }, teacherId: T1, subjectId: T1, date: "2026-10-01", startTime: "10:00" };
    expect(v.createBooking.safeParse({ ...base, bookingType: "SINGLE_SESSION", groupId: G1 }).success).toBe(true);
    for (const bookingType of ["FIRST_TRIAL", "COURSE_PACKAGE", "VOUCHER", "OTHER"]) {
      const extra = bookingType === "COURSE_PACKAGE" ? { courseId: T1 } : bookingType === "VOUCHER" ? { voucherId: T1 } : bookingType === "OTHER" ? { otherTitle: "x", student: undefined } : {};
      const r = v.createBooking.safeParse({ ...base, ...extra, bookingType, groupId: G1 });
      expect({ bookingType, ok: r.success }).toEqual({ bookingType, ok: false });
    }
  });
  test("`createBooking` (source): a live GROUP row ⇒ else 404 `ไม่พบกลุ่ม`; teacher / date / start must match ⇒ else 400; the kind resolved ONCE and handed down; the cap through `assertSeatFree` inside the tx, before the insert", () => {
    const C = region(SCHED, "export async function createBooking(", "\n}\n");
    expect(C).toContain('if (!g || g.bookingType !== "GROUP" || !COURSE_LIVE.has(g.status)) throw notFound("ไม่พบกลุ่ม");');
    expect(C).toContain("const same = g.teacherId === input.teacherId && g.date === input.date && hhmm(g.startTime) === hhmm(input.startTime);");
    expect(C).toContain('if (!same) throw badRequest("คาบต้องใช้ครู/วัน/เวลาเดียวกับกลุ่ม");');
    expect(C).toContain("input = { ...input, groupKind: await groupKindOf(db, input.groupId) };");
    expect(C.indexOf("groupKind: await groupKindOf(")).toBeLessThan(C.indexOf("captureBookingDiscount(input)"));
    expect(C).toContain("if (input.groupId) await assertSeatFree(tx, input.groupId, input.date);");
    expect(C.indexOf("assertSeatFree(tx, input.groupId")).toBeLessThan(C.indexOf("const id = await insertBooking(tx, studentId, input);"));
    // 🚫 no extend for a walk-in: the create never calls the extend path
    expect(C).not.toMatch(/seatOnGroup\(|groupTemplate\(/);
    expect(SCHED).not.toContain("GROUP_NO_DATE");
  });
  test("the cap is ONE count: `seatOnGroup` (the course seat) and the walk-in both go through `assertSeatFree`", () => {
    expect(region(SCHED, "async function seatOnGroup(", "\n}\n")).toContain("await assertSeatFree(tx, row.id, date);");
    expect((SCHED.match(/await assertSeatFree\(tx, /g) ?? []).length).toBe(2);
    const F = region(SCHED, "async function assertSeatFree(", "\n}\n");
    expect(F).toContain("inArray(bookings.status, [...COURSE_LIVE_STATUSES])");
    expect(F).toContain('if (live >= cap) throw conflict("GROUP_FULL", `วันที่ ${date} กลุ่มเต็ม (${live}/${cap})`);');
  });
  test("the route through the ROOT app: a walk-in ⇒ 201 { booking }; the 404 / 400 / 409 envelopes pass through by value", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const s = spyOn(svc, "createBooking").mockImplementation((async (input: any) => {
      calls.push(input);
      if (input.groupId === "00000000-0000-4000-8000-000000000404") throw new ApiException(404, "NOT_FOUND", "ไม่พบกลุ่ม");
      if (input.groupId === "00000000-0000-4000-8000-000000000400") throw new ApiException(400, "VALIDATION", "คาบต้องใช้ครู/วัน/เวลาเดียวกับกลุ่ม");
      if (input.groupId === "00000000-0000-4000-8000-000000000409") throw new ApiException(409, "GROUP_FULL", "วันที่ 2026-10-01 กลุ่มเต็ม (2/2)");
      return { booking: { id: "s-1", groupId: input.groupId, groupName: "DUO A+B" }, course: null };
    }) as any);
    try {
      const post = (groupId: string) => rootApp.fetch(new Request("http://localhost/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student: { id: T1 }, teacherId: T1, subjectId: T1, date: "2026-10-01", startTime: "10:00", bookingType: "SINGLE_SESSION", groupId }) }));
      const ok = await post(G1);
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as any).booking).toMatchObject({ groupId: G1, groupName: "DUO A+B" });
      expect(calls.at(-1)).toMatchObject({ bookingType: "SINGLE_SESSION", groupId: G1 });
      expect((await post("00000000-0000-4000-8000-000000000404")).status).toBe(404);
      expect((await post("00000000-0000-4000-8000-000000000400")).status).toBe(400);
      const full = await post("00000000-0000-4000-8000-000000000409");
      expect(full.status).toBe(409);
      expect(await full.json()).toEqual({ error: { code: "GROUP_FULL", message: "วันที่ 2026-10-01 กลุ่มเต็ม (2/2)" } });
    } finally { s.mockRestore(); }
  });
});

describe("🔑 the group DTO carries `priceGroup` from the resolver's own mapping; `ensure-sale-items --dry-run` writes nothing", () => {
  test("DTO by value: a DUO group ⇒ `balance-duo`; a GROUP ⇒ `balance-group`; an OTHER has no `group`", () => {
    const teacher = { id: T1, name: "ครูหนึ่ง", nickname: "หนึ่ง", type: "FULL_TIME" };
    const row = (kind: string) => ({ id: "g1", date: "2026-10-01", startTime: "10:00:00", endTime: "11:00:00", bookingType: "GROUP", status: "CONFIRMED", student: null, subject: null, teacher, otherTitle: "G", otherKind: kind, headCount: 2, groupKey: "k", seats: [] });
    expect((toBookingDTO(row("DUO")) as any).group.priceGroup).toBe("balance-duo");
    expect((toBookingDTO(row("GROUP")) as any).group.priceGroup).toBe("balance-group");
    expect((toBookingDTO({ ...row("ECA"), bookingType: "OTHER" }) as any).group).toBeNull();
    expect(code(src("src/db/mappers.ts"))).toContain('priceGroup: o.kind === "DUO" || o.kind === "GROUP" ? GROUP_KIND_PRICE_GROUP[o.kind] : null,');
  });
  test("`scripts/ensure-sale-items.ts --dry-run` (source): reads the box, prints `WOULD be created`, never inserts on the dry path", () => {
    const S = readSrc(readFileSync(resolve(root, "scripts/ensure-sale-items.ts"), "utf8")).replace(/\r\n/g, "\n");
    expect(S).toContain('const dryRun = process.argv.includes("--dry-run");');
    const loop = S.slice(S.indexOf("for (const item of SALE_ITEMS) {"), S.indexOf("console.log(\n"));
    expect(loop.indexOf("if (dryRun) {")).toBeLessThan(loop.indexOf("await db.insert(boItem)"));
    expect(loop).toContain("WOULD be created");
    expect(S).toContain('DRY RUN — nothing written.');
  });
  test("49 = 49 — 2b added no migration (TASK-401 added 0042, TASK-403 added 0043, TASK-406 added 0044, TASK-410 added 0045, TASK-411 added 0046, TASK-418 added 0047, TASK-420 added 0048)", () => {
    expect(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8").match(/"tag"/g)!.length).toBe(49);
  });
});
