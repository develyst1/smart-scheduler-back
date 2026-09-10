// TASK-318 (`REQ-085 §16d`/`§16e` + `§16.4` + batch 7b) — the LEAVE NOTICE, to the customer's own spec.
//
// 🔴 **The defect first, because the date is only how it is fixed.** The owner marked TWO sessions absent and
// the coach received TWO BYTE-IDENTICAL notices — *"ครูจะไม่รู้ว่าแจ้งลา พฤ ไหน"*. The sends were correct, one
// per session; **the messages could not be told apart**, so the one thing this message exists to do — *do not
// turn up for THIS class* — failed.
//
// 🔑 This is the TEACHER's side of TASK-316. Same defect, other surface, and 🚫 deliberately NOT the same
// format: `§16d` is the customer's own layout for the coach; the picker's `อังคาร 22/09` is the parent's.
// **Two surfaces, two audiences, two formats, both correct.**
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { t } from "./line-i18n";
import { ddmmyyyy } from "./time";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

/** One weekly course, two different Tuesdays — the owner's exact case. */
const leave = (date: string) =>
  formatOutboxMessage(
    {
      kind: "leave_notice",
      bookingType: "COURSE_PACKAGE",
      size: 6,
      studentName: "มะขิด",
    } as any,
    { studentName: "มะขิด", subject: "Freeskate", date, startTime: "12:00", endTime: "13:00", coach: "Ek" } as any,
    "TH",
    "teacher",
  );

describe("🔴 TASK-318 §3 — TWO sessions of the SAME weekly course produce DIFFERENT messages", () => {
  test("🔴 THE assertion this task exists for", () => {
    // ⚠️ Written first and deliberately: *the date is only how it is fixed*. Two Tuesdays, one course, one
    // coach — and before this the two notices were byte-identical.
    const a = leave("2026-09-10");
    const b = leave("2026-09-17");
    expect(a).not.toBe(b);
    // …and the ONLY thing that differs is the date, which is what makes it a fix rather than a coincidence.
    expect(a.replace("10-09-2026", "X")).toBe(b.replace("17-09-2026", "X"));
  });

  test("🔻 the WEEKDAY ALONE could not tell them apart — the defect, asserted so it cannot come back", () => {
    // Both dates are Thursdays in the old rendering's terms — any two dates a week apart share a weekday.
    // 📌 Kept as an assertion rather than a comment: it is the reason the format changed.
    const dow = (iso: string) => new Date(`${iso}T00:00:00`).getDay();
    expect(dow("2026-09-10")).toBe(dow("2026-09-17"));
    expect(leave("2026-09-10")).not.toContain("Thursday");
    expect(leave("2026-09-10")).not.toContain("พฤหัสบดี");
  });
});

