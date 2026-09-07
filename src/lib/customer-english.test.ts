// TASK-278 (REQ-079 §17b) — the customer's English, now that it is in the repo.
//
// 📌 Not a correction of TASK-275. That pass was right against the only source that existed; **the source was
// the problem, not the work** — §17 held @Porter's ANALYSIS of the eight screens, never the strings, and the
// transcript arrived afterwards.
//
// 🔑 The interesting half of this file is not the copy. It is the FIVE places their text must not be applied
// literally — each one a rule this repo already owns, each one a decision their copy could silently undo.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./line-i18n";
import { formatPhoneForDisplay, normalizePhone } from "./line-webhook";
import { formatOutboxMessage } from "./line-message";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));
const en = (key: string) => t(key, "EN");

describe("TASK-278 §2 — each mapped key carries §17b's sentence", () => {
  test("screen 1 · start", () => {
    expect(en("welcome")).toContain(`Please type 'register' to start.`);
  });

  test("screen 3 · phone", () => {
    expect(en("code_customer")).toBe("Please enter your phone number to continue.");
  });

  test("screen 4 · registration completed — their sentence, OUR variables", () => {
    expect(en("verify_parent_ok_existing")).toContain("Registration completed ✅");
    expect(en("verify_parent_ok_new")).toContain("Registration completed ✅");
  });

  test("screen 4 · student name and the cap", () => {
    for (const key of ["add_student_prompt", "add_student_name_prompt"]) {
      expect(en(key)).toContain(`Please enter the student's name, e.g. "Emily".`);
      expect(en(key)).toContain("You can add up to {max} students per phone number.");
    }
  });

  test("screen 5 · date of birth", () => {
    expect(en("add_birthdate_prompt")).toContain("Please enter the date of birth.");
  });

  test("screen 6 · province", () => {
    expect(en("add_province_prompt")).toContain("Please enter your current province");
  });

  test("screen 7 · check, and correct?", () => {
    expect(en("add_summary_head")).toBe("Please check your information before saving.");
    expect(en("add_summary_confirm")).toContain("Is this information correct?");
    expect(en("add_summary_confirm")).toContain(`Please type "Confirm" to save.`);
  });

  test("screen 8 · added", () => {
    expect(en("added_done")).toContain(`"{name}" has been added successfully. ✅`);
  });
});

describe("TASK-278 §4 — the five places their text is NOT applied literally", () => {
  test("🔴 1. the exit prints ONCE — `withExit` already appends it (TASK-245)", () => {
    // Their screen 7 has three lines and only two belong in the string. Putting `Type "Cancel" to exit.` back
    // inside `add_summary_confirm` prints it twice on the ONE step that used to have it inline — the exact bug
    // TASK-245's own comment records.
    expect(en("add_summary_confirm").toLowerCase()).not.toContain("cancel");
    expect(t("add_summary_confirm", "TH")).not.toContain("ยกเลิก");
    // …and the exit still exists, exactly once, in the place that appends it.
    expect(en("add_exit_hint").toLowerCase()).toContain("cancel");
    expect(src("src/services/line-webhook.service.ts")).toContain(
      'const withExit = (question: string, lang: Lang) => `${question}${t("add_exit_hint", lang)}`;',
    );
  });

  test("🔴 2. `{list}` and `{phone}` survive — TASK-047's privacy decision is not a wording", () => {
    // Their "Registration completed ✅" has no children line. Ours does, and it is a COUNT rather than names
    // because anyone can type a phone number. Dropping it to match their text would undo a decision.
    expect(en("verify_parent_ok_existing")).toContain("{list}");
    expect(en("verify_parent_ok_existing")).toContain("{phone}");
    expect(en("verify_parent_ok_new")).toContain("{phone}");
    expect(en("verify_parent_children_count")).toContain("{n}");
  });

  test("🔴 3. `{max}` is a VARIABLE — their copy hardcodes 5", () => {
    for (const key of ["add_student_prompt", "add_student_name_prompt"]) {
      for (const lang of ["TH", "EN"] as const) {
        expect({ key, lang, hasVar: t(key, lang).includes("{max}") }).toEqual({ key, lang, hasVar: true });
        // A literal would be a second place to change the cap, and the one nobody would remember.
        expect({ key, lang, literal: /up to 5 |สูงสุด 5 |ได้สูงสุด 5 /.test(t(key, lang)) }).toEqual({
          key,
          lang,
          literal: false,
        });
      }
    }
  });

  test("🔴 4. the DOB format and `skip` survive their sentence", () => {
    // Their copy omits both. TASK-277's format is an OWNER RULING; a copy pass does not get to drop it.
    const e = en("add_birthdate_prompt");
    expect(e).toContain("DD-MM-YYYY");
    expect(e).toContain("02-12-2024");
    expect(e.toLowerCase()).toContain("skip");
    expect(t("add_birthdate_prompt", "TH")).toContain("ข้าม");
  });

  test("🔴 5. no inline `Thai / English` label — the summary stays BLOCK per language", () => {
    // Their `ชื่อ / Name:` slash-pairs are DOCUMENT formatting; @Porter already ruled the headings are section
    // titles and the field labels are the same shape. A message with two bilingual conventions is TASK-257 §3
    // exactly — `จำนวนคาบที่ยืนยัน` under eight English labels. One message, one convention.
    for (const key of ["add_l_name", "add_l_birthdate", "add_l_province"]) {
      for (const lang of ["TH", "EN"] as const) {
        expect({ key, lang, inlinePair: / \/ /.test(t(key, lang)) }).toEqual({ key, lang, inlinePair: false });
      }
    }
    // The summary is composed by `both()`, i.e. a whole Thai block then a whole English one.
    expect(src("src/services/line-webhook.service.ts")).toContain(
      'both((l) => `${t("add_summary_head", l)}',
    );
  });
});

