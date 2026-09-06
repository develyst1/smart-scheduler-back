// REQ-015 / TASK-040 — re-runnable setup command: publish the LINE rich menus.
// TASK-247 (REQ-079): SIX menus now — parent/teacher × TH/EN, plus ยังไม่รู้จัก and รู้จักแล้ว (TH).
// Usage (operator, at deploy — needs LINE_CHANNEL_ACCESS_TOKEN + the images from TASK-041/247):
//   bun run line:publish-menus
// Re-run to republish after artwork changes. Fails clearly BEFORE any LINE API call if the token or any image
// is missing (never half-publishes). Do NOT run against the real OA from a dev box.
import {
  listRichMenus,
  publishRichMenus,
  summariseOurMenus,
  type MenuIds,
} from "../src/lib/line-rich-menu";

/** Fixed image-path contract with TASK-041 (Fern). Paths are relative to the repo (bun run cwd). */
export const IMAGE_PATHS = {
  parentThImage: "assets/line/parent-th.png",
  parentEnImage: "assets/line/parent-en.png",
  teacherThImage: "assets/line/teacher-th.png",
  teacherEnImage: "assets/line/teacher-en.png",
  // TASK-247 (REQ-079) — the two menus the bot has been reading for since TASK-234. Same fixed-filename
  // contract, and the same preflight: a missing image refuses the whole run BEFORE any LINE call, so "one
  // menu created, the other not" is not a state this command can leave the channel in.
  unknownThImage: "assets/line/unknown-th.png",
  knownThImage: "assets/line/known-th.png",
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
      "\nProvide the 4 images (TASK-041) under smart-scheduler-back/assets/line/ and set LINE_CHANNEL_ACCESS_TOKEN, then re-run.",
    );
    process.exit(1);
  }

  const ids = await publishRichMenus(IMAGE_PATHS);
  console.log("✓ Published rich menus (ids stored in app_settings.line_rich_menu_ids):");
  console.log(`  parent-TH : ${ids.parentTH}`);
  console.log(`  parent-EN : ${ids.parentEN}`);
  console.log(`  teacher-TH: ${ids.teacherTH}`);
  console.log(`  teacher-EN: ${ids.teacherEN}`);
  console.log(`  unknown-TH: ${ids.unknownTH}   ← account DEFAULT (REQ-079)`);
  console.log(`  known-TH  : ${ids.knownTH}     ← linked per user when a chat is bound`);

  // §4 — the footprint, read back from LINE rather than assumed from what we just created.
  for (const line of formatPublishFootprint(await listRichMenus(), ids)) console.log(`  ${line}`);

  console.log("Re-run `bun run line:publish-menus` to republish after the artwork changes.");
  process.exit(0);
}

if (import.meta.main) await main();
