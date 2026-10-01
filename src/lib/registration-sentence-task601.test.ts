// TASK-601 (COPY §19, approved by the owner as drafted) — the phone step must not claim a completion that has not happened.
//
// 🔴 Since TASK-590 a NEW family is created only when its FIRST CHILD is confirmed, in ONE transaction. At the phone step nothing is
// written. The two keys used to carry the same claim — *"Registration completed ✅"* — and Tanya read it as "the chat links the parent
// at the PHONE step" (TASK-594 §1: the behaviour was right, the words were not).
//   · `verify_parent_ok_new`      — a phone we do NOT know ⇒ COPY §19's sentence: we have the number, and the registration COMPLETES
//                                   when the first student is added. 🚫 It must never claim to be done.
//   · `verify_parent_ok_existing` — a phone we DO know ⇒ the customer's own sentence, unchanged: that account IS linked at that moment.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REGISTRATION_COPY, t } from "./line-i18n";

const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const W = code(read("src/services/line-webhook.service.ts"));
const region = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from) + from.length));
/** The words that assert a FINISHED state. 🔑 A conditional ("…จะเสร็จสมบูรณ์เมื่อ…", "…is complete once you…") is not one of them: it
 *  names what is still missing, which is the opposite claim. */
const CLAIMS_DONE = /สำเร็จ|เรียบร้อยค่ะ|completed|All set/i;

describe("🔴 TASK-601 — the two sentences are DIFFERENT, and only one of them may claim a completion", () => {
  test("🔑 DIFFERENT — the one thing a future edit could undo without anyone noticing", () => {
    for (const lang of ["TH", "EN"] as const) expect(t("verify_parent_ok_new", lang)).not.toBe(t("verify_parent_ok_existing", lang));
    // …and not merely different: the NEW one must not carry the old claim in either language
    for (const lang of ["TH", "EN"] as const) expect(t("verify_parent_ok_new", lang)).not.toContain("Registration completed");
  });
  test("🚫 by SHAPE — the NEW-phone sentence never claims the registration is done, and it NAMES what completes it", () => {
    for (const lang of ["TH", "EN"] as const) {
      const s = t("verify_parent_ok_new", lang);
      expect({ lang, claimsDone: CLAIMS_DONE.test(s) }).toEqual({ lang, claimsDone: false });
      // 🔑 shape, not wording: it must say the number is received AND name the first student as the condition. A sentence that only
      // dropped the claim would leave a parent wondering whether anything happened at all.
      expect({ lang, phone: s.includes("{phone}"), condition: /นักเรียนคนแรก/.test(s) && /first student/i.test(s) }).toEqual({ lang, phone: true, condition: true });
    }
    // it is a §17c screen, so it carries BOTH languages in the one string (TASK-594 §2's rule)
    expect(Object.keys(REGISTRATION_COPY)).toContain("verify_parent_ok_new");
    expect(/[ก-๙]/.test(t("verify_parent_ok_new", "EN")) && /[A-Za-z]/.test(t("verify_parent_ok_new", "EN"))).toBe(true);
  });
  test("✅ by VALUE — the EXISTING-phone sentence is the customer's own, unchanged (there the account IS linked)", () => {
    expect(t("verify_parent_ok_existing", "TH")).toBe("ผูกบัญชีผู้ปกครองสำเร็จ ✅ (เบอร์ {phone}){list}");
    expect(t("verify_parent_ok_existing", "EN")).toBe("Registration completed ✅ (phone {phone}){list}");
  });
  test("each sentence reaches its own case: `new` ⇒ the pending-phone branch (nothing written), `found` ⇒ the linked branch", () => {
    const V = region(W, "async function verifyAndLink(", "\n}\n");
    expect(V).toContain('if (r.outcome === "new") return { ok: true, pendingPhone: r.phone, message: (l) => t("verify_parent_ok_new", l, { phone: formatPhoneForDisplay(phone) }) };');
    expect(V).toContain('t("verify_parent_ok_existing"');
    // 🚫 and the new-phone sentence is used NOWHERE else — a second caller could show it after a real write
    expect((W.match(/verify_parent_ok_new/g) ?? []).length).toBe(1);
  });
});

describe("🔑 TASK-601 — DERIVED: nothing else in the registration flow claims completion before the first child is accepted", () => {
  /** Every key the chat can render from the phone step through the wizard, taken from the source rather than a kept list. */
  const flowKeys = () => {
    const parts = ["async function verifyAndLink(", "async function handleAddStudentStep(", "async function showStudentSummary(", "async function askMoreDetail(", "async function afterParentLink("].map((s) => region(W, s, "\n}\n"));
    parts.push(region(W, 'if (session.step === "AWAIT_CODE" && session.pendingRole) {', "\n  }\n"));
    parts.push(region(W, 'if (SKIP_WORDS.includes(lower) && session?.step === "AWAIT_STUDENT_NAME")', "return handleAddStudentStep("));
    return [...new Set(parts.flatMap((p) => [...p.matchAll(/\bt\("(\w+)"/g)].map((m) => m[1]!)))].sort();
  };
  test("the flow's strings are swept, and EVERY completion claim in them is one of the three justified cases", () => {
    const keys = flowKeys();
    expect(keys.length).toBeGreaterThan(20); // the sweep is not vacuous
    const claims = keys.filter((k) => CLAIMS_DONE.test(t(k, "TH")) || CLAIMS_DONE.test(t(k, "EN")));
    expect(claims).toEqual([
      // ✅ the child HAS been created by the time this renders — the claim is true (pinned against the writer below)
      "added_done",
      // ✅ reachable ONLY for a parent who already HAS a child: TASK-307 refuses the skip while there are none (guard pinned below)
      "skip_done",
      // ✅ an ADMIN link really is finished at that moment — it binds no family and waits for no child
      "verify_admin_ok",
      // ✅ a phone we already know: that account IS linked at that moment (the customer's own sentence, value-pinned above)
      "verify_parent_ok_existing",
    ]);
    // 🔑 `skip_done` ("เรียบร้อยค่ะ ✅ / All set ✅") is the one that would be a lie before the first child, and it cannot be reached
    // there: the no-children branch re-asks for the name instead.
    const guard = region(W, 'if (SKIP_WORDS.includes(lower) && session?.step === "AWAIT_STUDENT_NAME")', "return handleAddStudentStep(");
    expect(guard.indexOf("if (!kids.length) {")).toBeLessThan(guard.indexOf('t("skip_done"'));
    expect(guard).toContain('withExit(t("add_student_name_prompt", lang), lang)'); // …the re-ask, not a completion
  });
  test("🔑 and the claim that IS allowed arrives only after the write: `added_done` sits after the creator in the confirm branch", () => {
    const confirm = region(W, 'if (session.step === "AWAIT_STUDENT_CONFIRM") {', "\n  }\n");
    for (const writer of ["registerFamilyWithFirstChild(", "createStudentFromLine(parent!, {"]) {
      expect(confirm.indexOf(writer)).toBeGreaterThan(-1);
      expect(confirm.indexOf(writer)).toBeLessThan(confirm.indexOf('t("added_done", lang'));
    }
  });
});
