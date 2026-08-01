// Route-level test for `GET /students/eligible` (TASK-051) — proves the literal path is NOT shadowed by
// `GET /students` (the TASK-029 lesson) and that the type enum is enforced.
//
// No service mock — and since TASK-072 that's a free choice rather than a workaround. (It used to be forced:
// `./api` was already imported by another test file whose whole-module `mock.module` had won the race, so a
// late one here wouldn't apply. Those stubs are gone; narrow spies would work fine now if this ever needs one.)
// This uses the assertion that needs no DB and still proves dispatch — `?type=FIRST_TRIAL` must 400.
// If the request were being served by `GET /students` (whose query schema has only optional q/limit), an
// unknown `type` param would simply be ignored and the response would be 200. A 400 can therefore only come
// from the eligible route's own `z.enum([...])`. The 200 path hits the DB, so it's deploy smoke.
import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.SKIP_AUTH = "true";

const { api } = await import("./api");

describe("GET /students/eligible (TASK-051)", () => {
  test("🔑 not shadowed by /students: an unsupported type is rejected by THIS route's enum → 400", async () => {
    // FIRST_TRIAL / SINGLE_SESSION are deliberately not served here (they use `GET /students?q=`).
    expect((await api.request("/students/eligible?type=FIRST_TRIAL")).status).toBe(400);
    expect((await api.request("/students/eligible?type=NONSENSE")).status).toBe(400);
  });

  test("a missing type → 400 (the endpoint is type-driven by design)", async () => {
    expect((await api.request("/students/eligible")).status).toBe(400);
  });

  test("control: plain /students ignores an unknown query param (so the 400s above prove dispatch)", async () => {
    const res = await api.request("/students?type=FIRST_TRIAL&limit=1");
    expect(res.status).not.toBe(400); // reaches the search handler, not the eligible enum
  });
});
