// TASK-488 — the backfill REPORT's pure half: given the counts per stored value of the OLD columns (`bookings.checkin_source`,
// `camp_days.marked_by`), say where migration 0057 puts each one, and flag every value that is not a known channel (it will be
// read as a PERSON — a username — and filed under the `staff` channel). The operator runs `scripts/checkin-provenance-report.ts`
// (read-only) BEFORE `db:migrate` to see what will move, and AFTER to see the new columns; the engineers never query a database.
import { CHECKIN_CHANNELS, classifyLegacySource } from "./checkin-channel";

export interface ValueCount { value: string | null; count: number }

/** One table: value · count · → where it goes. Values that are NOT a channel are marked, so a forgotten channel stands out. */
export function formatProvenanceReport(title: string, rows: ValueCount[]): string[] {
  const sorted = [...rows].sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  const lines = [`${title} — ${sorted.reduce((n, r) => n + r.count, 0)} row(s), ${sorted.length} distinct value(s):`];
  for (const r of sorted) {
    const c = classifyLegacySource(r.value);
    const where = r.value === null ? "→ (both NULL)" : c.actor === null ? `→ channel ${c.channel}` : `→ channel staff + ACTOR "${c.actor}"  ⚠️ not a channel — check it is a person`;
    lines.push(`  ${String(r.value ?? "NULL").padEnd(24)} ${String(r.count).padStart(7)}  ${where}`);
  }
  lines.push(`  (known channels: ${CHECKIN_CHANNELS.join(", ")})`);
  return lines;
}
