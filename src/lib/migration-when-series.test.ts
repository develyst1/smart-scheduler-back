// TASK-494 — a migration's `when` can never sit below the ledger's newest row, and never jump out of our series.
//
// 🔴 THE MECHANISM (read this before touching `drizzle/meta/_journal.json`): drizzle does NOT apply migrations by name or by
// hash. `migrate` reads ONE number — the newest `created_at` in the ledger — and applies a migration only when its journal
// `when` is GREATER (drizzle-orm pg-core/dialect.js: `lastDbMigration.created_at < migration.folderMillis`). Everything else is
// skipped IN SILENCE, exit 0 (TASK-085: the most expensive class of bug this project has had). So:
//  · a `when` at or below the previous one ⇒ on a box that has the previous one, the new migration NEVER runs;
//  · a `when` above our series (a real `Date.now()`, which `drizzle-kit generate` ALWAYS writes: `when: +new Date()`, no
//    option) runs once — and then every later migration in our series sits below it and NEVER runs.
// The owner's read-only count (09-26), both boxes: sid 97 rows / 97 distinct, uat 78 / 78, min 1782154751279, **max
// 1783000000052 = 0056's own `when`** — the ledger rows beyond ours are pre-split history BELOW the series. That safety holds
// only while every new `when` stays in the series above it. This file is what makes it a rule instead of an accident.
// 📌 The count (files = journal tags) is ALREADY pinned by the census tests, e.g. `camp-day-rate-req104.test.ts` and
// `booking-rental-row-req091.test.ts` (58 = 58) — referenced here, not duplicated.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const JOURNAL = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };

/** Our hand-assigned series starts at 0004 (`1783000000000`) and counts up by one per migration. */
const SERIES_START = 1_783_000_000_000;
/** A million migrations of headroom — and far below any real clock of this era (a `Date.now()` today is ~1790…). */
const SERIES_CEILING = SERIES_START + 1_000_000;
/** The owner's measurement (09-26, sid and uat): the newest ledger row on both boxes — 0056's `when`. */
const LEDGER_MAX_MEASURED = 1_783_000_000_052;
/** The four migrations generated before the series existed, with real clock stamps — history, frozen by value. */
const PRE_SERIES: Array<[string, number]> = [
  ["0000_supreme_zarek", 1_782_154_751_279],
  ["0001_add_reschedule_fields", 1_782_743_601_027],
  ["0002_reschedule_slot_index", 1_782_743_623_109],
  ["0003_app_settings", 1_782_747_790_472],
];

const TEACH = [
  "",
  "🔴 A migration `when` in drizzle/meta/_journal.json is wrong — and drizzle will NOT tell you: it applies a migration only if",
  "   its `when` is GREATER than the newest `created_at` in the ledger, and SKIPS everything else in silence, exit 0 (TASK-085).",
  "   · `drizzle-kit generate` always writes a real Date.now() (~1790…) — above our series, so every LATER migration would be",
  "     skipped forever on every box it reached.",
  "   · Fix: set the new entry's `when` to the previous entry's `when` + 1 (our series starts at 1783000000000 with 0004).",
  "   Offending entries:",
].join("\n");
const fail = (lines: string[]) => { if (lines.length) throw new Error(`${TEACH}\n${lines.map((l) => `     ${l}`).join("\n")}\n`); };

describe("🔴 every migration's `when` — strictly increasing, in our series, above the ledger's newest row", () => {
  test("strictly increasing in journal order (an equal or lower `when` is SKIPPED on any box that has the one before it)", () => {
    const bad: string[] = [];
    JOURNAL.entries.forEach((e, i) => {
      const prev = JOURNAL.entries[i - 1];
      if (prev && !(e.when > prev.when)) bad.push(`${e.tag}: when ${e.when} is not above ${prev.tag}'s ${prev.when} → set it to ${prev.when + 1}`);
    });
    fail(bad);
  });
  test(`from 0004 on, every \`when\` is in our series [${SERIES_START}, ${SERIES_CEILING}) — a Date.now()-shaped one is refused`, () => {
    const bad: string[] = [];
    JOURNAL.entries.forEach((e, i) => {
      if (i < PRE_SERIES.length) return;
      if (e.when < SERIES_START || e.when >= SERIES_CEILING) bad.push(`${e.tag}: when ${e.when} is outside our series → set it to ${JOURNAL.entries[i - 1]!.when + 1}`);
    });
    fail(bad);
  });
  test("the four pre-series migrations are history, frozen by value (real clock stamps from before the series existed)", () => {
    expect(JOURNAL.entries.slice(0, PRE_SERIES.length).map((e) => [e.tag, e.when])).toEqual(PRE_SERIES);
    for (const [, w] of PRE_SERIES) expect(w).toBeLessThan(SERIES_START);
  });
  test("🔑 tied to the owner's measurement: the newest ledger row on sid AND uat (1783000000052) is 0056's own `when`, and every later migration sits above it", () => {
    const i56 = JOURNAL.entries.findIndex((e) => e.tag === "0056_booking_checkin_source");
    expect(JOURNAL.entries[i56]!.when).toBe(LEDGER_MAX_MEASURED);
    const bad = JOURNAL.entries.slice(i56 + 1).filter((e) => !(e.when > LEDGER_MAX_MEASURED)).map((e) => `${e.tag}: when ${e.when} is at or below the measured ledger max ${LEDGER_MAX_MEASURED} — it would never run on sid or uat`);
    fail(bad);
  });
  test("the teaching message says HOW it fails, not just that it did (whoever trips this is adding a migration)", () => {
    let msg = "";
    try { fail(["0099_example: when 1790000000000 is outside our series → set it to 1783000000099"]); } catch (e: any) { msg = e.message; }
    expect(msg).toContain("SKIPS everything else in silence");
    expect(msg).toContain("previous entry's `when` + 1");
    expect(msg).toContain("0099_example");
  });
});
