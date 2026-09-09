// TASK-315 (`REQ-085 §6.1`) — a family with FOUR children is forced to add a fifth.
//
// 🔴 The owner's own screenshot: `0900000092` links, is greeted *"พบข้อมูลของคุณแล้วค่ะ — มิลล่า, มิลลิม, asda,
// temp"*, and is immediately asked *"กรุณาระบุชื่อนักเรียน"*. *"เหมือนบังคับเลยมั้ย"*.
//
// 🔑 The rule is a BOUNDARY, not a new behaviour. `§6`'s justification for the mandatory prompt is *"a parent
// account with no child can do NOTHING in this product"* ⇒ **a family that already has children can do
// everything, so the rule never reached them.**
// 🚫 Not fixed with a skip: *the prompt should not be there, and a skip on a prompt that should not exist is a
// second wrong thing.*
//
// ⚠️ The pair of assertions is the point. *"A family with children gets no prompt"* alone would be satisfied by
// deleting the prompt — which is `§6`, the owner re-confirmed it this afternoon, and TASK-307 built it. **Both
// halves, always, in the same file.**
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./line-i18n";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));
const fn = (sig: string) => {
  const i = SVC.indexOf(sig);
  if (i < 0) throw new Error("no " + sig);
  return SVC.slice(i, SVC.indexOf("\n}\n", i));
};
const DECISION = fn("async function afterParentLink(");

/** The decision, reproduced from the source above — see the source assertion in the last describe. */
const tailFor = (kids: number, lang: "TH" | "EN" = "TH") =>
  kids === 0
    ? `\n${t("add_student_prompt", lang)}`
    : `\n\n${t("add_another_hint", lang)}\n\n${t("menu_body", "TH")}\n${t("menu_body", "EN")}`;

describe("🔴 TASK-315 §1 — the owner's exact case: FOUR children, and no name prompt", () => {
  test("🔴 a returning family is NOT asked for a child's name", () => {
    const tail = tailFor(4);
    expect(tail).not.toContain(t("add_student_prompt", "TH"));
    expect(tail).not.toContain("กรุณาระบุชื่อนักเรียน");
  });

  test("🔑 …and what they get instead is the invitation and the menu — theirs to choose, not to obey", () => {
    const tail = tailFor(4);
    // The customer's own screen-8 sentence, both languages, naming the phrase TASK-313 made accepted.
    expect(tail).toContain('กรุณาพิมพ์ "เพิ่มนักเรียน" ค่ะ');
    expect(tail).toContain('please type "Add Student".');
    // …and the menu, so a family who wants nothing more has somewhere to go.
    expect(tail).toContain(t("menu_body", "TH"));
    expect(tail).toContain(t("menu_body", "EN"));
  });

  test("🔑 the found-your-family line still comes first — the reply is head + tail, and the head is untouched", () => {
    // `verifyAndLink` builds the *"พบข้อมูลของคุณแล้วค่ะ — …"* line; TASK-315 changed only what follows it.
    expect(SVC).toContain("`${both(res.message)}${await afterParentLink(lineUserId, lang)}`");
    expect(t("verify_parent_ok_existing", "TH")).toContain("{list}");
  });
});

describe("🚫 TASK-315 §5 — ZERO children still gets the MANDATORY prompt (`§6`, re-confirmed)", () => {
  test("🔑 the assertion that keeps `§6` alive — without it, 'no forced prompt' becomes 'no prompt'", () => {
    const tail = tailFor(0);
    expect(tail).toBe(`\n${t("add_student_prompt", "TH")}`);
    expect(tail).toContain("กรุณาระบุชื่อนักเรียน");
    // 🚫 And no invitation to skip past it: a parent with no child must not be offered the menu here.
    expect(tail).not.toContain(t("add_another_hint", "TH"));
    expect(tail).not.toContain(t("menu_body", "TH"));
  });

  test("🔑 the step is SET on the zero path and CLEARED on the ≥1 path", () => {
    // 📌 The second half matters as much as the first: a returning parent's next word must not be read as a
    // child's name. Asserted on the source, because the branch is the behaviour.
    const zero = DECISION.slice(DECISION.indexOf("if (!kids.length) {"), DECISION.indexOf("await clearSession"));
    expect(zero).toContain('await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");');
    expect(zero).toContain('t("add_student_prompt", lang)');
    const many = DECISION.slice(DECISION.indexOf("await clearSession"));
    expect(many).toContain("await clearSession(lineUserId);");
    expect(many).not.toContain("setStep(");
    expect(many).toContain('t("add_another_hint", lang)');
  });

  test("🚫 TASK-307's no-skip guard is untouched — the first child is still mandatory once the flow is entered", () => {
    expect(SVC).toContain('if (SKIP_WORDS.includes(lower) && session?.step === "AWAIT_STUDENT_NAME")');
    expect(SVC).toContain("if (!kids.length) {");
  });
});

