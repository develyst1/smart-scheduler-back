// TASK-451 — a deterministic uuid for a TEST fixture, from the name the test already calls it.
//
// 🔴 Why this exists rather than a loosened guard: the uuid-param guard (TASK-450) refuses a malformed `:id` at the
// boundary, and a suite that calls the root app with `"b1"` is a suite asserting a shape the API never serves. The
// fixture is the thing that was wrong — so it gets a real uuid, and `uuidFor("b1")` keeps the name a reader needs:
// `DELETE /students/${uuidFor("gone")}` still says *which* student the case is about.
//
// 🚫 Not for product code. Nothing here is random and nothing here is a v4 uuid in the "unpredictable" sense — it is a
// stable name→uuid function, which is exactly what a fixture wants and exactly what an identifier must never be.
import { createHash } from "node:crypto";

const cache = new Map<string, string>();

/** The same seed always gives the same uuid (and different seeds never collide in practice — sha-256). */
export function uuidFor(seed: string): string {
  const hit = cache.get(seed);
  if (hit) return hit;
  const h = createHash("sha256").update(seed).digest("hex");
  // v4-shaped: the version nibble and the variant nibble are fixed, the rest is the digest.
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  cache.set(seed, id);
  return id;
}