describe("🔑 TASK-318 §1 — pinned BYTE-FOR-BYTE against `§16d`", () => {
  test("the customer's layout, their date format", () => {
    // ⚠️ Pinned against `REQ-085 §16d`'s VERBATIM block, which is ONE FIELD PER LINE — not against the TASK
    // page's summary of it, which compressed the fields onto two `·`-joined lines. **My first version of this
    // assertion copied the task and failed against the requirement.** 📌 The renderer's shape is unchanged and
    // was already pinned this way by TASK-305; `§16d` changes the header and the date, not the layout.
    // 📌 Their own line reads `Time :12:00-13:00` — a missing space, and NOT reproduced: every other field in
    // every template is ` : `, and a typo copied faithfully is still a typo. Same call as `§17c`'s stray
    // quotation marks (TASK-310), and reported the same way.
    expect(leave("2026-09-10")).toBe(
      "LEAVE NOTICE / แจ้งลา ‼️\n" +
        "Student : มะขิด\n" +
        "Program : Freeskate 6 HR\n" +
        "Date : 10-09-2026\n" +
        "Time : 12:00-13:00\n" +
        "Coach : Ek\n",
    );
  });

  test("🔑 `Date` is the DATE ALONE, `DD-MM-YYYY` — @Porter's `Tuesday 22/Sep/26` is WITHDRAWN", () => {
    expect(leave("2026-09-10")).toContain("Date : 10-09-2026");
    expect(leave("2026-09-10")).not.toContain("22/Sep");
    // 📌 It is the format they specified for a date of birth in `REQ-079 §17c` — they are consistent with
    // themselves, so we match them rather than invent a third style.
    expect(ddmmyyyy("2024-12-02")).toBe("02-12-2024");
    expect(t("add_birthdate_prompt", "TH")).toContain("DD-MM-YYYY");
  });

  test("⚠️ a value that is not a well-formed ISO date passes through UNCHANGED", () => {
    // The display must not invent a shape for something it does not recognise (the phone formatter's rule).
    for (const odd of ["2026-09", "not-a-date", "", "10-09-2026"]) expect(ddmmyyyy(odd)).toBe(odd);
  });

  test("🔑 ONE transformation, two contracts — the birthdate echo delegates rather than copies", () => {
    // The customer specified this format twice, for two messages. `formatBirthDateForDisplay` keeps its own
    // name and its own contract (TASK-280's pins: not the parser's inverse, one caller) and calls this.
    const ADD = code(src("src/lib/line-add-student.ts"));
    expect(ADD).toContain("return ddmmyyyy(iso);");
    expect(ADD).not.toMatch(/\$\{m\[3\]\}-\$\{m\[2\]\}-\$\{m\[1\]\}/); // the copy is gone
    expect(code(src("src/lib/time.ts"))).toContain("export const ddmmyyyy = (iso: string): string => {");
  });
});

describe("✅ TASK-318 §2 — the header, and the BOUNDARY that keeps it alive", () => {
  test("`LEAVE NOTICE / แจ้งลา ‼️`, bilingual, in BOTH language renderings", () => {
    for (const lang of ["TH", "EN"] as const) {
      expect(t("ob_leave_notice_title", lang)).toBe("LEAVE NOTICE / แจ้งลา ‼️");
    }
  });

  test("🔴 `§4`'s boundary is WRITTEN IN THE CODE beside the header", () => {
    // ⚠️ Not decoration. Without it someone "fixes" this back to English next month citing `§4` — **exactly
    // the shape that let `Date : อังคาร` ship after `REQ-079 §18` had already ruled labels English.**
    // *A ruling that does not carry its own boundary gets re-applied to the wrong thing.*
    const I18N = src("src/lib/line-i18n.ts");
    expect(I18N).toContain("`§4` governs values the system GENERATES. It never governed what a message is CALLED.");
    expect(I18N).toContain("this message reaches COACHES and ADMINS, never a parent");
    expect(I18N).toContain("no parent ever sees");
  });

  test("🚫 `§4` itself is UNCHANGED — the values the system generates are still English", () => {
    // The boundary cuts one way only: the message's NAME is theirs, every value inside it is still `§4`'s.
    const out = leave("2026-09-10");
    expect(out).toContain("Student : ");
    expect(out).toContain("Coach : ");
    expect(out).not.toContain("ครู"); // no Thai label leaked in beside the Thai header
  });
});

describe("🔴 TASK-318 §4 (`§16.4`) — `Sessions :` is gone from the course-wide notice, its pin REWRITTEN", () => {
  const course = (over: Record<string, unknown> = {}) =>
    formatOutboxMessage(
      {
        kind: "course_confirmed",
        studentName: "น้องเอ",
        subject: "Freeskate",
        bookingType: "COURSE_PACKAGE",
        size: 6,
        expiryDate: "2026-12-31",
        coach: "ครูหนึ่ง",
        startDate: "2026-09-06",
        weekday: 0,
        startTime: "10:00",
        endTime: "11:00",
        plannedLeaveDates: [],
        ...over,
      } as any,
      {},
      "TH",
      "parent",
    );

  test("🔻 the pin CHANGES, it is not deleted — the line is absent and the reason is the customer's", () => {
    // Their reasoning: the program name already carries the hours. ⇒ the line restated the line above it.
    expect(course()).not.toContain("Sessions :");
    expect(course()).toContain("Program : Freeskate 6 HR"); // …which is where the 6 lives now
  });

  test("🚫 `Remaining` and `*Expiry date` STAY on a course row — `§9`'s conditional pair", () => {
    // ⚠️ They are what tells a coach a COURSE row from a one-off: the owner's *"ไม่งั้นมันจะแยกยังไง"* is the
    // acceptance criterion, and `§16.4` took only `Sessions`.
    expect(course()).toContain("*Expiry date : 2026-12-31");
  });

  test("🚫 …and are ABSENT on a one-off, which is the pair's whole point", () => {
    const oneOff = course({ bookingType: "SINGLE_SESSION", size: undefined, expiryDate: undefined });
    expect(oneOff).not.toContain("*Expiry date");
    expect(oneOff).not.toContain("Remaining");
    expect(oneOff).not.toContain("Sessions :");
  });

  test("📌 what made the deletion SAFE — the two figures had been made to agree first", () => {
    // TASK-269 §1 pointed `Sessions` at the same field `programLabel` reads. Had they still disagreed,
    // deleting one would have hidden a defect instead of closing it.
    const MSG = code(src("src/lib/line-message.ts"));
    expect(MSG).not.toContain('extra(t("ob_f_sessions", lang)');
    expect(src("src/lib/line-message.ts")).toContain("the two agreed, so nothing is lost with");
  });
});

