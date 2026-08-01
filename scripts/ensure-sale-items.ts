// TASK-066 — create the INCOME items that sales post to. Re-runnable: `bun run sale:ensure-items`.
//
// Until now `first-trial` / `single-session` existed only in backoffice-back's `ops` seed (a schema
// retired by REQ-006), and `course-{size}` / `voucher-{hours}` items were created NOWHERE — so even
// before the sale route came unmounted, those two codes had nothing to post to. This creates all
// eight in `bo.item`, keyed by `external_ref`.
//
// ⚠️ It only ever INSERTS what's missing. It never updates an existing item, because the prices it
// carries are placeholders (see lib/sale-items.ts) and overwriting a real price that คุณกุ้ง has
// since set would be worse than the gap it fixes.
//
// Run AFTER backoffice-back's `bun run db:migrate` (0005 adds bo.item.external_ref).

import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { boItem } from "../src/db/schema";
import { SALE_ITEMS, SALE_SOURCE } from "../src/lib/sale-items";

const existing = await db
  .select({ externalRef: boItem.externalRef })
  .from(boItem)
  .where(eq(boItem.externalSource, SALE_SOURCE));
const have = new Set(existing.map((r) => r.externalRef).filter((r): r is string => r !== null));

let created = 0;
for (const item of SALE_ITEMS) {
  if (have.has(item.externalRef)) {
    console.log(`  = ${item.externalRef.padEnd(28)} exists — left alone (price NOT overwritten)`);
    continue;
  }
  await db.insert(boItem).values({
    name: item.name,
    unit: "each",
    direction: "INCOME",
    cadence: "VARIABLE",
    unitPriceMinor: item.unitPriceMinor,
    externalSource: SALE_SOURCE,
    externalRef: item.externalRef,
    metadata: {
      category: "REVENUE",
      // TASK-077: real card prices, VAT-INCLUSIVE. No `pricePlaceholder` flag any more — that flag is now
      // the marker for TASK-066's wrong rows, which `sale:retire-placeholders` reports on.
      vatInclusive: true,
      priceSource: "owner price card 2026-08-01 (SPEC-024)",
    },
  });
  created++;
  console.log(`  + ${item.externalRef.padEnd(28)} ${item.unitPriceMinor / 100} THB (VAT incl.)`);
}

console.log(
  `\nDone. ${created} created, ${SALE_ITEMS.length - created} already present.` +
    (created > 0
      ? "\n⚠️  Prices are the owner's VAT-INCLUSIVE card prices (SPEC-024). Never add tax on top." +
        "\n   Run `bun run sale:retire-placeholders` to review TASK-066's now-wrong placeholder rows."
      : ""),
);
process.exit(0);
