// TASK-314 — two more rules that guarded only the WIZARD door.
//
// 🔑 The pattern (my own Question answer on TASK-313): *`addStudentAndReply` predates the wizard, and every rule
// written FOR the wizard was written INTO the wizard. The inline door never generates a report — it succeeds,
// wrongly, silently.* Two rules moved to where BOTH doors reach them — MOVED, not copied, because a second copy
// is what created this class.
//
// 📌 The DIRECTION each moved, and why they did not move to the same place:
//   · AC-9 (duplicate → more detail) → `duplicateOutcomeFor` + `askMoreDetail`, HANDLER helpers. The rule's
//     whole content is a QUESTION, and only a handler can ask one. The pure `decideDuplicate` did not move.
//   · AC-11 (admin notified) → `createStudentFromLine`, the ONE LINE-side creator. 🚫 NOT into
//     `createStudentForParent`: that service function is also the staff screen's write (`routes/api.ts`,
//     `parent.service.createStudent`), and an admin adding a student would be notified of their own act. The rule
//     is "a parent registered a child over LINE", so it lives on the LINE side, shared by both LINE doors.
//   ⇒ Different homes because they are different KINDS of rule — a question and a side-effect — not untidiness.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideDuplicate } from "./line-add-student";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));
const fn = (sig: string) => {
  const i = SVC.indexOf(sig);
  if (i < 0) throw new Error("no " + sig);
  return SVC.slice(i, SVC.indexOf("\n}\n", i));
};
const WIZARD = fn("async function handleAddStudentStep(");
const INLINE = fn("async function addStudentAndReply(");
const CREATOR = fn("async function createStudentFromLine(");
const DUP = fn("async function duplicateOutcomeFor(");
const ASK = fn("async function askMoreDetail(");

