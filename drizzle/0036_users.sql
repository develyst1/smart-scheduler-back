-- TASK-377 (REQ-092 RBAC, SPEC-079 Stage 1) — `users`, and an EMPTY `user_permissions` so Stages 2–3 need no migration.
--
-- 🔴 Numbering: counted at the moment of writing, per the board rule ("no migration" is a CLAIM, not a state) —
-- `drizzle/*.sql` = 36 (0000–0035) and journal tags = 36 before this, newest `0035`, so this is `0036` — the
-- 37th file. Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop
-- at 0003).
--
-- 📌 WHY NOW. The app had ONE shared env login and a JWT `{ sub: username, role }`. The owner bought the full
-- RBAC system, staged: this is the foundation — real users, real passwords (`Bun.password`, argon2id), a guard
-- that reads the user row on every request so a disabled user is out within the request rather than the token's
-- TTL, and every audit `actor` becomes a real username. Permission KEYS are code constants (SPEC-079 §1), so
-- `user_permissions` holds only `(user_id, key)` grants — created here, empty, unused until Stage 2.
--
-- 🔒 THE LOCK — read this before running it:
--   · Two NEW tables and two NEW indexes. The only FK is from `user_permissions` (new) to `users` (new) — it
--     takes SHARE ROW EXCLUSIVE on `users`, a table that did not exist a statement earlier. **No lock is taken on
--     any EXISTING table**: `bookings`, `parents`, `course_packages` are untouched. Reads and writes elsewhere
--     continue throughout.
--   · ONE run, ONE transaction, four statements; every object is `IF NOT EXISTS` ⇒ rerunnable.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `user_permissions_user_key_uq` — invented by this
-- migration over a table invented by this migration (0034's two rules). Witnessing `users` would call a run that
-- died after the first statement "applied", and Stage 2 would find no grants table.
--
-- 📦 AFTER THE MIGRATION: set `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` in the env and restart. The
-- first `POST /auth/login` with that pair while `users` is EMPTY creates the first super admin and logs them in;
-- once any user exists the pair is ignored. The old `ADMIN_USERNAME` / `ADMIN_PASSWORD` login is RETIRED
-- (SPEC-079 §3.1) — remove them from the env.

CREATE TABLE IF NOT EXISTS "users" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Trimmed and lower-cased on write; `^[a-z0-9._-]{3,40}$`. The login key and the audit `actor`.
  "username"         text NOT NULL,
  -- `Bun.password.hash` (argon2id). Never selected into a DTO — the service picks columns.
  "password_hash"    text NOT NULL,
  "display_name"     text NOT NULL,
  -- A super admin ignores `user_permissions` (has everything) and is the only one who manages users.
  "is_super_admin"   boolean NOT NULL DEFAULT false,
  -- Set = the account is off: login refused, and the guard refuses a still-valid token within the request.
  "disabled_at"      timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  -- The creating super admin's username (the bootstrap writes `bootstrap`). Same convention as `dropped_by`.
  "created_by"       text,
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "users_username_uq" ON "users" ("username");
--> statement-breakpoint

-- Stage 2 onward: a user's effective GRANTS, one row per permission key (`menu:*`, `action:*` — code constants).
-- Created now so Stages 2 and 3 ship without a migration. Empty until then.
CREATE TABLE IF NOT EXISTS "user_permissions" (
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key"         text NOT NULL,
  "granted_by"  text,
  "granted_at"  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "user_permissions_user_key_uq" ON "user_permissions" ("user_id", "key");
