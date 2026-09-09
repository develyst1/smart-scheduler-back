// TASK-251 (REQ-079 §16) — the role step stops accepting bare numbers, and becomes buttons.
//
// 🔴 This is a LIVE-ACCOUNT collision, not a hypothesis: the customer's own OA already owns numbered replies,
// and our role step asked for `1 / 2 / 3` on the same account. So the assertion that matters most here is the
// NEGATIVE one — `parseRoleChoice("1")` must be null, and `role_prompt` must not contain a digit — because a
// prompt that still teaches `1` would keep manufacturing the collision even after the parser stopped accepting
// it. The copy and the parser have to move together or the fix is only half done.
//
// ⚠️ The second thing guarded here is that a TAP and a TYPED word reach ONE transition. Two paths would be two
// places to forget `resetStrikes`, and the symptom — a parent handed to a human after answering correctly —
// would look like the strike rule misbehaving rather than like a duplicated transition.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 🔻 **TASK-310 (`REQ-085 §5` via `REQ-079 §17c`, 2026-09-09) — THE BUTTONS ARE GONE. The parser is not.**
//
// 🔑 **The two halves of TASK-251 came apart, and only one of them was wrong.**
// · ✅ **The digits** — the live collision, the actual defect — are still gone, from the parser AND the copy,
//   and every assertion about them below is UNCHANGED and still passing. That work stands.
// · 🔻 **The buttons** are deleted. The customer's own screen 2 offers ONE path — *type `Next`* — precisely so
//   that a parent never learns the other roles exist (`REQ-085 §5`: *"ไม่ให้ลูกค้ารู้ว่ามี role อื่นด้วย"*).
//   ⚠️ **A role picker is a role list you cannot look away from**, so no arrangement of buttons could offer
//   one choice and hide two. ⇒ `rolePicker` is deleted rather than edited.
//
// 📌 **What TASK-251 was actually protecting survives intact**, and that is why this file keeps most of its
// assertions: no digit is asked for or accepted anywhere; a typed word still reaches ONE transition; and the
// postback namespace is still ours. **Nothing about §16's collision is reopened by removing the buttons.**
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { t, type Lang } from "../lib/line-i18n";
import { parsePostback, parseRoleChoice } from "../lib/line-webhook";

const SVC = readSrc(await Bun.file("src/services/line-webhook.service.ts").text());
const REPLY = readSrc(await Bun.file("src/lib/line-reply.ts").text());
const PARSER = readSrc(await Bun.file("src/lib/line-webhook.ts").text());

/** Comment text is prose, not behaviour — strip it before counting identifiers or slicing on landmarks. */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const LANGS: Lang[] = ["TH", "EN"];
/** ASCII digits AND Thai digits ๐-๙ — the TH copy is the one the customer reads. */
const ANY_DIGIT = /[0-9๐-๙]/;

describe("TASK-251 — the bare number is gone from the PARSER", () => {
  test("1 / 2 / 3 no longer resolve to a role", () => {
    // 📌 The whole point of the task. Each asserted separately so a failure names which one came back.
    expect(parseRoleChoice("1")).toBeNull();
    expect(parseRoleChoice("2")).toBeNull();
    expect(parseRoleChoice("3")).toBeNull();
    // …and neither do the shapes someone might "helpfully" re-add: padded, or Thai digits.
    expect(parseRoleChoice(" 1 ")).toBeNull();
    expect(parseRoleChoice("๑")).toBeNull();
  });

  test("every typed WORD still resolves — this is the path that must not close", () => {
    // ⚠️ SYSTEM-FACTS (corrected 2026-09-02): quick-reply chips ARE tappable on LINE PC, but they vanish the
    // moment the user types, and PC has no rich menu to bring them back. A PC user therefore ends up typing,
    // so the words below are not a nicety — for that user they are the only door.
    // 🔑 TASK-310 makes this the ONLY door for everyone, which is why the list matters more than it did.
    for (const w of ["next", "Next", "ลูกค้า", "ผู้ปกครอง", "นักเรียน", "พ่อ", "แม่", "customer", "parent"]) {
      expect({ w, role: parseRoleChoice(w) }).toEqual({ w, role: "customer" });
    }
    for (const w of ["ครู", "teacher"]) expect(parseRoleChoice(w)).toBe("teacher");
    for (const w of ["แอดมิน", "admin"]) expect(parseRoleChoice(w)).toBe("admin");
    // Typed by a human, so case and stray spacing must not decide the outcome.
    expect(parseRoleChoice("  Teacher  ")).toBe("teacher");
    expect(parseRoleChoice("ADMIN")).toBe("admin");
    expect(parseRoleChoice("xyz")).toBeNull();
  });

  test("🚫 no digit literal survives in the parser's accepted sets", () => {
    // A source guard, because the regression would be a one-character re-add during a merge.
    const body = code(PARSER).slice(code(PARSER).indexOf("export function parseRoleChoice"));
    const accepted = body.slice(0, body.indexOf("return null;"));
    expect(accepted).not.toMatch(/"[0-9]"/);
  });
});

