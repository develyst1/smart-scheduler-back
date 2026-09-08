// TASK-297 — three paths answered without reaching `app.onError`, and one returned no envelope at all.
//
// 🔑 These were found by asking a REACHABILITY question, not a correctness one — every line looks right where
// it is written. *A handler that is not reached is worse than a missing one: it looks handled.*
//
// ⚠️ None of them is on the owner's release path: (1) is read by LINE's servers, (2) by a calendar client,
// (3) by a developer typo or a stale client. **They are worth closing because DEF-5 established that "nobody
// would ever hit it" survives exactly until one gate moves.**
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.SKIP_AUTH = "true";

const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));

describe("TASK-297 (3) — an unknown path answers with the envelope", () => {
  test("🔑 …and `res.json()` on it PARSES — which is the whole defect", () => {
    // Hono's default 404 is plain text, so a client doing `res.json()` got a parse error rather than a
    // refusal it could read. The status is unchanged; only the body is now readable.
    return get("/api/no-such-route").then(async (res) => {
      expect(res.status).toBe(404);
      const body = (await res.json()) as any; // would THROW on the old plain-text body
      expect(body.error.code).toBe("NOT_FOUND");
      expect(typeof body.error.message).toBe("string");
    });
  });

  test("a 404 is not a thrown error — which is why `onError` never saw it", () => {
    // Named as a test because it is the mechanism, not a detail: `onError` handles throws, and a missing route
    // throws nothing. The two handlers are siblings, not a fallback chain.
    const INDEX = code(src("src/index.ts"));
    expect(INDEX).toContain("app.notFound((c) =>");
    expect(INDEX).toContain("app.onError((err, c) => {");
  });
});

describe("TASK-297 (1) — the webhook refusal is an object, not a string", () => {
  test("🔴 `error` was a bare STRING, so `.code` and `.message` were both undefined", () => {
    const W = code(src("src/routes/webhooks.ts"));
    expect(W).toContain('return c.json({ error: { code: "INVALID_SIGNATURE", message: "invalid signature" } }, 401);');
    expect(W).not.toContain('{ error: "invalid signature" }');
  });

  test("🚫 the signature CHECK and the 401 are untouched — only the shape moved", () => {
    const W = code(src("src/routes/webhooks.ts"));
    expect(W).toContain("if (!verifyLineSignature(body, signature, secret)) {");
    expect(W).toContain(", 401);");
  });
});

describe("TASK-297 (2) — the ICS route KEEPS its plain 404, on purpose", () => {
  test("⚪ left as plain text because its reader is a calendar client, not our envelope", () => {
    // 🚫 NOT changed for symmetry — changed only because it had to be. `c.notFound()` dispatches to the APP's
    // handler, and (3) gave the app one, so leaving it would have silently switched this route to JSON.
    // Writing the answer out preserves the behaviour and pins it against the next app-level change.
    const C = code(src("src/routes/calendar.ts"));
    expect(C).toContain('const plain404 = () => c.text("404 Not Found", 404);');
    expect(C).not.toContain("c.notFound()");
  });

  test("…and it still answers 404 with a body a calendar client can ignore", () => {
    return get("/api/calendar/nonexistent.ics").then(async (res) => {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("404 Not Found");
    });
  });
});

describe("🔑 TASK-297 — ASKING the reachability question instead of remembering it", () => {
  // @Sober's Question: is there a cheap way to ASK "what answers outside the envelope?", the way `35 = 35`
  // names a stray migration? This is that sweep — and its LIMITS are stated in the test below, because a
  // mechanism that looks complete and is not would be worse than none.
  const FILES = [
    "src/index.ts",
    "src/routes/api.ts",
    "src/routes/auth.ts",
    "src/routes/checkin.ts",
    "src/routes/internal.ts",
    "src/routes/webhooks.ts",
    "src/routes/calendar.ts",
    "src/lib/validate.ts",
  ];

  test("every `c.json({ error: …})` in a router carries a `code` AND a `message`", () => {
    // The bare-string webhook is exactly what this would have caught: `{ error: "invalid signature" }` has
    // neither. Matched on the source rather than by walking routes, because a route that is never requested by
    // a test still ships.
    const offenders: string[] = [];
    for (const f of FILES) {
      const s = code(src(f));
      // Each `error:` occurrence inside a json response, with the 200 characters that follow it.
      for (const m of s.matchAll(/c\.json\(\s*\{?\s*error:/g)) {
        const window = s.slice(m.index, m.index + 200);
        if (!window.includes("code:") || !window.includes("message:")) {
          offenders.push(`${f} :: ${window.split("\n")[0]!.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("⚠️ …and what this sweep CANNOT see, stated so nobody trusts it too far", () => {
    // 🚫 It reads the routers' own source. It does NOT see: a Response built in a helper and returned; a
    // `new Response(...)`; `c.text` / `c.body` with an error status (the ICS route above is deliberately one);
    // a library answering before our code runs (which is what DEF-5 was, and no source sweep would have found
    // it — TASK-296 needed a route-level assertion).
    // ⇒ The honest answer to *"can this be asked rather than remembered?"* is **partly**. This catches the
    // shape errors; the reachability question still needs an eye.
    const V = code(src("src/lib/validate.ts"));
    expect(V).toContain('code: "VALIDATION"'); // TASK-296's hook, still the only validator answer
    const INDEX = code(src("src/index.ts"));
    expect(INDEX).not.toContain("new Response(");
  });
});
