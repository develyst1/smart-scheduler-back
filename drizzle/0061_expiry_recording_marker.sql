-- TASK-556 (1b; Sober's ruling 09-29) — write down, ONCE, since when this box records every move of a course's expiry.
--
-- The Undo reads "no `course_expiry_changes` row" as "the expiry was never moved" — true only for a course born after recording
-- began. Every stretch/edit before 0034 went unrecorded (no backfill), so a pre-recording course's null means "unknown".
-- 🚫 NOT derivable from the ledger: `drizzle.__drizzle_migrations.created_at` is the journal's synthetic `when`, identical on
-- every box — it is not the time a migration ran. 🚫 NOT a live `min(changed_at)`: an empty table cannot tell "no moves yet"
-- from "no recording yet", so a fresh box would refuse everything. ⇒ the fact is written here, once:
--   an existing box → its EARLIEST recorded change (recording code was provably live then; courses born between the 0034 deploy
--   and that first record keep refusing — the safe direction);
--   a fresh box (no rows) → now(), i.e. before its first course.
-- ON CONFLICT DO NOTHING: a re-run never moves the marker.
-- Numbering: counted at the moment of writing — `drizzle/*.sql` = 61 (0000-0060), journal tags = 61, newest `0060`
-- (when 1783000000056) ⇒ this is `0061`, when 1783000000057 — the 62nd file. Hand-written (drizzle/README.md: no db:generate).
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the table. A table without its row (only reachable out-of-band) reads to the Undo
-- as "no marker" ⇒ it refuses, which is safe.
CREATE TABLE IF NOT EXISTS "expiry_recording_marker" (
  "id" smallint PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "recording_since" timestamptz NOT NULL
);
--> statement-breakpoint
INSERT INTO "expiry_recording_marker" ("id", "recording_since")
  SELECT 1, COALESCE((SELECT min("changed_at") FROM "course_expiry_changes"), now())
  ON CONFLICT ("id") DO NOTHING;
