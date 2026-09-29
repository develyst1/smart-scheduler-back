-- TASK-561 (REQ-110 item 2; Sober's ruling 09-29) — a teacher's ADVANCE leave, recorded as a fact.
--
-- Khwan: "วันที่ครูแจ้งลาล่วงหน้า … ทำตารางดำเฉพาะวันนั้นๆ ไม่ให้มีการจอง" — e.g. teacher A away on 21/10, a working day.
-- The owner: the WHOLE day is blocked for NEW bookings with that teacher only; bookings already there are LISTED for the
-- admin; NOTHING moves or cancels automatically. Before this table the fact existed nowhere: `reportOwnLeave` cancels the
-- day's rows and, on an EMPTY day (Khwan's case), wrote nothing. ⇒ record the fact instead of inferring it from side effects.
-- One row per (teacher, date). No backfill: nothing earlier recorded a leave day.
-- Numbering: counted at the moment of writing — `drizzle/*.sql` = 62 (0000-0061), journal tags = 62, newest `0061`
-- (when 1783000000057) ⇒ this is `0062`, when 1783000000058 — the 63rd file. Hand-written (drizzle/README.md: no db:generate).
-- 🔑 THE WITNESS (`lib/migration-witness.ts`): the unique index, the LAST object this file creates. Rerunnable: IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "teacher_leave_days" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "teacher_id" uuid NOT NULL REFERENCES "teachers"("id") ON DELETE RESTRICT,
  "date" date NOT NULL,
  "reason" text,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teacher_leave_days_teacher_date_uq" ON "teacher_leave_days" ("teacher_id", "date");
