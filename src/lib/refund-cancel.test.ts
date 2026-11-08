import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { ApiException, conflict, errorEnvelope, notFound } from "./http";
import { internalJobs } from "../routes/internal";
import { isAlreadyEnded, REFUND_END_NOTE, REFUND_END_REASON, refundCancel, setRefundCancelDeps, type RefundCancelDeps } from "./refund-cancel";
import { COURSE_END_REASONS, END_REASONS, isCourseEndReason, isEndReason } from "./course-plan";

// TASK-892 — a refund cancels the refunded plan. DB-free: `endCourse` / `endVoucher` are fakes. No LINE call, no real plan touched.

const ID = "11111111-1111-4111-8111-111111111111";
type Call = { fn: "endCourse" | "endVoucher"; id: string; input: { reason: string; note?: string | null }; actor?: string | null };

function fakes(over: Partial<Record<"endCourse" | "endVoucher", (id: string) => Promise<{ removedSessions: number }>>> = {}) {
  const calls: Call[] = [];
  const deps: RefundCancelDeps = {
    endCourse: async (id, input, actor) => (calls.push({ fn: "endCourse", id, input, actor }), over.endCourse ? over.endCourse(id) : { removedSessions: 7 }),
    endVoucher: async (id, input, actor) => (calls.push({ fn: "endVoucher", id, input, actor }), over.endVoucher ? over.endVoucher(id) : { removedSessions: 3 }),
  };
  return { deps, calls };
}
const ended = () => conflict("ALREADY_ENDED", "x");

describe("refundCancel — which function, with which reason", () => {
  test("COURSE → endCourse once, CUSTOMER_CANCELLED + note 'refund', the actor passed on; endVoucher untouched", async () => {
    const f = fakes();
    expect(await refundCancel({ refType: "COURSE", refId: ID, actor: "dong" }, f.deps)).toEqual({ cancelledSessions: 7, alreadyCancelled: false });
    expect(f.calls).toEqual([{ fn: "endCourse", id: ID, input: { reason: "CUSTOMER_CANCELLED", note: "refund" }, actor: "dong" }]);
  });
  test("VOUCHER → endVoucher once, the same reason and note; endCourse untouched", async () => {
    const f = fakes();
    expect(await refundCancel({ refType: "VOUCHER", refId: ID, actor: "dong" }, f.deps)).toEqual({ cancelledSessions: 3, alreadyCancelled: false });
    expect(f.calls).toEqual([{ fn: "endVoucher", id: ID, input: { reason: "CUSTOMER_CANCELLED", note: "refund" }, actor: "dong" }]);
  });
  test("no actor ⇒ null (the end functions record `endedBy` null), never undefined and never invented", async () => {
    const f = fakes();
    await refundCancel({ refType: "COURSE", refId: ID }, f.deps);
    expect(f.calls[0].actor).toBeNull();
    await refundCancel({ refType: "VOUCHER", refId: ID, actor: null }, f.deps);
    expect(f.calls[1].actor).toBeNull();
  });
  test("the reason the refund uses is one BOTH end functions accept (the course set and the voucher set)", () => {
    expect(REFUND_END_REASON).toBe("CUSTOMER_CANCELLED");
    expect(REFUND_END_NOTE).toBe("refund");
    expect(isCourseEndReason(REFUND_END_REASON)).toBe(true);
    expect(isEndReason(REFUND_END_REASON)).toBe(true);
    expect(COURSE_END_REASONS).toContain("CUSTOMER_CANCELLED");
    expect(END_REASONS).toContain("CUSTOMER_CANCELLED");
  });
  test("the cancelled count is the function's own removedSessions (0 is a valid count)", async () => {
    expect(await refundCancel({ refType: "COURSE", refId: ID }, fakes({ endCourse: async () => ({ removedSessions: 0 }) }).deps)).toEqual({ cancelledSessions: 0, alreadyCancelled: false });
    expect((await refundCancel({ refType: "VOUCHER", refId: ID }, fakes({ endVoucher: async () => ({ removedSessions: 12 }) }).deps)).cancelledSessions).toBe(12);
  });
});

