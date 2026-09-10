// TASK-334 Part A + TASK-335 (`REQ-087 §1a`/`§1c`) — three messages that said the wrong thing.
//
// 🔴 All three were LIVE on the deployed build, and only ONE of them was reported:
// · a VOUCHER deduction announced itself as `💡COURSE DEDUCTION` — the wrong noun about the thing they bought;
// · `Remaining : 14/15 ครั้ง` — THAI inside a value the SYSTEM generates (`REQ-085 §4`), **which nobody
//   reported**: it is `Date : อังคาร` again, in the one message family nobody had swept;
// · an approved teacher received `🔔 แจ้งเตือนจากระบบตารางเรียน` instead of the sentence the payload was
//   already carrying.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { t } from "./line-i18n";
import { remainingLabel } from "./course-deduction";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const CTX = { studentName: "น้องเอ", subject: "Freeskate", date: "2026-09-10", startTime: "10:00", endTime: "11:00", coach: "Ek" } as any;
const deduct = (bookingType: string, remaining: string) =>
  formatOutboxMessage({ kind: "course_deduction", bookingType, total: 15, expiryDate: "2026-12-31", remaining } as any, CTX, "TH", "parent");

describe("🔴 TASK-335 §1a — a VOUCHER deduction no longer calls itself a COURSE one", () => {
  test("🔑 the two headers DIFFER — the assertion the customer's report is about", () => {
    const voucher = deduct("VOUCHER", "14/15");
    const course = deduct("COURSE_PACKAGE", "2 HR");
    expect(voucher.split("\n")[0]).not.toBe(course.split("\n")[0]);
    expect(voucher).toStartWith("💡VOUCHER DEDUCTION");
  });

  test("🚫 …and the COURSE header is BYTE-IDENTICAL to today — its pin is theirs and did not move", () => {
    // ⚠️ `§1a` changed WHEN the course title is used, never its text.
    expect(deduct("COURSE_PACKAGE", "2 HR")).toStartWith("💡COURSE DEDUCTION");
    expect(t("ob_deduct_title", "TH")).toBe("💡COURSE DEDUCTION");
    expect(t("ob_deduct_title", "EN")).toBe("💡COURSE DEDUCTION");
  });

  test("📖 the voucher title is pinned by FORM, not by BYTES — it is a PLACEHOLDER", () => {
    // ⚠️ **The word is the customer's and @Porter is asking them.** By the convention adopted this week, a
    // string they have not seen is provisional ⇒ what is asserted is the SHAPE it must keep, and the words are
    // deliberately NOT frozen. 📌 Same treatment as `tsched_title_week` and `PENDING_RESCHEDULE`.
    const title = t("ob_deduct_title_voucher", "TH");
    expect(title.startsWith("💡")).toBe(true);            // the customer's emoji convention
    expect(title).toBe(title.toUpperCase());               // upper case, like its twin
    expect(title.endsWith(":")).toBe(false);               // …and NO trailing colon — its twin has none either
    expect(title).not.toBe(t("ob_deduct_title", "TH"));    // and it is DIFFERENT, which is the whole point
    expect(t("ob_deduct_title_voucher", "EN")).toBe(title); // one string for both readers, like every §7 title
    // 📌 Declared PLACEHOLDER in the table, so nobody byte-freezes it before the customer has seen it.
    expect(src("src/lib/line-i18n.ts")).toContain("PLACEHOLDER — MINE, and the customer has NOT seen it");
  });

  test("🚫 no new payload field, and the type is not re-derived", () => {
    // `§2`: the branch already computes `type` from the `bookingType` `deductionPayload` declares.
    const MSG = code(src("src/lib/line-message.ts"));
    expect(MSG).toContain('t(type === "VOUCHER" ? "ob_deduct_title_voucher" : "ob_deduct_title", lang)');
    expect(code(src("src/lib/course-deduction.ts"))).toContain('bookingType: "COURSE_PACKAGE" | "VOUCHER";');
  });
});

