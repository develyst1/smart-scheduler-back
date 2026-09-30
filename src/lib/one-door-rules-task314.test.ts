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
// 🔻 TASK-347 (`REQ-088`) — the creator and the duplicate helper moved to the ONE home of the registration
// decisions. `fnIn` reads them there; the two doors in THIS file (wizard, inline) still call them by name.
const REG = code(src("src/services/line-register.service.ts"));
const fnIn = (S: string, sig: string) => {
  const i = S.indexOf(sig);
  if (i < 0) throw new Error("no " + sig);
  return S.slice(i, S.indexOf("\n}\n", i));
};
const fn = (sig: string) => {
  const i = SVC.indexOf(sig);
  if (i < 0) throw new Error("no " + sig);
  return SVC.slice(i, SVC.indexOf("\n}\n", i));
};
const WIZARD = fn("async function handleAddStudentStep(");
// 🔻 TASK-583 (ruling 4) — `addStudentAndReply` is GONE: it wrote a child from the name alone. The inline door is now the router's
// `addMatch` branch, which WRITES NOTHING and hands the name to the wizard's name step — so every rule below reaches it through the
// wizard, by construction, instead of by a second copy.
const INLINE = SVC.slice(SVC.indexOf("const addMatch = parseAddCommand(raw);"), SVC.indexOf("if (inList(CMD_COURSES, cmd))"));
const INLINE_ENTERS_WIZARD = "return handleAddStudentStep(lineUserId, session as any, name, replyToken, lang);";
const CREATOR = fnIn(REG, "export async function createStudentFromLine(");
const DUP = fnIn(REG, "export async function duplicateOutcomeFor(");
const ASK = fn("async function askMoreDetail(");

