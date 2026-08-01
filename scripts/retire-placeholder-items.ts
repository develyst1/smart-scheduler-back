// TASK-077 — retire the placeholder INCOME items TASK-066 created, now that the real card prices exist.
//
// ⚠️ **DRY RUN BY DEFAULT. It changes nothing unless you pass `--apply`.**
//
// Why it isn't automatic: the placeholder rows carry `metadata.pricePlaceholder = true`, but between
// TASK-066's deploy and this one, someone may have corrected a price by hand — and correcting a price does
// not clear that flag. So a script that "just deactivates everything flagged" could retire a row a human had
// already fixed. The safe move is to show what's there, with what it's worth and how much has been posted
// against it, and let a person decide.
//
// It **deactivates** (`active = false`); it never DELETEs. `bo.movement` rows reference these items, and
// deleting one would take real posted revenue with it (ON DELETE CASCADE).
//
//   bun run sale:retire-placeholders           # report only
//   bun run sale:retire-placeholders --apply   # deactivate the rows listed

import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { boItem, boMovement } from "../src/db/schema";
import { SALE_ITEMS, SALE_SOURCE, isKnownSaleItem } from "../src/lib/sale-items";

const apply = process.argv.includes("--apply");

const rows = await db
  .select()
  .from(boItem)
  .where(and(eq(boItem.externalSource, SALE_SOURCE), eq(boItem.active, true)));

const placeholders = rows.filter((r) => (r.metadata as any)?.pricePlaceholder === true);

if (placeholders.length === 0) {
  console.log("No placeholder items found — nothing to retire.");
  process.exit(0);
}

// Three different problems, three different answers. Lumping them together is how a correct item gets
// deactivated or a wrong price gets silently overwritten.
const obsolete: typeof placeholders = []; // code no longer sold → safe to deactivate
const wrongPrice: Array<{ row: (typeof placeholders)[number]; card: number }> = []; // needs a HUMAN
const fine: typeof placeholders = []; // still sold, price already matches the card

for (const r of placeholders) {
  const card = SALE_ITEMS.find((i) => i.externalRef === r.externalRef);
  if (!r.externalRef || !isKnownSaleItem(r.externalRef)) obsolete.push(r);
  else if (card && card.unitPriceMinor !== r.unitPriceMinor) wrongPrice.push({ row: r, card: card.unitPriceMinor });
  else fine.push(r);
}

const movementsOf = async (itemId: string) =>
  (
    await db
      .select({ value: sql<number>`count(*)::int` })
      .from(boMovement)
      .where(eq(boMovement.itemId, itemId))
  )[0]!.value;

const baht = (minor: number) => (minor / 100).toLocaleString("en-US");

if (obsolete.length) {
  console.log(`🗑️  ${obsolete.length} OBSOLETE — the code is no longer sold. Safe to deactivate:\n`);
  for (const r of obsolete) {
    console.log(
      `  ${(r.externalRef ?? "(no ref)").padEnd(28)} ${baht(r.unitPriceMinor).padStart(9)} THB` +
        `  · ${await movementsOf(r.id)} movement(s)`,
    );
  }
}

if (wrongPrice.length) {
  console.log(
    `\n🔴 ${wrongPrice.length} STILL SOLD but at the WRONG PRICE. **This script will not touch them** —\n` +
      `   correcting a live price is a human decision (someone may have already fixed one by hand).\n` +
      `   Fix each via the backoffice item screen (PATCH /bo/items/:id):\n`,
  );
  for (const { row, card } of wrongPrice) {
    console.log(
      `  ${(row.externalRef ?? "").padEnd(28)} now ${baht(row.unitPriceMinor).padStart(9)} THB` +
        `  →  card ${baht(card).padStart(9)} THB  · ${await movementsOf(row.id)} movement(s)`,
    );
  }
}

if (fine.length) {
  console.log(
    `\n✅ ${fine.length} already match the card (${fine
      .map((r) => r.externalRef)
      .join(", ")}) — nothing to do; only their stale placeholder flag remains.`,
  );
}

if (obsolete.length === 0) {
  console.log("\nNothing to deactivate.");
  process.exit(0);
}

if (!apply) {
  console.log(
    "\nDRY RUN — nothing changed. Re-run with --apply to deactivate ONLY the obsolete rows above.\n" +
      "Deactivating keeps their movements and the history they represent; it only stops NEW sales\n" +
      "posting against a code that is no longer offered. Nothing is ever deleted (movements reference it).",
  );
  process.exit(0);
}

for (const r of obsolete) {
  await db.update(boItem).set({ active: false }).where(eq(boItem.id, r.id));
}
console.log(`\nDeactivated ${obsolete.length} obsolete item(s). No rows deleted; no movements touched.`);
if (wrongPrice.length) {
  console.log(`⚠️  ${wrongPrice.length} wrong-priced item(s) still need a human — see above.`);
}
process.exit(0);
