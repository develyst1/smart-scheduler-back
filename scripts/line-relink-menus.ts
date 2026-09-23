// TASK-446 (REQ-105 §6) — `bun run line:relink-menus [--dry-run] [--apply]`: re-link every follower whose per-user rich-menu id
// drifted from what the current rules give them. The PLAN is the deliverable (the `line:remove-menus` shape): the account is
// named first, every user is one line, and `--apply` needs a phrase that carries the count, so it cannot be typed unread.
// 🚫 Never deletes a menu, never unlinks, never touches a user the plan calls `ok`. A per-user failure is reported and the
// sweep continues — one unreachable account must not strand the rest.
import { getBotAccountLabel, getMenuIds, getUserRichMenuId, linkRichMenuToUser } from "../src/lib/line-rich-menu";
import { listMenuUsers } from "../src/lib/line-menu-users";
import { formatRelinkPlan, planRelink } from "../src/lib/line-relink-plan";
import { guardOaWriteOrExit } from "../src/lib/oa-guard";

/** What the operator must type at `--apply`. It names the count, so it cannot be typed without reading. */
export const confirmationPhrase = (count: number) => `RELINK ${count}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const apply = process.argv.includes("--apply");

  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("✗ line:relink-menus — LINE_CHANNEL_ACCESS_TOKEN is not set (needed to call the Messaging API).");
    process.exit(1);
  }

  const [account, ids, users] = await Promise.all([getBotAccountLabel(), getMenuIds(), listMenuUsers()]);
  // One read per user — the live per-user link. Sequential: a sweep is not a load test.
  for (const u of users) {
    u.linkedMenuId = await getUserRichMenuId(u.lineUserId);
    await sleep(120);
  }
  const plan = planRelink(users, ids);
  console.log(formatRelinkPlan(plan, { apply, account }));

  if (!apply) {
    console.log("\nDry run — nothing was written. Re-run with --apply to link the RELINK rows.");
    process.exit(0);
  }
  if (!plan.toRelink.length) {
    console.log("\nEvery follower already holds the menu the current rules give them — nothing to do.");
    process.exit(0);
  }

  // 🔴 TASK-448 — before the FIRST write: the token's account must be the one the operator NAMED (`--account`) and on
  // this machine's allow-list. The dry run above needs none of that — it writes nothing.
  await guardOaWriteOrExit();

  const expected = confirmationPhrase(plan.toRelink.length);
  const typed = prompt(`\nType "${expected}" to proceed (anything else cancels):`);
  if (typed?.trim() !== expected) {
    console.log("Cancelled — nothing was changed.");
    process.exit(1);
  }

  let linked = 0;
  const failed: Array<{ name: string; error: string }> = [];
  for (const r of plan.toRelink) {
    try {
      await linkRichMenuToUser(r.user.lineUserId, r.expectedId!);
      linked++;
      console.log(`✓ ${r.user.name} — ${r.expectedLabel}`);
    } catch (e) {
      failed.push({ name: r.user.name, error: (e as Error).message });
      console.error(`✗ ${r.user.name} — ${(e as Error).message}`);
    }
    await sleep(120);
  }

  console.log(`\n${linked} re-linked, ${failed.length} failed, ${plan.counts.ok} already correct, ${plan.counts["no-menu-published"]} blocked.`);
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.main) await main();
