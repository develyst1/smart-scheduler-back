// TASK-278 (REQ-079 §17b) — the customer's English, now that it is in the repo.
//
// 📌 Not a correction of TASK-275. That pass was right against the only source that existed; **the source was
// the problem, not the work** — §17 held @Porter's ANALYSIS of the eight screens, never the strings, and the
// transcript arrived afterwards.
//
// 🔑 The interesting half of this file is not the copy. It is the FIVE places their text must not be applied
// literally — each one a rule this repo already owns, each one a decision their copy could silently undo.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 🔻 **TASK-310 (2026-09-09) — §17b's TEXT IS SUPERSEDED BY `§17c`, and half of this file with it.**
//
// The customer sent finished copy for the same eight screens on 2026-09-08 and the owner ruled it the spec
// (*"ลูกค้าส่งมาให้ทำตามเลย"*). ⇒ **the byte pins below are re-pointed at `§17c`, or retracted with the reason.**
// 🔑 **Read the retractions as the SCORE OF §17b's five judgements**, because that is the question TASK-310
// asks and `REQ-086` will ask again: of the five places we chose NOT to apply their text literally, **three
// were right and survive verbatim, and TWO were us reading a document convention as a decision.**
// 🚫 What is NOT retracted is the §6 phone work and the notification sweep — those were never about §17b's
// wording, and they still pass exactly as written.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./line-i18n";
import { formatPhoneForDisplay, normalizePhone, parseRoleChoice } from "./line-webhook";
import { formatOutboxMessage } from "./line-message";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));
const en = (key: string) => t(key, "EN");

