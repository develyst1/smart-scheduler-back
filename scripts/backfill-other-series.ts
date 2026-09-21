// TASK-428 (REQ-101 §4 ruling 3) — the ONE-OFF backfill: existing ECA/Free/KOL rows (`booking_type OTHER`, a HUMAN kind,
// `other_series_key IS NULL`) grouped by (title · kind · start_time · teacher_id) ⇒ one key per group. CAMP rows are
// excluded by the kind (they belong to `camp_week_days`); a row that already has a key is untouched; re-runnable.
//
//   bun scripts/backfill-other-series.ts            # --dry-run (the default): prints the groups, writes NOTHING
//   bun scripts/backfill-other-series.ts --apply    # stamps one uuid per group, in ONE transaction
//
// The human runs it once after `db:migrate` (verify 50). `teacher_id` is in the key on purpose: two coaches' same-named
// 15:00 clubs must not merge into one series (a later swap-from-date would move the wrong coach's rows).
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../src/db";
import { bookings } from "../src/db/schema";
import { HUMAN_OTHER_KINDS } from "../src/lib/other-kind";
import { hhmm } from "../src/lib/time";

export type BackfillRow = { id: string; date: string; startTime: string; teacherId: string; otherTitle: string | null; otherKind: string | null; nickname?: string | null };
export type BackfillGroup = { key: string; title: string | null; kind: string | null; startTime: string; teacherId: string; nickname: string | null; rows: BackfillRow[] };

/** Pure: the grouping rule — (title · kind · start_time · teacher_id); one fresh uuid per group; date order inside. */
export function groupForBackfill(rows: BackfillRow[], mint: () => string = () => crypto.randomUUID()): BackfillGroup[] {
  const map = new Map<string, BackfillGroup>();
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const k = [r.otherTitle ?? "", r.otherKind ?? "", hhmm(r.startTime), r.teacherId].join("\u0000");
    const g = map.get(k) ?? { key: mint(), title: r.otherTitle, kind: r.otherKind, startTime: hhmm(r.startTime), teacherId: r.teacherId, nickname: r.nickname ?? null, rows: [] };
    g.rows.push(r);
    map.set(k, g);
  }
  return [...map.values()];
}

export const describeGroup = (g: BackfillGroup): string =>
  `${g.title ?? "(no title)"} · ${g.kind} · ${g.startTime} · ${g.nickname ?? g.teacherId} · ${g.rows.length} rows (${g.rows[0]!.date} … ${g.rows[g.rows.length - 1]!.date})`;

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await db.query.bookings.findMany({
    where: (b, { and: a, eq: e, inArray: inA, isNull: n }) => a(e(b.bookingType, "OTHER"), inA(b.otherKind, [...HUMAN_OTHER_KINDS]), n(b.otherSeriesKey)),
    with: { teacher: true },
  });
  const groups = groupForBackfill(rows.map((r: any) => ({ id: r.id, date: r.date, startTime: r.startTime, teacherId: r.teacherId, otherTitle: r.otherTitle, otherKind: r.otherKind, nickname: r.teacher?.nickname ?? null })));
  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${rows.length} un-keyed ECA/Free/KOL rows ⇒ ${groups.length} series`);
  for (const g of groups) console.log(`  ${g.key}  ${describeGroup(g)}`);
  if (!apply) { console.log("DRY RUN — nothing written. Re-run with --apply."); return; }
  await db.transaction(async (tx) => {
    for (const g of groups) {
      await tx.update(bookings).set({ otherSeriesKey: g.key }).where(and(inArray(bookings.id, g.rows.map((r) => r.id)), isNull(bookings.otherSeriesKey), eq(bookings.bookingType, "OTHER")));
    }
  });
  console.log(`stamped ${groups.length} keys on ${rows.length} rows.`);
}

if (import.meta.main) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
