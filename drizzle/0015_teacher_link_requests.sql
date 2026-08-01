-- REQ-020 Stage 2 / TASK-075: teacher LINE links become requests that staff approve.
--
-- Before this, typing a teacher's nickname into the bot bound that teacher's account to whoever typed it,
-- immediately (line-webhook.service.ts:174). Stage 1 (TASK-047) stopped a *collision* binding the wrong
-- person; this removes the assumption underneath it — a claim is now a request, and approval is the only
-- thing that grants access.
--
-- `teacher_id` is NULLABLE on purpose: for a nickname collision we do not know who the claimant is, and
-- guessing is the bug we are fixing. Staff name the teacher at approval time.
--
-- Hand-authored + journal-registered per drizzle/README.md (do NOT run `db:generate`). Idempotent; applied at
-- deploy by the human via `bun run db:migrate`.

CREATE TABLE IF NOT EXISTS "teacher_link_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "line_user_id" text NOT NULL,
  "claimed_nickname" text NOT NULL,
  "teacher_id" uuid REFERENCES "teachers"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "decided_by" text,
  CONSTRAINT "teacher_link_requests_status_chk"
    CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED'))
);
--> statement-breakpoint
-- ONE pending request per LINE account, enforced by the database rather than by remembering to check:
-- a confused teacher retrying three times must not leave staff three identical rows to work through.
-- Partial, so their historical APPROVED/REJECTED rows stay as an audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS "teacher_link_requests_pending_uq"
  ON "teacher_link_requests" ("line_user_id")
  WHERE "status" = 'PENDING';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teacher_link_requests_status_idx"
  ON "teacher_link_requests" ("status", "created_at");
