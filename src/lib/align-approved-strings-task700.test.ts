// TASK-700 — shipped strings aligned to what the OWNER approved (COPY-REVIEW-2026-09-29.md §18, :190–201). "Approved strings are not improved": a test fails if the
// particle `ค่ะ` comes back on the district / sub-district prompts, or the on-file words change. Pinned BY VALUE through `t()`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t, REGISTRATION_COPY } from "./line-i18n";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const raw = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/\r\n/g, "\n");

describe("🔴 TASK-700 — the three aligned strings, by value", () => {
  const R: any = REGISTRATION_COPY;
  test("🔻 TASK-800 (REQ-118, owner ruling 2, Porter's grant 2026-10-12) — the three address prompts (province · district · sub-district) were REMOVED with the chat's address steps; the on-file note stays", () => {
    for (const key of ["add_addr_province_prompt", "add_addr_district_prompt", "add_addr_subdistrict_prompt", "add_addr_province_bad", "add_province_prompt"]) expect({ key, present: key in R }).toEqual({ key, present: false });
  });
  test("the on-file note — the approved words, each half in its own parentheses, joined by ` / ` (inside one address line)", () => {
    expect(R.add_addr_on_file).toBe("(ที่อยู่เดิมของครอบครัว) / (the address we have on file)");
  });
  test("…and the summary line reads `{province} (ที่อยู่เดิมของครอบครัว) / (the address we have on file)` — no doubled brackets", () => {
    const WH = raw("src/services/line-webhook.service.ts");
    expect(WH).toContain('`${parent!.province} ${t("add_addr_on_file", lang)}`');
    expect(WH).not.toContain('(${t("add_addr_on_file", lang)})');
  });
});

describe("📋 TASK-700 — the labels, told true", () => {
  const I = readFileSync(resolve(root, "src/lib/line-i18n.ts"), "utf8");
  const TL = readFileSync(resolve(root, "src/lib/teacher-leave.ts"), "utf8");
  test("699's label is APPROVED, with the :525 pointer; the sentence itself is unchanged", () => {
    expect(I).toContain("✅ APPROVED by the owner 2026-10-07 — COPY-REVIEW-2026-09-29.md:525 (the DRAFTED sentence; :516 is a superseded PM rewrite).");
    expect(t("ob_course_expiry_changed", "TH")).toContain("แจ้งเปลี่ยนวันหมดอายุคอร์สค่ะ:");
  });
  test("the prompts and the on-file note are labelled APPROVED (aligned TASK-700)", () => {
    expect(I.split("✅ APPROVED by the owner 2026-10-01 — COPY-REVIEW-2026-09-29.md:190–201 (aligned TASK-700)").length - 1).toBe(1); // 🔻 TASK-800 (REQ-118, owner ruling 2, Porter's grant 2026-10-12) — the prompts' block is gone: only the on-file note carries it
  });
  test("ADMIN_LEAVE_FUTURE_ONLY is labelled by the NEW rule: engineer wording, LISTED not approved — and the trigger to return to the queue is stated", () => {
    expect(TL).toContain("📋 ENGINEER WORDING — LISTED, NOT APPROVED (owner rule 2026-10-07: a refusal no screen can reach).");
    expect(TL).toContain("The day a screen can send today's date, this returns to the");
  });
});
