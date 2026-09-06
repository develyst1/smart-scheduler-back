-- SPEC-076 / TASK-264 (REQ-082 AC-2) — a durable record of every change to a course's expiry date.
--
-- 🔴 Numbering: counted at the moment of writing, per the board rule ("no migration" is a CLAIM, not a state) —
-- `drizzle/*.sql` = 34 (0000–0033) and journal tags = 34 before this, newest `0033`, so this is `0034`.
-- Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop at 0003).
--
-- 📌 WHY A TABLE AND NOT A LOG LINE. `SYSTEM-FACTS.md`: *"NO audit table exists anywhere"* — clearing a
-- family's LINE link is a log line only. A log line answers nobody in six weeks, and the question this record
-- exists for is exactly that shape: *"ทำไมคอร์สนี้หมดอายุวันนี้"*. An expiry is the boundary of something a
-- family paid for, so moving it is a money-adjacent act performed by a staff click.
--
-- 🚫 THIS IS NOT AN AUDIT SYSTEM, and deliberately not. Nobody specified one, and *"log everything"* is a
-- design that grows until it is switched off.
-- ⚠️ **But this is the SECOND demand of its class in two weeks, so the SHAPE is the reusable part:**
--   subject id · from · to · actor · timestamp — nothing else.
-- **TASK-244 is the likely second tenant** (a durable trail for the one act that moves a LINE account between
-- families, today a log line, for the same reason). ⇒ When it lands, copy this shape into its own table rather
-- than inventing a third answer, or generalise these two together with that decision written down.
-- 🚫 **No free-text reason column.** Nobody asked for one, and a reason field on an audit row is a prompt
-- somebody has to fill in and will not — an always-empty column that makes the record look richer than it is.

CREATE TABLE IF NOT EXISTS "course_expiry_changes" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"  uuid NOT NULL REFERENCES "course_packages"("id") ON DELETE CASCADE,
  -- Both dates are stored, not just the new one: "from what" is half of AC-2, and reconstructing it by walking
  -- the previous row breaks the moment a row is missing — which is the state a hole on day one would leave.
  "from_date"  date NOT NULL,
  "to_date"    date NOT NULL,
  -- Same convention as `dropped_by` / `ended_by`: the token's subject, resolved at the ROUTE, never taken from
  -- a request body (TASK-160). Nullable because an unauthenticated path would otherwise write a lie.
  "actor"      text,
  "changed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The only way this table is ever read: "show me this course's expiry history, newest first."
CREATE INDEX IF NOT EXISTS "course_expiry_changes_course_idx"
  ON "course_expiry_changes" ("course_id", "changed_at" DESC);
