-- TASK-568 (REQ-110 item 3) — a voucher's expiry can be extended, and EVERY move of it is recorded from day one.
--
-- 🔴 D8 (TASK-556) existed because expiry moves went UNRECORDED: a reader could not tell "never moved" from "moved, unrecorded".
-- ⇒ this record exists BEFORE the edit does, and both writers of a voucher's expiry write here: an admin's edit (actor = the
-- username) and the first booking's re-count (actor NULL = the system). The value written at sale time is the starting point,
-- not a change.
-- The SAME shape as `course_expiry_changes` (0034 — "copy this shape into its own table rather than inventing a third answer"):
-- subject id · from · to · actor · when, nothing else. A sibling, not a shared table: that one's FK is to courses.
-- Numbering: counted at the moment of writing — `drizzle/*.sql` = 63 (0000-0062), journal tags = 63, newest `0062`
-- (when 1783000000058) ⇒ this is `0063`, when 1783000000059 — the 64th file. Hand-written (drizzle/README.md: no db:generate).
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the index, the LAST object this file creates. Rerunnable: IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "voucher_expiry_changes" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "voucher_id" uuid NOT NULL REFERENCES "vouchers"("id") ON DELETE CASCADE,
  "from_date"  date NOT NULL,
  "to_date"    date NOT NULL,
  "actor"      text,
  "changed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voucher_expiry_changes_voucher_idx" ON "voucher_expiry_changes" ("voucher_id", "changed_at" DESC);