describe("🔴 TASK-335 §1c — no Thai in a value the SYSTEM generates", () => {
  test("🔑 the voucher balance carries NO THAI — `14/15 sessions` after TASK-343", () => {
    // 🔻 TASK-343 added the unit word. 🔑 **The claim `§1c` makes is unchanged and is what this guards: no
    // THAI in a value the SYSTEM generates.** `sessions` is English and is @Porter's word ratified by the
    // OWNER — 📌 *removing `ครั้ง` applied a ruling; adding `sessions` was a decision somebody made on the
    // record, and the two are different acts.*
    expect(remainingLabel("voucher", 14, 15)).toBe("14/15 sessions");
    expect(deduct("VOUCHER", remainingLabel("voucher", 14, 15))).toContain("Remaining : 14/15 sessions");
  });

  test("🔻 …and the COURSE form, which TASK-335 left alone and TASK-343 changed", () => {
    expect(remainingLabel("course", 2, 6)).toBe("2/6 HR");
    expect(remainingLabel("course", -1, 6)).toBe("0/6 HR"); // the clamp is unchanged
  });

  test("🔑 NO THAI in the generated `Remaining` value — asserted for BOTH types, so the rule is about the MESSAGE", () => {
    // ⚠️ Asserted on both branches deliberately: `§4` is a rule about a MESSAGE, not about the branch that was
    // reported. A test that only checked the voucher would let the course form drift the other way.
    const THAI = /[฀-๿]/;
    for (const [kind, n, total] of [["course", 2, 6], ["voucher", 14, 15]] as const) {
      expect({ kind, thai: THAI.test(remainingLabel(kind, n, total)) }).toEqual({ kind, thai: false });
    }
  });

  test("🔴 the SAME helper feeds a SECOND message — so the Thai was in the daily reminder too", () => {
    // 📌 `jobs.service.ts` renders `TodayRow.remaining` through this helper for the AUTO daily schedule.
    // ⇒ `§1c` was never one message's defect, and one line fixed both. **Neither of us had counted the second.**
    const JOBS = code(src("src/services/jobs.service.ts"));
    expect(JOBS).toContain('remainingLabel("voucher", r.voucher.totalHours - r.voucher.usedHours, r.voucher.totalHours)');
    const today = formatOutboxMessage(
      { kind: "daily_reminder", rows: [{ studentName: "น้องเอ", bookingType: "VOUCHER", subjectName: "Freeskate", date: "2026-09-10", startTime: "10:00", endTime: "11:00", coach: "Ek", remaining: remainingLabel("voucher", 14, 15), expiryDate: "2026-12-31" }] } as any,
      {}, "TH", "parent",
    );
    expect(today).toContain("Remaining : 14/15");
    expect(today).not.toContain("ครั้ง");
  });

  test("🔴 the CARD's owner-verified `เหลือ 6/10` is UNCHANGED — and it never shared this helper", () => {
    // 🔻 The task warned that `remainingLabel` has two readers and one is the card. **It is not.**
    // `line-course-view.ts` computes and renders its own and imports nothing from `course-deduction`.
    // ⇒ **there was nothing to un-share**, which is why `§3` needed no second function and no parameter.
    const CARD = src("src/lib/line-course-view.ts");
    expect(CARD).not.toContain("remainingLabel");
    expect(CARD).not.toContain("course-deduction");
    expect(CARD).toContain("const remaining = Math.max(0, c.size - c.usedSessions);");
    // 📌 The card's own string, owner-verified in TASK-234 — it says `เหลือ` and it stays saying it. `§4`
    // governs a NOTIFICATION; the card is a conversation surface the owner signed off.
    expect(t("course_row", "TH")).toContain("เหลือ {remaining}/{total}");
  });

  test("🚫 `Remark` is NOT added to the deduction — `§1b`'s premise was wrong", () => {
    // 🔴 `COURSE DEDUCTION` has NEVER carried `Remark` — not for a voucher and not for a course. The customer
    // compared their voucher DEDUCTION to their course CONFIRMATION. ⇒ adding it would not restore parity; it
    // would add a field to a message they already approved, and change the byte-pinned course one too.
    const { TEMPLATE_FIELDS } = require("./line-message-fields");
    expect(TEMPLATE_FIELDS.course_deduction).not.toContain("note");
    expect(deduct("VOUCHER", "14/15")).not.toContain("Remark");
    expect(deduct("COURSE_PACKAGE", "2 HR")).not.toContain("Remark");
  });
});

