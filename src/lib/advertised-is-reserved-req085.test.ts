// TASK-313 — what the product ADVERTISES is reserved, and the inline add never checked.
//
// 🔴 §2 is the reason this is not a copy change: `add เมนู` created a child named `เมนู` — TASK-245's ORIGINAL
// defect (*"`เมนู` stored as a child's NAME, in a roster with no delete, by a bot that had just told him `เมนู`
// was a command"*) still live on the other door, the whole time. The guard existed; one of two doors never
// called it.
//
// 🔑 @Porter's principle — *no word the product PRINTS in a menu or a prompt may become a child's name* — is
// asserted in the three parts @Sober scored it into, and the third is LABELLED as the hand-kept limit it is:
//   (1) STRUCTURAL — `isReservedWord` on BOTH doors (this file, first describe);
//   (2) MECHANICAL — the MENU is parsed from its own string, both languages, and every token it advertises must
//       be reserved — so advertising a word without reserving it FAILS here (second describe);
//   (3) 🔴 HAND-KEPT — the customer's eight registration screens are PROSE (*"please type "Add Student"."*).
//       No parser finds that reliably and none is built here. ⚠️ What IS guarded: `§17c`'s screens are pinned
//       byte-for-byte (TASK-310), so their words cannot change silently. What is NOT guarded: a NEW instruction
//       added to a prose screen later, without its word being reserved. **That is the limit @Porter asked to be
//       told rather than discover, and this comment is where it is told.**
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./line-i18n";
import { isReservedWord, RESERVED_WORDS } from "./line-commands";
import { parseAddCommand } from "./line-add-student";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));
/** The inline add door, from its parse to the next router branch. */
const INLINE = SVC.slice(SVC.indexOf("const addMatch = parseAddCommand(raw);"), SVC.indexOf("if (inList(CMD_COURSES, cmd))"));
/** The name-prompt door — TASK-245's original guard. */
const PROMPT = SVC.slice(SVC.indexOf('if (session.step === "AWAIT_STUDENT_NAME" || session.step === "AWAIT_STUDENT_DETAIL")'), SVC.indexOf("await assertCanAddStudent(parent.id);"));

