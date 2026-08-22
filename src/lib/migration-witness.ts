// TASK-086 — "did this migration run?" answered by the DATABASE, not by the ledger.
//
// The 2026-08-02 dry-run proved the ledger is not faithful to the schema: 9 journal entries unrecorded, 6 of
// them demonstrably live. So the ledger stops being the input to reconciliation and becomes its output.
//
// ## The two rules that make a witness safe — they matter more than the map
// 1. **Witness the LAST object the migration creates, never the first.** A half-applied migration then reads
//    as "not applied", re-runs, and its `IF NOT EXISTS` guards absorb what already landed. Witnessing the
//    first object would declare a half-applied migration finished and leave a permanent hole.
// 2. **A false "applied" must be impossible.** The object must exist *only* because that migration ran. If a
//    hand-run fix or another migration could have created it, it is a bad witness — say so and pick another,
//    or mark it `needs-human`.
//
// ## ⚠️ How half-application can actually happen here — narrower than it looks
// `drizzle-orm/pg-core/dialect.cjs` wraps **the whole migrate run in ONE `session.transaction(...)`**, so a
// failure rolls everything back: `db:migrate` cannot leave a half-applied migration behind.
// The real exposure is **out-of-band** application — and we have a confirmed instance: the deleted
// `scripts/db-check-migrate.ts` executed statements one at a time with `sql.unsafe(stmt)` and **no
// transaction**, for `0004` and `0005`. Those two are exactly where a partial state is possible, which is why
// rule 1 is applied strictly rather than waved through on "it's transactional anyway".

/** How the verdict was reached, so the operator sees the reasoning and not just a boolean. */
export type WitnessKind =
  | { kind: "column"; table: string; column: string; schema?: string }
  | { kind: "column-absent"; table: string; column: string; schema?: string }
  | { kind: "table"; table: string; schema?: string }
  | { kind: "index"; index: string; schema?: string }
  | { kind: "index-predicate"; index: string; contains: string; schema?: string }
  | { kind: "constraint"; constraint: string }
  | { kind: "superseded-by"; tag: string }
  | { kind: "needs-human" };

export interface Witness {
  tag: string;
  probe: WitnessKind;
  /** Why this object proves *this* migration ran. A witness nobody can justify is a guess with a query on it. */
  why: string;
  /**
   * Can `db:migrate` safely attempt it if the verdict is "not applied"?
   * `false` ⇒ **halt and ask a human** — a wrong verdict there isn't recoverable by re-running.
   */
  rerunnable: boolean;
}

/**
 * scheduling-back. Each entry names the **last** object its migration creates.
 *
 * ⚠️ Two entries are deliberately not simple existence probes; both are explained on the entry.
 */
