-- SPEC-024 / TASK-077: subjects carry a PRICE GROUP, so a sale can post at the real card price.
--
-- Six skate programs share one price line, so the group — not the subject — is the unit prices are keyed on.
-- Keying by subject would mean ~24 items where 13 are needed, and a seventh skate program would need a price
-- invented rather than inherited.
--
-- The mapping is DATA, not code, precisely so the owner can add a program without a deploy: a new skate
-- program joins 'bike-skate' and is priced correctly by an UPDATE.
--
-- ⚠️ A subject left with NULL price_group cannot be sold as a course/session — the sale refuses **loudly**
-- (no item for an unknown code). That is deliberate: it must never fall back to a default price. "1st Trial"
-- is intentionally NULL — it is not a package, and `first-trial` is priced on its own.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate`). Idempotent.

ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "price_group" text;
--> statement-breakpoint
-- Matched on the seeded program names. ⚠️ If a production subject was renamed, its group stays NULL and its
-- sales refuse loudly rather than posting a wrong number — see the deploy smoke in the task notes, which
-- checks for any non-trial subject still NULL after this runs.
UPDATE "subjects" SET "price_group" = 'bike-skate'
  WHERE "price_group" IS NULL AND "name" IN (
    'Bike / Scooter / Balance Cruiser', 'Surfskate', 'Freeskate', 'Skateboard', 'Inline Skate'
  );
--> statement-breakpoint
UPDATE "subjects" SET "price_group" = 'onewheel'
  WHERE "price_group" IS NULL AND "name" = 'Onewheel E-Skate';
--> statement-breakpoint
UPDATE "subjects" SET "price_group" = 'balance-private'
  WHERE "price_group" IS NULL AND "name" = 'Balance Play (Private)';
--> statement-breakpoint
UPDATE "subjects" SET "price_group" = 'balance-group'
  WHERE "price_group" IS NULL AND "name" = 'Balance Play (Group)';
