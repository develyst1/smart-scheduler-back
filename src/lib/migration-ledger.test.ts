// TASK-085 — the ledger decisions, proven without a database.
//
// I cannot run any of this against a real DB (I don't touch real environments), so the parts that could go
// wrong are pure and tested here: attribution by hash, idempotency of the seed, and — the one Sober asked me
// to actually prove fails — the post-migrate guard.
import { describe, expect, test } from "bun:test";
import {
  attributeLedger,
  migrationHash,
  missingMigrations,
  newestCreatedAt,
  rowsToInsert,
  wouldApply,
  type LedgerRow,
  type OwnMigration,
} from "./migration-ledger";

// 🔻 TASK-655 — every `OwnMigration` now carries BOTH fingerprints (the field is REQUIRED), so this fixture builds them the
// same way the three scripts do. 📌 These texts contain no CRLF, so both fingerprints are the same string — the honest case
// for a migration with no line breaks, pinned on its own above.
const mk = (tag: string, when: number, sqlText: string): OwnMigration => ({
  tag,
  when,
  hash: migrationHash(sqlText),
  hashes: migrationFingerprints(sqlText).all,
});

const MINE = [
  mk("0000_init", 1_000, "create table a();"),
  mk("0001_more", 1_001, "create table b();"),
];
const THEIRS: LedgerRow = { hash: migrationHash("create schema bo;"), created_at: 9_999 };

describe("migrationHash — must match what drizzle stores, or nothing attributes", () => {
  test("sha256 of the raw file text, deterministic", () => {
    expect(migrationHash("create table a();")).toBe(migrationHash("create table a();"));
    expect(migrationHash("create table a();")).toHaveLength(64);
  });

  test("a one-character difference is a different migration", () => {
    expect(migrationHash("create table a();")).not.toBe(migrationHash("create table a() ;"));
  });
});

describe("attributeLedger — copy what's applied, never guess it", () => {
  test("🔑 rows matching this repo's files come across; the other repo's row does NOT", () => {
    const rows: LedgerRow[] = [
      { hash: MINE[0].hash, created_at: 1_000 },
      THEIRS,
      { hash: MINE[1].hash, created_at: 1_001 },
    ];
    const a = attributeLedger(rows, MINE);
    expect(a.mine.map((m) => m.tag)).toEqual(["0000_init", "0001_more"]);
    expect(a.foreign).toEqual([THEIRS]);
  });

  test("🔑 the legacy tag-as-hash rows are still ours — found in the real ledger, not imagined", () => {
    // `scripts/db-check-migrate.ts` inserted hash = the TAG string. Miss these and the verifier would report
    // 0004/0005 as unrecorded forever.
    const a = attributeLedger([{ hash: "0000_init", created_at: 1_000 }], MINE);
    expect(a.mine).toHaveLength(1);
    expect(a.mine[0]).toMatchObject({ tag: "0000_init", via: "legacy-tag" });
    expect(a.foreign).toHaveLength(0);
  });

  test("an unrecognisable row is reported, never silently copied", () => {
    const a = attributeLedger([{ hash: "deadbeef", created_at: 5 }], MINE);
    expect(a.mine).toHaveLength(0);
    expect(a.foreign).toHaveLength(1);
  });

  test("the ORIGINAL created_at is preserved — the seed copies history, it doesn't restamp it", () => {
    const a = attributeLedger([{ hash: MINE[0].hash, created_at: 1_000 }], MINE);
    expect(a.mine[0].row.created_at).toBe(1_000);
  });
});

describe("rowsToInsert — the seed is safe to re-run", () => {
  test("🔑 running it twice inserts nothing the second time", () => {
    const a = attributeLedger(
      [
        { hash: MINE[0].hash, created_at: 1_000 },
        { hash: MINE[1].hash, created_at: 1_001 },
      ],
      MINE,
    );
    expect(rowsToInsert(a.mine, [])).toHaveLength(2); // first run
    expect(rowsToInsert(a.mine, a.mine.map((m) => m.row.hash))).toHaveLength(0); // re-run
  });

  test("a partially-seeded ledger only gets the remainder", () => {
    const a = attributeLedger(
      [
        { hash: MINE[0].hash, created_at: 1_000 },
        { hash: MINE[1].hash, created_at: 1_001 },
      ],
      MINE,
    );
    expect(rowsToInsert(a.mine, [MINE[0].hash]).map((r) => r.tag)).toEqual(["0001_more"]);
  });
});

