// TASK-603 — the LINE digest's heading for a moved, not-yet-re-confirmed course.
//
// ⚖️ The owner ruled (2026-10-01, *"12 เอาแบบยาว"*): COPY §12's LONGER wording wins, and COPY §10's shorter draft is superseded. The
// superseded sentence lived HERE, in the backend's digest heading — @Fern derived that and did not reach across (TASK-602).
// 🚫 The ruling touched the SENTENCE ONLY. Two things it did NOT touch, and which a careless edit here would take with it:
//   · the panel row's line shape `<new start> · <child> · <sessions pending>`;
//   · the promise that **the DIGEST carries the COUNT only** — no names (`namesPeopleInDigest` off; the owner-approved list, REQ-020).
// 🔑 Every assertion below reads BOTH languages, or requires both scripts — the rule recorded from my TASK-594 trap and @Fern's twin:
//   *a `toContain` on a string the two languages share is satisfied by one of them alone.*
import { describe, expect, test } from "bun:test";
import { ATTENTION_CHECKS, buildDigestMessage } from "./attention";
import { t } from "./line-i18n";

const KEY = "courses_awaiting_reconfirm";
const SUPERSEDED = { TH: "คอร์สที่เลื่อนวันเริ่มแล้ว รอยืนยันใหม่", EN: "Courses with a moved start date, awaiting re-confirmation" };
const APPROVED = { TH: "คอร์สที่เลื่อนแล้วแต่ยังไม่ได้ยืนยันใหม่ (ลูกค้ายังถือตารางเดิม)", EN: "Courses moved but not re-confirmed (the family still has the old dates)" };

describe("🔴 TASK-603 — the digest heading carries §12's approved sentence, in BOTH languages", () => {
  test("by value: each language is §12's, and the superseded draft is gone from BOTH (not just one)", () => {
    for (const lang of ["TH", "EN"] as const) {
      expect(t(`att_${KEY}`, lang)).toBe(APPROVED[lang]);
      expect(t(`att_${KEY}`, lang)).not.toBe(SUPERSEDED[lang]);
    }
    // 🔑 the shared words that make the two warnings agree — the whole reason the longer wording won. Both languages, counted.
    expect([/ตารางเดิม/.test(t(`att_${KEY}`, "TH")), /old dates/.test(t(`att_${KEY}`, "EN"))]).toEqual([true, true]);
  });
  test("the two languages are DIFFERENT strings here — this heading is a keyed label, not a bilingual §17c screen", () => {
    expect(t(`att_${KEY}`, "TH")).not.toBe(t(`att_${KEY}`, "EN"));
    expect(/[ก-๙]/.test(t(`att_${KEY}`, "TH"))).toBe(true);
    expect(/[ก-๙]/.test(t(`att_${KEY}`, "EN"))).toBe(false); // an English digest line carries no Thai
  });
});

describe("🚫 TASK-603 — what the ruling did NOT touch, pinned as UNCHANGED", () => {
  const check = ATTENTION_CHECKS.find((c) => c.key === KEY)!;
  const items = [
    { id: "c1", label: "2026-10-12 · น้องเอ · 4" },
    { id: "c2", label: "2026-10-19 · Emily · 2" },
  ];
  test("🔑 the DIGEST carries the COUNT only — the names are absent in BOTH languages, even when the items are handed in", () => {
    expect(check.namesPeopleInDigest ?? false).toBe(false);
    for (const lang of ["TH", "EN"] as const) {
      const msg = buildDigestMessage([{ key: KEY, count: 2, items }], lang);
      expect(msg).toContain(`• ${APPROVED[lang]}: 2`); // the heading and the count, on one line
      // 🔑 no name, no date, no per-row line — asserted per ITEM so a partial leak cannot hide behind one absent name
      for (const it of items) expect({ lang, label: it.label, leaked: msg.includes(it.label) }).toEqual({ lang, label: it.label, leaked: false });
      for (const bit of ["น้องเอ", "Emily", "2026-10-12", "   - "]) expect({ lang, bit, leaked: msg.includes(bit) }).toEqual({ lang, bit, leaked: false });
    }
  });
  test("🔑 the PANEL's line shape is unchanged: `<new start> · <child> · <sessions pending>`", () => {
    // 🔑 by SHAPE, in order, not by bytes: the separator is escaped differently once transpiled (`·` → `\xB7`), and a byte pin on a
    // template literal would break on a toolchain change while saying nothing about the shape.
    const src = ATTENTION_CHECKS.find((c) => c.key === KEY)!.run.toString();
    const label = src.slice(src.indexOf("label:"), src.indexOf("`", src.indexOf("label:") + 8) + 1);
    const parts = ["course.startDate", "course.student?.nickname", "course.student?.name", "pendingCount"];
    const at = parts.map((p) => label.indexOf(p));
    expect({ missing: parts.filter((_, i) => at[i]! < 0) }).toEqual({ missing: [] });
    for (let i = 1; i < parts.length; i++) expect(at[i - 1]!).toBeLessThan(at[i]!);
    expect((label.match(/·|\\xB7/g) ?? []).length).toBe(2); // three fields, two separators
  });
  test("…and a check that MAY name people still does, so the count-only pin above is about THIS check and not a broken renderer", () => {
    const namer = ATTENTION_CHECKS.find((c) => c.namesPeopleInDigest)!;
    const msg = buildDigestMessage([{ key: namer.key, count: 1, items: [{ id: "x", label: "16:00 · น้องบี · Ek" }] }], "TH");
    expect(msg).toContain("   - 16:00 · น้องบี · Ek");
  });
});
