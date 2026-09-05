// TASK-249 (C-13) — the per-user menu link must follow the DB link state.
//
// @Porter asked whether clearing a family's LINE link puts that chat back on the unknown menu. It did not.
// Every menu call in this repo was a **link**; nothing ever removed one. So after an admin cleared a family
// (TASK-243), the parent's phone still showed **menu B** — แจ้งลา · เช็คอิน · คอร์สของฉัน — **the buttons of an
// account they no longer have.**
//
// 📌 And the reason it survived review: `line-rich-menu.ts` describes the fallback in words — *"a chat whose
// per-user link is ever removed falls back to ยังไม่รู้จัก"* — and **the premise never happened.** Third time in
// one week that a documented mechanism had no caller (`UNKNOWN_RICH_MENU` before TASK-247, `menuHasAdminButton`
// before its test, this). **The comment is not the mechanism**, which is why the assertions below are about
// call sites rather than about intent.
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";

const RICH = readSrc(await Bun.file(new URL("./line-rich-menu.ts", import.meta.url)).text());
const FAMILY = readSrc(await Bun.file(new URL("./family-link.ts", import.meta.url)).text());
const TEACHER = readSrc(await Bun.file(new URL("../services/teacher-link.service.ts", import.meta.url)).text());
const SVC = readSrc(await Bun.file(new URL("../services/line-webhook.service.ts", import.meta.url)).text());
const ROSTER = readSrc(await Bun.file(new URL("./roster-link.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fn = (src: string, decl: string) => {
  const rest = code(src).slice(code(src).indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};

describe("🔴 there is an unlink, and it is the fallback's missing caller", () => {
  test("`unlinkRichMenuFromUser` DELETEs the per-user link", () => {
    const f = fn(RICH, "export async function unlinkRichMenuFromUser");
    expect(f).toContain('method: "DELETE"');
    expect(f).toContain("/user/${userId}/richmenu");
  });

  test("🔑 removing the link is what makes the DEFAULT menu the answer — no 'link to unknown' anywhere", () => {
    // Linking a chat explicitly to the unknown menu would be a second definition of the same state, and the
    // state that a brand-new follower reaches with no code running at all. The absence is the design.
    expect(code(RICH)).not.toContain("linkUnknownRichMenu");
    expect(code(SVC)).not.toContain("ids.unknownTH");
  });
});

describe("🔴 every DB link-clear clears the menu link too — asserted as a PAIR", () => {
  test("`clearFamilyLine` (TASK-243, the admin clear) unlinks every account the family held", () => {
    // Every account, not just the primary: a family can hold several since TASK-230, and clearing one phone
    // while another keeps the menu is the same half-state the transaction exists to prevent.
    const clear = fn(FAMILY, "export async function clearFamilyLine");
    expect(clear).toContain("result.cleared.map((lineUserId) =>");
    expect(clear).toContain("unlinkRichMenuFromUser(lineUserId)");
  });

  test("⚠️ …AFTER the commit, and best-effort — a LINE hiccup must not undo an admin's database act", () => {
    const clear = fn(FAMILY, "export async function clearFamilyLine");
    expect(clear.indexOf("const result =")).toBeLessThan(clear.indexOf("unlinkRichMenuFromUser"));
    expect(clear).toContain(".catch(");
    // …and it is not inside the transaction body, where a network call has no business being.
    const unit = clear.slice(clear.indexOf("const run ="), clear.indexOf("const result ="));
    expect(unit).not.toContain("unlinkRichMenuFromUser");
  });

  test("`unlinkTeacherLine` — the SECOND clear path, same defect in the other role", () => {
    // Found by the grep @Sober asked for: a departed teacher kept `ตารางของฉัน` on their phone.
    const f = fn(TEACHER, "export async function unlinkTeacherLine");
    expect(f).toContain("unlinkRichMenuFromUser(before.lineUserId)");
    expect(f).toContain(".catch(");
    // 🔑 The account is read BEFORE the write: `returning()` hands back the row as it now is, where the id is
    // already `null`. Getting this wrong would unlink nothing and look like it worked.
    expect(f.indexOf("const before =")).toBeLessThan(f.indexOf(".set({ lineUserId: null })"));
  });

  test("🚫 `moveRosterLink` deliberately does NOT unlink — a role change is a MOVE, not a clear", () => {
    // It nulls the other roster's `line_user_id` while the caller links the new role's menu immediately after.
    // Unlinking here would blank the menu for a moment and then re-link it — churn on a real phone, and a
    // window where the chat has the wrong menu. Named so nobody "completes the set" later.
    expect(code(ROSTER)).not.toContain("unlinkRichMenuFromUser");
    expect(code(SVC)).toContain("await moveRosterLink(lineUserId,");
  });
});

describe("⚠️ the link ORDER at account-link — the known menu wins only because it is second", () => {
  test("`linkRoleRichMenu` runs BEFORE `linkKnownRichMenu` for a customer", () => {
    // Swap them and every newly-linked parent lands on the old REQ-015 parent menu instead of menu B — a
    // regression nothing else in the suite would notice, because both calls would still be present and both
    // would still succeed. Same shape as the `สมัคร` ordering pinned in TASK-246.
    const branch = code(SVC).slice(code(SVC).indexOf("await linkRoleRichMenu(lineUserId, role, seed)"));
    expect(branch.indexOf("linkRoleRichMenu")).toBeLessThan(branch.indexOf("linkKnownRichMenu"));
    expect(branch.slice(0, 400)).toContain('if (role === "customer") await linkKnownRichMenu(lineUserId, seed)');
  });

  test("…and the known menu is only for customers — a teacher must not get the family menu", () => {
    expect(code(SVC)).toContain('if (role === "customer") await linkKnownRichMenu');
  });
});