describe("🔴 missingMigrations — the guard, PROVEN to fail", () => {
  test("🔑 a journal entry with no ledger row is reported — this is the non-zero exit", () => {
    // Sober: "a guard that has never failed isn't known to work." This is that failure, on a scratch ledger
    // missing exactly one row.
    const missing = missingMigrations(MINE, [MINE[0].hash]);
    expect(missing.map((m) => m.tag)).toEqual(["0001_more"]);
    expect(missing).not.toHaveLength(0); // ⇒ the script exits 1
  });

  test("a fully-recorded ledger reports nothing — so the guard isn't just always-red", () => {
    expect(missingMigrations(MINE, MINE.map((m) => m.hash))).toHaveLength(0);
  });

  test("an EMPTY ledger reports everything — the exact state that would re-run 0000 on live data", () => {
    expect(missingMigrations(MINE, [])).toHaveLength(MINE.length);
  });

  test("legacy tag-as-hash rows count as recorded, so they don't raise a false alarm", () => {
    expect(missingMigrations(MINE, ["0000_init", MINE[1].hash])).toHaveLength(0);
  });
});

describe("🔴 wouldApply — the outage itself, reproduced", () => {
  test("this is the bug: scheduling's whole journal is 'older' than backoffice's newest row", () => {
    const schedulingNewest = mk("0017_entitlement_source", 1_783_000_000_013, "-- x");
    const backofficeNewestCreatedAt = 1_785_542_400_000; // backoffice 0005 in the SHARED ledger
    expect(wouldApply(schedulingNewest, backofficeNewestCreatedAt)).toBe(false); // ← silent skip, exit 0
  });

  test("…and with its OWN ledger it applies again — which is the fix, not a timestamp bump", () => {
    const schedulingNewest = mk("0017_entitlement_source", 1_783_000_000_013, "-- x");
    expect(wouldApply(schedulingNewest, 1_783_000_000_012)).toBe(true);
  });

  test("🔴 an EMPTY ledger applies EVERYTHING — why seeding must happen before the first migrate", () => {
    expect(MINE.every((m) => wouldApply(m, null))).toBe(true);
  });

  test("newestCreatedAt reads the single value drizzle's decision hangs on", () => {
    expect(newestCreatedAt([{ hash: "a", created_at: "5" }, { hash: "b", created_at: 9 }])).toBe(9);
    expect(newestCreatedAt([])).toBeNull();
  });
});

// ── 🔴 TASK-655 — ONE migration, TWO fingerprints ───────────────────────────────────────────────────────────────────
//
// The ledger stores sha256 of the `.sql` TEXT. The repo stores LF; a Windows checkout has CRLF ⇒ the same migration hashes
// differently depending on the machine that applied it. `db:verify` hashes the file on the machine RUNNING it, so a migration
// recorded under the other ending reads MISSING (red), and `seed-ledger` "repairs" it by adding a second row.
// 🔑 Both texts are built IN MEMORY here, deliberately: how THIS machine checked the files out is the very thing that varies,
//    so a test that reads its own working copy would prove whatever that machine happens to be.
import { isRecorded, migrationFingerprints } from "./migration-ledger"; // 📌 `OwnMigration` is already imported at the top of this file
import { readFileSync as read655, readFileSync as readFileSync655 } from "node:fs";
import { resolve as resolve655 } from "node:path";

const LF_TEXT = "CREATE TABLE a (\n  id uuid\n);\n--> statement-breakpoint\nALTER TABLE a ADD COLUMN b text;\n";
const CRLF_TEXT = LF_TEXT.replace(/\n/g, "\r\n");
const MIXED_TEXT = "CREATE TABLE a (\r\n  id uuid\n);\r\n--> statement-breakpoint\nALTER TABLE a ADD COLUMN b text;\r\n";
const FP = migrationFingerprints(LF_TEXT);
const own = (): OwnMigration => ({ tag: "0099_thing", when: 1_780_000_000_000, hash: FP.lf, hashes: FP.all });

