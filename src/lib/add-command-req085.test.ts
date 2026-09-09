// TASK-312 §1 (REQ-085 §13) — the `add` prefix swallowed `admin`, `address` and `Add Student`.
//
// 🔴 The defect: `/^(?:เพิ่มนักเรียน|เพิ่มลูก|add)\s*(.*)$/i` — `add` was a BARE PREFIX, `\s*` matched EMPTY, and
// `(.*)` took the rest of the word. `admin` → a child named `in`. `address` → `ress`. `Add Student` — the phrase
// our own screen 8 tells a parent to type — → `Student`. ⚠️ None of those is reserved; there is no delete route
// and no archive flag. **Every one of those writes was permanent.**
//
// 🔑 The assertions that matter are ABSENCES: `parseAddCommand` returning `null` is the router falling through
// to the real handler, and returning `{ name: null }` is the prompt — neither writes. The write is
// `addStudentAndReply`, and the source guard at the end pins that it runs only on a NAME.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAddCommand } from "./line-add-student";
import { CMD_ADMIN } from "./line-commands";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));

describe("🔴 TASK-312 §1 — `add` is a command only when the input ENDS there or a SEPARATOR follows", () => {
  test("🔴 `admin` reaches the ADMIN handler — the one nobody knew about", () => {
    // It matches nothing here, so the router falls through to `CMD_ADMIN`, which has carried `admin` all along.
    expect(parseAddCommand("admin")).toBeNull();
    expect(parseAddCommand("Admin")).toBeNull();
    expect((CMD_ADMIN as readonly string[]).includes("admin")).toBe(true);
    // …and the reason it never reached it: the add check runs FIRST, and still does — the PATTERN is the fix.
    expect(SVC.indexOf("const addMatch = parseAddCommand(raw);")).toBeLessThan(SVC.indexOf("if (inList(CMD_ADMIN, cmd))"));
  });

  test("🔴 `address` creates nothing", () => {
    expect(parseAddCommand("address")).toBeNull();
    expect(parseAddCommand("adding")).toBeNull();
    expect(parseAddCommand("addendum")).toBeNull();
  });

  test("✅ `add Emily` and `เพิ่มนักเรียน น้องเอ` still work — the fix must not cost the feature", () => {
    expect(parseAddCommand("add Emily")).toEqual({ name: "Emily" });
    expect(parseAddCommand("ADD Emily")).toEqual({ name: "Emily" });
    expect(parseAddCommand("เพิ่มนักเรียน น้องเอ")).toEqual({ name: "น้องเอ" });
    expect(parseAddCommand("เพิ่มลูก น้องบี")).toEqual({ name: "น้องบี" });
    // Thai keeps its tolerance — written without spaces, and no other Thai command begins this way.
    expect(parseAddCommand("เพิ่มนักเรียนน้องเอ")).toEqual({ name: "น้องเอ" });
    // The bare command, in either language, is the prompt: `name: null`, no write.
    expect(parseAddCommand("add")).toEqual({ name: null });
    expect(parseAddCommand("เพิ่มนักเรียน")).toEqual({ name: null });
  });
});

describe("🔴 TASK-312 §1 — `Add Student` is the COMMAND, not `add` + a name", () => {
  test("🔴 every casing and spacing of the phrase starts the prompt — and NONE writes", () => {
    // §13.3: case and whitespace are separate rules and both apply. ⚠️ Absurd casing on purpose — a test written
    // with `Add Student` passes a `toLowerCase()` applied to the first letter only.
    for (const phrase of ["Add Student", "add student", "ADD STUDENT", "AdD StUdEnT", "addstudent", "aDdStUdEnT", "add   student", "  Add Student  "]) {
      expect({ phrase, parsed: parseAddCommand(phrase) }).toEqual({ phrase, parsed: { name: null } });
    }
  });

  test("📌 DECISION — `Add Student Emily` creates `Emily`, and `addstudentemily` creates nothing", () => {
    // The customer's screen only promises the bare phrase, so this was mine to decide and to write down: the
    // phrase is the command, and it takes a name after a separator EXACTLY as the bare `add` does. One shape —
    // and it can never write `Student Emily` as a child's name, which is what the old pattern did.
    expect(parseAddCommand("Add Student Emily")).toEqual({ name: "Emily" });
    expect(parseAddCommand("add student น้องเอ")).toEqual({ name: "น้องเอ" });
    // No separator ⇒ not the command, not a name: falls through and writes nothing.
    expect(parseAddCommand("addstudentemily")).toBeNull();
  });

  test("🔑 TASK-313 §5 — `add child` is the SAME command: our older phrase, unadvertised, still served", () => {
    for (const typed of ["add child", "AdD ChIlD", "addchild"]) {
      expect({ typed, parsed: parseAddCommand(typed) }).toEqual({ typed, parsed: { name: null } });
    }
    expect(parseAddCommand("add child น้องเอ")).toEqual({ name: "น้องเอ" });
    expect(parseAddCommand("addchildren")).toBeNull(); // not the phrase, not a name: nothing
  });

  test("🚫 no fuzzy matching — `ad`, `adds`, `add-student` are not the command", () => {
    expect(parseAddCommand("ad")).toBeNull();
    expect(parseAddCommand("adds")).toBeNull();
    expect(parseAddCommand("add-student")).toBeNull();
  });
});

describe("🔑 TASK-312 §1 — the write happens ONLY on a name, and the pattern lives in ONE place", () => {
  test("the router writes on `addMatch.name` and prompts otherwise", () => {
    const block = SVC.slice(SVC.indexOf("const addMatch = parseAddCommand(raw);"), SVC.indexOf("if (inList(CMD_COURSES, cmd))"));
    expect(block).toContain("const name = addMatch.name;");
    expect(block).toContain("if (name) return addStudentAndReply(lineUserId, name, replyToken, { continueSession: false }, lang);");
    expect(block).toContain('await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");');
  });

  test("🔻 the bare prefix is gone from the service — asserted so a merge cannot bring it back", () => {
    expect(SVC).not.toContain("|add)\\s*(.*)$/i");
    expect(SVC).not.toMatch(/raw\.match\(\/\^\(\?:เพิ่มนักเรียน/);
    // …and the parser is pure: no DB, no i18n, no clock (same rule as the rest of `line-add-student.ts`).
    const LIB = code(src("src/lib/line-add-student.ts"));
    expect(LIB).not.toContain("from \"../db\"");
    expect(LIB).toContain("export function parseAddCommand(text: string): { name: string | null } | null {");
  });
});
