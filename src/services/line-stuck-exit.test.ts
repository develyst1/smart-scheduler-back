// SPEC-071 / TASK-245 (REQ-079) — a parent is never stuck.
//
// 🔴 What this is about, because the shape of the defect is the shape of the tests:
//
//   23:45  เมนู → "วันเกิดของน้อง …"          ← the word the bot advertises became the child's NAME
//   23:48  เมนู → "รูปแบบวันเกิดไม่ถูกต้องค่ะ"  ← the ESCAPE attempt was rejected as a bad date
//   23:48  ข้าม → …                            ← he finished the flow BECAUSE HE COULD NOT LEAVE IT
//
// The owner walked into that on his own phone. It wrote a student row into a roster that **has no delete for
// anything with history**. So the assertions below are not about `เมนู`; they are about the three properties
// that make the trap impossible: an exit at every step, one vocabulary, and a strike counter that actually
// counts. Fix only the word and every other accidental entry stays trapped.
//
// ⚠️ The end-to-end run of the owner's exact three messages needs session ROWS — that half is Tanya's. What is
// pinned here is everything provable without a database: the vocabulary, the wiring, and the invariant.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import {
  CMD_ADMIN,
  CMD_CALENDAR,
  CMD_CANCEL,
  CMD_CHECKIN,
  CMD_CHILDREN,
  CMD_COURSES,
  CMD_LEAVE,
  CMD_MENU,
  CMD_QR,
  CMD_REGISTER,
  CMD_REOPEN,
  CMD_SCHEDULE,
  CMD_SKIP,
  RESERVED_WORDS,
  isCancelWord,
  isReservedWord,
} from "../lib/line-commands";
import { HANDOVER_AT, shouldHandOver } from "../lib/line-routing";
import { KNOWN_RICH_MENU, UNKNOWN_RICH_MENU } from "../lib/line-rich-menu";
import { t } from "../lib/line-i18n";

