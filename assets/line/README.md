# LINE rich-menu artwork (REQ-015)

`bun run line:publish-menus` uploads these four images to the LINE Official Account. Supply them here with
**exactly these filenames** (the publish command's fixed path contract — TASK-040/041):

| File | Menu | Size (px) | Tap layout (must align to these bounds) |
|------|------|-----------|------------------------------------------|
| `parent-th.png` | Parent (Thai) | **2500 × 1686** | 3×2 grid: **check-in · leave · my-children** / **add-child · language · help** |
| `parent-en.png` | Parent (English) | 2500 × 1686 | same grid, English labels |
| `teacher-th.png` | Teacher (Thai) | **2500 × 843** | 2 cells: **my-schedule** · **language** |
| `teacher-en.png` | Teacher (English) | 2500 × 843 | same, English labels |

Tap areas/actions are defined in code (`src/lib/line-rich-menu.ts`); the image only needs to line up visually
with those bounds. **No QR button** on the parent menu (by design). Re-run the command after any artwork change.

## Regenerating the artwork (TASK-041)

The 4 PNGs are generated from [`generate-rich-menus.mjs`](generate-rich-menus.mjs) — pure geometry (cell bounds
mirror `line-rich-menu.ts`) + simple SVG icons, rasterised with `sharp`. `sharp` is **not** a dependency of this
backend repo, so run the script from a repo that has it (the frontoffice web does):

```bash
cd ../../../smart-scheduler-front   # any dir whose node_modules has `sharp`
bun ../smart-scheduler-back/assets/line/generate-rich-menus.mjs
```

It rewrites all 4 PNGs here (indexed PNG, ~20–50 KB each). Edit the palette / icons / label maps in that script
and re-run to tweak. Labels mirror `src/lib/line-i18n.ts` so the menu matches the bot replies:
`my children` = `btn_children` (นักเรียนของฉัน / My children), `add child` = `btn_register` (เพิ่มนักเรียน /
Add child), teacher cell 2 = `btn_langhelp` (ภาษา/ช่วยเหลือ). `language` / `help` / `my schedule` have no
dedicated i18n key (postback actions, not text buttons) → they use the SPEC-012 wording.

> ⚠️ Keep the visual cells in sync with `line-rich-menu.ts`. If a tweak needs different bounds, change **both**
> the code bounds and this artwork — never one side alone (that's the TASK-041 ↔ code contract).
