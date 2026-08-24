-- SPEC-063 / TASK-178 (REQ-068) — a note about the ATTENDEE, kept on the session.
--
-- 🔴 Why a new column rather than reusing `bookings.note`: `note` is the system's own status-reason field —
-- cancel, sick leave and the auto-extend all write it (`scheduler.service.ts:1595/1737/1927/1990/2031`). If the
-- two shared a column, taking a leave would overwrite "พาน้องมาด้วย 2 คน" and writing that note would erase the
-- reason a session was cancelled. Both losses would be silent, and neither is recoverable.
--
-- Nullable and additive: every existing booking is untouched, and a booking with no note behaves exactly as it
-- does today. No back-fill — there is nothing to derive one from.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — the snapshot chain stops
-- at 0003). Idempotent.

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "attendee_note" text;