describe("TASK-251 — the bare number is gone from the COPY", () => {
  test("role_prompt contains no digits, TH and EN", () => {
    // 🔴 Asserted per language, not on a join: the EN string could be clean while the TH one — the string the
    // customer's parents actually read — still says "1 =". That is the failure that would ship.
    for (const lang of LANGS) expect(t("role_prompt", lang)).not.toMatch(ANY_DIGIT);
  });

  test("🔻 the three button labels are gone entirely — there is nothing left to keep digit-free", () => {
    // TASK-310: the keys are deleted with the picker. `t()` returns the KEY on a miss, so a surviving label
    // would show up here as its own Thai/English word rather than as the key name.
    for (const lang of LANGS) {
      for (const key of ["role_btn_customer", "role_btn_teacher", "role_btn_admin"] as const) {
        expect({ key, lang, rendered: t(key, lang) }).toEqual({ key, lang, rendered: key });
      }
    }
  });

  test("🔴 the prompt names ONE word, and it is not a role", () => {
    // 🔻 This test used to demand the opposite — *"the prompt still NAMES the typed words, in both languages"* —
    // because a PC user who loses the chips must be told what to type. **The instruction survives; the LIST
    // does not.** `REQ-085 §5` is satisfied by not ADVERTISING the roles, and `§17e` records the owner
    // accepting knowingly that a parent CAN still guess `ครู`. ⇒ the assertion flips from presence to ABSENCE.
    for (const lang of LANGS) {
      expect(t("role_prompt", lang)).toContain("Next");
      expect(t("role_prompt", lang)).not.toContain("ครู");
      expect(t("role_prompt", lang)).not.toContain("แอดมิน");
      expect(t("role_prompt", lang).toLowerCase()).not.toContain("teacher");
      expect(t("role_prompt", lang).toLowerCase()).not.toContain("admin");
    }
    // 🔑 …and the word it DOES name is one the parser accepts — the property this file has always guarded,
    // now pointed at the only word a parent is shown.
    expect(parseRoleChoice("Next")).toBe("customer");
  });
});

describe("🔻 TASK-310 — `rolePicker` is DELETED, and its siblings are not", () => {
  test("🔴 the builder is gone from the reply layer", () => {
    // ⚠️ Asserted as an absence AND as a gravestone: a deleted builder with no note is one somebody re-adds.
    expect(code(REPLY)).not.toContain("export function rolePicker(");
    expect(REPLY).toContain("`rolePicker` is DELETED, and the deletion is the point");
  });

  test("🚫 …and nothing sends role buttons any more", () => {
    const c = code(SVC);
    expect(c).not.toContain("rolePicker");
    expect(c).not.toContain("role_btn_");
    // The one builder that asks the question is now a plain text reply — one message, one path.
    expect(c).toContain('const askRole = (lang: Lang) => textReply(t("role_prompt", lang), lang);');
  });

  test("✅ `bookingPicker` and `childPicker` are UNTOUCHED — the deletion is about role lists, not pickers", () => {
    // 🔑 The difference is the whole argument: those two show a parent THEIR OWN bookings and THEIR OWN
    // children. This one showed every reader the roles the product has.
    expect(code(REPLY)).toContain("export function bookingPicker(");
    expect(code(REPLY)).toContain("export function childPicker(");
  });
});

