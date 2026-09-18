// SPEC-063 / TASK-184 — `toSessionRow` may not silently drop a DTO field again.
//
// The type annotation is the real guard (a dropped field is now a compile error). This test covers the half a
// type cannot: that the mapper actually READS the column rather than declaring a field it always fills with
// null — which would type-check perfectly and be exactly as broken for the person using the editor.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";

const SRC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const FN = code(SRC.slice(SRC.indexOf("const toSessionRow = ")));
const BODY = FN.slice(0, FN.indexOf("});") + 3);

describe("toSessionRow carries the attendee note (TASK-184)", () => {
  test("🔴 it reads the column — not a hardcoded null that would type-check just as well", () => {
    expect(BODY).toContain("attendeeNote: b.attendeeNote ?? null");
  });

  test("🔴 the mapper is TYPED to the DTO — that is what makes the next dropped field a compile error", () => {
    // This was `(b: any) => ({…})`, an allow-list tied to nothing, which is how TASK-178's note reached the
    // booking DTO and never the plan: the per-session editor could save a note it could not show, and staff
    // overwrite what they cannot see. Fourth compiler-silent allow-list in this feature set.
    expect(BODY).toContain("): PlanSessionRow => ({");
  });

  test("the fields the plan already relied on are still there (regression)", () => {
    for (const f of ["id:", "date:", "startTime:", "status:", "bookingType:", "teacher:", "subject:"]) {
      expect(BODY).toContain(f);
    }
  });
});

// ───────── SPEC-045 / TASK-190 (REQ-052) — the rental lookup is batched, not an N+1 ─────────
// 🔻 TASK-371 (REQ-091 Deploy A) — REWRITTEN, not deleted: the marker is a ROW now (`booking_rentals`), read as a
// RELATION in `withBookingRelations` (Drizzle's one batched relation query), so `bookingsWithRentals` — the
// ledger join by product code — is gone with the `hasRental` it fed. The CLAIM this block makes is unchanged:
// no reader resolves rentals one booking at a time.
describe("the rental row is batched, not an N+1 (TASK-190 → TASK-371)", () => {
  const fnSrc = (name: string) => {
    const at = SRC.indexOf(`export async function ${name}`);
    const rest = SRC.slice(at);
    return rest.slice(0, rest.indexOf("\n}\n") + 2);
  };

  test("🔴 the calendar reads the rental as a RELATION — no lookup inside the loop that maps ~90 bookings", () => {
    const body = fnSrc("getCalendar");
    expect(SRC).toContain("  rental: true,\n"); // in the shared relation set (🔻 TASK-397 added `seats` + `group` after it — still the ONE set)
    expect(SRC).toContain("  group: true,\n} as const;");
    expect(body).toContain("with: withBookingRelations,");
    const loop = body.slice(body.indexOf("for (const row of bookingRows)"), body.indexOf("\n  }\n", body.indexOf("for (const row of bookingRows)")));
    expect(loop).not.toMatch(/await|rentalsByBooking|bookingRentals/);
  });

  test("the paged list — the one HAND-BUILT select — batches over its page, keyed by booking", () => {
    const body = fnSrc("getBookings");
    expect(body).toContain("const rentalRows = await rentalsByBooking(rows.map((r) => r.b.id));");
    expect(body).toContain("rental: rentalRows.get(r.b.id) ?? null,");
  });

  test("an empty id list short-circuits — no query for a page with no bookings", () => {
    const at = SRC.indexOf("async function rentalsByBooking(");
    const body = SRC.slice(at, SRC.indexOf("\n}\n", at));
    expect(body).toContain("if (bookingIds.length === 0) return new Map();");
    expect(body).toContain("inArray(bookingRentals.bookingId, bookingIds)");
  });

  test("🚫 the ledger join is GONE — a rental is a row, not a movement with a product code", () => {
    expect(SRC).not.toContain("bookingsWithRentals");
    expect(SRC).not.toContain("hasRental");
  });
});