export const SCHEDULING_WITNESSES: Witness[] = [
  {
    tag: "0000_supreme_zarek",
    probe: { kind: "index", index: "students_name_idx" },
    why: "Last statement of the baseline. Only 0000 creates this index; nothing later drops or recreates it.",
    rerunnable: false, // bare CREATE TABLE, no IF NOT EXISTS — a re-run raises 42P07
  },
  {
    tag: "0001_add_reschedule_fields",
    probe: { kind: "column", table: "bookings", column: "reschedule_to" },
    why: "Last of the three columns 0001 adds; no other migration adds it.",
    rerunnable: false, // bare ADD COLUMN → 42701 on re-run
  },
  {
    tag: "0002_reschedule_slot_index",
    // ⚠️ NOT an existence probe. 0002 and 0007 both DROP and recreate `bookings_teacher_slot_uq`, differing
    // ONLY in the predicate. After 0007, 0002's version no longer exists anywhere — its effect is gone.
    probe: { kind: "superseded-by", tag: "0007_leave_overbook_slot_index" },
    why:
      "0002's only effect is an index that 0007 replaces, so it cannot be observed independently once 0007 " +
      "has run. Verdict is inherited from 0007. ⚠️ Re-running 0002 would REGRESS 0007 (it would drop " +
      "SICK_LEAVE back out of the predicate and re-break overbooking-on-leave), so it must never be attempted.",
    rerunnable: false,
  },
  {
    tag: "0003_app_settings",
    probe: { kind: "table", table: "app_settings" },
    why: "0003 creates exactly this one table and nothing else creates it.",
    rerunnable: false, // bare CREATE TABLE
  },
  {
    tag: "0004_teacher_work_days",
    probe: { kind: "column", table: "teachers", column: "work_days" },
    why:
      "The migration's only object. ⚠️ This is one of the two the deleted db-check-migrate.ts could apply " +
      "out-of-band without a transaction, so a partial state is conceivable — but 0004 has a single " +
      "statement, so 'partial' and 'absent' are the same thing here.",
    rerunnable: true, // ADD COLUMN IF NOT EXISTS
  },
  {
    tag: "0005_line_crm_checkin",
    probe: { kind: "table", table: "line_link_sessions" },
    why:
      "The LAST object 0005 creates (after the bookings/students columns and the checkin-token index). " +
      "⚠️ Chosen precisely because db-check-migrate.ts could have applied this one statement-by-statement: " +
      "if it stopped early, this table is missing → verdict 'not applied' → re-run, and every statement in " +
      "0005 is IF NOT EXISTS so the parts that landed are absorbed.",
    rerunnable: true,
  },
  {
    tag: "0006_parents",
    // The last STATEMENTS of 0006 are two DROP COLUMNs, so completion is proved by an absence.
    probe: { kind: "column-absent", table: "students", column: "phone" },
    why:
      "0006's final statement is `ALTER TABLE students DROP COLUMN IF EXISTS phone`. `students.phone` is " +
      "created by the 0000 baseline and dropped by nothing else, so its ABSENCE is an exact witness that " +
      "0006 ran to completion — and it is the last effect, satisfying the last-object rule.",
    // 🔴 The one migration that genuinely cannot survive a re-run: its backfill at line 15 reads
    // `students.phone`, which the same file drops at the end → second run raises 42703.
    rerunnable: false,
  },
  {
    tag: "0007_leave_overbook_slot_index",
    probe: {
      kind: "index-predicate",
      index: "bookings_teacher_slot_uq",
      contains: "SICK_LEAVE",
    },
    why:
      "0002 and 0007 create the SAME index name; only 0007's predicate excludes SICK_LEAVE. Probing the " +
      "index DEFINITION rather than its existence is what distinguishes them — existence alone would be " +
      "satisfied by 0000/0002 and would falsely report 0007 as applied.",
    rerunnable: false, // DROP INDEX (unguarded) then bare CREATE UNIQUE INDEX
  },
  {
    tag: "0008_badges",
    probe: { kind: "index", index: "booking_badges_value_idx" },
    why:
      "Last statement of 0008, created after badge_types/badge_values/booking_badges and their other " +
      "indexes — so it proves the whole badge structure landed. No other migration references booking_badges.",
    rerunnable: true, // its CREATEs are IF NOT EXISTS
  },
  {
    tag: "0009_noshow_jobruns",
    probe: { kind: "index", index: "job_runs_job_date_idx" },
    why: "Last statement of 0009, created after `job_runs` itself — so it proves the table landed too.",
    rerunnable: true,
  },
  {
    tag: "0010_teacher_archived",
    probe: { kind: "column", table: "teachers", column: "archived" },
    why:
      "0010 adds exactly this one column and nothing else creates teachers.archived — so presence is an " +
      "exact witness, and with a single statement there is no partial state to miss.",
    rerunnable: true,
  },
  {
    tag: "0011_freelance_budgets",
    probe: { kind: "constraint", constraint: "freelance_budgets_teacher_id_teachers_id_fk" },
    why:
      "The LAST object 0011 creates, after the table. Sober confirmed the ADD CONSTRAINT is wrapped in a " +
      "DO $$ … EXCEPTION WHEN duplicate_object $$ block, so it is re-runnable.",
    rerunnable: true,
  },
  {
    tag: "0012_line_lang",
    probe: { kind: "column", table: "teachers", column: "line_lang" },
    why: "0012 adds parents.line_lang FIRST and teachers.line_lang LAST — this is the later of the two.",
    rerunnable: true,
  },
  {
    tag: "0013_teacher_calendar_token",
    probe: { kind: "index", index: "teachers_calendar_token_uq" },
    why: "Last statement, created after `teachers.calendar_token`, so it proves the column landed too.",
    rerunnable: true,
  },
  {
    tag: "0014_people_demographics_suspend",
    probe: { kind: "column", table: "parents", column: "suspended_at" },
    why:
      "The LAST of the five columns 0014 adds (gender, birth_date, nationality, province, suspended_at). " +
      "Probing `students.gender` — the first — would report a partially-applied 0014 as finished.",
    rerunnable: true,
  },
  {
    tag: "0015_teacher_link_requests",
    probe: { kind: "index", index: "teacher_link_requests_status_idx" },
    why: "Last statement of 0015, after the table and the partial unique index.",
    rerunnable: true,
  },
  {
    tag: "0016_subjects_price_group",
    probe: { kind: "column", table: "subjects", column: "price_group" },
    why:
      "0016's last STATEMENTS are data UPDATEs, which have no schema footprint to probe. The column is the " +
      "last schema object. Safe because the whole run is one transaction, so the UPDATEs cannot have been " +
      "skipped while the column landed — and 0016 has never been applied out-of-band. ⚠️ Whether the UPDATEs " +
      "matched anything is a separate question (a renamed subject leaves price_group NULL) — that is the " +
      "TASK-077 deploy smoke, not this witness.",
    rerunnable: true,
  },
  {
    tag: "0017_entitlement_source",
    probe: { kind: "constraint", constraint: "vouchers_source_chk" },
    why: "The LAST object 0017 creates — after both `source` columns and the course_packages constraint.",
    rerunnable: true,
  },
  {
    tag: "0018_course_subject",
    probe: { kind: "constraint", constraint: "course_packages_subject_id_subjects_id_fk" },
    why:
      "0018's later statements are a data back-fill and a CONDITIONAL `SET NOT NULL` — neither is a reliable " +
      "schema footprint (the NOT NULL is deliberately skipped when a course has no bookings to derive from). " +
      "The FK is the last unconditional object, and the whole migration runs in one transaction, so the FK " +
      "existing means the back-fill ran too. Whether NOT NULL landed is a deploy observation, not this witness.",
    rerunnable: true,
  },
  {
    tag: "0019_planned_at_creation",
    probe: { kind: "column", table: "bookings", column: "planned_at_creation" },
    why:
      "0019 is a single `ADD COLUMN IF NOT EXISTS` — the column IS the migration, so there is no earlier object " +
      "that could report it finished early, and nothing else creates `bookings.planned_at_creation` " +
      "(TASK-148 / REQ-045: the flag that makes an absence declared at creation free of leave quota).",
    rerunnable: true,
  },
  {
    tag: "0020_booking_discount",
    probe: { kind: "constraint", constraint: "bookings_discount_kind_chk" },
    why:
      "The LAST object 0020 creates — after all four discount columns. Witnessing the CHECK rather than any one " +
      "column is what makes a half-applied run detectable: the constraint only exists once every column it " +
      "depends on has landed (TASK-162 / REQ-063).",
    rerunnable: true,
  },
  {
    tag: "0021_course_prior_sessions",
    probe: { kind: "column", table: "course_packages", column: "prior_sessions" },
    why:
      "0021 is one `ADD COLUMN IF NOT EXISTS` followed by a back-fill UPDATE, both in one transaction — so the " +
      "column existing means the back-fill ran too, and nothing else creates `course_packages.prior_sessions`. " +
      "The UPDATE is guarded on `prior_sessions = 0`, so a re-run cannot compound it (TASK-165 / REQ-064).",
    rerunnable: true,
  },
];

