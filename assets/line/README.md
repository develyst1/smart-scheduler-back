# LINE rich-menu artwork (REQ-107 — one bilingual menu per role)

`bun run line:publish-menus` uploads **three** images, one per role, from **exactly these paths** (the fixed contract in
`scripts/line-publish-menus.ts` → `IMAGE_PATHS`; a missing file refuses the whole run before any LINE call):

| File | Menu (role) | Size (px) | Cells (tap areas live in `src/lib/line-rich-menu.ts`) | Where it comes from |
|------|-------------|-----------|--------------------------------------------------------|---------------------|
| `menu-unknown.png` | unlinked chat (the account DEFAULT) | **2500 × 843** | 2 cells: **สมัครสมาชิก / Sign Up** · **คุยกับแอดมิน / Chat with Admin** | the customer's art, stretched (`resize-customer-menus.mjs`) |
| `menu-customer.png` | linked parent | **2500 × 1686** | 3×2: **แจ้งลา · เช็คอิน · คอร์สของฉัน** / **เพิ่มนักเรียน · ภาษา/ช่วยเหลือ · คุยกับแอดมิน** | the customer's art, stretched (`resize-customer-menus.mjs`) |
| `menu-teacher.png` | teacher | **2500 × 843** | 2 cells: **ตารางของฉัน / My schedule** · **ภาษา/ช่วยเหลือ / Language/Help** | generated (`generate-rich-menus.mjs`) |

## The rules a file must meet
- **The exact size above.** The tap areas are a grid over the definition's `size`; an image of any other size puts the
  buttons where the parent does not tap. 🔴 **This is a test:** `src/lib/rich-menu-images-req107.test.ts` reads each
  file's PNG header and fails the suite if its width × height is not its menu's `size`.
- **PNG, ≤ 1,000,000 bytes.** LINE's cap is "1 MB"; we hold to the stricter reading. Same test.
- **Cells never change on one side alone.** A different layout means changing `line-rich-menu.ts` AND the art together.

## Regenerating
`sharp` is **not** a dependency of this backend; run both scripts from a repo that has it (the frontoffice web does):

```bash
cd ../smart-scheduler-front
bun ../smart-scheduler-back/assets/line/resize-customer-menus.mjs <linked-6cell image> <unlinked-2cell image>
bun ../smart-scheduler-back/assets/line/generate-rich-menus.mjs
```

- **`resize-customer-menus.mjs`** — the customer's two parent images (their originals live in the workspace's
  `smart-scheduler/project-docs/customer-2026-09-25-richmenu/`; she sent 1527×1030 and 2160×728). Stretched to the exact
  sizes by the owner's ruling (2026-09-25): use them now, and if full-size originals arrive, run it again on those. It
  writes full-colour PNG first; if that is over the cap it writes a **256-colour PNG (quality 90, no dither)** and
  **prints that it did**. On 2026-09-25: `menu-customer.png` 592 KB (256-colour, full colour was 2.7 MB) ·
  `menu-unknown.png` 984 KB (full colour).
- **`generate-rich-menus.mjs`** — draws `menu-teacher.png` from code: the teacher menu's same two cells, same blue,
  Thai over English. ⏪ If the owner keeps the Thai-only picture instead, the one-line swap is written beside the job in
  the script (use `teacher-th`'s svg). It also rewrites the six files below, byte-identical.

## Older files in this folder (not published any more)
`parent-th/en.png`, `teacher-th/en.png` (REQ-015) and `unknown-th.png`, `known-th.png` (REQ-079) are the language-era
menus. Menus already on an account keep their images until `line:remove-menus` removes those menus (after the relink
sweep, never before). `src/lib/line-rich-menu-artwork.test.ts` still pins the generator's geometry for them.
