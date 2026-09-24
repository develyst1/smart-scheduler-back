-- TASK-460 (REQ-105 §7, DEF-1) — the webhook's idempotency store.
--
-- 🔑 WHY A TABLE AND NOT A FLAG SOMEWHERE: LINE re-delivers an event when it did not get a timely 200 — which is
-- exactly the state we have been in (14 x request_timeout on 2026-09-24, on the REAL customer OA). Once the handler
-- runs AFTER the ACK, a re-delivered "type your phone" must not link the family twice or message them twice. The
-- PRIMARY KEY is the whole mechanism: the INSERT itself is the dedupe (ON CONFLICT DO NOTHING ... RETURNING), so two
-- concurrent deliveries of one event cannot both pass — a read-then-check could never promise that.
--
-- 🚫 NOT a column on `line_link_sessions`: a postback from a chat with no session would have nowhere to write, and
-- that row is deleted when the flow completes. A key that vanishes when the flow ends is not a key.
--
-- ⏳ The rows are swept by the EXISTING day-end job (older than 7 days), not by a new job: a new job here would be an
-- exe plus a Task Scheduler registration only the human can perform, for a table of one-line rows (TASK-456's shape).
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 55 (0000-0054) and journal tags = 55 before
-- this, newest `0054`, so this is `0055` — the 56th file. Hand-authored + journal-registered per drizzle/README.md;
-- do NOT run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` -> ... -> `0054` -> THIS — one `db:migrate` run; `db:verify` expects 56. No enum.
--
-- ⚠️ LOCKS: a CREATE TABLE touches nothing that exists; the index is created with the table. Rerunnable (IF NOT EXISTS).
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the table — it is this file's only object.

CREATE TABLE IF NOT EXISTS "line_webhook_events" (
  "webhook_event_id" text PRIMARY KEY,
  "seen_at"          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- the sweep deletes by age, so it reads this and never the table
CREATE INDEX IF NOT EXISTS "line_webhook_events_seen_at_idx" ON "line_webhook_events" ("seen_at");
