-- SPEC-071 / TASK-230 (REQ-079) — a family is a set of LINE accounts, and an invite is the only way in.
--
-- 🔴 Numbering: counted at the moment of writing, per the board rule ("no migration" is a CLAIM, not a state) —
-- `drizzle/*.sql` = 30 (0000–0029) and journal tags = 30 before this, newest `0029`, so this is `0030`.
-- Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop at 0003).
--
-- 📌 Why this exists at all: a LINE chat cannot be addressed until it speaks, so the door has to be something a
-- parent TYPES. The family code died with §15, which leaves the invite as the ONLY way anyone ever joins a
-- family — mother, father, grandmother, a new phone. These two tables are therefore the data model, not a
-- convenience over `parents.line_user_id`.

CREATE TABLE IF NOT EXISTS "family_line_links" (
  "parent_id"    uuid NOT NULL REFERENCES "parents"("id") ON DELETE CASCADE,
  "line_user_id" text NOT NULL,
  "linked_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("parent_id", "line_user_id")
);
--> statement-breakpoint

-- 🔴 THE LOAD-BEARING LINE. One LINE account belongs to exactly ONE family.
--
-- Without it a second family's invite silently re-points an account, and that parent opens the app to
-- **another family's children** — TASK-047's PII failure by a different route. It extends the same
-- "one LINE user ⇒ one active roster link" rule `lib/roster-link.ts` already enforces for teacher/parent,
-- which is why this is a UNIQUE INDEX and not an application check: the app decides who may join, the database
-- decides that they may only join once.
CREATE UNIQUE INDEX IF NOT EXISTS "family_line_links_user_uq"
  ON "family_line_links" ("line_user_id");
--> statement-breakpoint

-- An invite is a one-shot, expiring token an admin hands to a family. `used_at` / `used_by` are kept rather
-- than the row being deleted: "who joined this family, and when" is the question this table exists to answer
-- after the fact, and a deleted row answers nothing.
CREATE TABLE IF NOT EXISTS "family_invites" (
  "code"       text PRIMARY KEY,
  "parent_id"  uuid NOT NULL REFERENCES "parents"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "used_at"    timestamptz,
  "used_by"    text
);
--> statement-breakpoint

-- AC-17 — an admin (or the two-strikes rule) can silence the bot in one chat for a while.
ALTER TABLE "line_link_sessions" ADD COLUMN IF NOT EXISTS "muted_until" timestamptz;
--> statement-breakpoint

-- ⚠️ AC-18's TWO-STRIKES counter — **not** the code lockout. `code_attempts` / `code_locked_until` died with the
-- family code in §15; this one survives, because Rule 5 still requires "two unexpected replies and the bot hands
-- over", which needs a per-conversation count. The two were deleted on one sentence in a release note, which is
-- exactly why the distinction is written here as well as in the spec.
--
-- It resets on success and dies with the session row: a counter that only ever increments hands someone a
-- locked chat in June for a typo in March.
--
-- 🔑 THE WITNESS for 0030 is `family_invites` / `family_line_links_user_uq` — objects that exist ONLY after this
-- ran. `ADD COLUMN` is witnessable, but a column on a pre-existing table is the weaker probe, and `0022` is the
-- incident where a probe that was true before and after hid a migration that had never run.
ALTER TABLE "line_link_sessions" ADD COLUMN IF NOT EXISTS "unexpected_count" integer NOT NULL DEFAULT 0;
