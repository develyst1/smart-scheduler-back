// TASK-277 (REQ-079 §17, closed by the owner 2026-09-06) — the birth date is `วัน-เดือน-ปี`.
//
// 🔻 The ruling was written down on 09-06 and never became a task. It was still unbuilt on 09-07, and TASK-275
// made the flow bilingual in between — **so a prompt the owner had already overruled was translated.** A
// decision written down and not turned into a task is the same class as the week's other four: *a note is not a
// mechanism.*
//
// 🔑 The sharp line is §17's own warning: a four-digit-first string must be refused **with the format message**,
// not read as day 2024. It would fail either way — the point is WHICH sentence the parent reads.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBirthDate } from "./line-add-student";
import { t } from "./line-i18n";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));

describe("TASK-277 — the owner's strings, verbatim, with the escape kept", () => {
  test("🔑 the prompt is his sentence", () => {
    // Verbatim from §17: `กรุณาพิมพ์วันเกิดของนักเรียนค่ะ (วัน-เดือน-ปี เช่น 02-12-2024)`
    const th = t("add_birthdate_prompt", "TH");
    expect(th.startsWith("กรุณาพิมพ์วันเกิดของนักเรียนค่ะ (วัน-เดือน-ปี เช่น 02-12-2024)")).toBe(true);
    expect(th).not.toContain("ปปปป-ดด-วว"); // the overruled format is gone from the copy, not only from the parser
  });

  test("🔑 the rejection is his sentence", () => {
    const th = t("add_birthdate_bad", "TH");
    expect(th.startsWith("รูปแบบวันเกิดไม่ถูกต้องค่ะ กรุณาพิมพ์เป็น วัน-เดือน-ปี เช่น 02-12-2024")).toBe(true);
    expect(th).not.toContain("ปปปป-ดด-วว");
  });

  test("⚠️ `ข้าม` survives in BOTH strings — his sentences do not mention it, ours must", () => {
    // Dropping the way out of a wizard step is not a wording change. Added AFTER his words rather than woven
    // through them, so the verbatim sentence stays verbatim.
    expect(t("add_birthdate_prompt", "TH")).toContain("ข้าม");
    expect(t("add_birthdate_bad", "TH")).toContain("ข้าม");
    expect(t("add_birthdate_prompt", "EN").toLowerCase()).toContain("skip");
    expect(t("add_birthdate_bad", "EN").toLowerCase()).toContain("skip");
    // …and the parser still honours it, in both languages' words.
    expect(parseBirthDate("ข้าม")).toEqual({ ok: true, value: null });
    expect(parseBirthDate("skip")).toEqual({ ok: true, value: null });
  });

  test("both strings carry the EXAMPLE — a format without one is a format someone guesses at", () => {
    for (const key of ["add_birthdate_prompt", "add_birthdate_bad"] as const) {
      for (const lang of ["TH", "EN"] as const) expect(t(key, lang)).toContain("02-12-2024");
    }
  });
});

describe("TASK-277 — the parser: day-first in, ISO out", () => {
  test("🔑 `02-12-2024` → `2024-12-02`", () => {
    expect(parseBirthDate("02-12-2024")).toEqual({ ok: true, value: "2024-12-02" });
  });

  test("🔴 `2024-12-02` is REFUSED — the format message, not a nonsense parse", () => {
    // §17: *"refuse it CLEARLY rather than read `2024-12-02` as day 2024 and produce a confusing error."*
    // 🚫 And not by accident: the four-digit-first shape is matched and rejected BEFORE the day-first pattern
    // is tried, so the refusal is about the ORDER rather than about a day being out of range.
    expect(parseBirthDate("2024-12-02").ok).toBe(false);
    expect(src("src/lib/line-add-student.ts")).toContain(
      "if (/^\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}$/.test(raw)) return { ok: false };",
    );
  });

  test("🚫 both orders are NOT accepted — `03-04-2024` means exactly one date", () => {
    // If both were accepted, this string would mean 3 April or 4 March depending on which rule fired, and no
    // reader could tell which they got. Day-first, always.
    expect(parseBirthDate("03-04-2024")).toEqual({ ok: true, value: "2024-04-03" });
  });

  test("🔴 the round-trip guard survived the reorder", () => {
    // `new Date("2026-02-31")` silently becomes March 3. This is the one guard a format change could quietly
    // have lost, so it is restated day-first rather than assumed.
    expect(parseBirthDate("31-02-2026").ok).toBe(false);
    expect(parseBirthDate("01-13-2018").ok).toBe(false);
    expect(parseBirthDate("00-01-2018").ok).toBe(false);
    expect(parseBirthDate("yesterday").ok).toBe(false);
  });

  test("🔑 the STORED value is still `YYYY-MM-DD` — an input format, not a storage format", () => {
    // The one place a reorder could reach the database. Every accepted input comes back ISO.
    for (const input of ["02-12-2024", "2-4-2018", "31-12-1999", "1/1/2020"]) {
      const r = parseBirthDate(input);
      expect({ input, iso: r.ok && /^\d{4}-\d{2}-\d{2}$/.test(r.value ?? "") }).toEqual({ input, iso: true });
    }
  });
});

describe("TASK-277 — the confirm step is now load-bearing, and the code says so", () => {
  test("🔴 the summary still prints the date back, with the reason in a comment", () => {
    // `03-04-2024` is unambiguous to the parser and ambiguous to the person typing. The summary is what stands
    // between them and a wrong birthdate on a roster with no delete.
    const svc = src("src/services/line-webhook.service.ts");
    expect(svc).toContain("LOAD-BEARING FOR CORRECTNESS");
    expect(svc).toContain("const lines = summaryLines(next, {");
    expect(svc).toContain('t("add_summary_head", l)');
    expect(svc).toContain("birthDate: t(\"add_l_birthdate\", lang)");
  });
});
