-- TASK-492 (SPEC-094, owner rulings 09-25/09-26) — the admin UNDO of a mistaken leave or a false check-in.
--
-- 🔑 TWO objects, both ruled by Sober (TASK-492 contract ❓1):
--  · `bookings.leave_charged` — did THIS leave take quota? RECORDED at the moment a leave door charges (true) or does not
--    (false). "Took quota" is NOT `!planned_at_creation`: an over-quota per-session leave (status set, no quota, no make-up)
--    and an undone attendance (TASK-258) are both SICK_LEAVE with nothing taken, and neither is marked. Inferring the charge
--    from "was it planned?" is TASK-488's mistake with money attached — so the fact is written down. NULL = a leave taken
--    before this file (legacy): the Undo infers only where certain and REFUSES otherwise. No backfill, on purpose.
--  · `booking_undos` — APPEND-ONLY, one row per Undo: who, when, why, what the row was, what came back. An undo is an EVENT,
--    not a property of the row — and it keeps the ORIGINAL check-in's provenance (owner ruling 2) in the one place nothing
--    overwrites (the row's own check-in columns are cleared by a check-in Undo, and a later real check-in rewrites them).
--    The day-end reads it: a session whose check-in was undone is NOT auto-attended (Sober ❓2).
--
-- 🔴 The old columns are untouched. Numbering: counted at the moment of writing — `drizzle/*.sql` = 58 (0000-0057), journal
-- tags = 58, newest `0057` (when 1783000000053) ⇒ this is `0058`, when 1783000000054 — the 59th file. Hand-authored +
-- journal-registered per drizzle/README.md.
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object this file creates — `booking_undos_booking_idx`.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "leave_charged" boolean;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booking_undos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "booking_id" uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "undone_by" text,
  "undone_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reason" text,
  "prior_status" text NOT NULL,
  "prior_checkin_channel" text,
  "prior_checkin_actor" text,
  "leave_refunded" boolean DEFAULT false NOT NULL,
  "makeup_cancelled_id" uuid,
  "expiry_from" date,
  "expiry_to" date,
  CONSTRAINT "booking_undos_kind_chk" CHECK ("kind" IN ('leave', 'checkin'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_undos_booking_idx" ON "booking_undos" ("booking_id", "kind");
