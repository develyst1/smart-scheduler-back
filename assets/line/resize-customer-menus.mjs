// TASK-472 (REQ-107) — the customer's two parent-menu images, stretched to LINE's exact sizes, ≤ 1 MB.
//
// A SIBLING of `generate-rich-menus.mjs`, not an extension of it: that script DRAWS its menus from code and needs no
// input, so any machine can regenerate them; this one needs the customer's own files, which live outside this repo.
// Folding it in would make every regeneration depend on her files being present.
//
// The owner's ruling (09-25): stretch her files to the exact sizes NOW and use them; if Khwan sends full-size originals,
// run this again on those. `fit: "fill"` stretches on purpose — her linked menu is already the right ratio (1527×1030 ≈
// 2500×1686), her unlinked one is not (2160×728 → 2500×843, a 2 % vertical stretch).
//
// ≤ 1 MB: each file is written as full-colour PNG at maximum compression first. Only if that lands over the cap is it
// written as a 256-colour PNG (quality 90, no dither), and the script SAYS SO on the console — never a silent quality cliff.
//
// RUN (needs `sharp`, which lives in the frontoffice web repo — the same anchoring as the generator):
//   cd smart-scheduler-front
//   bun ../smart-scheduler-back/assets/line/resize-customer-menus.mjs <linked-6cell image> <unlinked-2cell image>
// Writes menu-customer.png (2500×1686) and menu-unknown.png (2500×843) next to this script.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const sharp = createRequire(join(process.cwd(), "noop.js"))("sharp");
const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 1_000_000; // LINE says "1 MB" — read as the STRICTER 1,000,000 bytes, so no reading of it can refuse the file

const [linked, unlinked] = process.argv.slice(2);
if (!linked || !unlinked) {
  console.error("usage: resize-customer-menus.mjs <linked-6cell image> <unlinked-2cell image>");
  process.exit(1);
}

const jobs = [
  { src: linked, file: "menu-customer.png", width: 2500, height: 1686 },
  { src: unlinked, file: "menu-unknown.png", width: 2500, height: 843 },
];

for (const j of jobs) {
  const meta = await sharp(j.src).metadata();
  const base = () => sharp(j.src).resize(j.width, j.height, { fit: "fill" });
  let buf = await base().png({ compressionLevel: 9 }).toBuffer();
  let mode = "full-colour PNG";
  if (buf.length > MAX_BYTES) {
    // quality 90, NO dithering: her art is flat orange line work on off-white, and dithering is what bloats it
    // (quality 100 + dither measured 1.56 MB on the 6-cell file; this measured 0.59 MB and reads the same side by side).
    buf = await base().png({ compressionLevel: 9, palette: true, quality: 90, dither: 0 }).toBuffer();
    mode = "⚠️ 256-colour PNG, quality 90, no dither (full colour was over 1 MB)";
  }
  if (buf.length > MAX_BYTES) throw new Error(`${j.file}: still ${buf.length} bytes after palette — over LINE's 1 MB cap; not written`);
  writeFileSync(join(OUT_DIR, j.file), buf); // the exact bytes measured above — no second encode
  console.log(`wrote ${j.file}: ${meta.width}×${meta.height} → ${j.width}×${j.height}, ${buf.length} bytes, ${mode}`);
}
console.log("done");
