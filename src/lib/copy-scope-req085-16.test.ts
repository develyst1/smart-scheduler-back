// TASK-323 (`REQ-085 §16.2` + `§16g`) — two copy items, each with a boundary the copy does not state.
//
// 🔑 Both are one string. Neither is a string edit: `§16.2` names TWO screens and `withExit` has TWELVE call
// sites; `§16g` names two headers and one of them has no specified twin. **Every copy item in this batch turned
// out to be a decision about SCOPE wearing a string's clothing.**
//
// 🔴 The assertion that matters most here is a BEHAVIOUR one and it is not about copy at all: **`ยกเลิก` still
// works on both screens.** *"Remove the hint" is one edit from "remove the exit", and only one of those was
// asked for.*
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./line-i18n";
import { isCancelWord, CMD_CANCEL } from "./line-commands";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));
const WIZARD = SVC.slice(SVC.indexOf("async function handleAddStudentStep("), SVC.indexOf("\n}\n", SVC.indexOf("async function handleAddStudentStep(")));

describe("🔴 TASK-323 §1 — the hint comes off TWO screens, and only two", () => {
  test("🔑 the birthdate and province PROMPTS render without it", () => {
    expect(SVC).toContain('return reply(replyToken, t("add_birthdate_prompt", lang));');
    expect(SVC).toContain('return reply(replyToken, t("add_province_prompt", lang));');
    expect(SVC).not.toContain('withExit(t("add_birthdate_prompt", lang), lang)');
    expect(SVC).not.toContain('withExit(t("add_province_prompt", lang), lang)');
  });

  test("🚫 the other NINE sites still carry it — *not product-wide* is PINNED, not trusted", () => {
    // ⚠️ Counted, because "we only changed two" is exactly the claim a count can hold and prose cannot.
    // ⚠️ ELEVEN call sites, not the twelve the task counted: the twelfth is the DECLARATION, which reads
    // `const withExit = (question…` and does not match `withExit(`. Two came off ⇒ **nine remain**.
    expect(SVC.match(/withExit\(/g)!.length).toBe(9);
    for (const kept of [
      'withExit(t("add_student_name_prompt", lang), lang)', // five sites — the name prompt and its re-asks
      'withExit(t("add_dup_detail", lang), lang)', // the duplicate-detail ask
      'withExit(t("add_summary_confirm", lang), lang)', // the summary and its re-ask
      'withExit(t("add_birthdate_bad", lang), lang)', // §2's decision — below
    ]) {
      expect({ kept, present: SVC.includes(kept) }).toEqual({ kept, present: true });
    }
    // 🚫 And `withExit` itself is untouched (TASK-245): one string, one append site.
    expect(SVC).toContain('const withExit = (question: string, lang: Lang) => `${question}${t("add_exit_hint", lang)}`;');
    expect(t("add_exit_hint", "TH")).toBe(" · หรือพิมพ์ ยกเลิก เพื่อออก");
  });

  test("🚫 their SENTENCES are untouched — `§16.2` removes the HINT, not their text", () => {
    // The `§17c` pins on both screens are unchanged and live in `registration-copy-req079.test.ts`; what moved
    // is the CALL SITE, not the string. ⚠️ Including the spacing inside `(วัน-เดือน-ปีค.ศ. )`.
    expect(t("add_birthdate_prompt", "TH")).toBe(
      "กรุณาระบุวันเกิดของนักเรียนค่ะ\n(วัน-เดือน-ปีค.ศ. )\nPlease enter the date of birth in (DD-MM-YYYY)",
    );
    expect(t("add_province_prompt", "TH")).toContain("กรุณาระบุ เขต แขวง จังหวัด");
    for (const key of ["add_birthdate_prompt", "add_province_prompt"]) {
      expect(t(key, "TH")).not.toContain("ยกเลิก");
      expect(t(key, "TH").toLowerCase()).not.toContain("cancel");
    }
  });
});

describe("🔴 TASK-323 §3 — THE assertion: `ยกเลิก` STILL WORKS on both screens", () => {
  test("🔑 the exit is checked at the TOP of the wizard, before any step reads the text as an answer", () => {
    // 📌 TASK-245 put it there so a step added later cannot forget it — which is exactly why removing the
    // ADVERTISEMENT cannot remove the EXIT. Asserted by ORDER: the cancel check precedes every step branch.
    expect(WIZARD).toContain("if (isCancelWord(text)) {");
    expect(WIZARD.indexOf("isCancelWord(text)")).toBeLessThan(WIZARD.indexOf('session.step === "AWAIT_STUDENT_BIRTHDATE"'));
    expect(WIZARD.indexOf("isCancelWord(text)")).toBeLessThan(WIZARD.indexOf('session.step === "AWAIT_STUDENT_PROVINCE"'));
    // …and cancelling still clears the draft and says so, on any step.
    const exit = WIZARD.slice(WIZARD.indexOf("if (isCancelWord(text)) {"));
    expect(exit.slice(0, exit.indexOf("\n  }"))).toContain("await clearSession(lineUserId);");
    expect(exit.slice(0, exit.indexOf("\n  }"))).toContain('t("add_cancelled", l)');
  });

  test("🔑 the WORDS still resolve — the vocabulary is untouched", () => {
    for (const w of ["ยกเลิก", "cancel", "Cancel", "CANCEL", "  cancel  "]) {
      expect({ w, ok: isCancelWord(w) }).toEqual({ w, ok: true });
    }
    expect([...CMD_CANCEL]).toEqual(["ยกเลิก", "cancel"]);
  });
});

describe("🔑 TASK-323 §2 — the bad-birthdate RE-ASK keeps the hint. DECIDED, and here is the evidence", () => {
  test("🔴 the re-ask still carries it — the one screen where a parent is demonstrably stuck", () => {
    expect(SVC).toContain('withExit(t("add_birthdate_bad", lang), lang)');
  });

  test("📌 …and the reason is three lines above it in the source, not an opinion of mine", () => {
    // 🔴 **The bad-birthdate re-ask is the exact screen TASK-245 exists because of**: the owner typed `เมนู` to
    // escape, was told the date format was wrong, and could not leave. ⇒ taking the exit hint off it would
    // re-open, in COPY, the defect that task closed in BEHAVIOUR — the day after closing it.
    // 📌 The customer's complaint is clutter on a screen read for the FIRST time; a parent who has just been
    // refused is not on that screen any more. **Two readings were available and this is why I took this one.**
    const raw = src("src/services/line-webhook.service.ts");
    expect(raw).toContain("THIS is the branch where rule 5 failed the");
    expect(raw).toContain("the bad-birthdate re-ask is the exact screen TASK-245 exists because of");
  });

  test("🚫 …and it is still a STRIKE, so two failures still reach a person", () => {
    // The hint is the first way out; the handover is the second. Neither was asked for and neither moved.
    const branch = WIZARD.slice(WIZARD.indexOf('session.step === "AWAIT_STUDENT_BIRTHDATE"'));
    expect(branch.slice(0, branch.indexOf("await resetStrikes"))).toContain("strikeOrPrompt(");
  });
});

describe("✅ TASK-323 §4 — the two COMMAND headers, and the reuse question answered", () => {
  test("the daily header is the customer's own form", () => {
    for (const lang of ["TH", "EN"] as const) expect(t("tsched_title_today", lang)).toBe("⏱️TODAY'S SCHEDULE:");
  });

  test("🔑 …and it is pinned EQUAL to the AUTO header, which is the answer to reuse-or-new-key", () => {
    // ❓ Reuse would make a future edit to their AUTO header move the COMMAND one SILENTLY. A second copy
    // would let the two drift SILENTLY. ⇒ **separate keys, and the coincidence asserted**: the day either
    // moves, this fails and a human decides. 📌 Neither failure mode can happen quietly.
    expect(t("tsched_title_today", "TH")).toBe(t("ob_today_title", "TH"));
    expect(t("tsched_title_today", "EN")).toBe(t("ob_today_title", "EN"));
    // 🚫 They are still two keys — this is not a rename to one.
    const I18N = src("src/lib/line-i18n.ts");
    expect(I18N).toContain("tsched_title_today:");
    expect(I18N).toContain("ob_today_title:");
  });

  test("📖 the WEEKLY header is a PLACEHOLDER — its FORM is pinned, its WORDS are not", () => {
    // ⚠️ Nothing in the customer's four messages specifies a weekly schedule, so this string is @Porter's and
    // they have not seen it. **The convention adopted this week: the criterion is the deliverable; the string
    // is provisional until they ratify it.** ⇒ what is asserted is the SHAPE it must keep — the same shape as
    // its daily twin, which is the only property that was actually decided.
    const week = t("tsched_title_week", "TH");
    expect(week.startsWith("⏱️")).toBe(true);
    expect(week.endsWith(":")).toBe(true);
    expect(week).toBe(week.toUpperCase());
    expect(t("tsched_title_week", "TH")).toBe(t("tsched_title_week", "EN"));
    // 🚫 …and it is not the daily one — two ranges, two headers.
    expect(week).not.toBe(t("tsched_title_today", "TH"));
    // 📌 The placeholder is DECLARED in the table, the way `PENDING_RESCHEDULE` is.
    expect(src("src/lib/line-i18n.ts")).toContain("PLACEHOLDER — @PORTER'S, and the customer has NOT seen it");
  });

  test("🚫 HEADERS ONLY — the compact COMMAND body is byte-identical", () => {
    // 📌 `§16f`'s "unify the shapes" reading was WITHDRAWN; this task must not become one.
    const SCHED = code(src("src/lib/line-schedule.ts"));
    expect(SCHED).toContain('const title = t(range === "week" ? "tsched_title_week" : "tsched_title_today", lang);');
    // The row and day-heading builders are untouched, so the body cannot have moved with the header.
    expect(SCHED).toContain("export function dayHeading(isoDate: string, lang: Lang): string {");
    expect(SCHED).toContain("return `${DAY_NAMES[lang][d.getDay()]} ${day}/${month}`;");
    expect(t("tsched_empty", "TH")).toBe("ไม่มีคาบสอนในช่วงนี้");
  });
});
