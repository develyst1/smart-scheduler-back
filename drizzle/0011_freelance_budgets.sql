-- SPEC-005 / TASK-019: re-home the freelance budget into scheduling `public` (standalone, no ops).
-- Hand-written IF-NOT-EXISTS (matches the repo's migration style + the drifted-meta posture).
CREATE TABLE IF NOT EXISTS "freelance_budgets" (
	"teacher_id" uuid PRIMARY KEY NOT NULL,
	"monthly_budget_minor" integer NOT NULL,
	"rate_minor" integer NOT NULL,
	"remaining_minor" integer NOT NULL,
	"reorder_minor" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "freelance_budgets" ADD CONSTRAINT "freelance_budgets_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
