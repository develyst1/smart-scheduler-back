// REQ-042 / TASK-130 — ADOPT the rich-menu ids that already exist on the OA into
// `app_settings.line_rich_menu_ids`. The menus were published before, but the ids were never stored in the DB
// the runtime reads, so `linkRoleRichMenu` finds no target and silently no-ops → the menu never switches on
// role change / language toggle (the REQ-042 defect).
//
// Zero OA write: this reads `GET /richmenu/list` and performs ONE DB upsert. It deliberately does NOT create,
// upload, link, delete, or set-default any menu — republishing would add duplicate menus and reset the channel
// default, which is customer-visible on this OA (SPEC-038 STEP 3a vs 3b).
//
// Usage (operator, on the server whose env points at the target DB + OA):
//   bun run line:adopt-menus
// Re-runnable: storing the same ids again is a harmless no-op change.
import {
  PARENT_RICH_MENU,
  PARENT_RICH_MENU_EN,
  TEACHER_RICH_MENU,
  TEACHER_RICH_MENU_EN,
  listRichMenus,
  storeMenuIds,
  type MenuIds,
} from "../src/lib/line-rich-menu";

/** Canonical menu name → the `MenuIds` key, taken from the defs `publishRichMenus` creates. */
export const NAME_TO_KEY: Record<string, keyof MenuIds> = {
  [PARENT_RICH_MENU.name]: "parentTH",
  [PARENT_RICH_MENU_EN.name]: "parentEN",
  [TEACHER_RICH_MENU.name]: "teacherTH",
  [TEACHER_RICH_MENU_EN.name]: "teacherEN",
};

/** Pure name→id selection (no IO). `missing` lists the canonical names the OA has none of, so a gap is
 *  reported instead of a half-stored map. When a name repeats (this OA carries 2 of each), the LAST
 *  occurrence in `/richmenu/list` order wins — any menu of that name works, so what matters is that
 *  re-runs pick the same one. */
export function selectMenuIds(menus: Array<{ richMenuId?: string; name?: string }>): {
  ids: MenuIds;
  missing: string[];
} {
  const ids: MenuIds = {};
  for (const m of menus) {
    const key = m.name ? NAME_TO_KEY[m.name] : undefined;
    if (key && m.richMenuId) ids[key] = m.richMenuId; // later occurrence overwrites → last one wins
  }
  const missing = Object.keys(NAME_TO_KEY).filter((name) => !ids[NAME_TO_KEY[name]!]);
  return { ids, missing };
}

async function main() {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("✗ line:adopt-menus — LINE_CHANNEL_ACCESS_TOKEN is not set (needed to read the Messaging API).");
    process.exit(1);
  }

  const all = await listRichMenus();
  const { ids, missing } = selectMenuIds(all);
  if (missing.length) {
    console.error(`✗ line:adopt-menus — the OA has ${all.length} menu(s), but these are missing:`);
    for (const name of missing) console.error(`  - ${name}`);
    console.error("\nNothing was stored (a half map would leave the switch broken for those roles).");
    process.exit(1);
  }

  await storeMenuIds(ids);
  console.log("✓ Adopted the OA's existing rich menus (stored in app_settings.line_rich_menu_ids):");
  console.log(`  parent-TH : ${ids.parentTH}`);
  console.log(`  parent-EN : ${ids.parentEN}`);
  console.log(`  teacher-TH: ${ids.teacherTH}`);
  console.log(`  teacher-EN: ${ids.teacherEN}`);
  console.log("No menu was created, linked, deleted, or made default. Verify with `bun run line:inspect-menus`.");
  process.exit(0);
}

if (import.meta.main) await main();
