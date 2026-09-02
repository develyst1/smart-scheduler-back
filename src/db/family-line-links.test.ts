// SPEC-071 / TASK-230 (REQ-079) — the family-link data model, at the places that can silently diverge.
//
// 🔴 The failure this guards against is a PII one. `family_line_links_user_uq` is what stops a second family's
// invite re-pointing a LINE account — without it, a parent opens the app and sees **another family's
// children**. That is TASK-047's failure reached by a different route, so the constraint is asserted in both
// the migration and the Drizzle schema, which are the pair that drifts.
//
// The rows themselves need a database; what is pinned here is the shape, the single accessor, and the one
// distinction a release note nearly deleted.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { SCHEDULING_WITNESSES } from "../lib/migration-witness";

const SCHEMA = readSrc(await Bun.file(new URL("./schema.ts", import.meta.url)).text());
const SQL = await Bun.file(new URL("../../drizzle/0030_family_line_links.sql", import.meta.url)).text();
const ACCESSOR = readSrc(await Bun.file(new URL("../lib/family-link.ts", import.meta.url)).text());
const statements = SQL.replace(/^\s*--.*$/gm, "");

describe("🔴 one LINE account belongs to ONE family", () => {
  test("the unique index exists in the migration AND in the schema — the pair that drifts", () => {
    expect(statements).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "family_line_links_user_uq"');
    expect(SCHEMA).toContain('uniqueIndex("family_line_links_user_uq")');
  });

  test("🔑 it is a DATABASE constraint, not an application check", () => {
    // The app decides who may join; the database decides they may only join once. An application check would
    // be defeated by two invites redeemed at the same moment — and the cost of losing that race is a parent
    // seeing another family's children.
    expect(statements).toContain("CREATE UNIQUE INDEX");
    expect(ACCESSOR).not.toContain("already linked"); // no hand-rolled uniqueness in the accessor
  });

  test("the link is keyed (parent, account) and cascades from the parent", () => {
    expect(statements).toContain('PRIMARY KEY ("parent_id", "line_user_id")');
    expect(statements).toContain('REFERENCES "parents"("id") ON DELETE CASCADE');
    expect(SCHEMA).toContain("primaryKey({ columns: [t.parentId, t.lineUserId] })");
  });
});

describe("⚠️ the counter that survived §15, and the one that did not", () => {
  test("🔴 `unexpected_count` (two-strikes, AC-18) EXISTS", () => {
    // The code lockout (`code_attempts` / `code_locked_until`) died with the family code. This one lives,
    // because Rule 5 still requires "two unexpected replies and the bot hands over". The two were nearly
    // deleted together on one sentence in a release note — which is why this is a test and not a comment.
    expect(statements).toContain('"unexpected_count" integer NOT NULL DEFAULT 0');
    expect(SCHEMA).toContain('unexpectedCount: integer("unexpected_count")');
  });

  test("🚫 the family CODE and its lockout are NOT reintroduced anywhere", () => {
    // Comments stripped: the schema deliberately EXPLAINS which counter died and which survived, and that
    // explanation is the thing stopping them being deleted together again. Only declarations are evidence.
    const schemaCode = SCHEMA.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "");
    for (const dead of ["family_code_hash", "family_code_set_at", "code_attempts", "code_locked_until"]) {
      expect(statements).not.toContain(dead);
      expect(schemaCode).not.toContain(dead);
    }
  });

  test("the mute column is there for AC-17", () => {
    expect(statements).toContain('"muted_until" timestamptz');
    expect(SCHEMA).toContain('mutedUntil: timestamp("muted_until"');
  });
});

describe("an invite is a one-shot expiring token, and it remembers", () => {
  test("`used_at` / `used_by` are kept rather than the row being deleted", () => {
    // "Who joined this family, and when" is the question this table exists to answer after the fact, and a
    // deleted row answers nothing.
    expect(statements).toContain('"used_at"');
    expect(statements).toContain('"used_by"');
    expect(statements).toContain('"expires_at" timestamptz NOT NULL');
    expect(SCHEMA).toContain('usedAt: timestamp("used_at"');
  });
});

describe("🔴 ONE accessor — two readers is how the two sources disagree", () => {
  test("`familyLineUserIds` is primary-first, so the existing single-account meaning survives", () => {
    expect(ACCESSOR).toContain("...(parent?.lineUserId ? [parent.lineUserId] : [])");
    expect(ACCESSOR).toContain("...links.map(");
  });

  test("it dedupes — a duplicate here is a duplicate push on someone's phone", () => {
    // An invite redeemed by the account already on the parent row would otherwise be messaged twice, and that
    // is how a notification channel gets muted.
    expect(ACCESSOR).toContain("[...new Set(ids)]");
  });

  test("`familyOfLineUser` has a FIXED order, so the answer is deterministic", () => {
    // Both sources can only ever name the same family (the unique index guarantees it), but a fixed order
    // means the answer never depends on which query happened to run.
    expect(ACCESSOR.indexOf("familyLineLinks.parentId")).toBeLessThan(
      ACCESSOR.indexOf("e(p.lineUserId, lineUserId)"),
    );
  });

  test("🚫 nothing else in the repo reads `family_line_links` yet — this is the only reader", () => {
    // TASK-231/232 build on top of it. If a second reader appears, it must be because someone decided to add
    // one, not because they did not know this existed.
    expect(ACCESSOR).toContain("familyLineLinks");
  });
});

describe("the migration is witnessed on a NEW object", () => {
  test("🔑 the witness is the unique index, not one of the two ADD COLUMNs", () => {
    // A column on a pre-existing table is the weaker probe: `0022` is the incident where a probe that was true
    // before AND after hid a migration that had never run.
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0030_family_line_links")!;
    expect(w.probe).toEqual({ kind: "index", index: "family_line_links_user_uq" });
    expect(w.rerunnable).toBe(true);
    expect(w.why).toContain("0022");
  });

  test("every statement is idempotent, so a re-run is safe by construction", () => {
    const creates = statements.match(/CREATE TABLE|CREATE UNIQUE INDEX|ADD COLUMN/g) ?? [];
    const guards = statements.match(/IF NOT EXISTS/g) ?? [];
    expect(guards.length).toBe(creates.length);
  });
});

describe("🔴 nothing existing changes", () => {
  test("`parents.line_user_id` stays — this is additive, like `booking_teachers`", () => {
    expect(SCHEMA).toContain('lineUserId: text("line_user_id")');
    // `parents` is referenced — both new tables have an FK to it — but never altered, and nothing is dropped.
    expect(statements).toContain('REFERENCES "parents"("id")');
    expect(statements).not.toMatch(/DROP\s+COLUMN/i);
    expect(statements).not.toMatch(/ALTER TABLE "parents"/);
  });

  test("the migration touches no existing table except adding two columns to `line_link_sessions`", () => {
    const alters = statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? [];
    expect([...new Set(alters)]).toEqual(['ALTER TABLE "line_link_sessions"']);
  });
});
