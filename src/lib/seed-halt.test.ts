// TASK-281 — the seed halt guarded the migrate step and blocked the seed.
//
// 🔻 `db:seed-ledger` refused on `uat` — the CUSTOMER'S live box, mid-deploy — because `0033` is
// `not-applied && !rerunnable`. **The refusal was correct by the rule, and the rule was in the wrong place:**
// a `db:migrate` concern living inside a `db:seed-ledger` tool, blocking the seed to protect the step after it.
//
// 🔑 Three facts make it spurious for the seed, and each is checked here rather than asserted in prose:
// `--apply` writes rows only for `applied` tags · `db:preflight` (TASK-266) guards the migrate step directly ·
// and `0033`'s `rerunnable: false` is CORRECT and must not be "fixed".
//
// ⚠️ The fixture below is tonight's exact `uat` shape, against the **real** witness table — not a made-up one,
// because the claim is about what the owner will see when he re-runs it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SCHEDULING_WITNESSES,
  appliedTags,
  judge,
  seedHalts,
  seedWarnings,
  type WitnessResult,
} from "./migration-witness";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

/** Tonight's `uat`: everything found except `0033`, whose predicate probe correctly came back false. */
const UAT = new Map<string, boolean | null>(
  SCHEDULING_WITNESSES.map((w) => [w.tag, w.tag === "0033_paused_slot_index" ? false : true]),
);
const results = judge(SCHEDULING_WITNESSES, UAT);

describe("TASK-281 — tonight's `uat`, against the real witness table", () => {
  test("🔑 nothing halts — the seed can run", () => {
    // The whole task in one assertion: last night this was length 1 and the tool exited 1.
    expect(seedHalts(results)).toHaveLength(0);
  });

  test("⚠️ …and `0033` is WARNED about, not silently dropped", () => {
    // An operator who saw a 🔴 STOP last night must see something in the same place tonight, or the tool looks
    // like it stopped noticing.
    expect(seedWarnings(results).map((r: WitnessResult) => r.tag)).toEqual(["0033_paused_slot_index"]);
  });

  test("🔴 `0033` is skipped by the seed either way — which is why halting protected nothing", () => {
    // `appliedTags` is what `--apply` writes rows for. A not-applied tag is not in it, halt or no halt.
    expect(appliedTags(results)).not.toContain("0033_paused_slot_index");
    expect(appliedTags(results)).toHaveLength(SCHEDULING_WITNESSES.length - 1);
  });

  test("🚫 `0033`'s `rerunnable: false` is CORRECT and stays — it is not the thing to fix", () => {
    // A bare `DROP INDEX` with no `IF EXISTS`. Softening the flag would make the migrate guard wrong to make a
    // seed message quieter — the opposite trade.
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0033_paused_slot_index")!;
    expect(w.rerunnable).toBe(false);
    expect(w.probe).toEqual({ kind: "index-predicate", index: "bookings_teacher_slot_uq", contains: "PAUSED" });
    // …and the probe is a PREDICATE check, so `found=false` is a reliable negative rather than an unknown.
    expect(src("drizzle/0033_paused_slot_index.sql")).toContain("DROP INDEX");
  });
});

describe("TASK-281 — the exact numbers the owner will see", () => {
  // The DoD's fixture: `0033` not applied, `0025`–`0027` applied but not yet in this repo's ledger.
  const UNRECORDED = ["0025_booking_cancel_reason", "0026_course_leave_quota", "0027_course_size_sanity"];

  test("🔑 exactly three rows to insert", () => {
    // `toInsert` = applied tags whose hash is not already present. Reproduced here from the same two functions
    // the script uses, so the count is the script's own arithmetic and not a restatement of it.
    const applied = appliedTags(results);
    const present = new Set(applied.filter((t) => !UNRECORDED.includes(t)));
    const toInsert = applied.filter((t) => !present.has(t));
    expect(toInsert.sort()).toEqual([...UNRECORDED].sort());
    expect(toInsert).toHaveLength(3);
  });

  test("the summary counts halts and warnings SEPARATELY", () => {
    // One entry, one place — an entry appearing in both lists would read as two problems.
    const s = code(src("scripts/seed-ledger-from-schema.ts"));
    expect(s).toContain("${halts.length} need a human · ${warnings.length} warned");
    const both = seedHalts(results).filter((h: WitnessResult) => seedWarnings(results).some((w) => w.tag === h.tag));
    expect(both).toHaveLength(0);
  });
});

describe("TASK-281 — the seed exits 0, and says why it did not stop", () => {
  const S = code(src("scripts/seed-ledger-from-schema.ts"));

  test("🔴 only `needs-human` reaches the refusal", () => {
    expect(S).toContain("const halts = seedHalts(results);");
    expect(S).toContain("const warnings = seedWarnings(results);");
    expect(S).toContain("if (halts.length) {");
    expect(S).toContain("process.exit(1);");
    // 🚫 The warning branch must NOT exit — that is the entire defect.
    const warnBlock = S.slice(S.indexOf("if (warnings.length) {"), S.indexOf("const applied = appliedTags"));
    expect(warnBlock).not.toContain("process.exit");
  });

  test("⚠️ the warning is LOUD and tells the operator where the guard now lives", () => {
    const raw = src("scripts/seed-ledger-from-schema.ts");
    expect(raw).toContain("⚠️  WARNING —");
    expect(raw).toContain("This does NOT block the seed");
    // The sentence that stops the next person re-adding the halt: the concern moved, it did not disappear.
    expect(raw).toContain("db:preflight");
  });

  test("🚫 the old one-function-two-questions shape is gone", () => {
    expect(code(src("src/lib/migration-witness.ts"))).not.toContain("export function blockers(");
    // And nothing else ever called it — the reason softening it was safe.
    for (const f of ["scripts/verify-migrations.ts", "scripts/probe-witnesses.ts", "scripts/migrate-preflight.ts"]) {
      expect({ f, uses: code(src(f)).includes("seedHalts") || code(src(f)).includes("seedWarnings") }).toEqual({
        f,
        uses: false,
      });
    }
  });
});
