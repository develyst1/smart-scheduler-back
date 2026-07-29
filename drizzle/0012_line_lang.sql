-- REQ-015 / TASK-039: per-user LINE bot reply language (TH|EN), null → TH. Additive + idempotent
-- (matches the repo's IF-NOT-EXISTS migration style; safe to (re-)apply against the drifted meta snapshot).
-- Apply at deploy on the scheduling DB; the app owns public.*. BE does NOT apply it (brownfield).
ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "line_lang" text;
--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "line_lang" text;
