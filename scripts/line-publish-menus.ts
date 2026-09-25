// REQ-015 / TASK-040 — re-runnable setup command: publish the LINE rich menus.
// TASK-247 (REQ-079): SIX menus now — parent/teacher × TH/EN, plus ยังไม่รู้จัก and รู้จักแล้ว (TH).
// Usage (operator, at deploy — needs LINE_CHANNEL_ACCESS_TOKEN + the images from TASK-041/247):
//   bun run line:publish-menus
// Re-run to republish after artwork changes. Fails clearly BEFORE any LINE API call if the token or any image
// is missing (never half-publishes). Do NOT run against the real OA from a dev box.
import {
  getMenuIds,
  listRichMenus,
  publishRichMenus,
  summariseOurMenus,
  type MenuIds,
} from "../src/lib/line-rich-menu";
import { guardOaWriteOrExit } from "../src/lib/oa-guard";

/** Fixed image-path contract with TASK-041 (Fern). Paths are relative to the repo (bun run cwd). */
export const IMAGE_PATHS = {
  // 🔴 TASK-468 (REQ-107) — THREE bilingual images, one per role (TH + EN on one picture). Same fixed-filename contract and
  // the same preflight: a missing image refuses the whole run BEFORE any LINE call. The teacher image is the EXISTING
  // teacher artwork (unchanged cells), re-published so its id is live again.
  unknownImage: "assets/line/menu-unknown.png",
  customerImage: "assets/line/menu-customer.png",
  teacherImage: "assets/line/menu-teacher.png",
} as const;

/** Pure precondition check — returns a list of blocking errors (empty = ready to publish). */
export function preflightErrors(hasToken: boolean, missingImages: string[]): string[] {
  const errors: string[] = [];
  if (!hasToken) errors.push("LINE_CHANNEL_ACCESS_TOKEN is not set (needed to call the Messaging API).");
  for (const p of missingImages) errors.push(`missing rich-menu image: ${p}`);
  return errors;
}

/**
 * 🔴 TASK-252 §4 — **`publish` must SAY it.** *"Nobody looked because nothing told them."*
 *
 * `publishRichMenus` creates its set and deletes nothing, so every run leaves its predecessor on the
 * channel — six per run, accumulating for weeks. @Porter's inspect found **20 menus on the demo OA, every
 * one ours**, and no command had ever mentioned it.
 *
 * 🚫 It reports; it does not clean up. Deleting menus on a live account as a side effect of publishing is
 * exactly the unreviewed destruction the owner refused (*"สั่งทีมทำเครื่องมือ แบบนี้เสี่ยงไป"*). Removal
 * stays a deliberate, reviewed act behind `line:remove-menus`.
 *
 * Pure: the IO shell hands it the channel list, so the sentence can be asserted without a network.
 */
export function formatPublishFootprint(
  channel: Array<{ richMenuId?: string; name?: string | null }>,
  created: MenuIds,
): string[] {
  const f = summariseOurMenus(channel, created);
  const out = [
    `Channel now holds ${f.onChannel} rich menu(s); ${f.ours} carry our names, and ${f.current} are the set just published.`,
  ];
  if (f.leftover) {
    out.push(
      `⚠️  ${f.leftover} of our menus are LEFT OVER from earlier publishes — this command never deletes.`,
      "    `bun run line:remove-menus` lists them for review; `bun run line:inspect-menus` shows them all.",
    );
  }
  if (f.onChannel - f.ours > 0) {
    out.push(`${f.onChannel - f.ours} menu(s) on the channel are not ours and are none of this command's business.`);
  }
  return out;
}
/**
 * 🔴 TASK-473 K0b — the report of what was STORED, read back from `app_settings` after the merge.
 *
 * ⚠️ TASK-468 changed the publish to three per-role menus and left this report printing six LEGACY keys, which are never
 * set by a publish any more ⇒ it printed `undefined` six times. That output is what an operator reads to know what happened
 * on a REAL account. So: the three per-role ids first (each marked NEW if this run created it, ⚠️ NOT STORED if the read-back
 * lacks it), then every legacy id still kept — by what was stored, never by what we assume was stored.
 * Pure: the IO shell hands it the read-back and the created ids.
 */
export const ROLE_KEYS = ["unknown", "customer", "teacher"] as const;
export function formatStoredIds(stored: MenuIds, created: MenuIds): string[] {
  const out = ["✓ Published rich menus — ids STORED in app_settings.line_rich_menu_ids (read back after the merge):"];
  for (const k of ROLE_KEYS) {
    const v = stored[k];
    const tag = !v ? "⚠️ NOT STORED" : v === created[k] ? "NEW" : "kept from an earlier publish";
    out.push(`  ${k.padEnd(9)}: ${v ?? "-"}   ← ${tag}${k === "unknown" ? " · account DEFAULT" : ""}`);
  }
  const legacy = Object.entries(stored).filter(([k, v]) => !(ROLE_KEYS as readonly string[]).includes(k) && !!v);
  if (legacy.length) {
    out.push("  legacy ids still stored (the relink sweep reads them to recognise old followers; removed only with the old menus):");
    for (const [k, v] of legacy.sort(([a], [b]) => a.localeCompare(b))) out.push(`    ${k.padEnd(10)}: ${v}`);
  }
  return out;
}

async function main() {
  const missing: string[] = [];
  for (const p of Object.values(IMAGE_PATHS)) {
    if (!(await Bun.file(p).exists())) missing.push(p);
  }
  const errors = preflightErrors(!!process.env.LINE_CHANNEL_ACCESS_TOKEN, missing);
  if (errors.length) {
    console.error("✗ line:publish-menus — cannot publish:");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "\nProvide the 3 bilingual images (TASK-468) under smart-scheduler-back/assets/line/ and set LINE_CHANNEL_ACCESS_TOKEN, then re-run.",
    );
    process.exit(1);
  }

  // 🔴 TASK-448 — publishing CREATES menus and moves the account default: the first call writes, so the guard runs first.
  await guardOaWriteOrExit();

  const ids = await publishRichMenus(IMAGE_PATHS);
  for (const line of formatStoredIds(await getMenuIds(), ids)) console.log(line);

  // §4 — the footprint, read back from LINE rather than assumed from what we just created.
  for (const line of formatPublishFootprint(await listRichMenus(), ids)) console.log(`  ${line}`);

  console.log("Re-run `bun run line:publish-menus` to republish after the artwork changes.");
  process.exit(0);
}

if (import.meta.main) await main();