describe("🔴 TASK-655 — the two fingerprints themselves", () => {
  test("LF and CRLF of the same migration hash DIFFERENTLY — the fact the whole task rests on", () => {
    expect(FP.lf).not.toBe(FP.crlf);
    expect(migrationFingerprints(CRLF_TEXT).lf).toBe(FP.lf); // …and either text yields the same PAIR
    expect(migrationFingerprints(CRLF_TEXT).crlf).toBe(FP.crlf);
    expect([...FP.all].sort()).toEqual([FP.lf, FP.crlf].sort());
  });
  test("⚠️ a MIXED-ending file yields exactly those two and no third — because it is normalised to LF BEFORE hashing", () => {
    const mixed = migrationFingerprints(MIXED_TEXT);
    expect(mixed.lf).toBe(FP.lf);
    expect(mixed.crlf).toBe(FP.crlf);
    // 🔑 hashing the raw text first would have produced a fingerprint matching NOTHING in any ledger
    expect(migrationHash(MIXED_TEXT)).not.toBe(FP.lf);
    expect(migrationHash(MIXED_TEXT)).not.toBe(FP.crlf);
  });
  test("a file with no line breaks at all has ONE fingerprint, not a duplicated pair", () => {
    const one = migrationFingerprints("SELECT 1;");
    expect(one.lf).toBe(one.crlf);
    expect(one.all).toHaveLength(1);
  });
  test("📌 REAL DATA — `0011_freelance_budgets`, the pair the owner's read found on BOTH boxes", () => {
    // 🔑 Read from the repo and normalised, so this pin holds whichever ending this machine checked the file out with.
    const fp = migrationFingerprints(read655(resolve655(import.meta.dir, "..", "..", "drizzle", "0011_freelance_budgets.sql"), "utf8"));
    expect(fp.lf).toBe("119846e1a44b55852fb6e1b56875101857e2df1986a651432f7156f54388f738");
    expect(fp.crlf).toBe("5f7e19afaf0c687195f8e94e2cb2b38679cfd8afcb4f037eafbc94a021524b15");
  });
});

describe("🔴 TASK-655 — every ledger comparison accepts EITHER fingerprint", () => {
  test("🔑 THE CASE THAT WENT RED: a ledger holding ONLY the OTHER ending ⇒ NOT missing", () => {
    expect(missingMigrations([own()], [FP.crlf])).toEqual([]);
    expect(missingMigrations([own()], [FP.lf])).toEqual([]);
  });
  test("BOTH present ⇒ not missing, and counted ONCE (a double is harmless, never two migrations)", () => {
    expect(missingMigrations([own()], [FP.lf, FP.crlf])).toEqual([]);
  });
  test("NEITHER present ⇒ still missing — the guard is not weakened, only widened to the same migration", () => {
    expect(missingMigrations([own()], ["beef", "cafe"])).toEqual([own()]);
    expect(missingMigrations([own()], [])).toEqual([own()]);
  });
  test("✅ the legacy tag-as-hash rule still answers", () => {
    expect(missingMigrations([own()], ["0099_thing"])).toEqual([]);
  });
  test("🔴 `ledgerLies`' rule — a schema-ABSENT migration recorded under the OTHER ending IS flagged", () => {
    // `verify-migrations.ts` filters its schema-absent witnesses through this same predicate. Before TASK-655 it looked up ONE
    // hash, so this row was invisible: 🔑 fixing `missing` and leaving this behind would have turned the loudest failure we
    // have — the ledger says applied, the database says otherwise — into a silent one.
    const present = new Set([FP.crlf]);
    expect(isRecorded(own(), present)).toBe(true);
    expect(isRecorded({ ...own(), tag: "0100_other", hash: "beef", hashes: ["beef", "dead"] }, present)).toBe(false);
  });
  test("🔴 the seed's 'already present' — the OTHER ending present ⇒ it inserts NOTHING", () => {
    // this is where the 48 / 21 doubles came from: the seed saw its own fingerprint missing and added a second row
    expect(isRecorded(own(), new Set([FP.crlf]))).toBe(true);
    expect(isRecorded(own(), new Set(["something-else"]))).toBe(false); // …and a genuinely absent one is still inserted
  });
  test("attribution: a row written under EITHER ending is recognised as OURS, with its tag", () => {
    const a = attributeLedger([{ hash: FP.crlf, created_at: 1 }, { hash: FP.lf, created_at: 2 }, { hash: "foreign", created_at: 3 }], [own()]);
    expect(a.mine.map((m) => [m.tag, m.via])).toEqual([["0099_thing", "hash"], ["0099_thing", "hash"]]);
    expect(a.foreign.map((r) => r.hash)).toEqual(["foreign"]);
  });
  test("🔻 TASK-655 — `hashes` is now REQUIRED: the optional fallback is RETIRED, and the COMPILER is what keeps it retired", () => {
    // ⚠️ This test used to pin the OPPOSITE: that `hashes` was optional, so `scripts/migrate-preflight.ts` — then outside the
    // claim — kept compiling and kept its one-fingerprint behaviour. @Sober has since claimed that script; it fills both now,
    // nothing builds a single-hash `OwnMigration` any more, and the field is required.
    // 🔑 **An optional field that every caller fills is a trap for the next caller who does not.**
    // ⇒ the claim that replaces it is stronger than any assertion could be: a FOURTH comparison cannot be written on one
    // fingerprint without failing to compile. The `@ts-expect-error` below IS that pin — if omitting `hashes` ever stops
    // being an error, this file stops compiling.
    const built: OwnMigration = { tag: "0099_thing", when: 1, hash: FP.lf, hashes: FP.all };
    expect(built.hashes).toEqual(FP.all);
    // @ts-expect-error — `hashes` is required; omitting it must not compile
    const without: OwnMigration = { tag: "0099_thing", when: 1, hash: FP.lf };
    expect(without.tag).toBe("0099_thing");
  });
});

