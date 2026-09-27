// TASK-530 (owner ruling (a), 2026-09-27) — the ADMIN's one-cell rich menu: `menu-admin.png`, 2500×843.
//
// 🔑 ONE cell ⇒ the whole picture is the tap target (`ADMIN_MENU` in `src/lib/line-rich-menu.ts` has ONE area = the full
// image). Nothing here draws a divider or a second "button", so the picture never suggests a hit-box the menu does not have.
// Style: the orange bilingual house style of the teacher menu (TASK-484) — off-white ground, an orange line icon in a pale
// orange disc with three rays each side, dark bold text.
// Words (TASK-530 §1, ruled by Sober as his recommendation; going to the owner): `SOM SCHEDULE` (the app's own name, the
// owner's spelling — TASK-357) · `เปิดระบบ · Open the system`. If the owner changes them, change WORDS below and re-run.
//
// ⚠️ TASK-484's lesson: this is the ONLY script that writes `menu-admin.png`. `generate-rich-menus.mjs` and
// `resize-customer-menus.mjs` never name it — pinned by `src/lib/rich-menu-admin-task530.test.ts`, which reads every script in
// this folder. Running any other generator therefore cannot overwrite it.
//
// RUN (needs `sharp`, which lives in the frontoffice web repo):
//   cd ../smart-scheduler-front && bun ../smart-scheduler-back/assets/line/generate-admin-menu.mjs

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { statSync } from "node:fs";

const sharp = createRequire(join(process.cwd(), "noop.js"))("sharp");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "menu-admin.png");

const W = 2500;
const H = 843;
const WORDS = { title: "SOM SCHEDULE", th: "เปิดระบบ", en: "Open the system" };

const BG = "#fbfaf9";
const ORANGE = "#fb5a14"; // the teacher art's orange
const DISC = "#fdeee6";
const TEXT = "#2b2f33";
const FONT = "'Leelawadee UI', Tahoma, 'Segoe UI', sans-serif";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Icon: a browser window with a small calendar inside — "the system", not a button.
const cx = 700, cy = 421;
const sw = (w) => `stroke="${ORANGE}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
const rays = [-1, 1]
  .map((side) => {
    const x0 = cx + side * 250;
    return `
    <line x1="${x0}" y1="${cy - 70}" x2="${x0 + side * 36}" y2="${cy - 100}" ${sw(22)} />
    <line x1="${x0 + side * 6}" y1="${cy}" x2="${x0 + side * 48}" y2="${cy}" ${sw(22)} />
    <line x1="${x0}" y1="${cy + 70}" x2="${x0 + side * 36}" y2="${cy + 100}" ${sw(22)} />`;
  })
  .join("");
const icon = `
  <circle cx="${cx}" cy="${cy}" r="215" fill="${DISC}" />
  ${rays}
  <rect x="${cx - 130}" y="${cy - 105}" width="260" height="200" rx="26" ${sw(20)} />
  <line x1="${cx - 130}" y1="${cy - 55}" x2="${cx + 130}" y2="${cy - 55}" ${sw(18)} />
  <circle cx="${cx - 95}" cy="${cy - 80}" r="8" fill="${ORANGE}" />
  <circle cx="${cx - 65}" cy="${cy - 80}" r="8" fill="${ORANGE}" />
  <line x1="${cx - 70}" y1="${cy - 5}" x2="${cx + 70}" y2="${cy - 5}" ${sw(18)} />
  <line x1="${cx - 70}" y1="${cy + 45}" x2="${cx + 20}" y2="${cy + 45}" ${sw(18)} />`;

const tx = 1040;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}" />
  ${icon}
  <text x="${tx}" y="400" font-family="${FONT}" font-size="150" font-weight="700" fill="${TEXT}">${esc(WORDS.title)}</text>
  <text x="${tx}" y="545" font-family="${FONT}" font-size="96" font-weight="700" fill="${ORANGE}">${esc(WORDS.th)}<tspan dx="34" fill="${TEXT}" font-weight="400">·&#160;${esc(WORDS.en)}</tspan></text>
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(OUT);
const bytes = statSync(OUT).size;
console.log(`wrote ${OUT} — ${W}×${H}, ${bytes} bytes${bytes > 1_000_000 ? "  ⚠️ OVER the 1,000,000-byte cap" : ""}`);
