// TASK-488 — READ-ONLY report of what migration 0057's backfill does (and did). It only SELECTs.
//
// Usage (operator, on the box whose env points at the target DB):
//   bun run db:provenance-report      # BEFORE db:migrate — what will move where; AFTER — what the new columns hold
//
// 🔑 Why it exists: the split's backfill sorts every stored provenance into a CHANNEL or a PERSON, and this is the one chance to
// SEE what the old columns actually contain — a value we never meant to be there shows up here, marked, instead of later as a
// chip that renders nothing. 🚫 The team never runs this against a real database; the owner does.
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { formatProvenanceReport, type ValueCount } from "../src/lib/checkin-provenance-report";

const counts = async (q: ReturnType<typeof sql>): Promise<ValueCount[]> =>
  ((await db.execute(q)) as any[]).map((r: any) => ({ value: r.value ?? null, count: Number(r.count) }));

async function main() {
  const out: string[] = [];
  out.push(...formatProvenanceReport("bookings.checkin_source (the OLD column)", await counts(sql`select checkin_source as value, count(*)::int as count from bookings group by 1`)));
  out.push(...formatProvenanceReport("camp_days.marked_by (the OLD column)", await counts(sql`select marked_by as value, count(*)::int as count from camp_days group by 1`)));
  // After the migration: the new pair, as stored. Before it, these columns do not exist — say so rather than fail.
  // TASK-488 — each table's OWN names: bookings `checkin_*`, camp_days `mark_*` (it records every mark, not only check-ins).
  const PAIRS = [
    { t: "bookings", channel: "checkin_channel", actor: "checkin_actor" },
    { t: "camp_days", channel: "mark_channel", actor: "mark_actor" },
  ] as const;
  for (const { t, channel, actor } of PAIRS) {
    try {
      const rows = (await db.execute(sql.raw(`select ${channel} as channel, ${actor} as actor, count(*)::int as count from ${t} group by 1, 2 order by 3 desc`))) as any[];
      out.push(`${t} — the NEW pair (channel · actor · count):`, ...rows.map((r) => `  ${String(r.channel ?? "NULL").padEnd(14)} ${String(r.actor ?? "—").padEnd(24)} ${String(r.count).padStart(7)}`));
    } catch {
      out.push(`${t} — the NEW columns do not exist yet (run again after db:migrate).`);
    }
  }
  console.log(out.join("\n"));
  process.exit(0);
}

if (import.meta.main) await main();
