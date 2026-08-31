// TASK-218 — the outbox send-once key, at the two places that must agree.
//
// 🔴 What this closes: `runDailyReminderJob` suppressed a whole day on a JOB-level flag. A manual/ops trigger
// at 07:00 wrote `attempted: true`, so the real 08:15 scheduled run skipped and **the day's reminders were
// silently eaten** — a test trigger suppressing the morning send, on a channel where nobody notices a message
// that never arrives. The idempotency moved to the recipient (`lib/daily-reminder.ts`, tested there).
//
// I cannot INSERT from here, so what these pin is the pair that can silently diverge — the hand-written
// migration and `schema.ts` — plus the properties the whole design rests on: the key is UNIQUE (a read alone is
// a race when both boxes fire at 08:15), a SKIPPED row never claims it, and the 23505 swallow is scoped.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";

const SCHEMA = readSrc(await Bun.file(new URL("./schema.ts", import.meta.url)).text());
const SQL = readSrc(await Bun.file(new URL("../../drizzle/0028_outbox_idempotency.sql", import.meta.url)).text());
const LINE = readSrc(await Bun.file(new URL("../lib/line.ts", import.meta.url)).text());

describe("0028 — the outbox can refuse a second send of the same message", () => {
  test("🔑 the migration and the Drizzle schema agree — they are the pair that silently diverges", () => {
    // `schema.ts` is what a future `db:generate` would compare against; leaving it behind would make the next
    // generated migration try to add the column again.
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS "idempotency_key"');
    expect(SCHEMA).toContain('idempotencyKey: text("idempotency_key")');
    for (const src of [SQL, SCHEMA]) expect(src).toContain("notification_outbox_idempotency_uq");
  });

  test("🔴 the index is UNIQUE — a read-then-write is a race when two boxes fire at 08:15", () => {
    expect(SQL).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "notification_outbox_idempotency_uq"');
    expect(SCHEMA).toContain('uniqueIndex("notification_outbox_idempotency_uq")');
  });

  test("the column is NULLABLE — every other outbox writer has its own natural non-repeat", () => {
    // NULLs are distinct in Postgres, so the unique index constrains only the keyed rows. A NOT NULL column
    // would force a key on confirms, leave notices and digests, none of which want one.
    expect(SQL).not.toContain('idempotency_key" text NOT NULL');
    expect(SCHEMA).not.toContain('text("idempotency_key").notNull()');
  });

  test("🔴 a SKIPPED row never carries the key — 'unreachable' is not 'reminded'", () => {
    // The SKIPPED branch writes no `idempotencyKey`. If it did, a parent who was unlinked at the 07:00 trigger
    // and links LINE by 08:15 would be permanently skipped for that day — the same silent miss, one layer over.
    const skippedBranch = LINE.slice(LINE.indexOf("if (!opts.recipientLineUserId)"), LINE.indexOf("try {"));
    expect(skippedBranch).toContain('status: "SKIPPED"');
    expect(skippedBranch).not.toContain("idempotencyKey");
  });

  test("🔴 the unique violation is reported as `duplicate`, not thrown — and only for a keyed send", () => {
    // Swallowing 23505 for an unkeyed insert would hide a real constraint failure.
    expect(LINE).toContain('if (opts.idempotencyKey && pgErrorCode(e) === "23505")');
    expect(LINE).toContain('status: "duplicate"');
  });

  test("🔴 the transaction caveat lives on `enqueueLine` itself, not only in a task file", () => {
    // Sober's review point: a swallowed 23505 inside a transaction leaves it ABORTED, so a keyed send must
    // stay outside one. A caveat that lives in a TASK is a caveat the next caller never reads.
    const doc = LINE.slice(0, LINE.indexOf("export async function enqueueLine"));
    expect(doc).toContain("OUTSIDE a transaction");
    expect(doc).toContain("aborted");
  });
});
