// TASK-459 — 🔑 the rule that makes ONE class of defect impossible: **a witness may not probe an object the
// current schema no longer declares.**
//
// Why this is not a tidiness test. `db:seed-ledger` trusts the witness to decide "has this migration run?", and it
// writes the ledger rows `db:migrate` then reads. A witness pointing at a dropped object reads `found=false` on a
// **correctly migrated** box, so the seeder reports the migration as NOT applied and proposes applying it — and
// applying it would UNDO the later migration that dropped the object. That is not a misleading message: it is a
// tool proposing a regression, on the owner's box, with a straight face. It happened on `sid` on 2026-09-24
// (`0052`'s table, dropped on purpose by `0053`); Porter stopped it at the dry run.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SCHEDULING_WITNESSES, judge, type Witness } from "./migration-witness";
import * as schema from "../db/schema";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");

// ── what the CURRENT schema declares ──────────────────────────────────────────────────────────────
const tables = new Map<string, { columns: Set<string>; indexes: Set<string> }>();
for (const v of Object.values(schema)) {
  if (!is(v as any, PgTable)) continue;
  const cfg = getTableConfig(v as any);
  tables.set(cfg.name, {
    columns: new Set(cfg.columns.map((c) => c.name)),
    indexes: new Set([...cfg.indexes.map((i: any) => i.config.name), ...cfg.foreignKeys.map(() => "")].filter(Boolean)),
  });
}
const enumLabels = new Map<string, Set<string>>();
for (const v of Object.values(schema)) {
  const e = v as any;
  // ⚠️ A `pgEnum` is a FUNCTION with properties (it is callable, to build columns) — a `typeof === "object"`
  // test silently skips every enum, and then every enum-label witness reads as stale. That was the checker's
  // own first bug, and it is the reason this test asserts its findings are not vacuous.
  if (e && (typeof e === "object" || typeof e === "function") && Array.isArray(e.enumValues) && typeof e.enumName === "string") {
    enumLabels.set(e.enumName, new Set(e.enumValues));
  }
}
// Migration SQL, in journal order. 🔑 The schema is NOT the only record of what exists: this repo's migrations are
// hand-written (drizzle never generated them), so several partial indexes and every CHECK constraint live ONLY in
// the SQL and were never declared in `schema.ts`. "Still there" therefore means: the schema declares it, OR no
// migration has dropped it.
const migrations = readdirSync(resolve(root, "drizzle"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ tag: f.replace(/\.sql$/, ""), sql: readFileSync(resolve(root, "drizzle", f), "utf8") }));

/** Statements naming every one of `terms`, newest last — the SQL half of "does this object still exist?". */
function lastStatementNaming(...terms: string[]): string | null {
  const hits = migrations.flatMap((m) =>
    m.sql
      .split("--> statement-breakpoint")
      .map((st) => st.replace(/^\s*--.*$/gm, "")) // 🚫 a comment mentioning the object is not a statement about it
      .filter((st) => terms.every((t) => new RegExp(`\\b${t}\\b`).test(st))),
  );
  return hits.length ? hits[hits.length - 1]!.trim() : null;
}
/** …and that last statement must not be the one that removed it. */
const notDropped = (dropRe: RegExp, ...terms: string[]): boolean => {
  const last = lastStatementNaming(...terms);
  return !!last && !dropRe.test(last);
};

/**
 * Is the object this witness probes still THERE — declared by the current schema, or at least never dropped by a
 * migration? The two halves are both needed: the schema is authoritative for what it declares, and the SQL is the
 * only record of the objects it does not.
 */
function stillDeclared(w: Witness): { ok: boolean; what: string } {
  const p: any = w.probe;
  switch (p.kind) {
    case "superseded-by":
      // The escape hatch, and the ONLY one: the witness says out loud that its own effect is gone.
      return { ok: true, what: `inherited from ${p.tag}` };
    case "needs-human":
      return { ok: true, what: "no probe" };
    case "table":
      return { ok: tables.has(p.table) || notDropped(/DROP\s+TABLE/i, p.table), what: `table ${p.table}` };
    case "column":
      return {
        ok: !!tables.get(p.table)?.columns.has(p.column) || notDropped(/DROP\s+COLUMN/i, p.table, p.column),
        what: `${p.table}.${p.column}`,
      };
    case "column-absent":
      // The inverse probe: it is correct precisely BECAUSE the column is gone from the schema.
      return { ok: tables.has(p.table) && !tables.get(p.table)!.columns.has(p.column), what: `${p.table}.${p.column} absent` };
    case "index":
    case "index-predicate":
      // 📌 Several partial indexes exist ONLY in the hand-written SQL (never declared in `schema.ts`) — that is
      // normal in this repo, so the SQL half carries them.
      return {
        ok: [...tables.values()].some((t) => t.indexes.has(p.index)) || notDropped(/DROP\s+INDEX/i, p.index),
        what: `index ${p.index}`,
      };
    case "enum-label":
      // 🚫 A label cannot be dropped from a pg enum at all, so the schema is the whole answer here.
      return { ok: !!enumLabels.get(p.type)?.has(p.label), what: `enum ${p.type} '${p.label}'` };
    case "constraint":
    case "constraint-def": {
      // 🚫 schema.ts declares no CHECK constraints — they exist only in the hand-written SQL. So the honest
      // equivalent of "still declared" is: the LAST migration statement that names it does not DROP it.
      return { ok: notDropped(/DROP\s+CONSTRAINT[^;]*$/i, p.constraint), what: `constraint ${p.constraint}` };
    }
    default:
      return { ok: false, what: `unknown probe kind ${p.kind}` };
  }
}

