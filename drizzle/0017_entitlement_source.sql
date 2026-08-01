-- SPEC-025 / TASK-079: where an entitlement came from — a SALE, or an IMPORT of one bought before go-live.
--
-- Why it must be recorded rather than inferred: since TASK-066 revenue posts at the point of sale, so
-- "created with no SALE movement" means *the sale path broke* — which is exactly what the `sales_not_posted`
-- attention check (TASK-067) watches for. An imported course has no movement **by design**, so without this
-- column go-live morning would list ~30 imported families as revenue faults for a week, and the one detector
-- guarding real revenue would get muted in the fortnight we most need it.
--
-- DEFAULT 'SALE': every existing row is a sale, and the normal path keeps behaving exactly as before.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate`). Idempotent.

ALTER TABLE "course_packages" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'SALE';
--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'SALE';
--> statement-breakpoint
ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_packages_source_chk";
--> statement-breakpoint
ALTER TABLE "course_packages" ADD CONSTRAINT "course_packages_source_chk"
  CHECK ("source" IN ('SALE', 'IMPORT'));
--> statement-breakpoint
ALTER TABLE "vouchers" DROP CONSTRAINT IF EXISTS "vouchers_source_chk";
--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_source_chk"
  CHECK ("source" IN ('SALE', 'IMPORT'));