const SVC = readSrc(await Bun.file(new URL("./line-webhook.service.ts", import.meta.url)).text());
const I18N = readSrc(await Bun.file(new URL("../lib/line-i18n.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const CODE = code(SVC);
const fn = (decl: string) => {
  const rest = CODE.slice(CODE.indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const WIZARD = fn("async function handleAddStudentStep");

describe("🔴 1 — there is a way OUT, from every step", () => {
  test("the exit is checked before ANY step reads the text as an answer", () => {
    // At the top of the handler, not per step: a step added next month cannot forget to offer it. That is the
    // whole difference between "the flow has an exit" and "these four steps happen to have one".
    expect(WIZARD).toContain("if (isCancelWord(text))");
    for (const step of ["AWAIT_STUDENT_NAME", "AWAIT_STUDENT_BIRTHDATE", "AWAIT_STUDENT_PROVINCE", "AWAIT_STUDENT_CONFIRM"]) {
      expect(WIZARD.indexOf("isCancelWord(text)")).toBeLessThan(WIZARD.indexOf(step));
    }
  });

  test("🔑 cancelling DELETES the draft — and the draft cannot outlive the delete", () => {
    // `clearSession` removes the session ROW, and the draft is a column on that row. So "cancelled" and "the
    // half-typed record is gone" are one act, not two that could disagree. A stranded half-record in a roster
    // with no delete is precisely what the owner's flow produced.
    const exit = WIZARD.slice(WIZARD.indexOf("isCancelWord(text)"), WIZARD.indexOf("AWAIT_STUDENT_NAME"));
    expect(exit).toContain("clearSession(lineUserId)");
    expect(exit).toContain('t("add_cancelled", lang)');
    expect(exit).not.toContain("createStudentForParent");
  });

  test("…and it SAYS it is gone, in both languages", () => {
    // "Cancelled" alone leaves the one question a parent must not be left holding: was half of it saved anyway?
    expect(t("add_cancelled", "TH")).toContain("ลบทิ้ง");
    expect(t("add_cancelled", "TH")).toContain("ยังไม่ได้บันทึก");
    expect(t("add_cancelled", "EN")).toContain("discarded");
    expect(t("add_cancelled", "EN")).toContain("nothing was saved");
  });

  test("🔴 EVERY question the wizard asks advertises the exit — asserted as a net, not four cases", () => {
    // A question that does not say so is a step the parent has no reason to believe they can leave, which is
    // exactly how someone finishes a registration they did not want.
    const QUESTIONS = [
      "add_student_name_prompt",
      "add_dup_detail",
      "add_birthdate_prompt",
      "add_birthdate_bad",
      "add_province_prompt",
      "add_summary_confirm",
    ];
    for (const key of QUESTIONS) {
      const uses = [...CODE.matchAll(new RegExp('t\\("' + key + '"', "g"))];
      expect(uses.length).toBeGreaterThan(0);
      for (const m of uses) {
        // `withExit(` sits immediately before the `t(` it wraps — one append site for the whole flow.
        expect(CODE.slice(m.index! - 9, m.index!)).toBe("withExit(");
      }
    }
  });

  test("the exit wording is @Porter's, once, in both languages", () => {
    expect(t("add_exit_hint", "TH")).toContain("ยกเลิก");
    expect(t("add_exit_hint", "TH")).toContain("เพื่อออก");
    expect(t("add_exit_hint", "EN")).toContain("cancel");
    // One definition: the sentence is NOT baked into the six question strings as well.
    expect(I18N.match(/หรือพิมพ์ ยกเลิก เพื่อออก/g)).toHaveLength(1);
  });

  test("`ยกเลิก` means exit, and only the whole word does", () => {
    expect(isCancelWord("ยกเลิก")).toBe(true);
    expect(isCancelWord("  Cancel  ")).toBe(true);
    // …but a child whose name merely contains it is not an exit — the check is equality, not a substring.
    expect(isCancelWord("ยกเลิกจอง")).toBe(false);
    expect(isCancelWord("น้องพีพี")).toBe(false);
  });
});

describe("🔴 2 — a word the bot advertises means the same thing everywhere", () => {
  test("🔑 ONE list: every word the router matches is reserved, by construction", () => {
    // The property, not a spot-check. A command added to `line-commands.ts` tomorrow is reserved the moment it
    // is added — which is the only version of this rule that stays true. A second copy is how "the bot said it
    // is a command" and "the bot stored it as a name" both became true at once.
    const every = [
      ...CMD_REGISTER, ...CMD_MENU, ...CMD_COURSES, ...CMD_ADMIN, ...CMD_CHILDREN, ...CMD_QR,
      ...CMD_CHECKIN, ...CMD_LEAVE, ...CMD_SCHEDULE, ...CMD_CALENDAR, ...CMD_CANCEL,
      ...CMD_REOPEN, // TASK-246 — and it was reserved the day it was written, which is the property
      ...CMD_SKIP,
    ];
    for (const word of every) expect(RESERVED_WORDS).toContain(word);
    expect(new Set(RESERVED_WORDS).size).toBe(new Set(every).size);
  });

  test("the four words the bot puts in front of a parent are all reserved", () => {
    // เมนู · ช่วยเหลือ · ยกเลิก · ข้าม — the ones printed in the command list and the prompts.
    for (const word of ["เมนู", "ช่วยเหลือ", "ยกเลิก", "ข้าม"]) expect(isReservedWord(word)).toBe(true);
    expect(isReservedWord("MENU")).toBe(true); // case-folded, like the router compares
    expect(isReservedWord(" เมนู ")).toBe(true);
  });

  test("🚫 a real name is NOT reserved — the rule must not eat the roster it protects", () => {
    for (const name of ["น้องพีพี", "สมชาย", "Emma", "ลาดา", "เมนูดา"]) expect(isReservedWord(name)).toBe(false);
  });

  test("the name step REFUSES it instead of storing it, and names the way round", () => {
    const nameStep = WIZARD.slice(WIZARD.indexOf("AWAIT_STUDENT_NAME"), WIZARD.indexOf("AWAIT_STUDENT_BIRTHDATE"));
    expect(nameStep).toContain("isReservedWord(name)");
    expect(nameStep).toContain('t("add_name_reserved", lang, { word: name })');
    // Refused BEFORE anything is written to the draft — the refusal is not a rollback.
    expect(nameStep.indexOf("isReservedWord(name)")).toBeLessThan(nameStep.indexOf("setDraft"));
  });

  test("🔑 the refusal names the cost and the escape — the rare child really called `เมนู`", () => {
    // Refusing without a next step is a door that just does not open. Staff can create a student on the People
    // screen, so the way through exists and is one sentence away.
    const th = t("add_name_reserved", "TH", { word: "เมนู" });
    expect(th).toContain("เมนู");
    expect(th).toContain("คำสั่งของระบบ");
    expect(th).toContain("แอดมิน");
    expect(t("add_name_reserved", "EN", { word: "menu" })).toContain("admin");
    // The word is quoted back, not a generic "that name is not allowed".
    expect(t("add_name_reserved", "TH", { word: "ช่วยเหลือ" })).toContain("ช่วยเหลือ");
  });
});

describe("🔴 3 — the invariant: no rejection bypasses the strike counter", () => {
  /**
   * The net, and the reason it is a net: rule 5 (two strikes → a human) was ALREADY shipped when the owner got
   * stuck, and it did not fire, because the birthdate step re-asked directly. Four individual cases would have
   * passed the day before. So this derives the refusals from the copy table itself — a key named `_bad` or
   * `_reserved` IS a refusal — and checks every use of every one of them.
   */
  const REFUSAL_KEYS = [...I18N.matchAll(/^ {2}([a-z0-9_]*_(?:bad|badphone|reserved))\s*:/gm)].map((m) => m[1]!);

  test("the refusal keys are discovered, not listed — a new one is covered on the day it is written", () => {
    expect(REFUSAL_KEYS).toContain("add_birthdate_bad");
    expect(REFUSAL_KEYS).toContain("add_name_reserved");
    expect(REFUSAL_KEYS).toContain("twofa_bad");
    expect(REFUSAL_KEYS).toContain("verify_admin_bad");
    expect(REFUSAL_KEYS).toContain("verify_parent_badphone");
  });

  test("🔴 every refusal reaches `strikeOrPrompt` — directly, or as the message of a failed verify", () => {
    for (const key of REFUSAL_KEYS) {
      const uses = [...CODE.matchAll(new RegExp('t\\("' + key + '"', "g"))];
      expect(uses.length).toBeGreaterThan(0);
      for (const m of uses) {
        const stmt = CODE.slice(Math.max(0, m.index! - 220), m.index!);
        const direct = stmt.lastIndexOf("strikeOrPrompt(");
        // The verifier hands its refusal back as a value; its ONE consumer strikes on it (asserted below).
        const carried = stmt.lastIndexOf("{ ok: false, message:");
        const bare = stmt.lastIndexOf("reply(replyToken");
        expect(Math.max(direct, carried)).toBeGreaterThan(bare);
      }
    }
  });

  test("…and the verifier's refusal has exactly ONE consumer, which strikes", () => {
    // Otherwise "it goes through `verifyAndLink`" would be a claim about a value nobody follows.
    expect(CODE.match(/if \(!res\.ok\) return strikeOrPrompt\(/g)).toHaveLength(1);
    expect(CODE).not.toMatch(/if \(!res\.ok\) return reply\(/);
  });

  test("🔴 the birthdate step — the exact branch that failed the owner — now counts", () => {
    const birth = WIZARD.slice(WIZARD.indexOf("AWAIT_STUDENT_BIRTHDATE"), WIZARD.indexOf("AWAIT_STUDENT_PROVINCE"));
    expect(birth).toContain("if (!parsed.ok) return strikeOrPrompt(");
    expect(birth).not.toMatch(/if \(!parsed\.ok\) return reply\(/);
  });

  test("two rejections in a row fetch a human — the escape he was reaching for", () => {
    expect(HANDOVER_AT).toBe(2);
    expect(shouldHandOver(1)).toBe(false); // the first is still someone trying
    expect(shouldHandOver(2)).toBe(true);
    // …and the handover apologises and names a person, rather than re-asking a third time.
    expect(t("handover_to_admin", "TH")).toContain("แอดมิน");
  });

  test("⚠️ a valid answer CLEARS the count — one fumble must not follow a parent through the flow", () => {
    // Without this, a mistyped date at step 2 plus a mistyped anything at step 4 hands over a parent who has
    // been answering correctly for two turns.
    const accepted = ["AWAIT_STUDENT_BIRTHDATE", "AWAIT_STUDENT_PROVINCE"];
    for (const step of accepted) {
      const branch = WIZARD.slice(WIZARD.indexOf(step));
      expect(branch.slice(0, branch.indexOf("setDraft"))).toContain("resetStrikes(lineUserId)");
    }
    // The name step too — it is the one that can now be rejected.
    const nameStep = WIZARD.slice(WIZARD.indexOf("AWAIT_STUDENT_NAME"), WIZARD.indexOf("AWAIT_STUDENT_BIRTHDATE"));
    expect(nameStep).toContain("resetStrikes(lineUserId)");
  });

  test("🚫 a duplicate name is NOT a strike — the parent answered correctly", () => {
    // Counting it would hand a two-child family over to a human for having two children. AC-9's more-detail
    // question is a further question, not a rejection.
    // Bounded at `resetStrikes` — the duplicate branch ends where the accepted-name path begins.
    const dup = WIZARD.slice(WIZARD.indexOf("decideDuplicate"), WIZARD.indexOf("await resetStrikes"));
    expect(dup).toContain('t("add_dup_detail", lang)');
    expect(dup).not.toContain("strikeOrPrompt");
  });
});

describe("✅ Face 2 — the bot is silent, but a PERSON is reachable", () => {
  test("the command list ends with the line that says someone will answer", () => {
    // AC-16 made the bot silent by default and nothing told the person in front of it that a human still reads
    // the chat. The list is the right home: whoever is reading it is, by definition, the one who is lost.
    expect(t("menu_body", "TH")).toContain("หรือพิมพ์คำถามเข้ามาได้เลยค่ะ เดี๋ยวแอดมินมาตอบนะคะ 🙏");
    expect(t("menu_body", "EN")).toContain("admin will read it and reply");
  });

  test("🔑 both `เมนู` AND `ช่วยเหลือ` render it — one string, one branch", () => {
    // They are the same command word list, so there is no second copy of the menu that could miss the line.
    expect([...CMD_MENU]).toContain("เมนู");
    expect([...CMD_MENU]).toContain("ช่วยเหลือ");
    expect([...CMD_MENU]).toContain("help");
    // TASK-246 joined `เปิดเมนู` to the same branch — one list, one `doMenu`, so the word the mute message
    // advertises cannot become an unknown word an hour later.
    expect(CODE).toContain("if (inList(CMD_MENU, cmd) || inList(CMD_REOPEN, cmd)) return doMenu(replyToken, lang)");
    expect(fn("function doMenu")).toContain('t("menu_body", lang)');
  });

  test("🚫 SCOPE — TASK-245 added no rich-menu cell; this needed no new image", () => {
    // @Porter's line for TASK-245, and it was firm: a cell means an image the owner has not asked for, so Face 2
    // went into the command list instead.
    // 📌 The known menu is SIX cells as of TASK-247 — the task that was given the artwork and asked for it. The
    // point of this guard is unchanged: the menus change only in the task that owns them, never as a side effect.
    expect(UNKNOWN_RICH_MENU.areas).toHaveLength(2);
    expect(KNOWN_RICH_MENU.areas).toHaveLength(6);
  });
});
