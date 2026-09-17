-- TASK-371 (REQ-091 §9, Deploy A) — a rental becomes a ROW on a session: `booking_rentals`.
--
-- 🔴 Numbering: counted at the moment of writing, per the board rule ("no migration" is a CLAIM, not a state) —
-- `drizzle/*.sql` = 35 (0000–0034) and journal tags = 35 before this, newest `0034`, so this is `0035` — the
-- 36th file, the first migration since 0034. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 WHY A ROW. Before this a rental was ONLY a ledger post (`recordRental` → `recordSale`): no row, no
-- "unpaid" state, so the grid could not say "collect cash for this one". The customer's `R` marker (red unpaid →
-- green paid) needs a fact that exists BEFORE the money moves. The row is that fact; the ledger stays the money —
-- it moves ONLY on the paid press, ONLY through `recordRental`, and `paid_at` is written only after the post
-- answered `recorded` or `duplicate`. 🚫 No price column: prices are constants (owner: fixed for now), and
-- `bo.movement` holds what was actually posted.
--
-- 🔒 THE LOCK — read this before running it (the human runs it; it is why this comment exists):
--   · `CREATE TABLE … REFERENCES "bookings"("id")` takes **SHARE ROW EXCLUSIVE on `bookings`** for the duration
--     of the statement: **reads continue, WRITES to `bookings` (INSERT/UPDATE/DELETE) wait.** There is NO
--     validation scan — the new table is empty — so the hold itself is milliseconds.
--   · It is NOT `0033`'s ACCESS EXCLUSIVE (that one blocked reads too, so the rule was "closed shop").
--   · ⚠️ The same QUEUEING hazard, smaller: if a transaction is holding `bookings` when this starts, the CREATE
--     queues behind it and every WRITE to `bookings` queues behind the CREATE. ⇒ **not closed-shop; a
--     write-blocking blink on `bookings`** — run it outside the 17:30 end-of-day job and not while an import is
--     running. Never read this as "it takes 5 ms".
--   · ONE run, ONE transaction (drizzle runs each migration in a transaction), both statements. `IF NOT EXISTS`
--     on both ⇒ rerunnable.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object this creates — the unique index below, not the
-- table — and it exists ONLY because this ran (0034's two rules). Witnessing the table would call a run that
-- died between the two statements "applied", and the UNIQUE would never exist.
--
-- 📦 DEPLOY ORDER: `db:migrate` (this) → `bun run sale:ensure-items` (adds the 5th `bo.item`,
-- `rental-helmet-pads` 100 — additive, never overwrites a price; NOT a migration insert, `bo.item` is the
-- backoffice's table) → restart. A paid press before the script runs answers `502 RENTAL_NOT_POSTED`, the row
-- stays unpaid, and the press is retried after — the contract's own backstop.

CREATE TABLE IF NOT EXISTS "booking_rentals" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id"  uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
  -- One of `RENTAL_CODES` (`lib/sale-items.ts`) — validated at the edge; the same code the ledger posts.
  "code"        text NOT NULL,
  -- Which set / which pair — required for `rental-set` and `rental-ride` (customer: "Full Set or inline").
  "remark"      text,
  -- Set ONLY after `recordRental` answered `recorded` or `duplicate`. NULL = the `R` is red.
  "paid_at"     timestamptz,
  -- Same convention as `dropped_by` / `ended_by`: the token's subject, resolved at the ROUTE (TASK-160).
  "paid_actor"  text,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "created_by"  text
);
--> statement-breakpoint

-- ONE rental per session — the customer's tiers are whole-session choices, not a basket. The service catches
-- this constraint's 23505 and answers `409 RENTAL_EXISTS` (the app's `onError` would otherwise call it SLOT_TAKEN).
CREATE UNIQUE INDEX IF NOT EXISTS "booking_rentals_booking_uq"
  ON "booking_rentals" ("booking_id");
