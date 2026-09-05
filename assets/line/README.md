# LINE rich-menu artwork (REQ-015 · REQ-079)

`bun run line:publish-menus` uploads these **six** images to the LINE Official Account. Supply them here with
**exactly these filenames** (the publish command's fixed path contract — TASK-040/041, extended by TASK-247):

| File | Menu | Size (px) | Tap layout (must align to these bounds) |
|------|------|-----------|------------------------------------------|
| `parent-th.png` | Parent (Thai) | **2500 × 1686** | 3×2 grid: **check-in · leave · my-children** / **add-child · language · help** |
| `parent-en.png` | Parent (English) | 2500 × 1686 | same grid, English labels |
| `teacher-th.png` | Teacher (Thai) | **2500 × 843** | 2 cells: **my-schedule** · **language** |
| `teacher-en.png` | Teacher (English) | 2500 × 843 | same, English labels |
| `unknown-th.png` | **ยังไม่รู้จัก** (Thai) — REQ-079 | **2500 × 843** | 2 cells: **เข้าใช้ระบบ** · **คุยกับแอดมิน** |
| `known-th.png` | **รู้จักแล้ว** (Thai) — REQ-079 | **2500 × 1686** | 3×2 grid: **แจ้งลา · เช็คอิน · คอร์สของฉัน** / **เพิ่มนักเรียน · ภาษา/ช่วยเหลือ · คุยกับแอดมิน** |

Tap areas/actions are defined in code (`src/lib/line-rich-menu.ts`); the image only needs to line up visually
with those bounds. **No QR button** on the parent menu (by design). Re-run the command after any artwork change.

**The default menu is `unknown-th`** (TASK-247). ยังไม่รู้จัก is the state a chat lands in with no code running;
รู้จักแล้ว is linked per user when a chat is bound, and there is deliberately **no unlink** — removing the link
falls back to unknown by itself.

**Colour:** the four REQ-015 menus are **blue**; the two REQ-079 menus are **orange** (the owner's entire art
direction — *"อยากได้สีส้ม แค่นั้นแหละ"*). ⚠️ They are deliberately not repainted together: re-creating a menu
changes its **richMenuId**, and every already-linked teacher keeps the OLD menu until they re-link. **A repaint
is a migration, not a colour change.**

**EN:** `unknown-en` / `known-en` are **not** produced. The defs exist, but a stored menu id whose image was
never uploaded renders **blank** on a phone — worse than falling back to the default. If EN is ever wanted, the
image and the stored id must arrive together.

## Regenerating the artwork (TASK-041 · TASK-247)

The 6 PNGs are generated from [`generate-rich-menus.mjs`](generate-rich-menus.mjs) — pure geometry (cell bounds
mirror `line-rich-menu.ts`) + simple SVG icons, rasterised with `sharp`. `sharp` is **not** a dependency of this
backend repo, so run the script from a repo that has it (the frontoffice web does):

```bash
cd ../../../smart-scheduler-front   # any dir whose node_modules has `sharp`
bun ../smart-scheduler-back/assets/line/generate-rich-menus.mjs
```

✅ Confirmed working on 2026-09-05 (`sharp` 0.34.5 in `smart-scheduler-front`): it rewrites all 6 PNGs here
(indexed PNG, ~17–50 KB each) and the four REQ-015 files come out **byte-identical**, so a regeneration for the
new menus cannot disturb the shipped ones. Edit the palette / icons / label maps in that script and re-run to
tweak. Labels mirror `src/lib/line-i18n.ts` so the menu matches the bot replies: `my children` = `btn_children`
(นักเรียนของฉัน / My children), `add child` = `btn_register` (เพิ่มนักเรียน / Add child), the merged
language/help cell = `btn_langhelp` (ภาษา/ช่วยเหลือ) — the same string on the teacher menu and on the new known
menu. `language` / `help` / `my schedule` have no dedicated i18n key (postback actions, not text buttons) → they
use the SPEC-012 wording.

> ⚠️ Keep the visual cells in sync with `line-rich-menu.ts`. If a tweak needs different bounds, change **both**
> the code bounds and this artwork — never one side alone (that's the TASK-041 ↔ code contract).
> 🔴 Since TASK-247 that sentence is also a **test**: `src/lib/line-rich-menu-artwork.test.ts` reads this
> generator as text and fails if either side moves a cell on the two REQ-079 menus.
