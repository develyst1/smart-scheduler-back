// TASK-472 (REQ-107) — the PICTURE and the DEFINITION of each menu agree.
//
// 🔑 The image is what a person sees; the definition (`line-rich-menu.ts`) is what LINE acts on. The tap areas are a grid
// over the definition's `size`, so an image of any other size puts every button somewhere other than where the parent
// taps — and until this file nothing said they agree. Now a drifted size fails the suite instead of confusing a parent.
// The pairing is read from the publish script's OWN `IMAGE_PATHS`, so the file checked is the file uploaded.
// Dimensions come from the PNG header (IHDR), read directly: no image library in this repo (sharp stays in the front).
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CUSTOMER_MENU, TEACHER_MENU, UNKNOWN_MENU, type RichMenuDef } from "./line-rich-menu";
import { IMAGE_PATHS } from "../../scripts/line-publish-menus";

const root = resolve(import.meta.dir, "..", "..");
/** LINE says "1 MB"; read as the STRICTER 1,000,000 bytes (the same cap `resize-customer-menus.mjs` enforces). */
const MAX_BYTES = 1_000_000;
const PNG_SIG = "89504e470d0a1a0a";

/** Width × height from a PNG's IHDR chunk (bytes 16–23, big-endian), after checking it IS a PNG. */
const pngSize = (buf: Buffer): { width: number; height: number } => {
  if (buf.subarray(0, 8).toString("hex") !== PNG_SIG || buf.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

const PAIRS: Array<[string, string, RichMenuDef]> = [
  ["unknown", IMAGE_PATHS.unknownImage, UNKNOWN_MENU],
  ["customer", IMAGE_PATHS.customerImage, CUSTOMER_MENU],
  ["teacher", IMAGE_PATHS.teacherImage, TEACHER_MENU],
];

describe("🔴 each published image is exactly its menu's size — the buttons line up with the taps", () => {
  test("the pairing covers every image the publish uploads (no fourth image slips past the check)", () => {
    expect(PAIRS.map(([, p]) => p).sort()).toEqual(Object.values(IMAGE_PATHS).sort());
  });
  for (const [role, path, def] of PAIRS) {
    test(`${role}: ${path} is a PNG of exactly ${def.size.width}×${def.size.height}, ≤ 1,000,000 bytes`, () => {
      const file = resolve(root, path);
      const size = pngSize(readFileSync(file));
      expect({ role, size }).toEqual({ role, size: def.size });
      expect({ role, underCap: statSync(file).size <= MAX_BYTES }).toEqual({ role, underCap: true });
    });
    test(`${role}: every tap area lies inside the picture`, () => {
      for (const a of def.areas) {
        const b = a.bounds;
        const inside = b.x >= 0 && b.y >= 0 && b.x + b.width <= def.size.width && b.y + b.height <= def.size.height;
        expect({ role, area: a.action.data, inside }).toEqual({ role, area: a.action.data, inside: true });
      }
    });
  }
  test("LINE's accepted sizes: the three definitions are ones LINE takes", () => {
    const ok = ["2500x1686", "2500x843", "1200x810", "1200x405", "800x540", "800x270"];
    for (const [role, , def] of PAIRS) expect({ role, ok: ok.includes(`${def.size.width}x${def.size.height}`) }).toEqual({ role, ok: true });
  });
});

describe("🔑 TASK-484 — the ORANGE teacher art's two cells ARE the teacher menu's two hit-boxes", () => {
  test("left half = My Schedule (`schedule`), right half = Language / Help (`lang`), full height — the artwork's divider is at 1250", () => {
    // The customer's art (REQ-109 §1) draws two equal cells split at x = 1250 of 2500 — checked by eye on the stretched file.
    // A stretched picture over the OLD hit-boxes looks right and taps wrong; this pins the boxes the picture was drawn for.
    expect(TEACHER_MENU.areas.map((a) => [a.action.data, a.bounds])).toEqual([
      ["action=schedule", { x: 0, y: 0, width: 1250, height: 843 }],
      ["action=lang", { x: 1250, y: 0, width: 1250, height: 843 }],
    ]);
    expect(TEACHER_MENU.size).toEqual({ width: 2500, height: 843 });
  });
});

describe("`pngSize` reads the header it claims to", () => {
  test("a real file, and a refusal for a non-PNG", () => {
    expect(pngSize(readFileSync(resolve(root, "assets/line/teacher-th.png")))).toEqual({ width: 2500, height: 843 });
    expect(() => pngSize(Buffer.from("GIF89a-not-a-png-at-all-000000"))).toThrow("not a PNG");
  });
});