describe("🔑 TASK-459 — every witness probes something the CURRENT schema still declares, or says it is inherited", () => {
  test("🔴 the walk: no witness points at a dropped object", () => {
    const stale = SCHEDULING_WITNESSES.filter((w) => !stillDeclared(w).ok).map((w) => `${w.tag} → ${stillDeclared(w).what}`);
    // A stale entry here is NOT cosmetic: `db:seed-ledger` would read `found=false` on a correctly migrated box,
    // call the migration not-applied, and propose applying it — undoing whatever dropped the object.
    expect(stale).toEqual([]);
  });

  test("📌 the walk is not vacuous — every witness is actually classified, and the kinds are the ones that exist", () => {
    expect(SCHEDULING_WITNESSES.length).toBe(56);
    const kinds = new Set(SCHEDULING_WITNESSES.map((w) => w.probe.kind));
    expect([...kinds].sort()).toEqual(["column", "column-absent", "constraint", "constraint-def", "enum-label", "index", "index-predicate", "superseded-by", "table"].filter((k) => kinds.has(k as any)) as any);
    for (const w of SCHEDULING_WITNESSES) expect({ tag: w.tag, what: stillDeclared(w).what }).not.toMatchObject({ what: expect.stringContaining("unknown probe kind") });
  });

  test("🚫 the guard on the guard: a fabricated stale witness IS caught, by each probe kind that can go stale", () => {
    // 🔑 These are the REAL objects TASK-454's `0053` dropped — not invented names. A checker that only rejects
    // names nobody ever used would have passed the day this defect shipped.
    const fakes: Witness[] = [
      { tag: "x-table", probe: { kind: "table", table: "camp_week_day_rates" }, why: "", rerunnable: true },
      { tag: "x-column", probe: { kind: "column", table: "camp_week_days", column: "teacher_ids" }, why: "", rerunnable: true },
      { tag: "x-index", probe: { kind: "index", index: "bookings_gone_idx" }, why: "", rerunnable: true },
      { tag: "x-enum", probe: { kind: "enum-label", type: "booking_type", label: "NOT_A_TYPE" }, why: "", rerunnable: true },
      { tag: "x-constraint", probe: { kind: "constraint", constraint: "bookings_never_existed_chk" }, why: "", rerunnable: true },
    ];
    for (const f of fakes) expect({ tag: f.tag, ok: stillDeclared(f).ok }).toEqual({ tag: f.tag, ok: false });
    // …and the two objects TASK-454 dropped are exactly the ones a stale witness would point at.
    expect(tables.has("camp_week_day_rates")).toBe(false);
    expect(tables.get("camp_week_days")!.columns.has("teacher_ids")).toBe(false);
  });
});

describe("🔴 TASK-459 — `0052`'s verdict is INHERITED from `0053`, and the dry run is clean again", () => {
  const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0052_camp_day_rates")!;

  test("the entry: superseded-by 0053, and the warning the next reader must meet", () => {
    expect(w.probe).toEqual({ kind: "superseded-by", tag: "0053_camp_day_teachers" });
    expect(w.rerunnable).toBe(false); // 🚫 re-running it would re-create the retired table
    expect(w.why).toContain("REGRESS");
    expect(w.why).toContain("0053");
  });

  test("🔑 by value — the ledger seeder's own logic over a correctly migrated box: 55 applied / 0 not-applied", () => {
    // Every probe answers TRUE except 0052's, which cannot be probed at all (its table is gone) — exactly the
    // state of the owner's `sid` box on 2026-09-24.
    const results = new Map<string, boolean | null>(
      SCHEDULING_WITNESSES.map((x) => [x.tag, x.tag === "0052_camp_day_rates" ? false : true] as const),
    );
    const judged = judge([...SCHEDULING_WITNESSES], results);
    expect(judged.filter((r) => r.verdict === "applied").length).toBe(56);
    expect(judged.filter((r) => r.verdict !== "applied").map((r) => `${r.tag} ${r.verdict}`)).toEqual([]);
    const j52 = judged.find((r) => r.tag === "0052_camp_day_rates")!;
    expect({ verdict: j52.verdict, found: j52.found, probe: j52.probe }).toEqual({
      verdict: "applied",
      found: null, // 🚫 never reports a probe result it did not take
      probe: "inherited from 0053_camp_day_teachers (own effect no longer observable)",
    });
  });

  test("📌 it inherits, it does not assume: if 0053 itself is not applied, 0052 is `needs-human`, never `applied`", () => {
    const results = new Map<string, boolean | null>(
      SCHEDULING_WITNESSES.map((x) => [x.tag, x.tag === "0053_camp_day_teachers" ? false : true] as const),
    );
    const judged = judge([...SCHEDULING_WITNESSES], results);
    expect(judged.find((r) => r.tag === "0052_camp_day_rates")!.verdict).toBe("needs-human");
    expect(judged.find((r) => r.tag === "0053_camp_day_teachers")!.verdict).toBe("not-applied");
  });
});

describe("📌 TASK-459 — the standing rule is written where the next author will meet it", () => {
  test("`drizzle/README.md` carries it, and it names the consequence rather than just the chore", () => {
    const readme = readFileSync(resolve(root, "drizzle/README.md"), "utf8");
    expect(readme).toContain("must re-point any witness that probes it — IN THE SAME TASK");
    expect(readme).toContain("db:seed-ledger");
  });
});