describe("refundCancel — already ended is a success that says so", () => {
  test.each(["COURSE", "VOUCHER"] as const)("%s: the ALREADY_ENDED 409 → 200-shaped { 0, true }", async (refType) => {
    const f = fakes({ endCourse: async () => Promise.reject(ended()), endVoucher: async () => Promise.reject(ended()) });
    expect(await refundCancel({ refType, refId: ID }, f.deps)).toEqual({ cancelledSessions: 0, alreadyCancelled: true });
    expect(f.calls).toHaveLength(1); // asked once; no retry, no second function
  });
  test("🔑 ONLY that refusal is mapped: another 409 (COURSE_ENDED / VOUCHER_ENDED), the same code with another status, a 404 and a 400 all pass through", async () => {
    for (const [e, status, code] of [
      [conflict("COURSE_ENDED", "x"), 409, "COURSE_ENDED"],
      [conflict("VOUCHER_ENDED", "x"), 409, "VOUCHER_ENDED"],
      [new ApiException(400, "ALREADY_ENDED", "x"), 400, "ALREADY_ENDED"],
      [notFound("ไม่พบคอร์ส"), 404, "NOT_FOUND"],
      [new ApiException(400, "INVALID_REASON", "x"), 400, "INVALID_REASON"],
    ] as const) {
      const err: any = await refundCancel({ refType: "COURSE", refId: ID }, fakes({ endCourse: async () => Promise.reject(e) }).deps).catch((x) => x);
      expect([err.status, err.code]).toEqual([status, code]);
    }
  });
  test("an unexpected error (a plain Error) is rethrown, not swallowed as 'already cancelled'", async () => {
    const err = await refundCancel({ refType: "VOUCHER", refId: ID }, fakes({ endVoucher: async () => Promise.reject(new Error("db down")) }).deps).catch((x) => x);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("db down");
  });
  test("a malformed answer (no session count) is an error, never a silent 'cancelled 0'", async () => {
    const err = await refundCancel({ refType: "COURSE", refId: ID }, fakes({ endCourse: async () => ({}) as never }).deps).catch((x) => x);
    expect((err as Error).message).toContain("no session count");
  });
  test.each([-1, 1.5, Number.NaN, "7" as unknown as number])("a session count of %p is an error too", async (bad) => {
    const err = await refundCancel({ refType: "VOUCHER", refId: ID }, fakes({ endVoucher: async () => ({ removedSessions: bad }) }).deps).catch((x) => x);
    expect((err as Error).message).toContain("no session count");
  });
  test("isAlreadyEnded: exactly status 409 + code ALREADY_ENDED", () => {
    expect(isAlreadyEnded(conflict("ALREADY_ENDED", "x"))).toBe(true);
    expect(isAlreadyEnded(conflict("OTHER", "x"))).toBe(false);
    expect(isAlreadyEnded(new ApiException(400, "ALREADY_ENDED", "x"))).toBe(false);
    expect(isAlreadyEnded(new Error("ALREADY_ENDED"))).toBe(false);
    expect(isAlreadyEnded({ status: 409, code: "ALREADY_ENDED" })).toBe(false);
    expect(isAlreadyEnded(null)).toBe(false);
  });
});

