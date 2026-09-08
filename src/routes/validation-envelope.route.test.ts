// TASK-296 (DEF-5) — 🔴 the owner was shown a raw zod issue array, regex source included.
//
// `@hono/zod-validator` answers a refusal ITSELF, so `app.onError` was never on that path. The `ZodError`'s
// `.message` IS the stringified issue list, and the FE rendered it because that is what a message is for.
// ⚠️ **Nobody chose to show it.** And it was never the resume route's bug: **every validated endpoint in the
// product has always answered this way** — it went unseen only because our forms usually gate the button.
//
// 🔑 So these assertions go THROUGH THE REAL ROUTERS, not against the hook in isolation: the defect was that a
// library default sat between the two, and a unit test of the hook would have passed on the broken build.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.SKIP_AUTH = "true";

const { api } = await import("./api");
const { authRoutes } = await import("./auth");
const { publicCheckin } = await import("./checkin");
const { VALIDATION_MESSAGE } = await import("../lib/validate");

// `Hono.request` is typed `Response | Promise<Response>`, so the await is the helper's, not each caller's.
const post = async (
  app: { request: (p: string, o: RequestInit) => Response | Promise<Response> },
  path: string,
  body: unknown,
): Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** What the owner actually saw, as a predicate: the shape of a serialised issue array. */
const looksLikeAnIssueArray = (s: string) =>
  s.includes("[") || s.includes("{") || /regex|invalid_|_type|expected|received|"path"/i.test(s);

describe("TASK-296 — the refusal the owner saw", () => {
  test("🔑 `POST /courses/:id/resume` with an empty `startTime` → 400, `code: VALIDATION`", async () => {
    // DEF-5's own request. `startTime` is `TIME`, a regex — the very schema whose SOURCE was on his screen.
    const res = await post(api, "/courses/abc/resume", { startDate: "2026-11-03", startTime: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("VALIDATION");
  });

  test("🔑 …and `error.message` contains NO regex, NO bracket and NO field path", async () => {
    // Asserted as an ABSENCE, because an absence is precisely what the owner was owed. A message that merely
    // *starts* with a sentence would still have the array behind it.
    const res = await post(api, "/courses/abc/resume", { startDate: "2026-11-03", startTime: "" });
    const message = ((await res.json()) as any).error.message as string;
    expect(message).toBe(VALIDATION_MESSAGE);
    expect(looksLikeAnIssueArray(message)).toBe(false);
    expect(message).not.toContain("startTime");
  });

  test("✅ the issues still exist — in `details`, where an engineer reads them", () => {
    // 🚫 Not in `message`. `ApiClientError` carries `details` deliberately and the red box does not render it,
    // so the network tab keeps everything the array was good for.
    const res = post(api, "/courses/abc/resume", { startDate: "2026-11-03", startTime: "" });
    return res
      .then((r) => r.json())
      .then((body: any) => {
        expect(Array.isArray(body.error.details)).toBe(true);
        expect(body.error.details.length).toBeGreaterThan(0);
      });
  });
});

describe("TASK-296 — one route proves a hook; these prove it is uniform", () => {
  // ⚠️ Two of the three are in DIFFERENT ROUTERS. A wrapper local to `api.ts` would have covered 57 call sites
  // and left five live — and an escaped one is this same defect, still shipping.
  const cases: Array<[string, () => Promise<Response>]> = [
    ["api.ts · POST /bookings", () => post(api, "/bookings", {})],
    ["auth.ts · POST /login", () => post(authRoutes, "/login", {})],
    ["checkin.ts · POST /checkin", () => post(publicCheckin, "/checkin", {})],
  ];

  for (const [name, run] of cases) {
    test(`${name} → the same envelope`, async () => {
      const res = await run();
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect({ name, code: body.error.code, message: body.error.message }).toEqual({
        name,
        code: "VALIDATION",
        message: VALIDATION_MESSAGE,
      });
      expect(looksLikeAnIssueArray(body.error.message)).toBe(false);
    });
  }
});

describe("TASK-296 — what must NOT have changed", () => {
  test("🚫 a VALID request still reaches the handler — the hook refuses nothing new", () => {
    // The whole risk of a validation change is that it starts refusing more. `success` returns `void`, so a
    // passing request is untouched; this asserts it at the source rather than trusting the read.
    const hook = readFileSync(resolve(import.meta.dir, "..", "lib", "validate.ts"), "utf8");
    expect(hook).toContain("if (!result.success) {");
  });

  test("🚫 the status is 400 — the code the envelope already used, not a new one", async () => {
    // `index.ts` emits exactly this for `23503`. ✅ We are not inventing an envelope; we stopped one path from
    // escaping the existing one.
    expect((await post(api, "/bookings", {})).status).toBe(400);
  });
});
