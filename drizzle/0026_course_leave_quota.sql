-- SPEC-068 / TASK-213 — an OFF-CARD imported course carries its own leave quota.
--
-- 🔴 The defect this closes: the form accepted any size 1–100, but leave quota and the max-week ceiling were
-- two hand-typed tables that knew only 4/6/10. An off-card size fell through both to `quota = 0, maxWeek = 0`
-- — a course with **no leave allowance and an expiry in its own first week** — and nothing anywhere said so.
-- (In practice it 500'd first, which is the only reason no family has one.)
--
-- The quota is stored rather than derived because for an off-card course it is **a fact somebody entered**,
-- not something the card can answer. `NULL` means "use the card's", so every existing course is untouched and
-- keeps deriving exactly as it does today.
--
-- `max_week` is deliberately NOT a column: it is `size + leave_quota` (the owner's rule — 4+1=5, 6+2=8,
-- 10+3=13), and a second stored number that must agree with the first is a second number that eventually
-- doesn't.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate` — the snapshot chain stops
-- at 0003). Idempotent.

ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "leave_quota" smallint;
--> statement-breakpoint
ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_packages_leave_quota_chk";
--> statement-breakpoint
-- A negative quota would be a course that can never take leave AND expires before it starts.
ALTER TABLE "course_packages" ADD CONSTRAINT "course_packages_leave_quota_chk"
  CHECK ("leave_quota" IS NULL OR "leave_quota" >= 0);
