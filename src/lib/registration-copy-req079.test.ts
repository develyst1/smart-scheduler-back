// TASK-310 (`REQ-085 §5` via `REQ-079 §17c`) — the registration copy is the CUSTOMER'S words.
//
// 🔑 **The words are the SPEC** (*"ลูกค้าส่งมาให้ทำตามเลย"*), so this file pins them BYTE-FOR-BYTE rather than
// by keyword. ⚠️ A `toContain` here would pass on a sentence with a word missing from the middle of it, and
// **this is the one flow today where a wrong string is met by a stranger rather than by staff.**
//
// 🔴 **The assertion that carries `REQ-085 §5` is an ABSENCE**, and it is deliberately last: `ครู`, `แอดมิน`
// and `CEO` appear NOWHERE in what a registering parent is sent. Everything above it is the copy that carries
// it — §5 is made of copy rather than code, which is exactly why it needs asserting rather than reading.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REGISTRATION_COPY, REGISTRATION_KEYS, both, t, tb } from "./line-i18n";
import { parseRoleChoice } from "./line-webhook";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));

/**
 * 🔑 `REQ-079 §17c`, transcribed here as the customer sent it — the ONE place this file's expectations come
 * from. ⚠️ Written out as literals rather than imported from the i18n table: a test that reads the value it
 * is checking asserts nothing at all. **The two copies of these words are the spec and the shipped string,
 * and this is where they meet.**
 */
const SCREEN = {
  1: 'กรุณาพิมพ์ "สมัคร" เพื่อลงทะเบียนค่ะ\nPlease type "register" to start.',
  2: 'กรุณาพิมพ์ "Next" เพื่อเข้าใช้งานค่ะ\nPlease type "Next" to continue.',
  3: "กรุณาระบุเบอร์โทรศัพท์ค่ะ\nPlease enter your phone number.",
  "4a": "ลงทะเบียนผู้ปกครองสำเร็จแล้วค่ะ\nRegistration completed ✅\nเบอร์โทรศัพท์ / Phone: {phone}",
  "4b": 'กรุณาระบุชื่อนักเรียน เช่น "ส้ม"\nPlease enter the student\'s name, e.g. "Emily".',
  5: "กรุณาระบุวันเกิดของนักเรียนค่ะ\n(วัน-เดือน-ปีค.ศ. )\nPlease enter the date of birth in (DD-MM-YYYY)",
  6: "กรุณาระบุ เขต แขวง จังหวัด เช่น พระโขนงเหนือ วัฒนา กทม\nPlease enter your address: District, Sub-district, Province\nEg. Prakanueng Nuea, Wattana, BKK",
  "7a": "กรุณาตรวจสอบข้อมูลก่อนบันทึกค่ะ\nPlease check your information before saving.",
  "7b": 'ข้อมูลถูกต้องหรือไม่คะ?\nIs this information correct?\nกรุณาพิมพ์ "ยืนยัน" เพื่อบันทึก\nPlease Type "Confirm" to save.',
  "8a": 'เพิ่ม "{name}" สำเร็จแล้วค่ะ\n"{name}" has been added successfully. ✅{note}',
  "8b":
    'หากต้องการเพิ่มนักเรียนเข้าระบบ\nกรุณาพิมพ์ "เพิ่มนักเรียน" ค่ะ\nIf you would like to add another student,\nplease type "Add Student".',
} as const;