export type Verdict = "applied" | "not-applied" | "needs-human";

export interface WitnessResult {
  tag: string;
  /** What the probe looked for, rendered for the operator. */
  probe: string;
  /** What the database answered. `null` when the probe could not be evaluated. */
  found: boolean | null;
  verdict: Verdict;
  rerunnable: boolean;
  why: string;
}

/** Human-readable form of a probe, so the dry-run output explains itself. */
export function describeProbe(p: WitnessKind): string {
  switch (p.kind) {
    case "column":
      return `column ${p.table}.${p.column} exists`;
    case "column-absent":
      return `column ${p.table}.${p.column} is ABSENT (dropped)`;
    case "table":
      return `table ${p.schema ?? "public"}.${p.table} exists`;
    case "index":
      return `index ${p.index} exists`;
    case "index-predicate":
      return `index ${p.index} definition contains "${p.contains}"`;
    case "constraint":
      return `constraint ${p.constraint} exists`;
    case "superseded-by":
      return `inherited from ${p.tag} (own effect no longer observable)`;
    case "needs-human":
      return "no honest witness — a human must confirm";
  }
}

/**
 * Turn probe answers into verdicts. **Pure** — the SQL lives in the scripts, so this (the part that can be
 * wrong in an interesting way) is testable without a database.
 *
 * `probeResults` maps tag → what the database said. A tag missing from the map, or mapped to `null`, means
 * the probe could not be evaluated ⇒ `needs-human`, never an optimistic guess.
 */
export function judge(
  witnesses: Witness[],
  probeResults: Map<string, boolean | null>,
): WitnessResult[] {
  const out = new Map<string, WitnessResult>();

  const verdictOf = (w: Witness): Verdict => {
    if (w.probe.kind === "needs-human") return "needs-human";
    if (w.probe.kind === "superseded-by") {
      // Inherit, and only from a verdict we actually have. Never assume.
      const parent = out.get(w.probe.tag);
      if (!parent || parent.verdict !== "applied") return "needs-human";
      return "applied";
    }
    const found = probeResults.get(w.tag);
    if (found === undefined || found === null) return "needs-human";
    return found ? "applied" : "not-applied";
  };

  // Two passes so a `superseded-by` entry can inherit regardless of declaration order.
  for (const pass of [0, 1]) {
    for (const w of witnesses) {
      if (pass === 0 && w.probe.kind === "superseded-by") continue;
      const verdict = verdictOf(w);
      out.set(w.tag, {
        tag: w.tag,
        probe: describeProbe(w.probe),
        found: w.probe.kind === "superseded-by" ? null : (probeResults.get(w.tag) ?? null),
        verdict,
        rerunnable: w.rerunnable,
        why: w.why,
      });
    }
  }
  return witnesses.map((w) => out.get(w.tag)!);
}

/**
 * 🔴 The halt condition. Anything that would have `db:migrate` attempt a migration that cannot survive it,
 * or that we cannot judge, must stop the operator rather than proceed.
 */
export function blockers(results: WitnessResult[]): WitnessResult[] {
  return results.filter(
    (r) => r.verdict === "needs-human" || (r.verdict === "not-applied" && !r.rerunnable),
  );
}

/** Rows to seed: one per journal entry the database says is already applied. */
export const appliedTags = (results: WitnessResult[]): string[] =>
  results.filter((r) => r.verdict === "applied").map((r) => r.tag);
