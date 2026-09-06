// TASK-266 — the preflight that refuses a batch `drizzle-kit migrate` cannot apply in one run.
//
// 🔴 The DoD asks for the assertions to run against **the real migration files, not a fixture that resembles
// them** — and that is the whole difference here. Tonight's failure was not a case nobody imagined: `0032`'s own
// header states the constraint correctly and in full. It failed because **the check was prose inside the file
// being applied**, and a fixture-based test would have re-created exactly that: a rule that is right about an
// example and never meets the batch.
//
// ⚠️ So the first two tests read `drizzle/*.sql` off disk and assert the verdict on THE batch that failed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSrc } from "./read-src";
import {
  entriesThrough,
  formatRefusal,
  scanBatch,
  stripSqlComments,
  type PendingMigration,
} from "./migrate-preflight";

const dir = resolve(import.meta.dir, "..", "..", "drizzle");
const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
/** The real file, byte for byte — that is the point of this suite. */
const real = (tag: string): PendingMigration => ({ tag, sql: readFileSync(resolve(dir, `${tag}.sql`), "utf8") });
const ALL = journal.entries.map((e) => real(e.tag));

const PKG = JSON.parse(readFileSync(resolve(dir, "..", "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const VERIFY = readSrc(readFileSync(resolve(dir, "..", "scripts/verify-migrations.ts"), "utf8"));
const THROUGH = readSrc(readFileSync(resolve(dir, "..", "scripts/migrate-through.ts"), "utf8"));

describe("TASK-266 — it refuses TONIGHT'S batch, read off disk", () => {
  test("🔴 0032 + 0033 + 0034 pending ⇒ REFUSED, and it names the pair", () => {
    // The exact set `sid` had pending on 2026-09-06.
    const batch = ["0032_booking_paused_status", "0033_paused_slot_index", "0034_course_expiry_changes"].map(real);
    const blockers = scanBatch(batch);
    expect(blockers).toContainEqual({
      kind: "enum-label",
      label: "PAUSED",
      adds: "0032_booking_paused_status",
      uses: "0033_paused_slot_index",
    });
    const out = formatRefusal(blockers).join("\n");
    expect(out).toContain("0033_paused_slot_index uses 'PAUSED', which 0032_booking_paused_status adds");
    // §3 — it prints the NEXT COMMAND, not a diagnosis.
    expect(out).toContain("bun run db:migrate:through 0032_booking_paused_status");
    expect(out).toContain("bun run db:migrate");
  });

  test("🔑 …and 0032 ALONE is allowed — the split it prints must actually work", () => {
    // If this were refused too, the instruction would be a loop: the operator runs the printed command and is
    // refused again. The first run has to be applicable, or the control sends people back to typing
    // `drizzle-kit migrate` by hand — the thing this exists to prevent.
    expect(scanBatch([real("0032_booking_paused_status")])).toEqual([]);
    // …and so is the remainder the second run would see.
    expect(scanBatch([real("0033_paused_slot_index"), real("0034_course_expiry_changes")])).toEqual([]);
  });

  test("🔑 a batch is clean whenever it does not ADD a label — however many files use one", () => {
    // ⚠️ I wrote this twice as "the journal minus the offender" and the rule corrected me twice. The second
    // correction is the useful one: removing `0002` just promoted `0007`, because 'PENDING_RESCHEDULE' is
    // referenced by `0002`, `0007` AND `0033` — every rebuild of that index predicate.
    // 🔑 **The offender is the ADDER, not the user.** Once `0001` is committed the label exists and every one
    // of those files is fine — which is exactly why a SPLIT works at all, and why the split point is the
    // `ALTER TYPE` file rather than the first use.
    expect(scanBatch([real("0034_course_expiry_changes")])).toEqual([]);
    const noAdders = ALL.filter(
      (m) => m.tag !== "0001_add_reschedule_fields" && m.tag !== "0032_booking_paused_status",
    );
    expect(scanBatch(noAdders)).toEqual([]);
  });

  test("🔴 Q1 — the FULL journal holds TWO such pairs, and the older one is 0001/0002", () => {
    // 🔴 I wrote this test expecting ONE pair and the rule found two. `0001` adds 'PENDING_RESCHEDULE' and
    // `0002` uses it in an index predicate — **the identical shape, thirty-one migrations earlier.** It never
    // failed because the two were authored days apart and applied one run at a time; `0032`/`0033` were
    // written the same afternoon and met the same batch.
    //
    // ⚠️ **The consequence is live, not historical: a FRESH database has all 35 pending**, so
    // `drizzle-kit migrate` from empty would fail at `0002` today — and the preflight now refuses it first,
    // with the same two-command instruction. A new environment needs the split twice.
    const blockers = scanBatch(ALL);
    expect(blockers).toEqual([
      {
        kind: "enum-label",
        label: "PENDING_RESCHEDULE",
        adds: "0001_add_reschedule_fields",
        uses: "0002_reschedule_slot_index",
      },
      {
        kind: "enum-label",
        label: "PAUSED",
        adds: "0032_booking_paused_status",
        uses: "0033_paused_slot_index",
      },
    ]);
  });

  test("🔑 …and a from-scratch run is told BOTH split points, earliest first", () => {
    // The instruction has to chain: run 1 stops at 0001, run 2 re-runs this check and stops at 0032. Printing
    // the later split first would give a first command that is itself refused.
    const out = formatRefusal(scanBatch(ALL)).join(String.fromCharCode(10));
    expect(out).toContain("bun run db:migrate:through 0001_add_reschedule_fields");
    expect(out).toContain("(also: 0033_paused_slot_index uses 'PAUSED' from 0032_booking_paused_status");
  });
});

describe("TASK-266 — comments are prose, and this rule would be switched off without that", () => {
  test("🔴 0029's header talks about ADD VALUE and 'OTHER', and 0029 is NOT refused", () => {
    // The precedent that stayed safe: `0029` adds `'OTHER'` and deliberately never references it in its own
    // batch — and it explains all of that in a comment that names both the statement and the label. A preflight
    // reading comments would refuse this correct migration, and a control that refuses correct work is a control
    // somebody removes.
    const m = real("0029_other_booking_type");
    expect(m.sql).toContain("ALTER TYPE … ADD VALUE"); // in prose, in the header
    expect(scanBatch([m])).toEqual([]);
    expect(scanBatch([m, real("0030_family_line_links")])).toEqual([]);
  });

  test("0033's header rules CONCURRENTLY out in prose — that must not read as a blocker", () => {
    expect(real("0033_paused_slot_index").sql).toContain("CONCURRENTLY");
    expect(scanBatch([real("0033_paused_slot_index")])).toEqual([]);
  });

  test("stripSqlComments removes -- and /* */ and nothing else", () => {
    expect(stripSqlComments("-- ALTER TYPE t ADD VALUE 'X'\nSELECT 1;")).not.toContain("ADD VALUE");
    expect(stripSqlComments("/* 'X' */ SELECT 'Y';")).toContain("'Y'");
    expect(stripSqlComments("/* 'X' */ SELECT 'Y';")).not.toContain("'X'");
  });
});

describe("TASK-266 — the rule itself, on batches we have not written", () => {
  const adds = (label: string) => `ALTER TYPE "booking_status" ADD VALUE IF NOT EXISTS '${label}';`;

  test("later use is refused; EARLIER use is not the same question", () => {
    expect(scanBatch([{ tag: "a", sql: adds("X") }, { tag: "b", sql: "SELECT 'X';" }])).toHaveLength(1);
    // A file that mentions the label BEFORE it is added is a different (and probably worse) problem, and one no
    // split can fix — so it is not reported as a split, because the instruction printed would be a lie.
    expect(scanBatch([{ tag: "a", sql: "SELECT 'X';" }, { tag: "b", sql: adds("X") }])).toEqual([]);
  });

  test("same-file use is not reported — splitting cannot help, and we have never written one", () => {
    expect(scanBatch([{ tag: "a", sql: `${adds("X")} SELECT 'X';` }])).toEqual([]);
  });

  test("a different label does not trigger it", () => {
    expect(scanBatch([{ tag: "a", sql: adds("X") }, { tag: "b", sql: "SELECT 'Y';" }])).toEqual([]);
  });

  test("⚠️ Q1's second class: a statement Postgres refuses in a transaction AT ALL", () => {
    // Not a split problem — `drizzle-kit migrate` cannot apply it by any route — so it gets its own message
    // rather than being folded into the enum one, which would print an instruction that does not work.
    const b = scanBatch([{ tag: "z", sql: "CREATE INDEX CONCURRENTLY x ON t (a);" }]);
    expect(b).toEqual([{ kind: "non-transactional", tag: "z", statement: "CONCURRENTLY" }]);
    const out = formatRefusal(b).join("\n");
    expect(out).toContain("Postgres refuses inside a transaction block");
    expect(out).not.toContain("db:migrate:through");
  });

  test("with several pairs, the split point is the EARLIEST one", () => {
    // Applying through the earliest `adds` is always safe; the second run re-runs this same check and stops at
    // the next one. A later split point would print a first command that is itself refused.
    const out = formatRefusal(
      scanBatch([
        { tag: "0040_a", sql: adds("A") },
        { tag: "0041_b", sql: `SELECT 'A'; ${adds("B")}` },
        { tag: "0042_c", sql: "SELECT 'B';" },
      ]),
    ).join("\n");
    expect(out).toContain("bun run db:migrate:through 0040_a");
    expect(out).toContain("(also: 0042_c uses 'B' from 0041_b");
  });
});

describe("TASK-266 §4 — the split command exists and both halves end in db:verify", () => {
  test("db:migrate runs the preflight FIRST, and still verifies after", () => {
    expect(PKG.scripts["db:migrate"]).toBe("bun run db:preflight && drizzle-kit migrate && bun run db:verify");
    expect(PKG.scripts["db:preflight"]).toBe("bun run scripts/migrate-preflight.ts");
    expect(PKG.scripts["db:migrate:through"]).toBe("bun run scripts/migrate-through.ts");
  });

  test("🔑 the partial run ends in a SCOPED verify", () => {
    expect(THROUGH).toContain('"scripts/verify-migrations.ts", "--through", tag');
    // …and it refuses to report success if that verify fails.
    expect(THROUGH).toContain("if (verify.exitCode !== 0) process.exit(verify.exitCode ?? 1);");
  });

  test("🚫 the split runner never edits the real drizzle/ folder", () => {
    // A deploy step that rewrites the thing it is deploying turns a half-finished run into an unrecoverable one.
    expect(THROUGH).toContain("copyFileSync(resolve(dir, `${e.tag}.sql`)");
    expect(THROUGH).not.toContain("writeFileSync(resolve(dir");
    // The ledger hash is the sha256 of the file TEXT, so a rewritten byte would make run 2 re-apply run 1's work.
    expect(THROUGH).toContain('"__drizzle_migrations_scheduling"');
  });

  test("db:verify's default stays UNSCOPED — the narrowing must be asked for", () => {
    expect(VERIFY).toContain('const throughIdx = process.argv.indexOf("--through");');
    expect(VERIFY).toContain("let scoped = journal.entries;");
    // Both halves of the verify — the ledger and the witnesses — are scoped from the SAME list.
    expect(VERIFY).toContain("const WITNESSES = ALL_WITNESSES.filter((w) => scopedTags.has(w.tag));");
  });

  test("entriesThrough takes everything up to and including the tag, and refuses an unknown one", () => {
    const e = [{ tag: "a" }, { tag: "b" }, { tag: "c" }];
    expect(entriesThrough(e, "b")).toEqual([{ tag: "a" }, { tag: "b" }]);
    expect(entriesThrough(e, "a")).toEqual([{ tag: "a" }]);
    expect(() => entriesThrough(e, "zz")).toThrow("no migration tagged zz");
  });
});

describe("TASK-266 — the preflight fails CLOSED", () => {
  const SCRIPT = readSrc(readFileSync(resolve(dir, "..", "scripts/migrate-preflight.ts"), "utf8"));
  /** ⚠️ The same trap this whole task is about, met in my own test: the script's HEADER explains
   *  `drizzle-kit migrate` at length, so an unstripped `not.toContain` failed on prose. */
  const code = (x: string) => x.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

  test("🔴 anything it cannot determine exits non-zero", () => {
    // A preflight that waves the batch through when it cannot see is worse than none, because the deploy note
    // will say it ran.
    expect(SCRIPT).toContain("db:preflight could not decide");
    expect(SCRIPT).toContain("Refusing rather than guessing");
    expect(SCRIPT).toContain("DATABASE_URL required");
    // 🚫 §5 — it refuses and instructs; it never applies the split itself.
    expect(code(SCRIPT)).not.toContain("drizzle-kit");
    expect(code(SCRIPT)).not.toContain("Bun.spawn");
  });

  test("it computes pending with the SAME function db:verify uses", () => {
    // "Pending" meaning two things in the two halves of one deploy step is how they would come to disagree.
    expect(SCRIPT).toContain("missingMigrations(mine, rows.map((r) => r.hash))");
    expect(VERIFY).toContain("missingMigrations(mine, rows.map((r) => r.hash))");
  });
});
