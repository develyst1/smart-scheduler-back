// TASK-270 (DEF-1) — 🔴 the API's status enum is the DATABASE's, and there is exactly one of it.
//
// ## The defect, and why "add PAUSED to the list" was not the fix
// `POST /bookings/:id/pause` returned 200 and wrote `PAUSED`. The tray's own
// `GET /api/bookings?status=PAUSED` returned **400 ZodError**, so it rendered *ไม่มีรายการที่พักไว้* while a
// paused booking existed — **as shipped, pause read as DELETE**. The service filter was correct; the request
// never reached it.
//
// 🔴 There were FOUR copies of "every booking status": the DB enum (9), `validation.ts` (7),
// `types/contract.ts` (7) and `openapi/document.ts` (7). `PAUSED` reached ONE. And `NO_SHOW` had the identical
// gap and **nobody had ever found it** — historical rows render but could not be listed.
// ⇒ **The defect was not a forgotten line. It was that forgetting was possible**, and it had already happened
// twice: once found by a tester, once not found at all.
//
// ⚠️ So the test below **reads the DB enum** and enumerates it. A hand-written list here would be a FIFTH copy
// and would pass on the broken build for every value someone remembered to type.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as v from "./validation";
import { bookingStatus } from "./db/schema";
import { readSrc } from "./lib/read-src";

const root = resolve(import.meta.dir, "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("TASK-270 — every status the DATABASE accepts, the API accepts as a filter", () => {
  test("🔑 enumerate the DB enum — not a list typed here", () => {
    // The whole point: this loop grows by itself. A future `ALTER TYPE … ADD VALUE` reaches the API's contract
    // without anyone remembering four files.
    expect(bookingStatus.enumValues.length).toBeGreaterThanOrEqual(9);
    for (const status of bookingStatus.enumValues) {
      const parsed = v.bookingsQuery.safeParse({ status });
      expect({ status, ok: parsed.success }).toEqual({ status, ok: true });
    }
  });

  test("🔴 the two that were rejected: PAUSED (found by @Tanya) and NO_SHOW (never found)", () => {
    // Named explicitly as well as covered by the loop, because these two are the incident and the near-miss —
    // a regression on either should say which one it was, not "one of nine".
    expect(v.bookingsQuery.safeParse({ status: "PAUSED" }).success).toBe(true);
    expect(v.bookingsQuery.safeParse({ status: "NO_SHOW" }).success).toBe(true);
  });

  test("🚫 …and it still REFUSES a value the database has no room for", () => {
    // Deriving must not become "accept anything". An unknown status is still a clean 400, never a silent
    // fallback that returns the whole table.
    expect(v.bookingsQuery.safeParse({ status: "NOT_A_STATUS" }).success).toBe(false);
    expect(v.bookingsQuery.safeParse({ status: "paused" }).success).toBe(false); // case matters
    expect(v.bookingsQuery.safeParse({ status: "" }).success).toBe(false);
  });
});

describe("TASK-270 — one source, and no literal list survives anywhere else", () => {
  test("🚫 validation.ts derives, and holds no status literals", () => {
    const c = code(src("src/validation.ts"));
    expect(c).toContain("z.enum(bookingStatus.enumValues)");
    // The old shape, and every value it used to name. `SICK_LEAVE` is the tell: it appears in NO other enum
    // in this file, so finding it means the list came back.
    for (const dead of ['"SICK_LEAVE"', '"PENDING_RESCHEDULE"', '"ATTENDED"']) {
      expect({ dead, present: c.includes(dead) }).toEqual({ dead, present: false });
    }
  });

  test("🚫 types/contract.ts derives — and stays a TYPE-ONLY module", () => {
    const c = code(src("src/types/contract.ts"));
    expect(c).toContain("export type BookingStatus = (typeof bookingStatus.enumValues)[number];");
    // 🔑 Q1's answer, asserted rather than believed: `import type` + `typeof` means this file gains NO runtime
    // import, so nothing that pulls the contract can end up pulling a database connection.
    expect(c).toContain('import type { bookingStatus } from "../db/schema";');
    expect(c).not.toMatch(/^import \{/m);
    expect(c).not.toContain('"SICK_LEAVE"');
  });

  test("🚫 openapi/document.ts derives — the published contract cannot disagree with the database", () => {
    const c = code(src("src/openapi/document.ts"));
    expect(c).toContain("enum: [...bookingStatus.enumValues]");
    expect(c).not.toContain('"SICK_LEAVE"');
  });

  test("🔴 the DB enum is the only place the values are spelled", () => {
    // One literal list, in the file the database itself is defined from.
    expect(code(src("src/db/schema.ts"))).toContain('"PAUSED"');
  });
});

describe("TASK-270 §3 — widening the READ enum did not touch the WRITE path", () => {
  test("🔑 `updateStatus` still takes only the four VERBS", () => {
    // This is what makes deriving safe. If the write path took statuses, widening the read enum would have let
    // someone PATCH a booking straight to `PAUSED`, past every guard in `pauseBooking`.
    for (const action of ["confirm", "attend", "sick-leave", "cancel"]) {
      expect({ action, ok: v.updateStatus.safeParse({ action }).success }).toEqual({ action, ok: true });
    }
    for (const notAVerb of ["PAUSED", "NO_SHOW", "pause", "ATTENDED"]) {
      expect({ notAVerb, ok: v.updateStatus.safeParse({ action: notAVerb }).success }).toEqual({
        notAVerb,
        ok: false,
      });
    }
  });

  test("🚫 the read enum is used by ONE thing — the query filter", () => {
    // Sober's check, re-run rather than trusted: if a second consumer appears, the safety argument above needs
    // re-making, and this is where that shows up.
    const c = code(src("src/validation.ts"));
    expect(c.match(/BOOKING_STATUS/g)!.length).toBe(2); // the declaration + `bookingsQuery.status`
    expect(c).toContain("status: BOOKING_STATUS.optional(),");
  });

  test("🚫 the question-shaped status lists are NOT merged into this one", () => {
    // The opposite mistake, and it would be worse: those answer QUESTIONS (*does this free the slot?*, *does
    // this show on the calendar?*) and have real reasons to differ. These four were the same list four times.
    const c = code(src("src/db/schema.ts"));
    expect(c).toContain("export const SLOT_INACTIVE_STATUSES");
    expect(c).toContain("export const CALENDAR_HIDDEN_STATUSES");
    expect(code(src("src/validation.ts"))).not.toContain("SLOT_INACTIVE_STATUSES");
  });
});
