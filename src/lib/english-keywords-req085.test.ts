// TASK-312 §2 (REQ-085 §13 / §13.1 / §13.3) — every keyword has an English form, and case never matters.
//
// 🔑 The owner's principle, so the next keyword does not need re-deciding: *if the bot can be TOLD to type a
// word, it must accept that word in both languages.* ⇒ the sweep below is written FROM THE LIST — every
// `CMD_*` export of `line-commands.ts` — so a keyword added next month FAILS here until it has an English form.
// 🚫 Not a hand-written table of pairs: *a list is complete the day it is written and wrong a week later.*
//
// 🔴 ═══ THE BLIND SPOT, DECLARED HERE BECAUSE THE SWEEP CANNOT SEE IT ═══
// Two vocabularies live OUTSIDE `line-commands.ts`, and iterating its exports does not reach them:
//   1. `CONFIRM` / `CANCEL` / `SKIP` in `line-add-student.ts` (`isConfirm`, `isCancel`, `isSkip`);
//   2. the `Add Student` phrase — a regex in `parseAddCommand`, not a list entry.
// Both are asserted BY HAND in the last describe. ⚠️ If a third vocabulary is added outside the list, this
// sweep will stay green and say nothing — which is exactly how TASK-288's assertions stayed green through a
// live defect. **An assertion that names what it does not cover is worth more than one that quietly covers
// less.** 🚫 Moving those two INTO the list is a design change and waits until after the owner's round.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as COMMANDS from "./line-commands";
import { isCancel, isConfirm, isSkip, parseAddCommand } from "./line-add-student";
import { parseRoleChoice } from "./line-webhook";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));

/** Every `CMD_*` list the vocabulary exports — discovered, not enumerated. */
const LISTS = Object.entries(COMMANDS).filter(
  (e): e is [string, readonly string[]] => e[0].startsWith("CMD_") && Array.isArray(e[1]),
);
const isEnglish = (w: string) => /^[a-z][a-z -]*$/.test(w);
/** `ConFiRM`-style casing: the owner's own example shape — never Title Case, which a first-letter fix would pass. */
const absurd = (w: string) => [...w].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("");
const shout = (w: string) => w.toUpperCase();
/** How the router compares a typed command: `const cmd = raw.toLowerCase()` then `inList(CMD_X, cmd)`. */
const routerAccepts = (list: readonly string[], typed: string) => list.includes(typed.trim().toLowerCase());

describe("🔑 TASK-312 §2.3 — every keyword in the vocabulary has an ENGLISH form (asserted over the LIST)", () => {
  test("the sweep sees the whole vocabulary", () => {
    // A sanity floor so an accidental rename of the export prefix cannot turn this file into a no-op.
    expect(LISTS.length).toBeGreaterThanOrEqual(13);
    expect(LISTS.map(([n]) => n)).toContain("CMD_REGISTER");
    expect(LISTS.map(([n]) => n)).toContain("CMD_SKIP");
  });

  test("🔴 no list is Thai-only — a keyword that exists in one language is a door half the parents cannot open", () => {
    for (const [name, list] of LISTS) {
      expect({ name, english: list.filter(isEnglish) }).not.toEqual({ name, english: [] });
    }
  });

  test("🔴 §13.3 — every English form is accepted in ABSURD casing, the way the router compares it", () => {
    // `ConFiRM`, not `Confirm`: his four examples are the requirement.
    for (const [name, list] of LISTS) {
      for (const w of list.filter(isEnglish)) {
        for (const typed of [absurd(w), shout(w), `  ${absurd(w)}  `]) {
          expect({ name, typed, ok: routerAccepts(list, typed) }).toEqual({ name, typed, ok: true });
        }
      }
    }
    // …and the router really does lowercase before it compares — the property the loop above depends on.
    const SVC = src("src/services/line-webhook.service.ts");
    expect(SVC).toContain("const cmd = raw.toLowerCase();");
    expect(SVC).toContain("const lower = text.toLowerCase();");
    expect(SVC).toContain("const inList = (list: readonly string[], word: string) => list.includes(word);");
  });

  test("🚫 case-insensitive is not FORGIVING — a different word is refused", () => {
    expect(routerAccepts(COMMANDS.CMD_REGISTER, "REGISTERR")).toBe(false);
    expect(routerAccepts(COMMANDS.CMD_ADMIN, "admins")).toBe(false);
    expect(routerAccepts(COMMANDS.CMD_MENU, "men")).toBe(false);
  });

  test("🚫 Thai is untouched — it has no case, and the words are the same words", () => {
    expect(COMMANDS.CMD_REGISTER).toContain("สมัคร");
    expect(COMMANDS.CMD_ADMIN).toContain("แอดมิน");
    expect(COMMANDS.CMD_SKIP).toContain("ข้าม");
    expect(COMMANDS.CMD_CANCEL).toContain("ยกเลิก");
  });
});