describe("TASK-251 — a tap and a typed word reach ONE transition", () => {
  test("🔻 the postback branch OUTLIVES the picker, on purpose", () => {
    // ⚠️ A quick reply already sitting in a parent's chat when the deploy lands is still tappable. Nothing
    // EMITS `action=role` any more, so this branch is a deploy-window courtesy rather than a path — and the
    // reason is recorded next to it, because otherwise the next reader deletes it as dead code.
    const c = code(SVC);
    expect(c).toContain('if (action === "role")');
    expect(SVC).toContain("the picker that EMITTED this postback is GONE");
    // …and what it does with a payload it recognises is exactly what a typed word does.
    const tap = c.slice(c.indexOf('if (action === "role")'), c.indexOf('if (action === "enter")'));
    expect(tap).toContain('role === "customer" || role === "teacher" || role === "admin"');
    expect(tap).toContain("acceptRole(lineUserId, role, replyToken, lang)");
    expect(tap).toContain("send(replyToken, [askRole(lang)])");
    // The payload shape is still ours, and still parsed by our own parser.
    expect(parsePostback("action=role&role=teacher")).toEqual({
      action: "role",
      params: { action: "role", role: "teacher" },
    });
  });

  test("🔴 both doors call acceptRole — the transition exists exactly once", () => {
    const c = code(SVC);
    // One definition, and it is the only place the role step advances.
    expect(c.match(/acceptRole\(/g)!.length).toBe(3); // the declaration + the typed word + the tap
    expect(c.match(/setStep\(lineUserId, "AWAIT_CODE", role\)/g)!.length).toBe(1);
    // The typed-word branch.
    const typed = c.slice(c.indexOf('if (session.step === "CHOOSE_ROLE")'));
    expect(typed.slice(0, typed.indexOf("\n  }"))).toContain("acceptRole(lineUserId, role, replyToken, lang)");
    // The tap branch.
    const tap = c.slice(c.indexOf('if (action === "role")'), c.indexOf('if (action === "enter")'));
    expect(tap).toContain("acceptRole(lineUserId, role, replyToken, lang)");
  });

  test("acceptRole resets the strike count and sets the role-specific prompt", () => {
    const c = code(SVC);
    const body = c.slice(c.indexOf("async function acceptRole("), c.indexOf("const FLOW_CLEARED"));
    expect(body).toContain("resetStrikes(lineUserId)"); // AC-19 — a valid answer clears the count
    expect(body).toContain('setStep(lineUserId, "AWAIT_CODE", role)');
    // TASK-275 (REQ-079 §18): the BODY is bilingual (`tb`/`both`); the property this line guards is unchanged.
    // 🔑 TASK-310 — and this ONE expression now renders a §17c screen for a parent (`code_customer`) and one of
    // OURS for a teacher, correctly, because `both()` refuses to double a body that is already both languages.
    expect(body).toContain("tb(`code_${role}`)");
    expect(t("code_customer", "TH")).toBe(t("code_customer", "EN"));
    expect(t("code_teacher", "TH")).not.toBe(t("code_teacher", "EN"));
  });

  test("the same builder answers the สมัคร door and the strike re-ask", () => {
    // ⚠️ The re-ask still matters: a parent who mistyped must meet the SAME question, not a variant of it.
    const c = code(SVC);
    expect(c.match(/askRole\(lang\)/g)!.length).toBe(3); // the สมัคร door · the strike re-ask · the bad payload
    expect(c).toContain('t("role_prompt", lang), lang, askRole(lang))');
  });
});