describe("✅ TASK-318 §5 (batch 7b) — the ✅ on the THAI success lines of screens 4 and 8", () => {
  test("both languages now carry it, as their document does", () => {
    expect(t("verify_parent_ok_new", "TH")).toBe(
      "ลงทะเบียนผู้ปกครองสำเร็จแล้วค่ะ ✅\nRegistration completed ✅\nเบอร์โทรศัพท์ / Phone: {phone}",
    );
    expect(t("added_done", "TH")).toBe('เพิ่ม "{name}" สำเร็จแล้วค่ะ ✅\n"{name}" has been added successfully. ✅{note}');
  });

  test("🔑 the screens are still LANGUAGE-INVARIANT — the tick did not break TASK-310's property", () => {
    for (const key of ["verify_parent_ok_new", "added_done"]) {
      expect({ key, same: t(key, "TH") === t(key, "EN") }).toEqual({ key, same: true });
    }
  });
});

describe("🚫 TASK-318 §6 — what must not change", () => {
  test("🔑 the PARENT still does not receive the leave notice — asserted as an absence, unchanged", () => {
    // TASK-305's rule: teacher + admin, never the parent. The header now carries Thai precisely because no
    // parent reads this message.
    const SVC = code(src("src/services/scheduler.service.ts"));
    const sends = [...SVC.matchAll(/kind: "leave_notice"/g)];
    expect(sends.length).toBeGreaterThan(0);
    for (const m of sends) {
      const around = SVC.slice(Math.max(0, m.index! - 700), m.index! + 700);
      expect({ at: m.index, parent: /recipientType: "parent"/.test(around) }).toEqual({ at: m.index, parent: false });
    }
  });

  test("🚫 `§7.1`'s course-wide `Date` is still the WEEKDAY — a recurring slot, and a single date would be wrong", () => {
    expect(course_date()).toContain("Date : Sunday");
  });

  function course_date() {
    return formatOutboxMessage(
      {
        kind: "course_confirmed",
        studentName: "น้องเอ",
        subject: "Freeskate",
        bookingType: "COURSE_PACKAGE",
        size: 6,
        expiryDate: "2026-12-31",
        coach: "ครูหนึ่ง",
        startDate: "2026-09-06",
        weekday: 0,
        startTime: "10:00",
        endTime: "11:00",
        plannedLeaveDates: [],
      } as any,
      {},
      "TH",
      "parent",
    );
  }

  test("🚫 the picker's format (TASK-316) is untouched — two surfaces, two formats", () => {
    const { sessionPick } = require("./line-leave");
    const row = sessionPick(
      { id: "b1", studentId: "s1", date: "2026-09-22", startTime: "15:00:00", student: { name: "มิลล่า" }, teacher: { nickname: "Bank" }, subject: { name: "Skateboard" } },
      "TH",
    );
    expect(row.body).toBe("อังคาร 22/09 · 15:00 · ครูBank · Skateboard");
    expect(leave("2026-09-22")).not.toContain("22/09");
  });
});
