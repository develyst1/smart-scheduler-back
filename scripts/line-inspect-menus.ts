// TASK-045 — READ-ONLY diagnostic for the "menu renders but taps do nothing" defect. Creates/links/deletes
// NOTHING. Prints what LINE actually has, so the three hypotheses can be told apart:
//   (A) published menu has no/broken `areas`  → tap areas are dead zones, no event is ever sent
//   (B) the user has a DIFFERENT menu linked  → stale per-user link, or one made in the OA Manager
//   (C) events aren't delivered at all        → compare with the [line-in] webhook logs after a tap
//
// Usage:
//   bun run line:inspect-menus                 # stored menus + default + full channel list
//   bun run line:inspect-menus <lineUserId>    # ...plus which menu THAT user has linked  ← test of (B)
import {
  getDefaultRichMenuId,
  getMenuIds,
  getRichMenu,
  getUserRichMenuId,
  listRichMenus,
} from "../src/lib/line-rich-menu";

/** Renders one menu's identity + its tap areas — the direct test of hypothesis (A). Pure (no IO). */
export function formatMenu(label: string, id: string, menu: any | null): string {
  if (!menu) return `  ${label} [${id}] → NOT FOUND on LINE (deleted or wrong id)`;
  const areas: any[] = Array.isArray(menu.areas) ? menu.areas : [];
  const head =
    `  ${label} [${id}]\n` +
    `    name="${menu.name ?? "?"}" size=${menu.size?.width ?? "?"}x${menu.size?.height ?? "?"} ` +
    `chatBarText="${menu.chatBarText ?? "?"}" selected=${menu.selected}\n` +
    `    areas: ${areas.length}${areas.length === 0 ? "   ⚠️  NO AREAS → every tap is a dead zone (hypothesis A)" : ""}`;
  const rows = areas.map((a, i) => {
    const b = a?.bounds ?? {};
    const act = a?.action ?? {};
    const payload = act.data ?? act.uri ?? act.text ?? "(none)";
    return `      #${i} (${b.x},${b.y} ${b.width}x${b.height}) action.type=${act.type ?? "?"} data=${payload}`;
  });
  return [head, ...rows].join("\n");
}

async function main() {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("✗ line:inspect-menus — LINE_CHANNEL_ACCESS_TOKEN is not set (needed to read the Messaging API).");
    process.exit(1);
  }
  const userId = process.argv[2]?.trim();

  console.log("── Stored menu ids (app_settings.line_rich_menu_ids) ──");
  const ids = await getMenuIds();
  const entries = Object.entries(ids).filter(([, v]) => !!v) as Array<[string, string]>;
  if (!entries.length) {
    console.log("  (none stored — has `bun run line:publish-menus` been run against this DB?)");
  }
  for (const [label, id] of entries) {
    console.log(formatMenu(label, id, await getRichMenu(id)));
  }

  console.log("\n── Channel default menu (GET /user/all/richmenu) ──");
  const def = await getDefaultRichMenuId();
  const defLabel = entries.find(([, id]) => id === def)?.[0];
  console.log(
    def
      ? `  default = ${def}${defLabel ? `  (= our ${defLabel})` : "  ⚠️  NOT one of our stored ids"}`
      : "  (no default menu set — users with no per-user link see NO menu)",
  );

  console.log("\n── All menus on the channel (GET /richmenu/list) ──");
  const all = await listRichMenus();
  if (!all.length) console.log("  (none)");
  for (const m of all) {
    const known = entries.some(([, id]) => id === m.richMenuId) ? "" : "  ⚠️  created outside our publish (OA Manager?)";
    console.log(`  ${m.richMenuId} name="${m.name}" areas=${Array.isArray(m.areas) ? m.areas.length : "?"}${known}`);
  }

  if (userId) {
    console.log("\n── This user's linked menu (GET /user/{userId}/richmenu) ──  ← hypothesis (B)");
    const linked = await getUserRichMenuId(userId);
    if (!linked) {
      console.log("  (no per-user link → this user sees the channel default above)");
    } else {
      const label = entries.find(([, id]) => id === linked)?.[0];
      console.log(`  linked = ${linked}${label ? `  (= our ${label})` : "  ⚠️  NOT one of our stored ids (stale link?)"}`);
      console.log(formatMenu("linked", linked, await getRichMenu(linked)));
    }
  } else {
    console.log("\n(tip: pass a LINE userId to also show which menu that user has linked)");
  }
  process.exit(0);
}

if (import.meta.main) await main();