describe("🔴 TASK-313 §2 — `add เมนู` REFUSES and creates nothing (STRUCTURAL)", () => {
  test("🔴 the word is reserved, and the inline door asks before it writes", () => {
    expect(isReservedWord("เมนู")).toBe(true);
    expect(parseAddCommand("add เมนู")).toEqual({ name: "เมนู" }); // the parser hands the word over…
    // …and the write is fenced behind the guard: the refusal comes BEFORE `addStudentAndReply` in the block,
    // and it is the SAME guard and the SAME refusal the prompt uses — not a second check.
    expect(INLINE).toContain("if (name && isReservedWord(name)) {");
    expect(INLINE.indexOf("isReservedWord(name)")).toBeLessThan(INLINE.indexOf("addStudentAndReply("));
    expect(INLINE).toContain('strikeOrPrompt(lineUserId, session, replyToken, t("add_name_reserved", lang, { word: name }), lang)');
    expect(INLINE.match(/addStudentAndReply\(/g)!.length).toBe(1);
  });

  test("🔑 both doors — the same guard, the same refusal string, the same strike rule", () => {
    for (const door of [PROMPT, INLINE]) {
      expect(door).toContain("isReservedWord(name)");
      expect(door).toContain('t("add_name_reserved", lang, { word: name })');
      expect(door).toContain("strikeOrPrompt(");
    }
    // The guard is one definition — `isReservedWord` from `line-commands.ts` — imported, not re-implemented.
    expect(SVC).toContain("isReservedWord,");
    expect(SVC).not.toMatch(/RESERVED_WORDS\.includes/);
  });

  test("📌 the refusal lands the parent IN the name prompt, so the second strike can hand over", () => {
    // `strikeOrPrompt` counts on a session row. A linked parent typing an inline command may have none, so the
    // refusal first puts them where bare `add` would have — the name prompt — and counts from there. Asserted
    // by ORDER: the step is set before the strike is taken.
    expect(INLINE.indexOf('await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");')).toBeLessThan(INLINE.indexOf("strikeOrPrompt("));
    expect(INLINE).toContain("const session = (await getSession(lineUserId)) ?? {};");
  });

  test("every reserved word is refused on the inline door, by construction", () => {
    for (const w of RESERVED_WORDS) {
      const parsed = parseAddCommand(`add ${w}`);
      // Some reserved words are themselves the add command's own shape; the rest arrive as a name and are refused.
      if (parsed?.name) expect({ w, refused: isReservedWord(parsed.name) }).toEqual({ w, refused: true });
    }
  });
});

describe("✅ TASK-313 §1 — the EN menu advertises the customer's phrase, and `add child` still ADDS", () => {
  test("🔑 `Add Student`, screen 8's own words — not a second English phrase for an act they already named", () => {
    expect(t("menu_body", "EN")).toContain("· Add Student — register a child");
    expect(t("menu_body", "EN")).not.toContain("add child");
  });

  test("⚠️ `add child` is still ACCEPTED — parents have seen it — and it ADDS a child, never one named `child`", () => {
    // §5 (@Porter, verbatim): *"it stops being ADVERTISED; it does not start being refused. And when it is typed,
    // it must add a child and NOT name one `child`."* ⇒ `add child` is the COMMAND, exactly as `Add Student` is —
    // one shape, three phrases. 🚫 `child` is NOT reserved: that would REFUSE a parent who typed the old phrase
    // instead of serving them, and `child` is no longer a word we print.
    for (const typed of ["add child", "Add Child", "AdD ChIlD", "addchild"]) {
      expect({ typed, parsed: parseAddCommand(typed) }).toEqual({ typed, parsed: { name: null } });
    }
    expect(parseAddCommand("add child Emily")).toEqual({ name: "Emily" }); // same as `Add Student Emily`
    expect(parseAddCommand("addchildemily")).toBeNull(); // no separator ⇒ nothing, same as its sibling
    expect(isReservedWord("child")).toBe(false);
    expect(isReservedWord("add child")).toBe(true); // a bare command phrase is a word the product printed
    for (const lang of ["TH", "EN"] as const) expect(t("menu_body", lang)).not.toContain("add child");
  });

  test("🔑 the add PHRASE itself is reserved — a bare command is a word the product prints", () => {
    for (const w of ["เพิ่มนักเรียน", "เพิ่มลูก", "Add Student", "AdD StUdEnT", "addstudent", "add"]) {
      expect({ w, reserved: isReservedWord(w) }).toEqual({ w, reserved: true });
    }
    // …consulting the ONE definition (the regex), not a copied list entry (TASK-312 §2.3 kept it a regex).
    const CMDS = code(src("src/lib/line-commands.ts"));
    expect(CMDS).toContain("parseAddCommand(text)?.name === null");
    expect(CMDS).not.toContain('"เพิ่มนักเรียน"');
  });
});

describe("🔑 TASK-313 §3(2) — every token the MENU advertises is reserved (MECHANICAL, parsed from the string)", () => {
  /** `· <word> — <description>` lines, in whichever language. The token is what a parent would type. */
  const advertised = (lang: "TH" | "EN") =>
    t("menu_body", lang)
      .split("\n")
      .filter((l) => l.startsWith("· "))
      .map((l) => l.slice(2).split(" — ")[0].trim());

  test("the parser sees the whole menu — six commands per language", () => {
    expect(advertised("TH").length).toBe(6);
    expect(advertised("EN").length).toBe(6);
    expect(advertised("EN")).toContain("Add Student");
    expect(advertised("TH")).toContain("เพิ่มนักเรียน");
  });

  test("🔴 every advertised token is reserved — advertising a word without reserving it fails HERE", () => {
    for (const lang of ["TH", "EN"] as const) {
      for (const token of advertised(lang)) {
        expect({ lang, token, reserved: isReservedWord(token) }).toEqual({ lang, token, reserved: true });
      }
    }
  });

  test("🔴 (3) the customer's eight screens are PROSE and are NOT parsed here — declared, not hidden", () => {
    // The limit, stated next to the mechanism so green never means more than it does. What stands in for a
    // parser: the words those screens instruct are pinned byte-for-byte (TASK-310), and each instruction the
    // screens DO give today is reserved — checked by hand, and a NEW one added later is not covered.
    for (const w of ["สมัคร", "register", "Next", "ยืนยัน", "Confirm", "ยกเลิก", "Cancel", "เพิ่มนักเรียน", "Add Student"]) {
      const covered = isReservedWord(w) || w === "Next" || w === "ยืนยัน" || w === "Confirm";
      expect({ w, covered }).toEqual({ w, covered: true });
    }
    // `Next` / `ยืนยัน` / `Confirm` are role and confirm words — vocabularies outside `RESERVED_WORDS` (TASK-312's
    // declared blind spot), so the hand-check above names them rather than pretending the list holds them.
    expect(isReservedWord("Next")).toBe(false);
    expect(isReservedWord("Confirm")).toBe(false);
  });
});