describe("🔴 TASK-314 §2.1 — `add น้องเอ` twice behaves as the WIZARD does (AC-9)", () => {
  test("🔑 both doors ask the ONE helper, and the helper asks the ONE pure decision", () => {
    expect(WIZARD).toContain('(await duplicateOutcomeFor(parent.id, name)) === "more-detail"');
    expect(INLINE).toContain(INLINE_ENTERS_WIZARD); // 🔻 TASK-583 — the inline door asks it THROUGH the wizard
    expect(DUP).toContain("decideDuplicate(siblings.map((s: any) => s.name), name)");
    // …and nowhere else: the decision has exactly one caller, and 🔻 TASK-347 moved that caller to the ONE home
    // of the registration decisions. The webhook no longer calls the pure decision at all.
    expect(REG.match(/decideDuplicate\(/g)!.length).toBe(1);
    expect(SVC).not.toContain("decideDuplicate(");
  });

  test("🔑 the inline door NEVER writes (🔻 TASK-583) — it enters the wizard's NAME step, which asks the duplicate question and every required one", () => {
    expect(INLINE).not.toMatch(/createStudentFromLine|addStudentAndReply|createStudentForParent/);
    expect(INLINE).toContain('await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");');
    expect(INLINE.indexOf('setStep(lineUserId, "AWAIT_STUDENT_NAME"')).toBeLessThan(INLINE.lastIndexOf(INLINE_ENTERS_WIZARD));
    // the name step's EXACT duplicate guard — a disabled condition still "contains" the call, so the line itself is pinned
    expect(WIZARD).toContain('if (parent && session.step === "AWAIT_STUDENT_NAME" && (await duplicateOutcomeFor(parent.id, name)) === "more-detail") {'); // 🔻 TASK-590: a NEW family has no sibling
    expect(WIZARD).toContain("return askMoreDetail(lineUserId, draft, name, replyToken, lang);");
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
    expect(WIZARD).toContain("await createStudentFromLine(parent!, {"); // 🔻 TASK-590 — an EXISTING family; a new one goes through `registerFamilyWithFirstChild`, which calls the same creator
    expect(fnIn(REG, "export async function registerFamilyWithFirstChild(")).toContain("await createStudentFromLine(parent, {");
    expect(INLINE).toContain(INLINE_ENTERS_WIZARD); // 🔻 TASK-583 — the inline door reaches the creator only via the wizard's CONFIRM
    expect(CREATOR).toContain('await notifyAdmins({ kind: "student_registered", studentName: created.student.name, parentPhone: parent.phone }, exec);'); // 🔻 TASK-590: on the caller's tx (a new family's notice rolls back with it)
    // The row first, then the message — the order AC-11 always had.
    expect(CREATOR.indexOf("createStudentForParent(")).toBeLessThan(CREATOR.indexOf("notifyAdmins("));
    // …and no door calls the service write directly any more: the notification cannot be skipped by construction.
    // 🔻 TASK-347 — the ONE call to the service write and the ONE notification are in the register service now;
    // the webhook has NEITHER. **That absence is the stronger form of the same claim.**
    expect(REG.match(/createStudentForParent\(/g)!.length).toBe(1);
    expect(REG.match(/kind: "student_registered"/g)!.length).toBe(1);
    expect(SVC).not.toContain("createStudentForParent(");
    expect(SVC).not.toContain('kind: "student_registered"');
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
  test("the wizard asks it at the first step; the inline door has no copy of it — 🔻 TASK-583: it now ENTERS that step, so it gets the courtesy check too", () => {
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
    // 🔻 TASK-347 — the household `province` write rides INTO the one writer now (`province: draft.province`
    // is an argument, not a second `db.update` beside it). The sequence the confirm branch performs is the
    // same: write (student + province), notify, clear, reply screen 8.
    // 🔻 TASK-352 (`REQ-088 §9`) — the screen-6 string is an ADDRESS now, appended to `parents.note`; the chat never
    // writes `province`. The sequence is the same: write (student + note), notify, clear, reply screen 8.
    // 🔻 TASK-590 — the address is THREE parts (F-C) and a NEW family is created WITH this child in one transaction (D11 a); the
    // sequence is the same: write (student + household), notify (inside the writer), clear, reply screen 8.
    // (the SUCCESS path's clear: the first one AFTER the write — the new-family refusal and the catch each have their own)
    const successClear = confirm.indexOf("clearSession(lineUserId)", confirm.indexOf("createStudentFromLine(parent!, {"));
    expect(successClear).toBeGreaterThan(-1);
    expect(successClear).toBeLessThan(confirm.indexOf('t("added_done", lang'));
    const order = ["isConfirm(text)", "const address = addressOnFile ? null :", "registerFamilyWithFirstChild(", "createStudentFromLine(parent!, {", "const atMax = count >= MAX_STUDENTS_PER_PARENT;", 't("added_done", lang'];
    const at = order.map((o) => confirm.indexOf(o));
    expect({ missing: order.filter((_, i) => at[i]! < 0) }).toEqual({ missing: [] });
    for (let i = 1; i < order.length; i++) expect(at[i - 1]!).toBeLessThan(at[i]!);
    expect(confirm).toContain("birthDate: draft.birthDate ?? null, address })");
  });

  test("the name step still: refuses a reserved word (strike), checks the cap, asks the duplicate question, then moves on", () => {
    const name = WIZARD.slice(WIZARD.indexOf('if (session.step === "AWAIT_STUDENT_NAME" || session.step === "AWAIT_STUDENT_DETAIL")'), WIZARD.indexOf('if (session.step === "AWAIT_STUDENT_BIRTHDATE")'));
    const order = ["isReservedWord(name)", "assertCanAddStudent(parent.id)", "duplicateOutcomeFor(parent.id, name)", "resetStrikes(lineUserId)", 'setDraft(lineUserId, "AWAIT_STUDENT_BIRTHDATE"'];
    for (let i = 1; i < order.length; i++) expect(name.indexOf(order[i - 1])).toBeLessThan(name.indexOf(order[i]));
    // Only the NAME step asks; the DETAIL step is the answer, not a second question.
    expect(name).toContain('session.step === "AWAIT_STUDENT_NAME" && (await duplicateOutcomeFor(');
  });
});