describe("🔴 TASK-314 §2.1 — `add น้องเอ` twice behaves as the WIZARD does (AC-9)", () => {
  test("🔑 both doors ask the ONE helper, and the helper asks the ONE pure decision", () => {
    expect(WIZARD).toContain('(await duplicateOutcomeFor(parent.id, name)) === "more-detail"');
    expect(INLINE).toContain('(await duplicateOutcomeFor(parent.id, name)) === "more-detail"');
    expect(DUP).toContain("decideDuplicate(siblings.map((s: any) => s.name), name)");
    // …and nowhere else: the decision has exactly one caller in the handler.
    expect(SVC.match(/decideDuplicate\(/g)!.length).toBe(1);
  });

  test("🔑 the inline door ASKS before it writes — and the question puts the parent into the wizard's detail step", () => {
    expect(INLINE.indexOf("duplicateOutcomeFor(")).toBeLessThan(INLINE.indexOf("createStudentFromLine("));
    // ⚠️ The EXACT guard line, because a first mutation (`if (false && …)`) passed the two looser pins above:
    // the text of a disabled condition still "contains" the helper call. A green mutation proves nothing.
    expect(INLINE).toContain('\n  if ((await duplicateOutcomeFor(parent.id, name)) === "more-detail") {\n');
    expect(INLINE).toContain("return askMoreDetail(lineUserId, {}, name, replyToken, lang);");
    expect(ASK).toContain('await setDraft(lineUserId, "AWAIT_STUDENT_DETAIL", { ...draft, name });');
    expect(ASK).toContain('withExit(t("add_dup_detail", lang), lang)');
  });

  test("🚫 the AC's rule is UNCHANGED — more detail, never a rename; not a strike", () => {
    expect(decideDuplicate(["น้องเอ"], "น้องเอ")).toBe("more-detail");
    expect(decideDuplicate(["น้องเอ"], "น้องบี")).toBe("ok");
    expect(ASK).not.toContain("strikeOrPrompt");
    expect(DUP).not.toContain("strikeOrPrompt");
  });
});

describe("🔴 TASK-314 §2.2 — a child added INLINE notifies the admin (AC-11)", () => {
  test("🔑 ONE LINE-side creator, both doors call it, and the notification lives inside it", () => {
    expect(WIZARD).toContain("await createStudentFromLine(parent, {");
    expect(INLINE).toContain("await createStudentFromLine(parent, { name });");
    expect(CREATOR).toContain('await notifyAdmins({ kind: "student_registered", studentName: created.student.name, parentPhone: parent.phone });');
    // The row first, then the message — the order AC-11 always had.
    expect(CREATOR.indexOf("createStudentForParent(")).toBeLessThan(CREATOR.indexOf("notifyAdmins("));
    // …and no door calls the service write directly any more: the notification cannot be skipped by construction.
    expect(SVC.match(/createStudentForParent\(/g)!.length).toBe(1);
    expect(SVC.match(/kind: "student_registered"/g)!.length).toBe(1);
  });

  test("🔑 the SKIPPED row when no admin is linked — TASK-152's rule, reached through the same `notifyAdmins`", () => {
    // A silent failure to notify is the defect, not the absence of an admin. `notifyAdmins` writes the loud row
    // itself; both doors now reach it through the creator, so the inline door inherits it.
    const ADMIN = code(src("src/lib/line-admin.ts"));
    expect(ADMIN).toContain("if (!ids.length) {");
    expect(ADMIN).toContain('skipReason: "no admin recipient configured"');
    expect(CREATOR).toContain("notifyAdmins(");
    expect(CREATOR).not.toContain("getAdminLineUserIds(");
  });

  test("🚫 the DIRECTION — not into the service, because the staff screen writes through it too", () => {
    const PARENT_SVC = code(src("src/services/parent.service.ts"));
    expect(PARENT_SVC).not.toContain("notifyAdmins");
    expect(code(src("src/routes/api.ts"))).toContain("parent.createStudentForParent(");
    expect(PARENT_SVC).toContain("const { student } = await createStudentForParent(");
  });
});

describe("🚫 TASK-314 §3 — the cap's courtesy check is LEFT ALONE, with the reason", () => {
  test("the wizard asks it at the first step; the inline door relies on the write's own precondition", () => {
    // Correctly harmless: `createStudentForParent` calls `assertCanAddStudent` itself, which is exactly why it
    // was extracted. The difference is a worse MESSAGE on the inline door, not a missing rule.
    expect(WIZARD).toContain("await assertCanAddStudent(parent.id);");
    expect(INLINE).not.toContain("assertCanAddStudent(");
    expect(code(src("src/services/parent.service.ts"))).toContain("const existingCount = await assertCanAddStudent(parentId, exec);");
  });
});

describe("✅ TASK-314 — the wizard's BEHAVIOUR is byte-identical: a move, not a rewording", () => {
  test("the confirm branch still: writes, updates the household province, notifies, clears, replies screen 8", () => {
    // From the confirm word onward — the cancel branch above it has its own `clearSession`, which is not this one.
    const confirm = WIZARD.slice(WIZARD.indexOf("if (!isConfirm(text))"));
    const order = ["isConfirm(text)", "createStudentFromLine(parent, {", "set({ province: draft.province })", "clearSession(lineUserId)", 't("added_done", lang'];
    for (let i = 1; i < order.length; i++) expect(confirm.indexOf(order[i - 1])).toBeLessThan(confirm.indexOf(order[i]));
    expect(confirm).toContain("birthDate: draft.birthDate ?? null,");
  });

  test("the name step still: refuses a reserved word (strike), checks the cap, asks the duplicate question, then moves on", () => {
    const name = WIZARD.slice(WIZARD.indexOf('if (session.step === "AWAIT_STUDENT_NAME" || session.step === "AWAIT_STUDENT_DETAIL")'), WIZARD.indexOf('if (session.step === "AWAIT_STUDENT_BIRTHDATE")'));
    const order = ["isReservedWord(name)", "assertCanAddStudent(parent.id)", "duplicateOutcomeFor(parent.id, name)", "resetStrikes(lineUserId)", 'setDraft(lineUserId, "AWAIT_STUDENT_BIRTHDATE"'];
    for (let i = 1; i < order.length; i++) expect(name.indexOf(order[i - 1])).toBeLessThan(name.indexOf(order[i]));
    // Only the NAME step asks; the DETAIL step is the answer, not a second question.
    expect(name).toContain('session.step === "AWAIT_STUDENT_NAME" && (await duplicateOutcomeFor(');
  });
});