describe("🔴 TASK-334 Part A — an approved teacher is told what the payload already said", () => {
  const approved = (text: unknown) => formatOutboxMessage({ kind: "teacher_link_approved", text } as any, {}, "TH", "teacher");
  const TEXT = t("verify_teacher_ok", "TH", { nick: "ก้อง" });

  test("🔑 the teacher receives `verify_teacher_ok`, nickname and all", () => {
    expect(approved(TEXT)).toBe(TEXT);
    expect(approved(TEXT)).toContain("ก้อง");
  });

  test("🔴 …and the OLD behaviour is GONE — the default line is not reachable for this kind", () => {
    // ⚠️ The failure was silent in the worst way: the send SUCCEEDED. *The promise was kept in form and broken
    // in content.* Asserted as an absence so the branch cannot be deleted back into existence.
    expect(approved(TEXT)).not.toContain(t("ob_default", "TH"));
    expect(src("src/lib/line-message.ts")).toContain("the send happened and the message said nothing");
  });

  test("📌 a blank `text` falls back to today's behaviour — a poor message never becomes NO message", () => {
    for (const empty of ["", "   ", null, undefined]) expect(approved(empty)).toBe(t("ob_default", "TH"));
  });

  test("🚫 a SPECIFIC case, not a general `text` passthrough — and the reason is in the code", () => {
    // @Porter's reason, and it is better than "one more way to make a message": **a general passthrough would
    // make every future payload's `text` field silently load-bearing — a field added for LOGGING becomes a
    // message nobody meant to send.**
    const MSG = code(src("src/lib/line-message.ts"));
    expect(MSG).toContain('case "teacher_link_approved":');
    expect(MSG.match(/payload\.text/g)!.length).toBe(1); // exactly one branch reads it
    expect(src("src/lib/line-message.ts")).toContain("a field added for LOGGING becomes a message");
    // 🚫 …and no other kind is rendered from a `text` field.
    expect(formatOutboxMessage({ kind: "student_registered", text: "should not be used" } as any, {}, "TH", "parent")).toBe(t("ob_default", "TH"));
  });
});

describe("⛔ TASK-334 Part B — the two ADMIN kinds STILL render the default, and that is a DECISION", () => {
  test("🔴 both still generic — BLOCKED ON COPY, and the code says so", () => {
    // ⚠️ The facts are on the payload; the WORDS are the owner's. An admin alert is read under time pressure,
    // which is the worst place to ship a placeholder. 🅿️ PARKED by the owner — it stays LIVE and unfixed on the
    // board so it is not lost. **Asserted so the next reader knows it is a decision and not an oversight.**
    for (const kind of ["student_registered", "parent_asked_for_admin"]) {
      expect(formatOutboxMessage({ kind, studentName: "น้องเอ", parentPhone: "0812345678", lineUserId: "U1" } as any, {}, "TH", "parent"))
        .toBe(t("ob_default", "TH"));
    }
    expect(src("src/lib/line-message.ts")).toContain("BLOCKED ON COPY, not an oversight");
  });

  test("🚫 the three DEAD branches are untouched — a dead branch is not a defect; a MISSING one is", () => {
    // `reschedule_requested`, `sick_leave` and `leave_teacher` have a `case` and no producer. Deleting code a
    // requirement may still want is how the record is lost; it belongs with TASK-333's exhaustiveness work.
    const MSG = code(src("src/lib/line-message.ts"));
    for (const dead of ["reschedule_requested", "sick_leave", "leave_teacher"]) {
      expect({ dead, present: MSG.includes(`case "${dead}":`) }).toEqual({ dead, present: true });
    }
  });
});
