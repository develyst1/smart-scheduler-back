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
    console.log(`  = ${item.externalRef.padEnd(16)} exists — left alone (price not overwritten)`);
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
      pricePlaceholder: true,
      priceNote:
        "PLACEHOLDER — hours x the existing 1,390 THB/hr placeholder. Not a real price list; " +
        "courses very likely carry a bulk discount. TASK-066; real figures pending from Porter.",
    },
  });
  created++;
  console.log(`  + ${item.externalRef.padEnd(16)} created at ${item.unitPriceMinor / 100} THB (PLACEHOLDER)`);
}

console.log(
  `\nDone. ${created} created, ${SALE_ITEMS.length - created} already present.` +
    (created > 0 ? "\n⚠️  Prices above are PLACEHOLDERS — see lib/sale-items.ts." : ""),
);
process.exit(0);
