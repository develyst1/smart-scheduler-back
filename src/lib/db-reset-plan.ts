// SPEC-052 / TASK-151 (REQ-040 design) — the PURE part of the clean-slate reset: what is kept, what is
// cleared, in what order, and the assertions that decide whether a run may COMMIT.
//
// This is a mass delete on a real customer database, so the rules live here, unit-tested, rather than inline in
// a script where nobody can check them. The script does IO; this file decides.
//
// 🔴 The order is not cosmetic — every FK in `schema.ts` is RESTRICT, so a child must be deleted before its
// parent. Re-verified against `src/db/schema.ts` on 2026-08-19 (see the task notes for the edge list).

/** Never touched. Config + the roster the school keeps across a data reset. */
export const KEEP_TABLES = [
  "teachers",
  "subjects",
  "teacher_subjects",
  "badge_types",
  "badge_values",
  "app_settings",
] as const;

/** Deleted, in exactly this order (child → parent, matching the RESTRICT FKs). */
export const CLEAR_TABLES = [
  "booking_badges",
  "notification_outbox",
  "bookings",
  "course_packages",
  "vouchers",
  "students",
  "parents",
  "freelance_budgets",
  "teacher_link_requests",
  "line_link_sessions",
  "job_runs",
] as const;

export type Counts = Record<string, number>;

export interface ResetAssertion {
  ok: boolean;
  problems: string[];
}

/** A KEEP table whose count moved means the delete reached config or the roster — abort, do not COMMIT. */
export function assertKeepUnchanged(before: Counts, after: Counts): ResetAssertion {
  const problems: string[] = [];
  for (const t of KEEP_TABLES) {
    const b = before[t] ?? 0;
    const a = after[t] ?? 0;
    if (b !== a) problems.push(`${t}: ${b} → ${a} (ต้องไม่เปลี่ยน)`);
  }
  return { ok: problems.length === 0, problems };
}

/** After a real run every CLEAR table must be exactly empty — a partial wipe is not a clean slate. */
export function assertClearEmpty(after: Counts): ResetAssertion {
  const problems: string[] = [];
  for (const t of CLEAR_TABLES) {
    const a = after[t] ?? 0;
    if (a !== 0) problems.push(`${t}: ${a} (ต้องเหลือ 0)`);
  }
  return { ok: problems.length === 0, problems };
}

/** Both gates, as one verdict — this is what the script checks immediately before COMMIT. */
export function canCommit(before: Counts, after: Counts): ResetAssertion {
  const keep = assertKeepUnchanged(before, after);
  const clear = assertClearEmpty(after);
  return { ok: keep.ok && clear.ok, problems: [...keep.problems, ...clear.problems] };
}

/** Counts only — never a row, never a name. The operator reads this table and pastes it back safely. */
export function formatCountTable(before: Counts, after?: Counts): string {
  const line = (t: string, kind: "KEEP" | "CLEAR") => {
    const b = before[t] ?? 0;
    const a = after ? ` → ${after[t] ?? 0}` : "";
    return `  ${kind.padEnd(5)} ${t.padEnd(24)} ${String(b).padStart(6)}${a}`;
  };
  return [
    ...KEEP_TABLES.map((t) => line(t, "KEEP")),
    "  " + "─".repeat(40),
    ...CLEAR_TABLES.map((t) => line(t, "CLEAR")),
  ].join("\n");
}

/** How many rows the run would remove — the single number the owner sanity-checks before committing. */
export const totalToClear = (before: Counts): number =>
  CLEAR_TABLES.reduce((sum, t) => sum + (before[t] ?? 0), 0);
