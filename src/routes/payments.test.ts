import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { makePaymentRoutes, type PaymentOps } from "./payments";
import { badRequest, conflict, errorEnvelope, notFound } from "../lib/http";

// TASK-875 / SPEC-099 §8.5 — the HTTP contract of `/api/payments`, with the logic faked (its rules are tested in
// `lib/payment-record.test.ts`). What is proved here: the validation, the status codes, the shapes, and that `actor` is the user.

const C = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";

type Calls = { op: string; args: unknown[] }[];
function setup(over: Partial<PaymentOps> = {}, user: { username?: string } | null = { username: "staff-7" }) {
  const calls: Calls = [];
  const dto = { id: P, refType: "COURSE", refId: C, n: 2, paidOn: "2026-11-20", amountMinor: 40000, method: "CASH", updatedAt: "2026-11-20T03:00:00.000Z" };
  const ops: PaymentOps = {
    listPayments: async (...a: unknown[]) => (calls.push({ op: "list", args: a }), { payments: [dto], feeMinor: 90000, paidMinor: 40000, remainingMinor: 50000 }),
    addInstallment: async (...a: unknown[]) => (calls.push({ op: "add", args: a }), dto),
    patchPayment: async (...a: unknown[]) => (calls.push({ op: "patch", args: a }), dto),
    ...over,
  } as PaymentOps;
  const app = new Hono<{ Variables: { user: { username?: string } | undefined } }>();
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.route("/payments", makePaymentRoutes(ops));
  app.onError((err, c) => {
    const { status, body } = errorEnvelope(err);
    return c.json(body, status as any);
  });
  return { app, calls, dto };
}
const req = (app: Hono<any>, method: string, path: string, body?: unknown) =>
  app.request(`/payments${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as any;
const POST = { refType: "COURSE", refId: C, paidOn: "2026-11-20", amountMinor: 40000, method: "CASH" };

describe("GET /payments", () => {
  test("the §8.5 shape: payments + feeMinor / paidMinor / remainingMinor, and the query reaches the logic", async () => {
    const { app, calls } = setup();
    const r = await req(app, "GET", `?refType=COURSE&refId=${C}`);
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(Object.keys(b).sort()).toEqual(["feeMinor", "paidMinor", "payments", "remainingMinor"]);
    expect(Object.keys(b.payments[0]).sort()).toEqual(["amountMinor", "id", "method", "n", "paidOn", "refId", "refType", "updatedAt"]);
    expect(calls).toEqual([{ op: "list", args: ["COURSE", C] }]);
  });
  test.each([
    ["no query", ""],
    ["a BOOKING ref (slice 2a is course + voucher)", `?refType=BOOKING&refId=${C}`],
    ["a non-uuid refId", "?refType=COURSE&refId=abc"],
    ["no refId", "?refType=VOUCHER"],
  ])("400 VALIDATION — %s", async (_n, q) => {
    const { app, calls } = setup();
    const r = await req(app, "GET", q);
    expect(r.status).toBe(400);
    expect((await json(r)).error.code).toBe("VALIDATION");
    expect(calls).toHaveLength(0);
  });
});

describe("POST /payments (an installment)", () => {
  test("201 { payment }, and the actor is the signed-in user's username", async () => {
    const { app, calls, dto } = setup();
    const r = await req(app, "POST", "", POST);
    expect(r.status).toBe(201);
    expect(await json(r)).toEqual({ payment: dto });
    expect(calls).toEqual([{ op: "add", args: [POST, "staff-7"] }]);
  });
  test("no user on the context → actor null (never a crash)", async () => {
    const { app, calls } = setup({}, null);
    expect((await req(app, "POST", "", POST)).status).toBe(201);
    expect(calls[0].args[1]).toBeNull();
  });
  test.each([
    ["amount 0", { ...POST, amountMinor: 0 }],
    ["a negative amount", { ...POST, amountMinor: -5 }],
    ["a fractional amount (money is whole satang)", { ...POST, amountMinor: 10.5 }],
    ["a string amount", { ...POST, amountMinor: "400" }],
    ["method 'BITCOIN'", { ...POST, method: "BITCOIN" }],
    ["a missing method", { ...POST, method: undefined }],
    ["a date in the wrong shape", { ...POST, paidOn: "20/11/2026" }],
    ["a date that is not on the calendar", { ...POST, paidOn: "2026-02-31" }],
    ["a refType of CAMP", { ...POST, refType: "CAMP" }],
    ["a non-uuid refId", { ...POST, refId: "course-1" }],
  ])("400 VALIDATION — %s", async (_n, body) => {
    const { app, calls } = setup();
    const r = await req(app, "POST", "", body);
    expect(r.status).toBe(400);
    expect((await json(r)).error.code).toBe("VALIDATION");
    expect(calls).toHaveLength(0);
  });
  test("every method of the three is accepted", async () => {
    for (const method of ["TRANSFER", "CASH", "CARD"]) expect((await req(setup().app, "POST", "", { ...POST, method })).status).toBe(201);
  });
  test("the logic's refusals reach the client intact: 409 NO_FEE · 409 CONFLICT · 400 over the fee", async () => {
    const no = await req(setup({ addInstallment: async () => Promise.reject(conflict("NO_FEE", "no fee")) }).app, "POST", "", POST);
    expect([no.status, (await json(no)).error.code]).toEqual([409, "NO_FEE"]);
    const lost = await req(setup({ addInstallment: async () => Promise.reject(conflict("CONFLICT", "race")) }).app, "POST", "", POST);
    expect([lost.status, (await json(lost)).error.code]).toEqual([409, "CONFLICT"]);
    const over = await req(setup({ addInstallment: async () => Promise.reject(badRequest("over the fee")) }).app, "POST", "", POST);
    expect(over.status).toBe(400);
  });
});

describe("PATCH /payments/:id", () => {
  test("{ payment } with the id from the path, the patch from the body, the actor", async () => {
    const { app, calls, dto } = setup();
    const r = await req(app, "PATCH", `/${P}`, { method: "CARD", amountMinor: 70000 });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ payment: dto });
    expect(calls).toEqual([{ op: "patch", args: [P, { method: "CARD", amountMinor: 70000 }, "staff-7"] }]);
  });
  test("each field alone is a valid patch (row 1's amount included — §8.9)", async () => {
    for (const body of [{ method: "CASH" }, { paidOn: "2026-12-01" }, { amountMinor: 1 }]) expect((await req(setup().app, "PATCH", `/${P}`, body)).status).toBe(200);
  });
  test.each([
    ["an empty body", {}],
    ["only unknown keys", { n: 3 }],
    ["amount 0", { amountMinor: 0 }],
    ["a bad method", { method: "CHEQUE" }],
    ["a bad date", { paidOn: "tomorrow" }],
  ])("400 VALIDATION — %s", async (_n, body) => {
    const { app, calls } = setup();
    const r = await req(app, "PATCH", `/${P}`, body);
    expect(r.status).toBe(400);
    expect((await json(r)).error.code).toBe("VALIDATION");
    expect(calls).toHaveLength(0);
  });
  test("400 for a malformed id (never a database error)", async () => {
    const { app, calls } = setup();
    expect((await req(app, "PATCH", "/not-a-uuid", { method: "CASH" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  test("404 for an unknown payment, 409 NO_FEE and 400 over-the-fee pass through", async () => {
    const nf = await req(setup({ patchPayment: async () => Promise.reject(notFound("payment not found")) }).app, "PATCH", `/${P}`, { method: "CASH" });
    expect(nf.status).toBe(404);
    const no = await req(setup({ patchPayment: async () => Promise.reject(conflict("NO_FEE", "x")) }).app, "PATCH", `/${P}`, { amountMinor: 5 });
    expect([no.status, (await json(no)).error.code]).toEqual([409, "NO_FEE"]);
    const over = await req(setup({ patchPayment: async () => Promise.reject(badRequest("over")) }).app, "PATCH", `/${P}`, { amountMinor: 5 });
    expect(over.status).toBe(400);
  });
});

describe("the router's surface", () => {
  test("exactly three routes — GET /, POST /, PATCH /:id — and no DELETE (a payment is corrected, never removed)", () => {
    const routes = makePaymentRoutes({} as PaymentOps).routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
    expect([...new Set(routes)].sort()).toEqual(["GET /", "PATCH /:id", "POST /"]); // each validator is its own entry in the table
  });
  test("the file imports the validator from ../lib/validate (DEF-5), never the library", () => {
    const src = readFileSync(new URL("./payments.ts", import.meta.url), "utf8");
    expect(src).toContain('from "../lib/validate"');
    expect(src).not.toContain("@hono/zod-validator");
  });
});
