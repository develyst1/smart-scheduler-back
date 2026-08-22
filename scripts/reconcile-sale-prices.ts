// SPEC-058 / TASK-158 Part B (REQ-061) — `sale:reconcile-prices`: bring stored `bo.item` prices back in line
// with the catalogue. OWNER-RUN, on both boxes.
//
// Why this exists rather than a manual edit in the item screen: `sale:ensure-items` is insert-only (correct —
// it must never overwrite a price a human set), so a CARD correction never reaches the stored item and every
// later sale posts the old number. That drift has bitten twice. A hand edit in the UI fixes one row once,
// unauditably; this fixes every mismatch, shows both numbers first, and can be re-run safely.
//
//   · DRY RUN BY DEFAULT — every change listed with `from → to`, then rolled back. `--commit` writes.
//   · Updates ONLY `bo.item.unit_price_minor`, only where it differs. Never creates (that is
//     `sale:ensure-items`), never deletes, never touches a posted `bo.movement` — history stays as sold.
//   · Console = product codes + prices. No customer data is read.
import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { boItem } from "../src/db/schema";
import { SALE_SOURCE } from "../src/lib/sale-items";
import { formatReconcilePlan, planPriceReconcile } from "../src/lib/price-reconcile-plan";

const commit = process.argv.includes("--commit");
const DRY_RUN_ROLLBACK = "__dry_run_rollback__";

async function main() {
  console.log(`── sale:reconcile-prices · ${commit ? "COMMIT (เขียนจริง)" : "DRY RUN (ไม่เขียนอะไร)"}`);
  try {
    await db.transaction(async (tx: any) => {
      const stored = await tx
        .select({ externalRef: boItem.externalRef, name: boItem.name, unitPriceMinor: boItem.unitPriceMinor })
        .from(boItem)
        .where(eq(boItem.externalSource, SALE_SOURCE));
      const plan = planPriceReconcile(
        stored.filter((s: any) => s.externalRef).map((s: any) => ({ ...s, externalRef: s.externalRef as string })),
      );
      console.log(formatReconcilePlan(plan));

      if (!commit) throw new Error(DRY_RUN_ROLLBACK);
      for (const c of plan.changes) {
        await tx
          .update(boItem)
          .set({ unitPriceMinor: c.to })
          .where(and(eq(boItem.externalSource, SALE_SOURCE), eq(boItem.externalRef, c.externalRef)));
      }
    });
  } catch (e: any) {
    if (e?.message === DRY_RUN_ROLLBACK) {
      console.log("\n  DRY RUN — ยังไม่แก้ราคา. ตรวจรายการข้างบนแล้วรันซ้ำด้วย --commit");
      process.exit(0);
    }
    console.error(`✗ sale:reconcile-prices ไม่สำเร็จ — ไม่มีการเปลี่ยนแปลง (rollback): ${e?.message ?? e}`);
    process.exit(1);
  }
  console.log("✓ ปรับราคาเรียบร้อย — แตะเฉพาะราคาของ item ที่ไม่ตรง; การขายที่ลงบัญชีไปแล้วไม่ถูกแก้");
  console.log("  รันซ้ำได้ (ครั้งที่สองจะพบ 0 รายการ). อย่าลืมรันทั้ง sid และ uat");
  process.exit(0);
}

if (import.meta.main) await main();