describe("§2.1 — `ครู` → `teacher`", () => {
  test("🔻 it was never missing: `ครู` is a ROLE word, not a command, and `teacher` has sat beside it since TASK-251", () => {
    // The inventory looked in `line-commands.ts` and found no `ครู` — correctly, because it is not there. The
    // only place the bot accepts `ครู` is `parseRoleChoice`, and that pair has been complete all along.
    // ⇒ nothing to add. Asserted with absurd casing so §13.3 covers the role words too.
    expect(parseRoleChoice("ครู")).toBe("teacher");
    for (const typed of ["teacher", "TEACHER", "TeAcHeR", "  tEaChEr "]) expect(parseRoleChoice(typed)).toBe("teacher");
    for (const typed of ["admin", "AdMiN"]) expect(parseRoleChoice(typed)).toBe("admin");
    for (const typed of ["next", "NeXt"]) expect(parseRoleChoice(typed)).toBe("customer");
    expect(parseRoleChoice("teachers")).toBeNull();
    // …and `ครู` is not a command keyword anywhere the sweep can see.
    for (const [, list] of LISTS) expect(list).not.toContain("ครู");
  });
});

describe("🔴 THE DECLARED BLIND SPOT — asserted by hand because the sweep cannot reach it", () => {
  test("1. `confirm` / `cancel` / `skip` in `line-add-student.ts` — with the owner's own `ConFiRM`", () => {
    for (const typed of ["confirm", "Confirm", "ConFirm", "ConFiRM", "CONFIRM", "yEs", "OK"]) {
      expect({ typed, ok: isConfirm(typed) }).toEqual({ typed, ok: true });
    }
    expect(isConfirm("CONFIRMM")).toBe(false); // the same WORD however typed — never a different word
    expect(isConfirm("ยืนยัน")).toBe(true);
    for (const typed of ["cancel", "CaNcEl", "NO"]) expect(isCancel(typed)).toBe(true);
    for (const typed of ["skip", "SkIp", "NoNe"]) expect(isSkip(typed)).toBe(true);
    expect(isCancel("cancelled")).toBe(false);
  });

  test("2. the `Add Student` phrase — a regex, not a list entry", () => {
    for (const typed of ["Add Student", "AdD StUdEnT", "ADD STUDENT", "addstudent", "aDdStUdEnT"]) {
      expect({ typed, parsed: parseAddCommand(typed) }).toEqual({ typed, parsed: { name: null } });
    }
    expect(parseAddCommand("add studentt")).toEqual({ name: "studentt" }); // `add` + a name; not the phrase, and not fuzzy
  });

  test("📌 the blind spot is DECLARED in this file, so the next reader knows what green does not mean", () => {
    const me = src("src/lib/english-keywords-req085.test.ts");
    expect(me).toContain("THE BLIND SPOT, DECLARED HERE BECAUSE THE SWEEP CANNOT SEE IT");
    expect(me).toContain("line-add-student.ts");
    expect(me).toContain("parseAddCommand");
  });
});
