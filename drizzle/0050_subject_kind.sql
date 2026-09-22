-- TASK-437 (REQ-095 §13.4a, SPEC-089 A) — a subject has a TYPE, not a name rule: `subjects.kind` = PRIVATE (the default) |
-- DUO. The two seeded DUO programs carry DUO (`scripts/ensure-subjects.ts`, the human runs it after this); the DUO Program
-- dropdown lists DUO subjects only, every other picker hides them, and the SERVER refuses a DUO course on a non-DUO subject
-- (and a Private course on a DUO one). The closed set is `SUBJECT_KINDS` in `lib/subject-kinds.ts` — the CHECK below is its
-- database copy, pinned equal by the suite.
--
-- 🔴 Numbering: counted at the moment of writing — `drizzle/*.sql` = 50 (0000–0049) and journal tags = 50 before this,
-- newest `0049`, so this is `0050` — the 51st file. Hand-authored + journal-registered per drizzle/README.md; do NOT
-- run `db:generate` (snapshots stop at 0003).
--
-- 📌 THE CUTOVER ORDER: `0038` → … → `0049` → THIS — one `db:migrate` run; `db:verify` expects 51. No enum. Then the
-- human runs `bun run subjects:ensure` (dry-run), reads the plan, and `--apply`.
--
-- ⚠️ LOCKS, said plainly:
--   · `ALTER TABLE subjects ADD COLUMN kind text NOT NULL DEFAULT 'PRIVATE'`: `subjects` is a SMALL table (a dozen rows) —
--     the default fills in place under ACCESS EXCLUSIVE for a blink; nothing waits that a human could notice.
--   · The CHECK is added `NOT VALID` and then `VALIDATE`d (the 0045 shape) — the validation scan runs under SHARE UPDATE
--     EXCLUSIVE, which blocks nothing a reader or writer does.
--
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the CHECK's DEFINITION — `subjects_kind_chk` contains both literals — the
-- LAST object, invented here. Rerunnable: the column IF NOT EXISTS; the constraint dropped-if-exists before it is added.

ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'PRIVATE';
--> statement-breakpoint

ALTER TABLE "subjects" DROP CONSTRAINT IF EXISTS "subjects_kind_chk";
--> statement-breakpoint

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_kind_chk"
  CHECK ("kind" IN ('PRIVATE', 'DUO')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "subjects" VALIDATE CONSTRAINT "subjects_kind_chk";