describe("🔑 TASK-310 §2 — the eight screens, BYTE-FOR-BYTE against §17c", () => {
  test("screens 1 · 2 · 3 — the entry keyword, the one path, the phone", () => {
    expect(t("welcome", "TH")).toBe(SCREEN[1]);
    expect(t("role_prompt", "TH")).toBe(SCREEN[2]);
    expect(t("code_customer", "TH")).toBe(SCREEN[3]);
  });

  test("screen 4 — the success line and the name prompt, and the phone is a VARIABLE", () => {
    // 🔴 `§17d-4`, ruled by the owner: their `082-503-1502` is **the number the person just typed**. A literal
    // would have shipped their example to every family.
    expect(t("verify_parent_ok_new", "TH")).toBe(SCREEN["4a"]);
    expect(t("verify_parent_ok_new", "TH", { phone: "082-503-1502" })).toContain("Phone: 082-503-1502");
    expect(t("add_student_prompt", "TH")).toBe(SCREEN["4b"]);
    // 🔑 The re-ask is the same sentence — one wording for one question (TASK-307 §3).
    expect(t("add_student_name_prompt", "TH")).toBe(SCREEN["4b"]);
  });

  test("🔑 all FIVE `add_student_name_prompt` call sites agree — the property TASK-307 was protecting", () => {
    // ⚠️ TASK-307 §5 ruled this prompt SINGLE-language, to stop the re-ask being bilingual while the first ask
    // was not. **§17c supersedes the ruling and satisfies the property in the other direction**: every site
    // renders the identical bilingual block, so the five cannot disagree even in principle.
    // 📌 Asserted on the EXPRESSION, because that is what makes them one wording rather than five that happen
    // to match today.
    expect(SVC.match(/t\("add_student_name_prompt", lang\)/g)!.length).toBe(5);
    expect(SVC).not.toMatch(/t\("add_student_name_prompt", lang, /);
    expect(SVC).not.toMatch(/tb\("add_student_name_prompt"/);
  });

  test("screens 5 · 6 — the birthdate and the ADDRESS", () => {
    expect(t("add_birthdate_prompt", "TH")).toBe(SCREEN[5]);
    expect(t("add_province_prompt", "TH")).toBe(SCREEN[6]);
  });

  test("screen 7 — head, the three labels, confirm", () => {
    expect(t("add_summary_head", "TH")).toBe(SCREEN["7a"]);
    expect(t("add_summary_confirm", "TH")).toBe(SCREEN["7b"]);
    // Their labels, in their shape — `ชื่อ / Name: น้องส้ม` is how the line reads once `summaryLines` joins it.
    expect(t("add_l_name", "TH")).toBe("ชื่อ / Name");
    expect(t("add_l_birthdate", "TH")).toBe("วันเดือนปีเกิด / Date of Birth");
    expect(t("add_l_province", "TH")).toBe("ที่อยู่ / Address");
  });

  test("screen 8 — added, and the invitation to add another", () => {
    expect(t("added_done", "TH")).toBe(SCREEN["8a"]);
    expect(t("add_another_hint", "TH")).toBe(SCREEN["8b"]);
  });

  test("🔑 every screen is LANGUAGE-INVARIANT — that is what `bilingual` means here", () => {
    // §17c writes Thai and English into one block, interleaved line by line. ⇒ there is nothing to switch,
    // and a parent whose LINE is in English reads the identical screen a Thai parent does.
    for (const key of REGISTRATION_KEYS) {
      expect({ key, same: t(key, "TH") === t(key, "EN") }).toEqual({ key, same: true });
    }
  });

  test("🚫 …so `both()` refuses to send one twice — asserted on the JOINER, not on a call site", () => {
    // 🔴 The failure this closes is invisible in code review: `tb("welcome")` reads fine and would have sent
    // the customer's whole screen twice. The rule lives in `both()` so no call site has to know.
    for (const key of REGISTRATION_KEYS) expect(tb(key)).toBe(t(key, "TH"));
    expect(both(() => "same")).toBe("same");
    // …and a body that genuinely differs is still joined, Thai above English.
    expect(both((l) => (l === "TH" ? "ไทย" : "EN"))).toBe("ไทย\nEN");
  });

  test("🚫 NONE of the eight numbered headings is sent (`§17f`)", () => {
    // 🔴 Screen 2's especially: *"เลือกบทบาท / Select Your Role"* above a message offering ONE option would
    // tell a parent both that roles exist AND that they were not offered a choice — **the one heading whose
    // text defeats the requirement its own screen exists to satisfy.**
    const all = REGISTRATION_KEYS.map((k) => t(k, "TH")).join("\n");
    for (const heading of [
      "เริ่มลงทะเบียน",
      "Start Registration",
      "เลือกบทบาท",
      "Select Your Role",
      "Phone Number",
      "เพิ่มนักเรียน / Add a Student",
      "ตรวจสอบข้อมูล / Confirm",
      "เพิ่มนักเรียนสำเร็จ",
      "Student Added Successfully",
    ]) {
      expect({ heading, sent: all.includes(heading) }).toEqual({ heading, sent: false });
    }
    // ⚠️ Heading 5 (*"วันเดือนปีเกิด / Date of Birth"*) is NOT in that list, and the reason is the interesting
    // one: those exact words ARE sent — as screen 7's FIELD LABEL, inside the message body, which is where
    // their own examples put them. ⇒ the thing that identifies a heading is not its words but its NUMBER.
    expect(all).toContain("วันเดือนปีเกิด / Date of Birth");
    for (const line of all.split("\n")) expect({ line, numbered: /^\d+\.\s/.test(line) }).toEqual({ line, numbered: false });
  });
});

describe("🔴 TASK-310 §3 — `REQ-085 §5`: the assertion that matters is an ABSENCE", () => {
  /** Everything a REGISTERING PARENT is sent, from the first message to the last. */
  const parentJourney = [
    t("welcome", "TH"),
    t("role_prompt", "TH"),
    t("code_customer", "TH"),
    t("verify_parent_ok_new", "TH", { phone: "082-503-1502" }),
    t("add_student_prompt", "TH"),
    t("add_birthdate_prompt", "TH"),
    t("add_province_prompt", "TH"),
    t("add_summary_head", "TH"),
    t("add_l_name", "TH"),
    t("add_l_birthdate", "TH"),
    t("add_l_province", "TH"),
    t("add_summary_confirm", "TH"),
    t("add_exit_hint", "TH"),
    t("added_done", "TH", { name: "น้องดีซี", note: "" }),
    t("add_another_hint", "TH"),
  ].join("\n");

  test("🔴 `ครู`, `แอดมิน` and `CEO` appear NOWHERE in a registering parent's messages", () => {
    // ⚠️ **This is `REQ-085 §5`.** Today the entry screen hands every parent the door AND the key —
    // *"คุณเป็นใครคะ? … ผู้ปกครอง · ครู · แอดมิน"*. After this there is ONE path offered, and a teacher or an
    // admin types their own word without being told to.
    for (const word of ["ครู", "แอดมิน", "CEO", "ผู้บริหาร", "teacher", "Teacher", "admin", "Admin"]) {
      expect({ word, shown: parentJourney.includes(word) }).toEqual({ word, shown: false });
    }
  });

  test("🔑 …and the ONE word that IS offered advances a PARENT", () => {
    expect(t("role_prompt", "TH")).toContain("Next");
    expect(parseRoleChoice("Next")).toBe("customer");
    expect(parseRoleChoice("next")).toBe("customer");
    // The entry keyword is `สมัคร` / `register` — screen 1, and NOT `Next`, which is screen 2.
    expect(src("src/lib/line-commands.ts")).toContain(
      'export const CMD_REGISTER = ["สมัคร", "register", "ลงทะเบียน", "เริ่มต้น"] as const;',
    );
    expect(t("welcome", "TH")).toContain("สมัคร");
    expect(t("welcome", "TH")).not.toContain("Next");
  });

  test("🚫 `CEO` is not a CODE PATH — the word stays in the REQ (`§17e-1`)", () => {
    // 📌 The owner struck it: *"ผู้บริหาร / CEO ข้าม"*. ⇒ no role, no keyword, no branch. Asserted on the
    // parser and on the service, because "we did not build it" is exactly the claim a test can hold.
    expect(parseRoleChoice("CEO")).toBeNull();
    expect(parseRoleChoice("ceo")).toBeNull();
    expect(parseRoleChoice("ผู้บริหาร")).toBeNull();
    expect(code(src("src/lib/line-webhook.ts"))).not.toContain("CEO");
    expect(SVC).not.toContain('"CEO"');
  });

  test("⚠️ `ครู` / `แอดมิน` are still ACCEPTED — guessable BY DECISION, not by oversight", () => {
    // `§17e-2`: the owner accepted the trade knowingly after @Porter named it. §5 is satisfied by not
    // ADVERTISING the roles, not by making them unguessable. 🚫 **Nobody re-opens this as a defect.**
    expect(parseRoleChoice("ครู")).toBe("teacher");
    expect(parseRoleChoice("แอดมิน")).toBe("admin");
  });
});

describe("🚫 TASK-310 §4 — what this pass must NOT have moved", () => {
  test("🔴 `LEAVE_NOTICE_TOO_LATE` still stands (`§12.2`)", () => {
    // ⚠️ Named in the task because today's §12 work removed the OTHER refusals. Removing this one would be a
    // regression, not this batch — and I raised its `UC-029` citation as a QUESTION rather than acting on it.
    expect(src("src/services/scheduler.service.ts")).toContain("LEAVE_NOTICE_TOO_LATE");
  });

  test("🚫 the ADDRESS field and its storage are untouched — a prompt that lists parts is not a schema", () => {
    // `§17e`'s correction, in @Porter's own words. The prompt names District / Sub-district / Province as
    // GUIDANCE; the answer is and stays ONE free-text value on the household.
    expect(SVC).toContain('const province = isSkip(text) ? null : text.trim() || null;');
    expect(SVC).toContain("await db.update(parents).set({ province: draft.province })");
    expect(src("src/db/schema.ts")).toContain("province");
  });

  test("🚫 the STEPS, the state machine and `SKIP_WORDS` are unchanged", () => {
    for (const step of [
      "CHOOSE_ROLE",
      "AWAIT_CODE",
      "AWAIT_2FA",
      "AWAIT_STUDENT_NAME",
      "AWAIT_STUDENT_DETAIL",
      "AWAIT_STUDENT_BIRTHDATE",
      "AWAIT_STUDENT_PROVINCE",
      "AWAIT_STUDENT_CONFIRM",
    ]) {
      expect({ step, present: SVC.includes(`"${step}"`) }).toEqual({ step, present: true });
    }
    expect(SVC).toContain("const SKIP_WORDS: readonly string[] = CMD_SKIP;");
  });

  test("🔑 TASK-307's no-skip branch still works — and it re-asks with the NEW copy", () => {
    // The first child cannot be skipped (`REQ-085 §6`), and the sentence it re-asks with is now the
    // customer's. ⚠️ **Both halves, because a working guard that quotes retired copy is half a regression.**
    const guard = SVC.slice(
      SVC.indexOf('if (SKIP_WORDS.includes(lower) && session?.step === "AWAIT_STUDENT_NAME")'),
      SVC.indexOf("return handleAddStudentStep("),
    );
    expect(guard).toContain("if (!kids.length) {");
    expect(guard).toContain('withExit(t("add_student_name_prompt", lang), lang)');
    expect(t("add_student_name_prompt", "TH")).toBe(SCREEN["4b"]);
  });

  test("🚫 the exit still prints exactly ONCE, appended by `withExit` (TASK-245 / TASK-278 §4.1)", () => {
    // §17c screen 7 ends with *"พิมพ์ ยกเลิก เพื่อออกจากการลงทะเบียน / Type "Cancel" to exit."*. It is NOT in
    // the string: `withExit` already appends the exit to every question, and putting it back prints it twice
    // on the one step that used to carry it inline.
    expect(t("add_summary_confirm", "TH")).not.toContain("ยกเลิก");
    expect(t("add_summary_confirm", "TH").toLowerCase()).not.toContain("cancel");
    expect(t("add_exit_hint", "TH")).toContain("ยกเลิก");
    expect(SVC).toContain('const withExit = (question: string, lang: Lang) => `${question}${t("add_exit_hint", lang)}`;');
  });

  test("🚫 no notification copy leaked into this pass", () => {
    // The six §7 notification formats are a different audience and a different rule (`REQ-079 §18`: the
    // conversation is bilingual, the notifications are not). Nothing here may reach them.
    const MSG = src("src/lib/line-message.ts");
    for (const key of REGISTRATION_KEYS) expect({ key, inMsg: MSG.includes(`"${key}"`) }).toEqual({ key, inMsg: false });
  });
});

describe("🔑 TASK-310 — the screens as ASSEMBLED, not only as strings", () => {
  test("🔴 screen 4 is ONE block: their success line, their phone line, their name prompt — each ONCE", () => {
    // ⚠️ The composition is where a bilingual block gets doubled, and a doubled screen still passes every
    // string pin above. **This is the assertion that catches it.**
    const screen4 = `${both((l) => t("verify_parent_ok_new", l, { phone: "082-503-1502" }))}\n${t("add_student_prompt", "TH")}`;
    expect(screen4).toBe(
      'ลงทะเบียนผู้ปกครองสำเร็จแล้วค่ะ\nRegistration completed ✅\nเบอร์โทรศัพท์ / Phone: 082-503-1502\n' +
        'กรุณาระบุชื่อนักเรียน เช่น "ส้ม"\nPlease enter the student\'s name, e.g. "Emily".',
    );
    // …and the service builds it exactly that way — 🔻 TASK-315 through `afterParentLink`, which returns this
    // tail WITH its single leading newline for a family with NO children. **Screen 4 is the new-parent screen,
    // and a new parent has no children**, so the byte-for-byte pin above is the one that still applies here;
    // a RETURNING family is not on this screen at all (`§6.1`).
    expect(SVC).toContain("`${both(res.message)}${await afterParentLink(lineUserId, lang)}`");
    expect(SVC).toContain('return `\\n${t("add_student_prompt", lang)}`;');
  });

  test("🔑 screen 7 renders ONCE, with the labels inside it", () => {
    expect(SVC).toContain('`${t("add_summary_head", lang)}\\n${lines.join("\\n")}\\n\\n${withExit(t("add_summary_confirm", lang), lang)}`');
    expect(SVC).not.toContain('both((l) => `${t("add_summary_head", l)}');
  });

  test("🔑 screen 8 invites another child — unless the household is at the cap", () => {
    // **The words are theirs; the condition is ours** — their copy could not know about `MAX_STUDENTS_PER_PARENT`.
    expect(SVC).toContain('${atMax ? "" : "\\n" + t("add_another_hint", lang)}');
    expect(SVC.match(/atMax \? "" : "\\n" \+ t\("add_another_hint", lang\)/g)!.length).toBe(2);
  });
});
