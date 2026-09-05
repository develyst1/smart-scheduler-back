// TASK-250 — take THIS repo's rich menus off a LINE account, reviewably.
//
// 🔴 **This runs against a CUSTOMER'S LIVE OA.** The owner asked for it after being offered the raw API calls
// and refusing them — *"สั่งทีมทำเครื่องมือ แบบนี้เสี่ยงไป"*. **He is not asking for a delete; he is asking for a
// delete he can review before it fires.** So the dry run is the deliverable, not a courtesy, and `--apply`
// prints the same review again and asks for a typed confirmation before touching anything.
//
// Usage (operator, on the box whose env points at the target DB + OA):
//   bun run line:remove-menus            # DRY RUN — the full plan, nothing changed
//   bun run line:remove-menus --apply    # prints the plan again, then asks you to type the confirmation
//
// Order is not arbitrary (§5): cancel the default FIRST, delete the menus, clear the stored ids LAST. Every
// intermediate state is then one the product already understands — *no menu* — and a run that dies midway
// leaves the ids still naming what is left, so re-running finishes the job.
//
// 🚫 The team never runs this. Not `--apply`, not dry.
import {
  clearDefaultRichMenu,
  clearMenuIds,
  deleteRichMenu,
  getBotAccountLabel,
  getDefaultRichMenuId,
  getMenuIds,
  listRichMenus,
} from "../src/lib/line-rich-menu";
import { formatRemovalPlan, idsToKeep, planMenuRemoval } from "../src/lib/line-menu-removal-plan";

/** What the operator must type at `--apply`. It names the count, so it cannot be typed without reading. */
export const confirmationPhrase = (count: number) => `REMOVE ${count}`;

async function main() {
  const apply = process.argv.includes("--apply");

  // Preflight, same as publish: refuse BEFORE any call rather than half-way through one.
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("✗ line:remove-menus — LINE_CHANNEL_ACCESS_TOKEN is not set (needed to call the Messaging API).");
    process.exit(1);
  }

  const [account, stored, channel, defaultId] = await Promise.all([
    getBotAccountLabel(),
    getMenuIds(),
    listRichMenus(),
    getDefaultRichMenuId(),
  ]);
  const plan = planMenuRemoval(stored, channel, defaultId);
  console.log(formatRemovalPlan(plan, { apply, account }));

  if (!apply) process.exit(0);

  if (!plan.toDelete.length && !plan.cancelDefault) {
    console.log("\nNothing of ours is on this account — nothing to do.");
    process.exit(0);
  }

  // 🔴 The confirmation the owner's objection is really about. Non-interactive stdin returns null ⇒ refuse:
  // a review nobody read is not a review, and this must never be runnable from a script or a cron.
  const expected = confirmationPhrase(plan.toDelete.length);
  const typed = prompt(`\nType "${expected}" to proceed (anything else cancels):`);
  if (typed?.trim() !== expected) {
    console.log("Cancelled — nothing was changed.");
    process.exit(1);
  }

  // §5 — the default first, so the channel never points at an id that is being deleted.
  if (plan.cancelDefault) {
    await clearDefaultRichMenu();
    console.log("✓ channel default cancelled");
  }

  const deleted = new Set<string>();
  const failed: Array<{ id: string; error: string }> = [];
  for (const m of plan.toDelete) {
    try {
      const outcome = await deleteRichMenu(m.id);
      deleted.add(m.id);
      console.log(`✓ ${m.label.padEnd(10)} ${m.id} — ${outcome}`);
    } catch (e) {
      // One failure must not abandon the rest: the end state is the goal, and the ids of whatever survived are
      // kept below so a re-run can finish.
      failed.push({ id: m.id, error: (e as Error).message });
      console.error(`✗ ${m.label.padEnd(10)} ${m.id} — ${(e as Error).message}`);
    }
  }

  // …and the stored ids LAST, keeping only what is still out there.
  await clearMenuIds(idsToKeep(stored, deleted));

  console.log(`\n${deleted.size} menu(s) removed, ${failed.length} failed, ${plan.foreign.length} left alone.`);
  if (failed.length) {
    console.error("Re-run to finish — the ids of the survivors are still stored, which is what makes that work.");
    process.exit(1);
  }
  console.log("Stored ids cleared. `bun run line:inspect-menus` will show the account as it now stands.");
  process.exit(0);
}

if (import.meta.main) await main();