describe("🔴 TASK-655 — the two SCRIPTS ask the same rule (source — they import a database and cannot be run here)", () => {
  // ⚠️ Added because mutations E3 and E5 SURVIVED: nothing imports `seed-ledger-from-schema.ts` (it opens a connection at the
  // top level), so pinning the predicate alone proved the rule and NOT that the seed asks it. 🔑 **A shared helper is only
  // shared where somebody calls it, and a test of the helper cannot see the call.**
  const read = (f: string) => readFileSync655(resolve655(import.meta.dir, "..", "..", f), "utf8").replace(/\r\n/g, "\n");
  const VERIFY = read("scripts/verify-migrations.ts");
  const SEED = read("scripts/seed-ledger-from-schema.ts");
  const PREFLIGHT = read("scripts/migrate-preflight.ts");

  test("🔴 `verify` asks it for BOTH halves — `missing` and the dangerous `ledgerLies`", () => {
    expect(VERIFY).toContain("const fp = migrationFingerprints(readFileSync(resolve(dir, `${e.tag}.sql`), \"utf8\"));");
    expect(VERIFY).toContain("return { tag: e.tag, when: e.when, hash: fp.lf, hashes: fp.all };");
    expect(VERIFY).toContain("return !!m && isRecorded(m, ledgerHashes);");
    expect(VERIFY).not.toMatch(/ledgerHashes\.has\(hashOf\.get/); // the one-hash lookup is gone
  });
  test("🔴 the SEED counts EITHER fingerprint as present — this is where the 48 / 21 doubles came from", () => {
    expect(SEED).toContain("  .filter((m) => !isRecorded(m, present));");
    expect(SEED).not.toMatch(/\.filter\(\(m\) => !present\.has\(m\.hash\)\)/);
  });
  test("🔴 …and when it DOES insert it writes the LF fingerprint — the one every machine produces after the pin", () => {
    expect(SEED).toContain("return { tag, when: entry.when, hash: fp.lf, hashes: fp.all };");
    expect(SEED).not.toContain("hash: fp.crlf");
  });
  test("🔻 TASK-655 follow-up — `migrate-preflight` asks it too, so PREFLIGHT and VERIFY mean ONE thing by 'pending'", () => {
    // ⚠️ It was listed and left in the first round because it sat outside the claim; @Sober claimed it and handed it over.
    // 🔑 It is the script that decides whether a deploy goes ahead, so a one-fingerprint check there named a migration as
    // PENDING that was already applied — the same class of wrongness as `ledgerLies`, at the other end of the deploy.
    expect(PREFLIGHT).toContain("const fp = migrationFingerprints(sqlOf(e.tag));");
    expect(PREFLIGHT).toContain("return { tag: e.tag, when: e.when, hash: fp.lf, hashes: fp.all };");
    expect(PREFLIGHT).not.toContain("hash: migrationHash(sqlOf(e.tag)),"); // the single-fingerprint build is gone
  });
  test("📌 `.gitattributes` pins ONLY the migrations folder — never repo-wide (we refused that before)", () => {
    const attrs = read(".gitattributes").trim().split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(attrs).toEqual(["drizzle/*.sql text eol=lf"]);
  });
});
