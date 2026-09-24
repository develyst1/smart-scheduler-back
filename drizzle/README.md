# Scheduling migrations (`drizzle/`)

## Deploy: apply migrations with the standard command

```bash
bun run db:migrate      # = drizzle-kit migrate, uses $DATABASE_URL
```

`drizzle-kit migrate` applies every migration listed in `meta/_journal.json` that isn't yet recorded in the
DB's `__drizzle_migrations` table. It is **safe to re-run** (already-applied migrations are skipped), and our
hand-authored migrations use `... IF NOT EXISTS` so they're idempotent even if an environment applied one by
hand. **Use `bun run db:migrate` — no `psql` side-channel.**

> Every `NNNN_*.sql` here must have a matching entry in `meta/_journal.json`, or `db:migrate` silently skips it.
> (That was the `0012_line_lang` defect — TASK-042 registered it; the folder is now consistent, idx 0–12.)

## ⚠️ Trap: do NOT run `db:generate` / `db:push` as-is (snapshot chain is incomplete)

`meta/` contains snapshots for **only `0000–0003`**, but the journal + SQL go up to `0012`. Migrations
`0004–0012` were **hand-authored** (not produced by `drizzle-kit generate`), so no per-migration snapshot was
written for them.

`drizzle-kit generate` diffs the current schema against the **latest snapshot**. With the 0004–0012 snapshots
missing it can't reconstruct that state, so **it regenerates the ENTIRE schema as a new migration** — verified
2026-07-30 (a probe `generate` in an isolated scratch copy emitted one full-schema migration re-creating all 18
tables, incl. `parents/teachers.line_lang`, `freelance_budgets`, the `bo` `item`/`movement`, badges, etc.). If
that were committed and applied it would try to re-create existing objects → breakage.

**So, to add a schema change in this repo, follow the established pattern — do NOT `db:generate`:**

1. Edit `src/db/schema.ts`.
2. **Hand-write** `drizzle/NNNN_<name>.sql` using `ADD COLUMN/TABLE ... IF NOT EXISTS` (+ `--> statement-breakpoint`
   between statements), mirroring `0010`–`0012`.
3. **Add the matching entry** to `meta/_journal.json` (`{"idx": N, "version": "7", "when": <continue the
   synthetic incrementing value>, "tag": "NNNN_<name>", "breakpoints": true}`).
4. Apply with `bun run db:migrate`.

Rebuilding the real 0004–0012 snapshot chain so `db:generate` works again is a separate, careful task (it must
not fabricate unverifiable meta snapshots) — out of scope for a feature change.

## 🔑 A migration that drops an object must re-point any witness that probes it — IN THE SAME TASK

`src/lib/migration-witness.ts` gives every migration a **witness**: one database object whose presence proves that
migration ran. `bun run db:seed-ledger` trusts those witnesses to decide what to write into the ledger that
`db:migrate` then reads.

⇒ If your migration **drops or supersedes** an object that an EARLIER migration uses as its witness, that earlier
witness starts reading `found=false` on a **correctly migrated** box. The seeder then reports that migration as
*not applied* and proposes applying it — and applying it would **undo your migration**. It is not a misleading
message; it is a tool proposing a regression.

**What to do, in the same task, never "later":**

1. Re-point the earlier witness to `{ kind: "superseded-by", tag: "<your migration>" }` (see `0002` → `0007`, and
   `0052` → `0053`).
2. Set its `rerunnable: false` and say in its `why` that **re-running it would REGRESS** your migration, and what
   it would break.
3. `src/lib/witness-observability-req105.test.ts` walks every witness and fails if one probes an object no longer
   declared by the schema and not dropped-then-kept by the SQL. It will catch you — but it catches you **after**
   you have already thought about it, which is the wrong order.

📌 2026-09-24: this cost a halted deploy on `sid` (`0052`'s table, dropped on purpose by `0053`).
