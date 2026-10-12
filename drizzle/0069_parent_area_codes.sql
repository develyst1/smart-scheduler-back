-- TASK-800 (REQ-118, owner GO 2026-10-12) — the parent's address as AREA CODES: the official DOPA codes of the province (2 digits), the district (4) and the sub-district (6), so an address can be shown in either
-- language, checked for consistency (the district inside the province, the sub-district inside the district) and counted. THREE nullable text columns on `parents`; `parents.province` (the Thai name) STAYS and is written
-- FROM the code, so Palm's reports and every reader keep working untouched.
-- NO DATA IS WRITTEN HERE: existing rows keep NULL codes. The backfill is a separate, OWNER-RUN script (`scripts/backfill-area-codes.ts`, a dry run by default) — never part of a deploy.
-- Rerunnable: YES — `ADD COLUMN IF NOT EXISTS`. `subdistrict_code` is the LAST column added, so a half-applied file reads as "not applied" and re-runs (the witness rule).
ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "province_code" text;
--> statement-breakpoint
ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "district_code" text;
--> statement-breakpoint
ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "subdistrict_code" text;
