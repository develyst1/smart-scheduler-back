// TASK-273 — the eleventh attention card would have shipped `att_my_new_card` as its heading.
//
// 🔴 **Nothing was broken.** Ten cards, ten headings — and nothing held them that way: the keys were plain
// strings in an array and `t()` returns the KEY on a miss, correctly, for genuinely dynamic keys.
//
// 📌 Third instance of one class in a day — `status_*` (broken, found by a tester), `ics.ts`'s raw `STATUS:`
// (broken, found by reading), and this one. **Two of the three were found only because somebody happened to
// look.** This is the one where the control costs a line and there is no defect to argue about first, which is
// exactly why it was worth spending the line on.
//
// ⚠️ The real control is the COMPILER — `Record<AttentionKey, Entry>` — and it is proved by deleting a label,
// not by anything in this file. What is asserted here is that the headings did not MOVE while being retyped.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./line-i18n";
import { ATTENTION_CHECKS } from "./attention";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const code = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("TASK-273 — every card has a heading, and the compiler is what says so", () => {
  test("🔑 every key in ATTENTION_CHECKS renders a real heading, both languages", () => {
    // Enumerated from the array itself — a list typed here would be the same defect one level up.
    expect(ATTENTION_CHECKS.length).toBe(10);
    for (const c of ATTENTION_CHECKS) {
      for (const lang of ["TH", "EN"] as const) {
        const label = t(`att_${c.key}`, lang);
        expect({ key: c.key, lang, raw: label === `att_${c.key}` }).toEqual({ key: c.key, lang, raw: false });
      }
    }
  });

  test("🔑 `AttentionKey` is DERIVED from the array, never hand-written", () => {
    const c = code("src/lib/attention.ts");
    expect(c).toContain('export type AttentionKey = (typeof CHECKS)[number]["key"];');
    expect(c).toContain("] as const satisfies readonly AttentionCheck[];");
    // 🚫 A hand-written union would agree today and drift on the first new card.
    expect(c).not.toMatch(/export type AttentionKey =\s*$/m);
    expect(c).not.toContain('AttentionKey = "unconfirmed_bookings"');
  });

  test("🔑 the labels are ONE exhaustive Record, not loose table entries", () => {
    const c = code("src/lib/line-i18n.ts");
    expect(c).toContain("const ATTENTION_LABELS: Record<AttentionKey, Entry> = {");
    expect(c).toContain("...ATTENTION_LABEL_ENTRIES,");
    // The old shape must not come back: a loose `att_x:` line in the table sits OUTSIDE the compiler's question.
    expect(c).not.toMatch(/^\s*att_[a-z_]+:/m);
  });

  test("⚠️ `t()`'s fall-through is untouched — it is right for genuinely dynamic keys", () => {
    expect(t("att_not_a_card")).toBe("att_not_a_card");
  });

  test("📌 each card's `titleKey` is still `att_` + its key — the two spellings agree", () => {
    // They are two spellings of one fact, and nothing has ever checked that they match.
    for (const c of ATTENTION_CHECKS) {
      expect({ key: c.key, titleKey: c.titleKey }).toEqual({ key: c.key, titleKey: `att_${c.key}` });
    }
  });
});

describe("TASK-273 — the ten headings are BYTE-IDENTICAL to before", () => {
  // "No-op" is a claim. Moving ten entries out of a table and into a Record is exactly when one loses a word.
  const BEFORE: Record<string, { TH: string; EN: string }> = {
    unconfirmed_bookings: { TH: "คาบที่ยังไม่ยืนยัน (วันนี้/พรุ่งนี้)", EN: "Unconfirmed classes (today/tomorrow)" },
    teachers_without_line: { TH: "ครูที่ยังไม่ผูก LINE", EN: "Teachers without LINE linked" },
    expiring_entitlements: { TH: "คอร์ส/วอยเชอร์ที่ใกล้หมดอายุ", EN: "Courses/vouchers expiring soon" },
    nearly_finished_courses: { TH: "คอร์สที่ใกล้ใช้ครบ", EN: "Courses nearly finished" },
    freelance_near_cap: { TH: "ครูฟรีแลนซ์ที่งบใกล้เต็ม", EN: "Freelance budgets near their cap" },
    incomplete_students: { TH: "นักเรียนที่ข้อมูลไม่ครบ", EN: "Students with incomplete details" },
    pending_teacher_links: { TH: "คำขอผูกบัญชีครูที่รออนุมัติ", EN: "Teacher link requests awaiting approval" },
    sales_not_posted: { TH: "การขายที่ยังไม่ลงบัญชี", EN: "Sales not posted to backoffice" },
    discount_not_applied: {
      TH: "ส่วนลดที่ไม่ได้ถูกใช้ (ขายเต็มราคา)",
      EN: "Discounts not applied (charged full price)",
    },
    orphaned_sessions: {
      TH: "คาบในอนาคตที่ครูไม่พร้อม (ปิดใช้งาน/ไม่สอนวันนั้น)",
      EN: "Future sessions with an unavailable teacher (archived / off that weekday)",
    },
  };

  test("🔴 not one word moved", () => {
    for (const [key, entry] of Object.entries(BEFORE)) {
      expect({ key, TH: t(`att_${key}`, "TH"), EN: t(`att_${key}`, "EN") }).toEqual({ key, ...entry });
    }
  });

  test("…and the card ORDER is unchanged — the digest reads top to bottom", () => {
    expect(ATTENTION_CHECKS.map((c) => c.key)).toEqual(Object.keys(BEFORE));
  });
});
