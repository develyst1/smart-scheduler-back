// LINE rich-menu artwork generator (REQ-015 / TASK-041).
// Produces the 4 rich-menu PNGs whose visual cells line up EXACTLY with the tap areas fixed in
// `src/lib/line-rich-menu.ts`. Regenerate after any tweak — the publish command reads the PNGs from
// this folder. Labels mirror `src/lib/line-i18n.ts` (btn_* keys) so the menu and the bot replies agree.
//
// RUN (needs `sharp`, which lives in the frontoffice web repo):
//   cd ../../..              # anywhere with sharp on the resolution path…
//   cd smart-scheduler-front # …e.g. the frontoffice web (has sharp installed)
//   bun ../smart-scheduler-back/assets/line/generate-rich-menus.mjs
// Outputs parent-{th,en}.png (2500×1686) + teacher-{th,en}.png (2500×843) next to this script.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// Resolve `sharp` from the CURRENT WORKING DIR (run this from a repo that has it — e.g. the
// frontoffice web), not from this file's folder (the backend repo has no sharp). ESM bare-import
// would look next to this file and fail; anchoring createRequire at cwd fixes that.
const sharp = createRequire(join(process.cwd(), "noop.js"))("sharp");

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// ── Palette (frontoffice Mantine, restrained) ──
const BG = "#ffffff";
const BLUE = "#228be6"; // Mantine blue.6 — the app primary (the four REQ-015 menus)
// TASK-247 — the owner's entire art direction was *"อยากได้สีส้ม แค่นั้นแหละ"*. Mantine orange.7, and it applies
// to the two REQ-079 menus ONLY: repainting the shipped four means re-creating them, which changes their ids,
// and every already-linked teacher keeps the OLD menu until they re-link. A repaint is a migration.
const ORANGE = "#f76707";
const TEXT = "#212529"; // Mantine dark.9
const DIVIDER = "#e9ecef"; // subtle cell separators
const FONT = "Tahoma, 'Leelawadee UI', 'Segoe UI', sans-serif";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Icons: simple, high-contrast line/silhouette glyphs centred at (cx,cy), ~±100 box ──
// TASK-247: the accent is a parameter so one menu can be orange while the shipped ones stay blue. Every glyph
// already drew with the single constant, so this is one argument rather than an edit per icon. The white ground
// and the dark label stay in both — the README's legibility rule, and orange-on-white is the readable way round.
const iconSet = (ACCENT) => {
const sw = (w) => `stroke="${ACCENT}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;

return {
  // check-in: checkmark in a ring
  checkin: (cx, cy) => `
    <circle cx="${cx}" cy="${cy}" r="94" ${sw(16)} />
    <path d="M ${cx - 46} ${cy + 2} L ${cx - 14} ${cy + 38} L ${cx + 52} ${cy - 40}" ${sw(20)} />`,
  // leave: calendar with an ✕
  leave: (cx, cy) => `
    <rect x="${cx - 92}" y="${cy - 66}" width="184" height="164" rx="20" ${sw(15)} />
    <line x1="${cx - 92}" y1="${cy - 24}" x2="${cx + 92}" y2="${cy - 24}" ${sw(15)} />
    <line x1="${cx - 54}" y1="${cy - 92}" x2="${cx - 54}" y2="${cy - 54}" ${sw(15)} />
    <line x1="${cx + 54}" y1="${cy - 92}" x2="${cx + 54}" y2="${cy - 54}" ${sw(15)} />
    <line x1="${cx - 26}" y1="${cy + 12} " x2="${cx + 30}" y2="${cy + 66}" ${sw(16)} />
    <line x1="${cx + 30}" y1="${cy + 12}" x2="${cx - 26}" y2="${cy + 66}" ${sw(16)} />`,
  // children: two filled people (adult + child)
  children: (cx, cy) => `
    <circle cx="${cx - 40}" cy="${cy - 30}" r="30" fill="${ACCENT}" />
    <path d="M ${cx - 82} ${cy + 70} a 42 48 0 0 1 84 0 Z" fill="${ACCENT}" />
    <circle cx="${cx + 48}" cy="${cy - 8}" r="22" fill="${ACCENT}" />
    <path d="M ${cx + 18} ${cy + 72} a 30 34 0 0 1 60 0 Z" fill="${ACCENT}" />`,
  // register/add child: one person + a plus badge
  register: (cx, cy) => `
    <circle cx="${cx - 8}" cy="${cy - 34}" r="32" fill="${ACCENT}" />
    <path d="M ${cx - 54} ${cy + 66} a 46 52 0 0 1 92 0 Z" fill="${ACCENT}" />
    <circle cx="${cx + 58}" cy="${cy + 44}" r="34" fill="${ACCENT}" />
    <line x1="${cx + 58}" y1="${cy + 26}" x2="${cx + 58}" y2="${cy + 62}" stroke="#ffffff" stroke-width="12" stroke-linecap="round" />
    <line x1="${cx + 40}" y1="${cy + 44}" x2="${cx + 76}" y2="${cy + 44}" stroke="#ffffff" stroke-width="12" stroke-linecap="round" />`,
  // language: globe
  lang: (cx, cy) => `
    <circle cx="${cx}" cy="${cy}" r="92" ${sw(15)} />
    <ellipse cx="${cx}" cy="${cy}" rx="40" ry="92" ${sw(12)} />
    <line x1="${cx - 92}" y1="${cy}" x2="${cx + 92}" y2="${cy}" ${sw(12)} />
    <line x1="${cx - 78}" y1="${cy - 46}" x2="${cx + 78}" y2="${cy - 46}" ${sw(10)} />
    <line x1="${cx - 78}" y1="${cy + 46}" x2="${cx + 78}" y2="${cy + 46}" ${sw(10)} />`,
  // help: ? in a ring
  help: (cx, cy) => `
    <circle cx="${cx}" cy="${cy}" r="92" ${sw(16)} />
    <text x="${cx}" y="${cy + 50}" font-family="${FONT}" font-size="150" font-weight="700" fill="${ACCENT}" text-anchor="middle">?</text>`,
  // schedule: calendar with agenda lines
  schedule: (cx, cy) => `
    <rect x="${cx - 92}" y="${cy - 66}" width="184" height="164" rx="20" ${sw(15)} />
    <line x1="${cx - 92}" y1="${cy - 24}" x2="${cx + 92}" y2="${cy - 24}" ${sw(15)} />
    <line x1="${cx - 54}" y1="${cy - 92}" x2="${cx - 54}" y2="${cy - 54}" ${sw(15)} />
    <line x1="${cx + 54}" y1="${cy - 92}" x2="${cx + 54}" y2="${cy - 54}" ${sw(15)} />
    <line x1="${cx - 52}" y1="${cy + 20}" x2="${cx + 52}" y2="${cy + 20}" ${sw(14)} />
    <line x1="${cx - 52}" y1="${cy + 58}" x2="${cx + 18}" y2="${cy + 58}" ${sw(14)} />`,
  // language + help combined: globe with a ? badge
  langhelp: (cx, cy) => `
    <circle cx="${cx - 14}" cy="${cy - 6}" r="80" ${sw(14)} />
    <ellipse cx="${cx - 14}" cy="${cy - 6}" rx="34" ry="80" ${sw(11)} />
    <line x1="${cx - 94}" y1="${cy - 6}" x2="${cx + 66}" y2="${cy - 6}" ${sw(11)} />
    <circle cx="${cx + 66}" cy="${cy + 58}" r="40" fill="${ACCENT}" />
    <text x="${cx + 66}" y="${cy + 76}" font-family="${FONT}" font-size="66" font-weight="700" fill="#ffffff" text-anchor="middle">?</text>`,
  // TASK-247 — คอร์สของฉัน: an open book / course card with session ticks.
  mycourses: (cx, cy) => `
    <rect x="${cx - 96}" y="${cy - 72}" width="192" height="152" rx="18" ${sw(15)} />
    <line x1="${cx}" y1="${cy - 72}" x2="${cx}" y2="${cy + 80}" ${sw(13)} />
    <line x1="${cx - 66}" y1="${cy - 30}" x2="${cx - 26}" y2="${cy - 30}" ${sw(12)} />
    <line x1="${cx - 66}" y1="${cy + 12}" x2="${cx - 26}" y2="${cy + 12}" ${sw(12)} />
    <line x1="${cx + 26}" y1="${cy - 30}" x2="${cx + 66}" y2="${cy - 30}" ${sw(12)} />
    <line x1="${cx + 26}" y1="${cy + 12}" x2="${cx + 66}" y2="${cy + 12}" ${sw(12)} />`,
  // TASK-247 — คุยกับแอดมิน: a speech bubble with a person in it. The one button that must never read as
  // decoration: it is the promise that a human is reachable.
  admin: (cx, cy) => `
    <path d="M ${cx - 100} ${cy - 76} h 200 a 20 20 0 0 1 20 20 v 108 a 20 20 0 0 1 -20 20 h -104 l -56 46 v -46 h -40 a 20 20 0 0 1 -20 -20 v -108 a 20 20 0 0 1 20 -20 Z" ${sw(15)} />
    <circle cx="${cx}" cy="${cy - 24}" r="26" fill="${ACCENT}" />
    <path d="M ${cx - 42} ${cy + 42} a 42 46 0 0 1 84 0 Z" fill="${ACCENT}" />`,
  // TASK-247 — เข้าใช้ระบบ: a door with an arrow going IN. Deliberately not the `register` person+plus, which
  // reads as "add a child" — a different act, on the one cell that has no precedent to reuse.
  enter: (cx, cy) => `
    <path d="M ${cx + 10} ${cy - 90} h 80 v 180 h -80" ${sw(15)} />
    <line x1="${cx - 96}" y1="${cy}" x2="${cx + 30}" y2="${cy}" ${sw(16)} />
    <path d="M ${cx - 20} ${cy - 46} L ${cx + 30} ${cy} L ${cx - 20} ${cy + 46}" ${sw(16)} />`,
};
};

// One cell = centred icon (upper) + label (lower), with generous padding from the tap edges.
function cellSvg(cell, labelSize, icons) {
  const cx = cell.x + cell.w / 2;
  const iconY = cell.y + cell.h * 0.4;
  const labelY = cell.y + cell.h * 0.74;
  return `
    ${icons[cell.icon](cx, iconY)}
    <text x="${cx}" y="${labelY}" font-family="${FONT}" font-size="${labelSize}" font-weight="600"
          fill="${TEXT}" text-anchor="middle">${esc(cell.label)}</text>`;
}

function menuSvg({ width, height, cells, labelSize, dividers, accent = BLUE }) {
  const icons = iconSet(accent);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${BG}" />
    ${dividers.map((d) => `<line x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}" stroke="${DIVIDER}" stroke-width="3" />`).join("")}
    ${cells.map((c) => cellSvg(c, labelSize, icons)).join("")}
  </svg>`;
}

// ── Layouts (bounds mirror src/lib/line-rich-menu.ts exactly) ──
const CW = 833; // floor(2500/3)
const CH = 843; // 1686/2

const parentCells = (L) => [
  { x: 0, y: 0, w: CW, h: CH, icon: "checkin", label: L.checkin },
  { x: CW, y: 0, w: CW, h: CH, icon: "leave", label: L.leave },
  { x: CW * 2, y: 0, w: 2500 - CW * 2, h: CH, icon: "children", label: L.children },
  { x: 0, y: CH, w: CW, h: CH, icon: "register", label: L.register },
  { x: CW, y: CH, w: CW, h: CH, icon: "lang", label: L.lang },
  { x: CW * 2, y: CH, w: 2500 - CW * 2, h: CH, icon: "help", label: L.help },
];
const parentDividers = [
  { x1: CW, y1: 0, x2: CW, y2: 1686 },
  { x1: CW * 2, y1: 0, x2: CW * 2, y2: 1686 },
  { x1: 0, y1: CH, x2: 2500, y2: CH },
];
const teacherCells = (L) => [
  { x: 0, y: 0, w: 1250, h: 843, icon: "schedule", label: L.schedule },
  { x: 1250, y: 0, w: 1250, h: 843, icon: "langhelp", label: L.langhelp },
];
const teacherDividers = [{ x1: 1250, y1: 0, x2: 1250, y2: 843 }];

// ── TASK-247 / REQ-079 — the two menu SETS. Bounds mirror UNKNOWN_RICH_MENU / KNOWN_RICH_MENU exactly, and
// `line-rich-menu-artwork.test.ts` fails if either side moves a cell — the README's "never one side alone"
// stopped being a sentence and became a test.
const KW = 833; // floor(2500/3), as in the code
const unknownCells = (L) => [
  { x: 0, y: 0, w: 1250, h: 843, icon: "enter", label: L.enter },
  { x: 1250, y: 0, w: 1250, h: 843, icon: "admin", label: L.admin },
];
const unknownDividers = [{ x1: 1250, y1: 0, x2: 1250, y2: 843 }];
const knownCells = (L) => [
  { x: 0, y: 0, w: KW, h: CH, icon: "leave", label: L.leave },
  { x: KW, y: 0, w: KW, h: CH, icon: "checkin", label: L.checkin },
  { x: KW * 2, y: 0, w: 2500 - KW * 2, h: CH, icon: "mycourses", label: L.mycourses },
  { x: 0, y: CH, w: KW, h: CH, icon: "register", label: L.register },
  { x: KW, y: CH, w: KW, h: CH, icon: "langhelp", label: L.lang },
  { x: KW * 2, y: CH, w: 2500 - KW * 2, h: CH, icon: "admin", label: L.admin },
];
const knownDividers = parentDividers; // the same 3×2 grid

// Labels — from line-i18n.ts btn_* keys (children/register use the i18n wording); lang/help/schedule
// have no dedicated i18n key so they use the SPEC-012 table wording.
const PARENT = {
  TH: { checkin: "เช็คอิน", leave: "แจ้งลา", children: "นักเรียนของฉัน", register: "เพิ่มนักเรียน", lang: "ภาษา", help: "ช่วยเหลือ" },
  EN: { checkin: "Check-in", leave: "Leave", children: "My children", register: "Add child", lang: "Language", help: "Help" },
};
const TEACHER = {
  TH: { schedule: "ตารางของฉัน", langhelp: "ภาษา/ช่วยเหลือ" },
  EN: { schedule: "My schedule", langhelp: "Language/Help" },
};
// TASK-247 — REQ-079 §12 wording, TH only this round (an EN menu id with no EN image renders blank on a phone,
// which is worse than falling back). `ภาษา/ช่วยเหลือ` is spelled as `btn_langhelp` in line-i18n.ts spells it —
// the same string already on the teacher menu, which is the reason this six-cell layout works at all.
const UNKNOWN = { TH: { enter: "เข้าใช้ระบบ", admin: "คุยกับแอดมิน" } };
const KNOWN = {
  TH: {
    leave: "แจ้งลา",
    checkin: "เช็คอิน",
    mycourses: "คอร์สของฉัน",
    register: "เพิ่มนักเรียน",
    lang: "ภาษา/ช่วยเหลือ",
    admin: "คุยกับแอดมิน",
  },
};

const jobs = [
  { file: "parent-th.png", svg: menuSvg({ width: 2500, height: 1686, cells: parentCells(PARENT.TH), labelSize: 76, dividers: parentDividers }) },
  { file: "parent-en.png", svg: menuSvg({ width: 2500, height: 1686, cells: parentCells(PARENT.EN), labelSize: 76, dividers: parentDividers }) },
  { file: "teacher-th.png", svg: menuSvg({ width: 2500, height: 843, cells: teacherCells(TEACHER.TH), labelSize: 88, dividers: teacherDividers }) },
  { file: "teacher-en.png", svg: menuSvg({ width: 2500, height: 843, cells: teacherCells(TEACHER.EN), labelSize: 88, dividers: teacherDividers }) },
  // TASK-247 — orange, and orange ONLY here (see the palette note).
  { file: "unknown-th.png", svg: menuSvg({ width: 2500, height: 843, cells: unknownCells(UNKNOWN.TH), labelSize: 88, dividers: unknownDividers, accent: ORANGE }) },
  { file: "known-th.png", svg: menuSvg({ width: 2500, height: 1686, cells: knownCells(KNOWN.TH), labelSize: 76, dividers: knownDividers, accent: ORANGE }) },
];

for (const j of jobs) {
  const path = join(OUT_DIR, j.file);
  await sharp(Buffer.from(j.svg)).png({ compressionLevel: 9, palette: true }).toFile(path);
  console.log("wrote", j.file);
}
console.log("done");
