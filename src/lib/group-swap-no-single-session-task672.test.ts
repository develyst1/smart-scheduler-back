// TASK-672 — 🔴 LIVE MONEY DEFECT. A GROUP series has NO one-session swap. The Manage-plan dialog sent `{ to, onDate }` (+ a one-session
// `rateMinor`); `groupSeriesSwap` had no `onDate`, so zod STRIPPED it and `swapGroupSeriesTeacher` swapped the WHOLE group from today and
// paid the incoming coach the one-session rate from today onward. The validator now REFUSES `onDate` (and ONLY `onDate`):
// pure, and through the ROOT app with the service spied — a refused body must NEVER reach the service.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { GROUP_SWAP_NO_SINGLE_SESSION, groupSeriesSwap } from "../validation";
import * as otherSeries from "../services/other-series.service";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

const T2 = "22222222-2222-4222-8222-222222222222";
const GKEY = "44444444-4444-4444-8444-444444444444"; // the group key is a uuid; the global param guard (TASK-451) refuses anything else with a 400 of its own
const ONE_SESSION = "2026-10-20";
const issueAt = (r: any, path: string) => (r.success ? undefined : r.error.issues.find((i: any) => i.path.join(".") === path));

describe("🔴 TASK-672 — the validator: `onDate` is refused, ONLY `onDate`", () => {
  test("`{ to, onDate }` ⇒ refused, ONE issue at `onDate`, with the (draft) sentence", () => {
    const r = groupSeriesSwap.safeParse({ to: T2, onDate: ONE_SESSION });
    expect(r.success).toBe(false);
    expect((r as any).error.issues).toHaveLength(1);
    expect(issueAt(r, "onDate")).toMatchObject({ path: ["onDate"], message: GROUP_SWAP_NO_SINGLE_SESSION });
    expect(GROUP_SWAP_NO_SINGLE_SESSION.length).toBeGreaterThan(0); // pinned by reference: the words are a DRAFT
  });
  test("`{ to, onDate, rateMinor }` (the harm: the one-session rate would ride as the from-here-on rate) ⇒ refused", () => {
    const r = groupSeriesSwap.safeParse({ to: T2, onDate: ONE_SESSION, rateMinor: 33000 });
    expect(r.success).toBe(false);
    expect(issueAt(r, "onDate")).toBeDefined();
  });
  test("ANY present `onDate` is refused — an empty string and `null` too — so no shape slips through", () => {
    for (const onDate of [ONE_SESSION, "", null, 0, false]) expect(groupSeriesSwap.safeParse({ to: T2, onDate }).success).toBe(false);
  });
  test("`onDate` together with a valid `fromDate` is STILL refused (it is the field, not the combination)", () => {
    expect(groupSeriesSwap.safeParse({ to: T2, fromDate: ONE_SESSION, onDate: ONE_SESSION }).success).toBe(false);
  });
  test("the bodies that worked still work, and parse to exactly what they did", () => {
    expect(groupSeriesSwap.safeParse({ to: T2 })).toMatchObject({ success: true, data: { to: T2 } });
    expect(groupSeriesSwap.safeParse({ to: T2, fromDate: ONE_SESSION })).toMatchObject({ success: true, data: { to: T2, fromDate: ONE_SESSION } });
    expect(groupSeriesSwap.safeParse({ to: T2, fromDate: ONE_SESSION, rateMinor: 33000 })).toMatchObject({ success: true, data: { to: T2, fromDate: ONE_SESSION, rateMinor: 33000 } });
    expect(groupSeriesSwap.safeParse({ to: T2, rateMinor: 33000 }).success).toBe(true);
    expect("onDate" in (groupSeriesSwap.parse({ to: T2 }) as object)).toBe(false); // an absent key is not invented
  });
  test("🔴 NOT `.strict()`: a stray `from` is still silently STRIPPED (`.data` = `{ to }`) — group-series-req104:210's pin, unchanged", () => {
    expect(groupSeriesSwap.safeParse({ from: "11111111-1111-4111-8111-111111111111", to: T2 }).data).toEqual({ to: T2 });
    expect(groupSeriesSwap.safeParse({ to: T2, whatever: 1 }).success).toBe(true);
  });
  test("`fromDate`, `to` and `rateMinor` keep their own rules (a bad date, a non-uuid `to`, a negative rate are still refused)", () => {
    expect(groupSeriesSwap.safeParse({ to: T2, fromDate: "20-10-2026" }).success).toBe(false);
    expect(groupSeriesSwap.safeParse({ to: "not-a-uuid" }).success).toBe(false);
    expect(groupSeriesSwap.safeParse({ to: T2, rateMinor: -1 }).success).toBe(false);
  });
});

describe("🔴 TASK-672 — through the ROOT app: `PATCH /api/group-series/:key/teacher`, the service spied", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  const calls: unknown[][] = [];
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });
  const patch = async (body: unknown) => {
    process.env.SKIP_AUTH = "true"; // the dev user is a super admin: the coach-rate key is not what this test is about
    calls.length = 0;
    spies.push(spyOn(otherSeries, "swapGroupSeriesTeacher").mockImplementation((async (...a: unknown[]) => { calls.push(a); return { swapped: 1 }; }) as any));
    return rootApp.fetch(new Request(`http://localhost/api/group-series/${GKEY}/teacher`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  };

  test("`{ to, onDate }` ⇒ 400 VALIDATION, the issue at `onDate`, and the service is NEVER called", async () => {
    const res = await patch({ to: T2, onDate: ONE_SESSION });
    const body = (await res.json()) as any;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.details).toEqual([expect.objectContaining({ path: ["onDate"], message: GROUP_SWAP_NO_SINGLE_SESSION })]);
    expect(calls).toEqual([]);
  });
  test("`{ to, onDate, rateMinor }` ⇒ 400 and the service is NEVER called (no coach is ever paid the one-session rate from today)", async () => {
    expect((await patch({ to: T2, onDate: ONE_SESSION, rateMinor: 33000 })).status).toBe(400);
    expect(calls).toEqual([]);
  });
  test("`{ to, fromDate }`, `{ to, fromDate, rateMinor }` and `{ to }` ⇒ 200, and the service is called EXACTLY as today (the body, unchanged)", async () => {
    for (const body of [{ to: T2, fromDate: ONE_SESSION }, { to: T2, fromDate: ONE_SESSION, rateMinor: 33000 }, { to: T2 }]) {
      expect((await patch(body)).status).toBe(200);
      expect(calls).toEqual([[{ groupKey: GKEY }, body]]);
    }
  });
});
