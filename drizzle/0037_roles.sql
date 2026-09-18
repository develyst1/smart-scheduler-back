-- TASK-387 (REQ-092 RBAC, SPEC-079 Stage 4 — the finale) — `roles`, `role_permissions`, `users.role_id`.
--
-- 🔴 Numbering: counted at the moment of writing, per the board rule ("no migration" is a CLAIM, not a state) —
-- `drizzle/*.sql` = 37 (0000–0036) and journal tags = 37 before this, newest `0036`, so this is `0037` — the
-- 38th file. Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop
-- at 0003).
--
-- 📌 THE MODEL (decided, SPEC-079 §1 + TASK-387 §1). A role is LIVE, not a snapshot: `users.role_id` references
-- it and a user's EFFECTIVE grants = the role's keys ∪ the user's own `user_permissions` rows (additive
-- overrides; no "deny" this stage). Editing a role changes every holder at their next request — the guard reads
-- per request, so there is no propagation job. Keys stay code constants (`lib/permissions.ts`); both grant tables
-- hold only `(owner, key)`.
--
-- 🔒 THE LOCK — read this before running it (the human runs it; it is why this comment exists):
--   · Statement 3, `ALTER TABLE users ADD COLUMN role_id uuid NULL REFERENCES roles`, takes **ACCESS EXCLUSIVE on
--     `users`** for the duration of that ONE statement: reads AND writes to `users` wait. A NULLable column with
--     no default is a catalog write — **no table rewrite, no backfill** — and the FK validation scans `users` once
--     (every row is NULL, nothing to check). `users` is tens of rows: the hold is milliseconds. **The four other
--     statements lock nothing existing** — `roles` and `role_permissions` are new; their only FKs are to each
--     other and (`users.role_id`) to `roles`, a table that did not exist a statement earlier.
--   · ⚠️ The queueing hazard, in miniature: every request's guard READS `users` (Stage 1), so while the ALTER
--     waits for a transaction that holds `users`, every login and every guarded request queues behind it. ⇒ a
--     read-blocking blink on `users` — run it at a quiet moment, not during an import. Never read this as "5 ms".
--   · ONE run, ONE transaction (drizzle runs each migration in a transaction), five statements; every object is
--     `IF NOT EXISTS` ⇒ rerunnable.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `role_permissions_role_key_uq` — invented by this
-- migration over a table invented by this migration (0034's two rules). Witnessing `roles` or the column would
-- call a run that died mid-way "applied", and the one-key-per-role guarantee would never exist.
--
-- 🚫 DELETING A ROLE IN USE: `users.role_id` is `ON DELETE RESTRICT` — the DB refuses; the service refuses FIRST
-- with the holder count (`409 ROLE_IN_USE`) so the super admin reassigns before deleting. `role_permissions` is
-- `ON DELETE CASCADE`: a role's keys go with the role.

CREATE TABLE IF NOT EXISTS "roles" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Trimmed on write, 1–60 chars; unique CASE-INSENSITIVELY (the Select would show two "Admin"s otherwise).
  "name"         text NOT NULL,
  "description"  text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  -- The creating super admin's username. Same convention as `users.created_by`.
  "created_by"   text,
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "roles_name_uq" ON "roles" (lower("name"));
--> statement-breakpoint

-- 🔒 The one statement that touches an existing table — see THE LOCK above. NULL = no role (own rows only).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role_id" uuid NULL REFERENCES "roles"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- A role's grants, one row per permission KEY (`menu:*`, `action:*` — code constants). Read by the guard as
-- `… UNION SELECT key FROM role_permissions WHERE role_id = <the user's>`.
CREATE TABLE IF NOT EXISTS "role_permissions" (
  "role_id"     uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "key"         text NOT NULL,
  "granted_by"  text,
  "granted_at"  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_role_key_uq" ON "role_permissions" ("role_id", "key");
