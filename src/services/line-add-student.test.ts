// SPEC-071 / TASK-233 (REQ-079 §5 Flow 3) — เพิ่มนักเรียน: summary before write, admin told, nothing partial.
//
// 🔴 Why the confirm step is the deliverable and not politeness: this writes into a roster that has **no delete
// for anything with history**. That is the product, not an oversight — so three seconds of review against a
// record nobody can remove is the cheapest safety this flow will ever get.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import {
  ADD_STUDENT_STEPS,
  decideDuplicate,
  isAddStudentStep,
  isCancel,
  isConfirm,
  isSkip,
  nextStep,
  parseBirthDate,
  summaryLines,
} from "../lib/line-add-student";
import { decideMessageRoute } from "../lib/line-routing";
import { t } from "../lib/line-i18n";

const SVC = readSrc(await Bun.file(new URL("./line-webhook.service.ts", import.meta.url)).text());
const WIZARD = readSrc(await Bun.file(new URL("../lib/line-add-student.ts", import.meta.url)).text());
const SQL = await Bun.file(new URL("../../drizzle/0031_line_session_draft.sql", import.meta.url)).text();
const PARENT_SVC = readSrc(await Bun.file(new URL("./parent.service.ts", import.meta.url)).text());
const body = (decl: string) => {
  const rest = SVC.slice(SVC.indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const FLOW = body("async function handleAddStudentStep");
const labels = { name: "ชื่อ", birthDate: "วันเกิด", province: "จังหวัด", none: "ไม่ระบุ" };
/**
 * Comments stripped — a structural claim must measure the CODE, not the prose explaining it.
 *
 * ⚠️ Fourth time this trap has come up this week: these files deliberately discuss the very symbols the tests
 * assert on (`createStudentForParent`, "no delete", `Math.random`), so an unstripped `toContain` measures the
 * explanation and fails on a file that is correct.
 */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("🔴 AC-10 — the summary shows what will be written, and nothing is written before confirm", () => {
  test("the summary carries all three fields", () => {
    const lines = summaryLines({ name: "น้องรดา", birthDate: "2018-04-02", province: "ภูเก็ต" }, labels);
    expect(lines).toEqual(["ชื่อ: น้องรดา", "วันเกิด: 2018-04-02", "จังหวัด: ภูเก็ต"]);
  });

  test("🔑 a SKIPPED field is shown as skipped, not omitted", () => {
    // An absent line reads as "the system already knows that" — the exact misunderstanding a confirmation step
    // exists to prevent.
    const lines = summaryLines({ name: "น้องต้น" }, labels);
    expect(lines[1]).toBe("วันเกิด: ไม่ระบุ");
    expect(lines[2]).toBe("จังหวัด: ไม่ระบุ");
  });

  const beforeConfirm = () =>
    code(FLOW).slice(0, code(FLOW).indexOf('session.step === "AWAIT_STUDENT_CONFIRM"'));

  test("🔴 the roster write happens ONLY in the confirm branch", () => {
    // The whole of AC-12 in one assertion: if `createStudentForParent` were called anywhere earlier in this
    // flow, an abandoned conversation would leave a child in a roster with no delete.
    expect(beforeConfirm()).not.toContain("createStudentForParent(");
    expect(code(FLOW)).toContain("createStudentForParent(");
    expect(code(FLOW).indexOf("isConfirm(text)")).toBeLessThan(code(FLOW).indexOf("createStudentForParent("));
  });

  test("every step before confirm writes to the DRAFT only", () => {
    for (const w of ["insert(students", "createStudentForParent(", "notifyAdmins("]) {
      expect(beforeConfirm()).not.toContain(w);
    }
    expect(beforeConfirm()).toContain("setDraft(");
    // …and the ONE read it does before that is the cap precondition, which writes nothing.
    expect(beforeConfirm()).toContain("assertCanAddStudent(parent.id)");
  });
});

describe("🔴 AC-12 — abandon at ANY step and nothing exists", () => {
  test("the draft lives on the session, which expires and is deleted outright", () => {
    // Nothing to clean up: the row was never going to be created until confirm, and the session itself dies
    // after 30 minutes of silence (TASK-231).
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS "draft" jsonb');
    expect(SVC).toContain("async function setDraft");
  });

  test("cancelling at the summary writes nothing and SAYS so", () => {
    // The parent has just read a summary; the one thing they must not wonder is whether part of it was saved.
    expect(FLOW).toContain("if (isCancel(text))");
    const cancelBranch = FLOW.slice(FLOW.indexOf("if (isCancel(text))"), FLOW.indexOf("if (!isConfirm(text))"));
    expect(cancelBranch).toContain("clearSession");
    expect(cancelBranch).not.toContain("createStudentForParent");
    expect(t("add_cancelled", "TH")).toContain("ยังไม่ได้บันทึก");
  });

  test("cancel and confirm words are distinct — no word means both", () => {
    for (const w of ["ยืนยัน", "confirm", "ok"]) {
      expect(isConfirm(w)).toBe(true);
      expect(isCancel(w)).toBe(false);
    }
    for (const w of ["ยกเลิก", "cancel"]) {
      expect(isCancel(w)).toBe(true);
      expect(isConfirm(w)).toBe(false);
    }
  });
});

describe("🔴 AC-9 — a duplicate asks for MORE DETAIL; it never demands a rename", () => {
  test("an existing name in the same family asks for detail", () => {
    expect(decideDuplicate(["น้องรดา"], "น้องรดา")).toBe("more-detail");
    expect(decideDuplicate(["น้องรดา"], " น้องรดา ")).toBe("more-detail"); // trimmed
    expect(decideDuplicate(["น้องรดา"], "น้องต้น")).toBe("ok");
    expect(decideDuplicate([], "น้องรดา")).toBe("ok");
  });

  test("🚫 the message asks for a surname/nickname and never says 'rename'", () => {
    // Two real children can share a name. A rename demand is both wrong AND a disclosure — it confirms to
    // whoever typed the phone that such a child exists.
    const th = t("add_dup_detail", "TH");
    expect(th).toContain("นามสกุลหรือชื่อเล่น");
    expect(th).not.toContain("ตั้งใหม่");
    expect(t("add_dup_detail", "EN").toLowerCase()).not.toContain("rename");
  });

  test("it does not reveal WHOSE child the existing one is", () => {
    // The message is a constant: no name, no parent, nothing interpolated from the roster.
    expect(t("add_dup_detail", "TH")).not.toContain("{");
  });

  test("the duplicate check runs on the NAME step only — the detail step is the answer, not a second question", () => {
    expect(FLOW).toContain('if (session.step === "AWAIT_STUDENT_NAME") {');
    expect(FLOW).toContain("decideDuplicate(");
    expect(nextStep("AWAIT_STUDENT_NAME", "more-detail")).toBe("AWAIT_STUDENT_DETAIL");
    expect(nextStep("AWAIT_STUDENT_DETAIL")).toBe("AWAIT_STUDENT_BIRTHDATE");
  });
});

describe("the step machine — one place, so no branch can skip the confirm", () => {
  test("the happy path always ends at CONFIRM", () => {
    expect(nextStep("AWAIT_STUDENT_NAME")).toBe("AWAIT_STUDENT_BIRTHDATE");
    expect(nextStep("AWAIT_STUDENT_BIRTHDATE")).toBe("AWAIT_STUDENT_PROVINCE");
    expect(nextStep("AWAIT_STUDENT_PROVINCE")).toBe("AWAIT_STUDENT_CONFIRM");
    expect(nextStep("AWAIT_STUDENT_CONFIRM")).toBe("AWAIT_STUDENT_CONFIRM");
  });

  test("every wizard step routes to `add-student`, from ONE list", () => {
    // The router and the handler read the same constant, so they cannot disagree about what "in this flow"
    // means — the drift that would let a step fall through to silence mid-registration.
    for (const step of ADD_STUDENT_STEPS) {
      expect(isAddStudentStep(step)).toBe(true);
      expect(decideMessageRoute(step, "customer")).toBe("add-student");
    }
    expect(isAddStudentStep("AWAIT_CODE")).toBe(false);
    expect(isAddStudentStep(null)).toBe(false);
  });
});

describe("the birthdate is parsed strictly — a wrong date cannot be undone", () => {
  test("`YYYY-MM-DD` is accepted; skip yields null", () => {
    expect(parseBirthDate("2018-04-02")).toEqual({ ok: true, value: "2018-04-02" });
    expect(parseBirthDate("2018/4/2")).toEqual({ ok: true, value: "2018-04-02" });
    expect(parseBirthDate("ข้าม")).toEqual({ ok: true, value: null });
    expect(isSkip("skip")).toBe(true);
  });

  test("🔴 an impossible date is REFUSED, not rolled forward", () => {
    // `new Date("2026-02-31")` silently becomes March 3. A birthdate that quietly becomes the wrong date is
    // worse than one nobody entered, and this roster has no delete to fix it with.
    expect(parseBirthDate("2026-02-31").ok).toBe(false);
    expect(parseBirthDate("2018-13-01").ok).toBe(false);
    expect(parseBirthDate("yesterday").ok).toBe(false);
    expect(parseBirthDate("02-04-2018").ok).toBe(false);
  });

  test("a bad format re-asks rather than guessing — and TASK-245: the re-ask COUNTS", () => {
    // 🔴 Changed by TASK-245, deliberately. This used to pin a bare `reply`, and that bare `reply` is why rule 5
    // never fired for the owner: he typed `เมนู` at this step, was told the date was malformed, and the strike
    // counter never moved — so the second attempt re-asked instead of fetching a person.
    expect(FLOW).toContain("if (!parsed.ok) return strikeOrPrompt(");
    expect(FLOW).toContain('t("add_birthdate_bad", lang)');
    expect(FLOW).not.toMatch(/if \(!parsed\.ok\) return reply\(/);
  });
});

describe("🔴 AC-11 — an admin is notified on success", () => {
  test("it reuses `notifyAdmins`, not a second recipient list", () => {
    // `notifyAdmins` writes a loud SKIPPED row when no admin is configured (TASK-152's lesson), so a
    // mis-configured environment is visible instead of silently dropping the hand-off.
    expect(FLOW).toContain("await notifyAdmins(");
    expect(FLOW).not.toContain("getAdminLineUserIds(");
    expect(FLOW).toContain('kind: "student_registered"');
  });

  test("the notification happens only AFTER the row exists", () => {
    expect(FLOW.indexOf("createStudentForParent(")).toBeLessThan(FLOW.indexOf("notifyAdmins("));
  });
});

// ═══ The two additions Sober asked for at review ═══
describe("🔴 the 2FA code moved OUT of `pending_role` into `draft`", () => {
  test("it is written to `draft` and read back through one accessor", () => {
    // The SA's stated condition on TASK-232 was "a proper column the next time a migration is open anyway".
    // `0031` was that moment — and still UNRUN, so the move costs nothing today. Skipping it would have made a
    // column named "what this step is waiting on" permanently hold a 2FA code AND a three-field wizard.
    expect(SVC).toContain("draft: { twoFaCode: code }");
    expect(SVC).toContain("const twoFaCodeOf =");
    expect(SVC).toContain("matches2faCode(twoFaCodeOf(session), text)");
  });

  test("🚫 nothing reads the 2FA code out of `pending_role` any more", () => {
    expect(SVC).not.toContain("matches2faCode(session.pendingRole");
    // `pending_role` still means what its name says — the linking role — and nothing else.
    expect(SVC).toContain("session.pendingRole as LinkRole");
  });
});

describe("🔴 the per-parent cap is asked at the NAME step, not at the write", () => {
  test("it calls the SAME precondition the write calls — extracted, not copied", () => {
    // A second "how many is too many" at the call site is the duplicated rule that drifts. One definition,
    // one message, two callers.
    expect(SVC).toContain("await assertCanAddStudent(parent.id)");
    expect(PARENT_SVC).toContain("export async function assertCanAddStudent");
    expect(PARENT_SVC).toContain("await assertCanAddStudent(parentId, exec)");
    // …and the rule itself exists exactly once.
    expect(PARENT_SVC.match(/>= MAX_STUDENTS_PER_PARENT/g)).toHaveLength(1);
  });

  test("the write still enforces it — this is a courtesy check in front of the real one", () => {
    // If the early check were a REPLACEMENT, a race or a second entry point would slip past the cap.
    const create = PARENT_SVC.slice(
      PARENT_SVC.indexOf("export async function createStudentForParent"),
      PARENT_SVC.indexOf("Staff student creation"),
    );
    expect(create).toContain("assertCanAddStudent(parentId, exec)");
  });

  test("a parent at the cap is refused BEFORE the first question, and the session is cleared", () => {
    const early = code(FLOW).slice(0, code(FLOW).indexOf("decideDuplicate("));
    expect(early).toContain("assertCanAddStudent(parent.id)");
    expect(early).toContain("clearSession(lineUserId)");
  });

  test("the count the write returns is the one the precondition already paid for — no second query", () => {
    expect(PARENT_SVC).toContain("const existingCount = await assertCanAddStudent(parentId, exec)");
    expect(PARENT_SVC).toContain("count: existingCount + 1");
  });
});

describe("🚫 what this flow must NOT do", () => {
  test("no auto-scheduling — a human puts the child on the calendar", () => {
    for (const w of ["createBooking", "insertBooking", "bookings"]) expect(FLOW).not.toContain(w);
  });

  test("🔴 AC-20 — no money path is reachable from the wizard module or this flow", () => {
    // A rule the build enforces beats one in prose (TASK-223's shape).
    const MONEY = [
      "recordSale",
      "postBookingSale",
      "boMovement",
      "boItem",
      "applyHoldMove",
      "reconcileBookingHolds",
      "otherPriceMinor",
      "discountKind",
    ];
    for (const src of [WIZARD, FLOW]) {
      for (const m of MONEY) expect(src).not.toContain(m);
    }
    expect(WIZARD).not.toContain("import { db }");
  });

  test("no parent-side delete — §7(b) is a recommendation the owner has not ruled on", () => {
    // Comments stripped: both files DISCUSS the roster having no delete — that reasoning is the whole argument
    // for the confirm step, and a test that read prose would fail on the explanation it depends on.
    const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(FLOW).not.toContain("delete(students");
    expect(code(WIZARD)).not.toContain("delete");
  });
});