describe("🔻 TASK-278 §2 — §17b's sentences, RE-POINTED at §17c (TASK-310)", () => {
  // ⚠️ The eight screens are pinned BYTE-FOR-BYTE in `registration-copy-req085.test.ts`, against §17c. What
  // stays here is the QUESTION TASK-310 asks: **which of their sentences did we already have right?**
  test("✅ four sentences survive §17c word for word — we had them right from §17b", () => {
    // 🔑 These are the ones where the newer transcript changed nothing at all, and they are all ENGLISH:
    // §17b was a transcript of the same document's English column, so where their English did not move,
    // neither did ours. **This is the answer to the Question: our wording was right wherever we COPIED it.**
    expect(en("welcome")).toContain(`Please type "register" to start.`);
    expect(en("add_summary_head")).toContain("Please check your information before saving.");
    expect(en("add_summary_confirm")).toContain("Is this information correct?");
    expect(en("added_done")).toContain(`"{name}" has been added successfully. ✅`);
    expect(en("add_student_prompt")).toContain(`Please enter the student's name, e.g. "Emily".`);
  });

  test("🔴 …and four were WRONG in a way a parent would have noticed", () => {
    // 🔑 Not tone. Each of these told a parent to do something the screen no longer asks of them:
    // · screen 2 named THREE roles where §17c offers one path (`Next`) — `REQ-085 §5`'s whole subject;
    // · screen 3 asked for *"the PARENT'S phone"* with an example, where theirs asks plainly;
    // · screen 5 offered a `skip` their sentence does not;
    // · screen 6 asked for a PROVINCE where theirs asks for an address in three named parts.
    expect(t("role_prompt", "TH")).toContain("Next");
    expect(en("code_customer")).toContain("Please enter your phone number.");
    expect(en("code_customer")).not.toContain("to continue");
    expect(en("add_birthdate_prompt")).not.toContain("skip");
    expect(en("add_province_prompt")).toContain("District, Sub-district, Province");
  });

  test("screen 4 · registration completed — their sentence, OUR variables", () => {
    expect(en("verify_parent_ok_existing")).toContain("Registration completed ✅");
    expect(en("verify_parent_ok_new")).toContain("Registration completed ✅");
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

  test("🔻 3. `{max}` was a VARIABLE — and the SENTENCE holding it is gone (TASK-310)", () => {
    // ✅ **The judgement was right and is retracted anyway**, which is worth separating: a hardcoded `5` would
    // still be a second place to change the cap. §17c simply has no cap sentence on screen 4 at all.
    // ⇒ nothing interpolates `{max}` there any more, and the cap is enforced where it always was.
    for (const key of ["add_student_prompt", "add_student_name_prompt"]) {
      for (const lang of ["TH", "EN"] as const) {
        expect({ key, lang, hasVar: t(key, lang).includes("{max}") }).toEqual({ key, lang, hasVar: false });
        // 🔑 And still no literal cap anywhere in that copy — the retraction removes the sentence, not the rule.
        expect({ key, lang, literal: /up to 5 |สูงสุด 5 |ได้สูงสุด 5 /.test(t(key, lang)) }).toEqual({
          key,
          lang,
          literal: false,
        });
      }
    }
    // 🚫 The cap itself is untouched: it is a precondition on the WRITE, asked at the first step as a courtesy.
    expect(src("src/services/line-webhook.service.ts")).toContain("await assertCanAddStudent(parent.id);");
    expect(t("added_atmax_note", "TH")).toContain("{max}");
  });

  test("🔻 4. the DOB FORMAT survives — `skip` does not, and the rejection carries it (TASK-310)", () => {
    // 🔑 **Half right, and the half that mattered.** TASK-277's format IS an owner ruling and §17c states it in
    // both languages, so it survives their sentence exactly as this test demanded. The `skip` was OURS, and
    // §17c's screen 5 does not offer it ⇒ it stops being advertised on the PROMPT. ⚠️ `add_birthdate_bad` is
    // not one of their screens, so a parent who cannot answer is refused once and told both — see
    // `birthdate-format.test.ts`, where the pair is asserted together.
    const e = en("add_birthdate_prompt");
    expect(e).toContain("DD-MM-YYYY");
    expect(e.toLowerCase()).not.toContain("skip");
    expect(t("add_birthdate_bad", "TH")).toContain("ข้าม");
    expect(t("add_birthdate_bad", "EN")).toContain("02-12-2024");
  });

  test("🔴 5. WRONG — their `ชื่อ / Name:` slash-pairs were a DECISION, not document formatting (TASK-310)", () => {
    // 🔻 **This is the one I would flag hardest of the five.** §17b's reading was that the slash-pairs are the
    // same kind of thing as the numbered headings — document furniture — and §17f later ruled the HEADINGS out
    // on exactly that reasoning. ⚠️ **The labels are not the headings**: they sit INSIDE the message body, in
    // the middle of the screen the parent reads, and §17c prints them there in every one of their examples.
    // ⇒ the summary's labels are bilingual pairs, and the block-per-language convention it was protecting is
    // satisfied a different way — **the whole §17c screen is one block that is already both languages.**
    for (const key of ["add_l_name", "add_l_birthdate", "add_l_province"]) {
      for (const lang of ["TH", "EN"] as const) {
        expect({ key, lang, inlinePair: / \/ /.test(t(key, lang)) }).toEqual({ key, lang, inlinePair: true });
      }
    }
    // 🚫 And TASK-257 §3's rule is NOT reopened: this message still has ONE convention, it is just theirs now.
    expect(src("src/services/line-webhook.service.ts")).toContain('`${t("add_summary_head", lang)}');
  });
});

describe("🔻 TASK-278 §3 — screen 2 contributed EVERYTHING, and `role_prompt` is theirs now (TASK-310)", () => {
  test("🔴 the word we refused to instruct is the word the parser now accepts FIRST", () => {
    // 🔻 **The reasoning was sound and the conclusion was backwards.** *"Do not instruct a word the bot does
    // not accept"* is right — but the fix available was to make the bot accept it, and their screen 2 is the
    // one place `REQ-085 §5` actually lives: **one path offered, the other roles never named.** ⇒ `Next` is
    // taught and parsed, the picker is deleted, and the older words stay accepted without being advertised.
    expect(en("role_prompt")).toBe('กรุณาพิมพ์ "Next" เพื่อเข้าใช้งานค่ะ\nPlease type "Next" to continue.');
    expect(parseRoleChoice("Next")).toBe("customer");
    expect(parseRoleChoice("next")).toBe("customer");
    // …and what TASK-251 was protecting is intact: no digit is asked for, and none is accepted.
    expect(t("role_prompt", "TH")).not.toMatch(/[0-9๐-๙]/);
    expect(parseRoleChoice("1")).toBeNull();
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
  test("🔻 the Thai DID move — one task later, and by the customer's own hand (TASK-310)", () => {
    // ⏸️ This pinned *"§17b has no business touching Thai"*, and that stayed true for TASK-278. **§17c is a
    // different kind of source**: it is the customer writing BOTH languages for these screens, so the Thai is
    // theirs to move. ⚠️ Retained as the list of exactly WHICH Thai strings a copy pass may change — the eight
    // §17c screens and nothing else — with the untouched one asserted beside them.
    const MOVED = [
      "code_customer",
      "verify_parent_ok_new",
      "add_student_name_prompt",
      "add_province_prompt",
      "add_summary_head",
      "add_summary_confirm",
      "added_done",
    ];
    for (const key of MOVED) {
      // Every one is now a bilingual block: the same string whichever language is asked for.
      expect({ key, same: t(key, "TH") === t(key, "EN") }).toEqual({ key, same: true });
    }
    // 🚫 `verify_parent_ok_existing` is NOT a §17c screen — a returning family is not registering — and it is
    // byte-identical to what TASK-278 pinned. **The blast radius of a copy pass is a thing to keep asserting.**
    expect(t("verify_parent_ok_existing", "TH")).toBe("ผูกบัญชีผู้ปกครองสำเร็จ ✅ (เบอร์ {phone}){list}");
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
