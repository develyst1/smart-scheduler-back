-- TASK-394 (REQ-095 Stage 1, SPEC-080) — ECA · Free/KOL on the `OTHER` booking: a kind, a head count, a per-teacher
-- rate (STORED, never posted), and a reserved "posted" stamp.
--
-- 🔴 Numbering: counted at the moment of writing, per the board rule ("no migration" is a CLAIM, not a state) —
-- `drizzle/*.sql` = 40 (0000–0039) and journal tags = 40 before this, newest `0039`, so this is `0040` — the
-- 41st file. Hand-authored + journal-registered per drizzle/README.md; do NOT run `db:generate` (snapshots stop
-- at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → `0039` → THIS — one `db:migrate` run applies them in journal order; `db:verify`
-- expects 41. None depends on another's objects.
--
-- 📌 WHY COLUMNS ON `bookings`. The `OTHER` booking (REQ-078) already IS the non-revenue schedule: no student, a
-- title, several teachers, no money, it blocks the slot and reaches the coach's reminder. ECA / Free / KOL add
-- three facts to it — WHICH kind, HOW MANY heads, and each teacher's RATE (the owner's ruling: entered on the
-- schedule, stored here, PASSED to the backoffice as an expense — the pass itself is an owner decision,
-- SPEC-080 §3.1, so `rate_posted_at` is reserved and stays NULL this stage). `other_kind` is a CODE list
-- (`ECA | FREE | KOL`, `lib/other-kind.ts`), NOT a Postgres enum — an enum label add cannot share a transaction
-- with its first use (0029's split-run lesson), and a text column with a code list never will.
--
-- 🔒 THE LOCK — read this before running it (the human runs it; it is why this comment exists):
--   · 🔴 **`bookings` IS THE HOT TABLE**: every calendar read, every availability check, the 17:30 job, the
--     reminder job and every booking write touch it, and it is thousands of rows. Statements 1–4 each take
--     **ACCESS EXCLUSIVE on `bookings`** for the duration of that statement — reads AND writes wait. Each is a
--     NULLable column with no default: a catalog write, **no table rewrite, no backfill**, milliseconds each.
--   · ⚠️ THE QUEUEING HAZARD IS REAL HERE: if any transaction holds `bookings` when a statement starts (a
--     booking being written, the day-end job mid-run, an import), the ALTER queues behind it and EVERY calendar
--     read and booking write queues behind the ALTER until it gets its turn. ⇒ **run at a quiet moment — never
--     during the 17:30 end-of-day job, the morning reminder, or an import.** Never read "milliseconds" as
--     "harmless at any time".
--   · Statement 5 takes ACCESS EXCLUSIVE on `booking_teachers` — a tiny table (one row per extra teacher).
--   · ONE run, ONE transaction, five statements; all `IF NOT EXISTS` ⇒ rerunnable.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the LAST object — `booking_teachers.rate_minor` — invented by this
-- migration (0034's rules). Witnessing an earlier column would call a run that died mid-way "applied".

-- ECA | FREE | KOL (a code list in `lib/other-kind.ts`). NULL on every lesson type and on an OTHER made before this.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "other_kind" text NULL;
--> statement-breakpoint

-- How many heads the slot serves (a number; the free-text `note` carries anything else — SPEC-080 §3.2).
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "head_count" integer NULL;
--> statement-breakpoint

-- The PRIMARY teacher's rate for this session, in satang. STORED ONLY — nothing here posts it.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "teacher_rate_minor" integer NULL;
--> statement-breakpoint

-- RESERVED for the backoffice expense pass (owner decision pending). Always NULL this stage; nothing writes it.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "rate_posted_at" timestamptz NULL;
--> statement-breakpoint

-- Each ADDITIONAL teacher's rate for this session, in satang. STORED ONLY.
ALTER TABLE "booking_teachers" ADD COLUMN IF NOT EXISTS "rate_minor" integer NULL;
