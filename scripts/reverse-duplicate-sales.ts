// TASK-750 (REQ-130) — `sale:reverse-duplicates`: reverse the DUPLICATE day-end sales (the re-runs that posted the same booking's revenue again as `rev:<id>#n`). A ONE-OFF, OWNER-RUN correction.
//
// Mirrors `sale:reconcile-prices`:
//   · DRY RUN BY DEFAULT — the plan is listed, then the whole transaction is ROLLED BACK. `--commit` writes.
//   · APPEND-ONLY — it only INSERTS reversal movements (`rev-undo:<id>[#n]`), exactly what an attendance Undo writes for a generation. It never edits or deletes a movement, and touches no booking, attendance, quota,
//     outbox or LINE message.
//   · IDEMPOTENT — a booking whose duplicate is already reversed has no extra live sale any more, so a second `--commit` plans (and writes) 0.
//   · The console shows booking ids and amounts only. No names are read.
// The decision — which generations to reverse and why the HIGHEST stays live — is `lib/duplicate-sale-reversal.ts`.
import { like, or, sql } from "drizzle-orm";
import { db } from "../src/db";
import { boMovement, bookings } from "../src/db/schema";
import { formatDuplicatePlan, formatTarget, planAll, type BookingPlan, type RunTarget } from "../src/lib/duplicate-sale-reversal";

const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

/** The database and server this transaction is connected to (`current_database()`, `inet_server_addr()`). Read from the server itself, so it is what is REALLY connected — never the env value, which could be a user, a password or a URL. */
export async function readTarget(tx: any): Promise<RunTarget> {
  const res: any = await tx.execute(sql`select current_database() as db, coalesce(inet_server_addr()::text, 'local-socket') as host`);
  const row = (Array.isArray(res) ? res : res.rows)[0];
  return { database: String(row.db), host: String(row.host) };
}

export interface ReverseResult { plans: BookingPlan[]; written: number; rolledBack: boolean }

/** The whole run against an executor (`db` in the script; a fake ledger in the tests). Everything happens in ONE transaction; a dry run throws at the end so it is rolled back. */
export async function reverseDuplicates(exec: any, commit: boolean, log: (line: string) => void = console.log): Promise<ReverseResult> {
  let result: ReverseResult = { plans: [], written: 0, rolledBack: false };
  try {
    await exec.transaction(async (tx: any) => {
      log(formatTarget(await readTarget(tx))); // FIRST: which database is this pointed at (a wrong box must be seen before anything else)
      const found = await tx
        .select({
          key: boMovement.idempotencyKey,
          itemId: boMovement.itemId,
          qty: boMovement.qty,
          valueMinor: boMovement.valueMinor,
          bookingId: boMovement.refId,
          date: bookings.date,
          bookingType: bookings.bookingType,
        })
        .from(boMovement)
        .innerJoin(bookings, sql`${boMovement.refId} = ${bookings.id}::text`)
        .where(or(like(boMovement.idempotencyKey, "rev:%"), like(boMovement.idempotencyKey, "rev-undo:%"), like(boMovement.idempotencyKey, "discount:%")));
      const plans = planAll(
        found.filter((r: any) => r.key && r.bookingId).map((r: any) => ({ idempotencyKey: r.key as string, itemId: r.itemId, qty: r.qty, valueMinor: r.valueMinor, bookingId: r.bookingId as string, date: r.date, bookingType: r.bookingType })),
      );
      log(formatDuplicatePlan(plans));
      result = { plans, written: 0, rolledBack: false };
      if (!commit) throw new Error(DRY_RUN_ROLLBACK);
      for (const p of plans) {
        for (const r of p.reversals) {
          // `ON CONFLICT DO NOTHING`: a reversal that already exists is skipped, never an error — and it cannot poison the transaction the way a caught unique violation would.
          const wrote = await tx
            .insert(boMovement)
            .values({ itemId: r.itemId, qty: r.qty, valueMinor: r.valueMinor, reason: r.reason, refType: r.refType, refId: r.bookingId, idempotencyKey: r.idempotencyKey })
            .onConflictDoNothing()
            .returning({ id: boMovement.id });
          result.written += wrote.length;
        }
      }
    });
  } catch (e: any) {
    if (e?.message === DRY_RUN_ROLLBACK) return { ...result, written: 0, rolledBack: true };
    throw e;
  }
  return result;
}

async function main() {
  const commit = process.argv.includes("--commit");
  console.log(`── sale:reverse-duplicates · ${commit ? "COMMIT (เขียนจริง)" : "DRY RUN (ไม่เขียนอะไร)"}`);
  try {
    const r = await reverseDuplicates(db, commit);
    if (!commit) {
      console.log("\n  DRY RUN — ยังไม่เขียนอะไร. ตรวจรายการข้างบนแล้วรันซ้ำด้วย --commit");
      process.exit(0);
    }
    console.log(`✓ กลับรายการแล้ว ${r.written} รายการ — เพิ่มแถวกลับรายการเท่านั้น; ไม่แก้/ไม่ลบรายการเดิม, ไม่แตะการจอง/การเข้าเรียน/LINE`);
    console.log("  รันซ้ำได้ (ครั้งที่สองจะพบ 0 รายการ)");
  } catch (e: any) {
    console.error(`✗ sale:reverse-duplicates ไม่สำเร็จ — ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) await main();