describe("TASK-278 §3 — screen 2 contributes nothing, and `role_prompt` is untouched", () => {
  test("🚫 we do not instruct a word the bot does not accept", () => {
    // Their only screen-2 string is *"Please type "Next" to continue."* and we ship quick-reply BUTTONS
    // (TASK-251) — the fix for their own 1/2/3 collision. Applying their sentence would tell a parent to type
    // a word `parseRoleChoice` rejects.
    expect(en("role_prompt")).toBe("Who are you? Tap a button below, or type: parent · teacher · admin");
    expect(en("role_prompt")).not.toContain("Next");
    expect(t("role_prompt", "TH")).not.toContain("Next");
  });
});

describe("TASK-278 §6 — the phone is DISPLAYED formatted, and nothing else changes", () => {
  test("🔑 `0825031502` → `082-503-1502` — their screen 4's own shape", () => {
    expect(formatPhoneForDisplay("0825031502")).toBe("082-503-1502");
  });

  test("⚠️ an unrecognised number passes through UNCHANGED, never mangled into groups", () => {
    // We accept whatever people type — `normalizePhone` only strips non-digits — so a 9-digit landline or an
    // international form reaches here. Inventing a shape for a number we do not recognise prints something the
    // parent has never seen and cannot check against their phone.
    for (const odd of ["021234567", "66825031502", "12345", "", "08250315021"]) {
      expect({ odd, out: formatPhoneForDisplay(odd) }).toEqual({ odd, out: odd });
    }
  });

  test("🚫 it is NOT the inverse of `normalizePhone`, and has no caller outside the message layer", () => {
    // A formatted number reaching a lookup is how a family stops matching their own record.
    expect(normalizePhone("082-503-1502")).toBe("0825031502"); // unchanged behaviour
    const svc = src("src/services/line-webhook.service.ts");
    // Every use is inside a `t(...)` interpolation — three of them, all in the verify messages.
    const uses = [...svc.matchAll(/formatPhoneForDisplay\(/g)];
    expect(uses.length).toBe(3); // three call sites — the import line has no `(`
    for (const m of uses) {
      const before = svc.slice(Math.max(0, m.index! - 160), m.index!);
      expect({ at: m.index, inMessage: before.includes("t(\"verify_parent_ok") }).toEqual({
        at: m.index,
        inMessage: true,
      });
    }
    // 🚫 And nowhere near a lookup or a write.
    expect(svc).not.toMatch(/findParentByPhone\(formatPhoneForDisplay/);
    expect(svc).not.toMatch(/findOrCreateParentByPhone\(formatPhoneForDisplay/);
  });

  test("🚫 no other module calls it", () => {
    const callers = ["src/services/parent.service.ts", "src/services/scheduler.service.ts", "src/routes/api.ts"];
    for (const f of callers) {
      expect({ f, calls: src(f).includes("formatPhoneForDisplay") }).toEqual({ f, calls: false });
    }
  });
});

describe("TASK-278 §5 — nothing else moved", () => {
  test("🚫 every Thai string in the mapped keys is byte-identical", () => {
    // This pass has no business touching Thai. §7's one intended exception is the VALUE interpolated into
    // `{phone}`, not the strings — so the claim stays exactly true.
    const TH: Record<string, string> = {
      code_customer: "กรุณาพิมพ์เบอร์โทรของผู้ปกครอง (เช่น 0812345678)",
      verify_parent_ok_existing: "ผูกบัญชีผู้ปกครองสำเร็จ ✅ (เบอร์ {phone}){list}",
      verify_parent_ok_new: "ลงทะเบียนผู้ปกครองสำเร็จ ✅ (เบอร์ {phone})",
      add_student_name_prompt: "พิมพ์ชื่อนักเรียนที่ต้องการเพิ่ม (สูงสุด {max} คนต่อเบอร์)",
      add_province_prompt: "จังหวัดที่อยู่ หรือพิมพ์ ข้าม ค่ะ",
      add_summary_head: "ตรวจสอบข้อมูลก่อนบันทึกนะคะ",
      add_summary_confirm: "ถูกต้องไหมคะ? พิมพ์ ยืนยัน เพื่อบันทึก",
      added_done: 'เพิ่ม "{name}" สำเร็จ ✅{note}',
    };
    for (const [key, value] of Object.entries(TH)) {
      expect({ key, th: t(key, "TH") }).toEqual({ key, th: value });
    }
  });

  test("🚫 the six notifications are untouched", () => {
    const COURSE = {
      kind: "course_confirmed",
      studentName: "น้องเอ",
      subject: "Private Freeskate",
      bookingType: "COURSE_PACKAGE",
      size: 6,
      expiryDate: "2026-12-31",
      coach: "ครูหนึ่ง",
      startDate: "2026-09-06",
      weekday: 0,
      startTime: "10:00",
      endTime: "11:00",
      plannedLeaveDates: ["2026-09-14"],
      note: "แพ้ถั่ว",
    };
    const out = formatOutboxMessage(COURSE, {}, "TH", "parent");
    expect(out).toContain("📅CONFIRMED SCHEDULE:");
    expect(out).toContain("Sessions : 6");
    expect(out).toContain("Remark : แพ้ถั่ว");
    // …and no customer copy leaked in.
    expect(out).not.toContain("Registration completed");
  });
});
