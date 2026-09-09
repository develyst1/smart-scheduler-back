// TASK-307 (REQ-085 §6) — a parent may SKIP past having a child, and the account can then do nothing.
//
// 🔑 The owner's reason IS the acceptance criterion: *"a parent account with no child can do NOTHING in this
// product"* ⇒ skipping produced an account that exists, cannot be used, and gave the parent no way to know that
// was why. **A dead end that looks like a completed sign-up.**
//
// ⏸️ `REQ-085 §5` is NOT in this task — its copy is with the customer, and the REQ says *"No engineer may
// implement this text."* The last describe here exists only to prove it was not disturbed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t, tb } from "./line-i18n";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const WEBHOOK = code(src("src/services/line-webhook.service.ts"));
/** The skip guard alone. */
const guard = WEBHOOK.slice(
  WEBHOOK.indexOf('if (SKIP_WORDS.includes(lower) && session?.step === "AWAIT_STUDENT_NAME")'),
  WEBHOOK.indexOf("return handleAddStudentStep("),
);

describe("🔑 TASK-307 — the two moments the owner named are ONE branch", () => {
  test("🔴 the decision is `kids.length`, not the STEP", () => {
    // *"จังหวะเพิ่มลูกคนแรก และ แรกเริ่มที่ไม่มีลูก"* — the very start, and adding the FIRST child. The step is
    // identical for the first child and the fifth, so the question that decides it is **whether this parent
    // has a child at all**. Both moments reduce to the same test, and there is one branch rather than two.
    expect(guard).toContain("const skipParent = await findParentByLineUserId(lineUserId);");
    expect(guard).toContain("const kids = skipParent ? await listStudentsOfParent(skipParent.id) : [];");
    expect(guard).toContain("if (!kids.length) {");
  });

  test("🔑 a parent with NO children cannot skip — the flow does not advance", () => {
    // 📌 The session is deliberately NOT cleared: the flow stays where it was and asks again. Asserted by
    // ORDER — the early return comes before `clearSession`, so the no-child path cannot reach it.
    const noChild = guard.slice(guard.indexOf("if (!kids.length) {"), guard.indexOf("await clearSession"));
    expect(noChild).toContain("return reply(");
    expect(noChild).not.toContain("clearSession");
    expect(noChild).not.toContain("skip_done");
  });

  test("🔑 a parent WITH a child can still skip — this is what keeps the fix narrow", () => {
    // ⚠️ Without this, *"no skip"* quietly becomes *"no skip ever"*, and skipping a SECOND child is
    // legitimate — a parent who already has one is not in a dead end.
    expect(guard).toContain("await clearSession(lineUserId);");
    expect(guard).toContain('t("skip_done", l)');
  });
});

describe("🚫 TASK-307 §3 — an EXISTING string, and no new copy", () => {
  test("🔑 the re-ask is the prompt that asked for the name in the first place", () => {
    // **Re-ask, do not explain.** An engineer inventing the sentence a parent reads is how `Date : อังคาร`
    // shipped after REQ-079 §18 had already ruled otherwise.
    // 🔑 The re-ask and the FIRST ask are now the identical expression, so they cannot drift into two
    // wordings of one question.
    // 🔻 TASK-310 — the `{max}` argument is gone: `REQ-079 §17c`'s screen 4 is *"กรุณาระบุชื่อนักเรียน เช่น
    // ส้ม"* and carries no cap sentence for it to fill. ✅ **The property this test exists for is untouched** —
    // the re-ask and the first ask are still the identical expression, so they cannot drift into two wordings.
    const ask = 'withExit(t("add_student_name_prompt", lang), lang)';
    expect(guard).toContain(ask);
    expect((WEBHOOK.match(new RegExp(ask.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBeGreaterThan(1);
  });

  test("🚫 no new i18n key was added for this", () => {
    // The whole point of §3: the wording is not ours. If a key had to be invented, the task said STOP and ask.
    const I18N = src("src/lib/line-i18n.ts");
    expect(I18N).not.toContain("no_skip");
    expect(I18N).not.toContain("skip_blocked");
    expect(I18N).not.toContain("child_required");
  });

  test("🔻 the reply renders in the SESSION'S language — not `both()`", () => {
    // 🔻 This assertion used to demand `both()`, on the reading that a conversation must be bilingual. **It was
    // asserting a mistake and is replaced rather than left red.** `REQ-079 §18` is satisfied here a different
    // way: this flow KNOWS the session's `lang` and answers in it (39 `t(…, lang)` against 13 `both()`).
    // 🔑 `both()` is for a reader whose language is unknown; inside a session it is known — and using it made
    // the re-ask bilingual while the first ask was not, which a parent would have seen.
    // ⚠️ Scoped to the NO-CHILD branch: the later-child reply below it is `both((l) => skip_done …)` and was
    // always bilingual. §4 protects other steps' skip behaviour, so only the re-ask moved.
    const noChild = guard.slice(guard.indexOf("if (!kids.length) {"), guard.indexOf("await clearSession"));
    expect(noChild).not.toContain("both(");
    expect(noChild).toContain('t("add_student_name_prompt", lang)');
    // 🔻 TASK-310 — this used to add *"and the string still genuinely differs by language"*. **It no longer
    // does, and that is the point of §17c**: the customer wrote Thai and English into one block, so the
    // re-ask is bilingual through its STRING rather than through its helper. ⇒ the assertion is replaced
    // rather than left red, and what it was protecting — the re-ask and the first ask being one wording —
    // is asserted above and is now true in a stronger way: **every reader gets the identical screen.**
    expect(t("add_student_name_prompt", "TH")).toBe(t("add_student_name_prompt", "EN"));
    expect(t("add_student_name_prompt", "TH")).toContain("Please enter the student's name");
  });
});

describe("🔻 TASK-307 §4 — `REQ-085 §5`'s copy ARRIVED, and this is what happened to it", () => {
  test("🔴 the three role BUTTONS are gone — the customer is no longer holding the copy", () => {
    // ⏸️ TASK-307 §4 pinned these as untouched *while the customer wrote the words*. **They wrote them**
    // (`REQ-079 §17c`, 2026-09-08) and their screen 2 offers ONE path — type `Next` — so that a parent
    // never learns the other roles exist. ⇒ the buttons are not edited, they are DELETED, and the keys
    // with them. 🔑 Asserted as an absence, because a leftover label is a role word waiting for a caller.
    for (const key of ["role_btn_customer", "role_btn_teacher", "role_btn_admin"]) {
      for (const lang of ["TH", "EN"] as const) {
        expect({ key, lang, rendered: t(key, lang) }).toEqual({ key, lang, rendered: key }); // no such key
      }
    }
  });

  test("…and the entry prompt is ONE bilingual block, not two renderings", () => {
    expect(tb("role_prompt")).toBe(t("role_prompt", "TH"));
    expect(t("role_prompt", "TH")).toBe(t("role_prompt", "EN"));
  });

  test("🚫 `SKIP_WORDS` / `CMD_SKIP` themselves are unchanged", () => {
    // The fix is the CONDITION around the guard, never the vocabulary it matches.
    expect(WEBHOOK).toContain("const SKIP_WORDS: readonly string[] = CMD_SKIP;");
  });
});