describe("🔴 TASK-315 §3 — TWO DOORS, ONE decision", () => {
  test("🔑 both the link-success door and the 2FA door call the same function", () => {
    // ⚠️ 2FA is unreachable while `line_parent_2fa` is off, and exists so that switching it on is a setting
    // change and not a rebuild. Fixing only the reachable door would bring this defect back the day someone
    // flips that setting — certain they had changed nothing else.
    expect(SVC.match(/afterParentLink\(/g)!.length).toBe(3); // the declaration + both doors
    const twofa = SVC.slice(SVC.indexOf('if (session.step === "AWAIT_2FA")'), SVC.indexOf('if (session.step === "AWAIT_CODE" && session.pendingRole)'));
    expect(twofa).toContain("const tail = await afterParentLink(lineUserId, lang, kids);");
    expect(twofa).not.toContain('setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer")');
    const link = SVC.slice(SVC.indexOf('if (session.step === "AWAIT_CODE" && session.pendingRole)'));
    expect(link.slice(0, link.indexOf("\n  }"))).toContain("await afterParentLink(lineUserId, lang)");
  });

  test("🚫 …and NOT by writing the same three lines twice — NEITHER door decides for itself", () => {
    // The class this week was spent closing: a rule applied where the report came from, never to the sibling.
    // ⚠️ Asserted as an ABSENCE on both doors rather than as a count of `setStep` calls in the file — three
    // OTHER sites set that step legitimately (the inline add's prompt, TASK-313's reserved-word refusal, the
    // `register` postback), and a number that includes them measures the wrong thing. **My first version of
    // this test counted them and was simply wrong about the number.**
    const twofa = SVC.slice(SVC.indexOf('if (session.step === "AWAIT_2FA")'), SVC.indexOf('if (session.step === "AWAIT_CODE" && session.pendingRole)'));
    const link = SVC.slice(SVC.indexOf('if (session.step === "AWAIT_CODE" && session.pendingRole)'));
    const linkBranch = link.slice(0, link.indexOf("\n  }"));
    for (const door of [twofa, linkBranch]) {
      expect(door).not.toContain('setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer")');
      expect(door).not.toContain('t("add_student_prompt", lang)');
      expect(door).not.toContain("kids.length");
    }
    // …and the decision itself exists exactly once.
    expect(SVC.match(/async function afterParentLink\(/g)!.length).toBe(1);
  });

  test("⚠️ the 2FA door still greets by NAME — TASK-047's gate is honoured, and this task did not touch it", () => {
    const twofa = SVC.slice(SVC.indexOf('if (session.step === "AWAIT_2FA")'), SVC.indexOf('if (session.step === "AWAIT_CODE" && session.pendingRole)'));
    expect(twofa).toContain("parentChildrenNames(kids.map((k: any) => k.nickname ?? k.name), lang)");
    // …and it passes the children it already fetched, so the decision costs no second query.
    expect(DECISION).toContain("const kids = known ?? (await childrenOfLineParent(lineUserId));");
  });
});

describe("🚫 TASK-315 §4 — the copy EXISTS; none was written", () => {
  test("`add_another_hint` is reused, and it is the customer's screen-8 sentence", () => {
    // 📌 @Porter chose it deliberately: one phrase, one meaning, everywhere. And since TASK-313 the phrase it
    // names is the phrase the parser accepts — the sentence and the parser agree.
    expect(DECISION).toContain('t("add_another_hint", lang)');
    expect(t("add_another_hint", "TH")).toContain('กรุณาพิมพ์ "เพิ่มนักเรียน" ค่ะ');
    expect(t("add_another_hint", "TH")).toContain('please type "Add Student".');
  });

  test("🚫 no new i18n key — asserted as an absence", () => {
    const I18N = src("src/lib/line-i18n.ts");
    for (const invented of ["returning_family", "already_have_children", "no_prompt_needed", "welcome_back"]) {
      expect({ invented, present: I18N.includes(invented) }).toEqual({ invented, present: false });
    }
  });
});
