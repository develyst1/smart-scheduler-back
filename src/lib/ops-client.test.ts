import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { attachTeacherQuotas, drawFreelanceBudget, releaseFreelanceBudget } from "./ops-client";

// ops-client reads OPS_API_URL at call time (see ops-client.ts), so setting it here is enough.
const origFetch = globalThis.fetch;
const origUrl = process.env.OPS_API_URL;
process.env.OPS_API_URL = "http://ops.test";

afterEach(() => {
  globalThis.fetch = origFetch;
});
afterAll(() => {
  if (origUrl === undefined) delete process.env.OPS_API_URL;
  else process.env.OPS_API_URL = origUrl;
});

/** Stub global fetch; capture the parsed request bodies for assertions. */
function mockFetch(status: number) {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({}), { status });
  }) as unknown as typeof fetch;
  return calls;
}

describe("ops-client freelance budget (TASK-002)", () => {
  test("drawFreelanceBudget posts an OUT/BOOKING movement in satang", async () => {
    const calls = mockFetch(201);
    const r = await drawFreelanceBudget("teacher-1", 50000, {
      refId: "b1",
      idempotencyKey: "fl-book:b1",
      allowNegative: false,
    });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain("/api/v1/catalog/items/by-ref/movements");
    expect(calls[0].body).toMatchObject({
      externalSource: "smart-scheduler",
      externalRef: "teacher-1",
      direction: "OUT",
      quantity: 50000,
      amountMinor: 50000,
      refType: "BOOKING",
      refId: "b1",
      idempotencyKey: "fl-book:b1",
      allowNegative: false,
    });
  });

  test("drawFreelanceBudget surfaces a 409 as blocked (budget exhausted → abort booking)", async () => {
    mockFetch(409);
    const r = await drawFreelanceBudget("teacher-1", 50000, { idempotencyKey: "fl-book:b2" });
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
  });

  test("drawFreelanceBudget forwards allowNegative override", async () => {
    const calls = mockFetch(201);
    await drawFreelanceBudget("teacher-1", 50000, { allowNegative: true });
    expect(calls[0].body.allowNegative).toBe(true);
  });

  test("releaseFreelanceBudget posts an IN/BOOKING_REVERSAL movement of the same amount", async () => {
    const calls = mockFetch(201);
    const r = await releaseFreelanceBudget("teacher-1", 50000, {
      refId: "b1",
      idempotencyKey: "fl-unbook:b1",
    });
    expect(r.ok).toBe(true);
    expect(calls[0].body).toMatchObject({
      direction: "IN",
      quantity: 50000,
      amountMinor: 50000,
      refType: "BOOKING_REVERSAL",
      refId: "b1",
      idempotencyKey: "fl-unbook:b1",
    });
  });

  test("no-op (skipped) when OPS_API_URL is unset — dev/best-effort", async () => {
    const saved = process.env.OPS_API_URL;
    delete process.env.OPS_API_URL;
    const calls = mockFetch(201);
    const r = await drawFreelanceBudget("teacher-1", 50000, {});
    expect(r.skipped).toBe("OPS_API_URL unset");
    expect(calls).toHaveLength(0); // never hit the network
    process.env.OPS_API_URL = saved;
  });
});

describe("attachTeacherQuotas budget fields (TASK-008)", () => {
  test("maps ops EXPENSE item → satang budget/remaining/reorder + overLimit", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              externalRef: "t1",
              salePriceMinor: 50000,
              quantityOnHand: 120000,
              reorderLevel: 30000,
              metadata: { kind: "FREELANCE_BUDGET", monthlyBudgetMinor: 200000 },
            },
            {
              externalRef: "t2",
              salePriceMinor: 40000,
              quantityOnHand: 0,
              reorderLevel: null,
              metadata: null,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const res = await attachTeacherQuotas([
      { id: "t1", hourlyRate: null },
      { id: "t2", hourlyRate: null },
    ]);
    expect(res[0]).toMatchObject({
      hourlyRate: 500,
      remainingMinor: 120000,
      budgetMinor: 200000,
      reorderMinor: 30000,
      overLimit: false,
    });
    expect(res[1]).toMatchObject({
      remainingMinor: 0,
      budgetMinor: null,
      reorderMinor: null,
      overLimit: true, // remainingMinor ≤ 0 → auto-hidden
    });
  });
});