describe("the contract with scheduler.service (source pins, so a rename there fails here)", () => {
  const S = readFileSync(new URL("../services/scheduler.service.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const body = (from: string, to: string) => S.slice(S.indexOf(from), S.indexOf(to, S.indexOf(from)));
  test("endCourse refuses a second end with conflict('ALREADY_ENDED') and returns removedSessions", () => {
    const fn = body("export async function endCourse(", "// ─────────── TASK-838");
    expect(fn).toContain('throw conflict("ALREADY_ENDED"');
    expect(fn).toContain("removedSessions: doomed.length");
    expect(fn).toContain("endedBy: actor ?? null");
  });
  test("endVoucher refuses a second end with conflict('ALREADY_ENDED') and returns removedSessions", () => {
    const fn = S.slice(S.indexOf("export async function endVoucher("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('throw conflict("ALREADY_ENDED"');
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("removedSessions: doomed.length");
  });
  test("both throw notFound for an unknown id (→ 404)", () => {
    expect(S).toContain('if (!course) throw notFound("ไม่พบคอร์ส");\n  const rows = await exec.query.bookings.findMany({\n    where: (b: any, { and: a, eq: e }: any) => a(e(b.courseId, id), e(b.bookingType, "COURSE_PACKAGE")),');
    expect(S).toContain('if (!voucher) throw notFound("ไม่พบวอยเชอร์");\n  const rows = await exec.query.bookings.findMany({\n    where: (b: any, { eq: e }: any) => e(b.voucherId, id),');
  });
  test("this file calls the end functions and nothing else of the service; it imports no database", () => {
    const src = readFileSync(new URL("./refund-cancel.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/from "\.\.\/db"|from "\.\/db"|drizzle/);
    expect(src).toContain('await import("../services/scheduler.service")');
    expect(src).not.toMatch(/\.(update|insert|delete)\(/);
  });
});

describe("POST /internal/refund-cancel — the route", () => {
  const KEYS = ["INTERNAL_JOB_SECRET"];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  });
  let f: ReturnType<typeof fakes>;
  beforeEach(() => {
    process.env.INTERNAL_JOB_SECRET = "s3cret-892";
    f = fakes();
    setRefundCancelDeps(f.deps);
  });
  afterEach(() => setRefundCancelDeps(null));

  const app = () => {
    const a = new Hono();
    a.onError((err, c) => {
      const { status, body } = errorEnvelope(err);
      return c.json(body, status as 400);
    });
    return a.route("/internal", internalJobs);
  };
  const post = (body: unknown, headers: Record<string, string> = { "x-internal-secret": "s3cret-892" }) =>
    app().request("/internal/refund-cancel", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const j = async (r: Response) => (await r.json()) as any;
  const good = { refType: "COURSE", refId: ID, actor: "dong" };

  test("🔑 the secret gate: no header → 401, a wrong header → 401, no secret configured → 503; the end functions are never called", async () => {
    expect((await post(good, {})).status).toBe(401);
    const wrong = await post(good, { "x-internal-secret": "nope" });
    expect([wrong.status, (await j(wrong)).error.code]).toEqual([401, "UNAUTHORIZED"]);
    delete process.env.INTERNAL_JOB_SECRET;
    const off = await post(good, { "x-internal-secret": "anything" });
    expect([off.status, (await j(off)).error.code]).toEqual([503, "NOT_CONFIGURED"]);
    expect(f.calls).toHaveLength(0);
  });
  test("a good call: 200 { cancelledSessions, alreadyCancelled:false } and the right function with CUSTOMER_CANCELLED", async () => {
    const r = await post(good);
    expect(r.status).toBe(200);
    expect(await j(r)).toEqual({ cancelledSessions: 7, alreadyCancelled: false });
    expect(f.calls).toEqual([{ fn: "endCourse", id: ID, input: { reason: "CUSTOMER_CANCELLED", note: "refund" }, actor: "dong" }]);
  });
  test("VOUCHER goes to endVoucher; actor is optional", async () => {
    const r = await post({ refType: "VOUCHER", refId: ID });
    expect(await j(r)).toEqual({ cancelledSessions: 3, alreadyCancelled: false });
    expect(f.calls).toEqual([{ fn: "endVoucher", id: ID, input: { reason: "CUSTOMER_CANCELLED", note: "refund" }, actor: null }]);
  });
  test("already ended → 200 { 0, true } (a retried refund is not an error)", async () => {
    setRefundCancelDeps(fakes({ endCourse: async () => Promise.reject(ended()) }).deps);
    const r = await post(good);
    expect([r.status, await j(r)]).toEqual([200, { cancelledSessions: 0, alreadyCancelled: true }]);
  });
  test("an unknown id → 404 NOT_FOUND", async () => {
    setRefundCancelDeps(fakes({ endVoucher: async () => Promise.reject(notFound("ไม่พบวอยเชอร์")) }).deps);
    const r = await post({ refType: "VOUCHER", refId: ID });
    expect([r.status, (await j(r)).error.code]).toEqual([404, "NOT_FOUND"]);
  });
  test("any other refusal keeps its own status and code (a 409 COURSE_ENDED is not 'already cancelled')", async () => {
    setRefundCancelDeps(fakes({ endCourse: async () => Promise.reject(conflict("COURSE_ENDED", "x")) }).deps);
    const r = await post(good);
    expect([r.status, (await j(r)).error.code]).toEqual([409, "COURSE_ENDED"]);
  });
  test.each([
    ["no refType", { refId: ID }],
    ["an unknown refType", { refType: "RENTAL", refId: ID }],
    ["a lower-case refType", { refType: "course", refId: ID }],
    ["no refId", { refType: "COURSE" }],
    ["a non-uuid refId", { refType: "COURSE", refId: "abc" }],
    ["an empty actor", { refType: "COURSE", refId: ID, actor: "" }],
    ["an over-long actor", { refType: "COURSE", refId: ID, actor: "a".repeat(101) }],
    ["a numeric actor", { refType: "COURSE", refId: ID, actor: 5 }],
  ])("400 VALIDATION on %s, and nothing is ended", async (_n, body) => {
    const r = await post(body);
    expect([r.status, (await j(r)).error.code]).toEqual([400, "VALIDATION"]);
    expect(f.calls).toHaveLength(0);
  });
  test("the secret is checked BEFORE the work, and a body error does not bypass it (bad body + no secret ⇒ still refused by the gate or the validator, never ended)", async () => {
    await post({ refType: "COURSE", refId: "abc" }, {});
    await post(good, {});
    expect(f.calls).toHaveLength(0);
  });
  test("the route is the ONLY new one: internal.ts still holds the TASK-888 salary-remind lines unchanged (source pin)", () => {
    const src = readFileSync(new URL("../routes/internal.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(src).toContain('.post("/salary-remind", zValidator("json", salaryRemindBody)');
    expect(src).toContain('.post("/salary-remind-now", zValidator("json", payConfirmNowBody)');
    expect((src.match(/\.post\("\/refund-cancel"/g) ?? []).length).toBe(1);
  });
});
