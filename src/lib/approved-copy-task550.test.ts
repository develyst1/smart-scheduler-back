// TASK-550 — two LINE strings the owner approved as FINAL (COPY-REVIEW-2026-09-28 §E2 · §E3): pinned BY VALUE as TEMPLATES (the
// placeholders stay placeholders — never a rendered example), with the SHAPE pins kept beside them: the words are the owner's now,
// but the promise (the link alone on its line; the line only on a real append; never "make-up") is what makes each message honest.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t, tb } from "./line-i18n";

const I18N = readFileSync(resolve(import.meta.dir, "line-i18n.ts"), "utf8").replace(/\r\n/g, "\n");
/** The comment block directly above a key — where a DRAFT marker would live. */
const commentAbove = (key: string) => {
  const at = I18N.indexOf(`  ${key}: {`);
  const lines = I18N.slice(0, at).split("\n");
  const out: string[] = [];
  for (let i = lines.length - 2; i >= 0 && lines[i]!.trim().startsWith("//"); i--) out.unshift(lines[i]!);
  return out.join("\n");
};

describe("§E2 — the `ปฏิทิน` reply: FINAL, by value", () => {
  test("the TEMPLATE, both languages, byte for byte — `{url}` a placeholder", () => {
    expect(t("cal_web_link", "TH")).toBe("📅 ตารางสอนของคุณอยู่ในระบบ SOM SCHEDULE:\n{url}\n\nแตะลิงก์ แล้วเข้าสู่ระบบด้วยบัญชีที่แอดมินให้ไว้");
    expect(t("cal_web_link", "EN")).toBe("📅 Your teaching schedule is in SOM SCHEDULE:\n{url}\n\nTap the link and log in with the account your admin gave you.");
  });
  test("🔑 the shape still holds: the link ALONE on its line (TASK-519), the login line last", () => {
    for (const lang of ["TH", "EN"] as const) {
      const lines = t("cal_web_link", lang, { url: "https://x.test/?openExternalBrowser=1" }).split("\n");
      expect(lines[1]).toBe("https://x.test/?openExternalBrowser=1");
      expect(lines.at(-1)).toMatch(lang === "TH" ? /เข้าสู่ระบบ/ : /log in/);
    }
  });
});

describe("§E3 — the cancelled make-up's new-class line: FINAL, by value", () => {
  test("the TEMPLATE, both languages, byte for byte — `{date}` a placeholder", () => {
    expect(t("mc_new_class", "TH")).toBe("ระบบเพิ่มคาบใหม่ให้แล้ว วันที่ {date}");
    expect(t("mc_new_class", "EN")).toBe("A new class has been added on {date}.");
  });
  test("🔑 the promise outranks the letters: never ชดเชย / make-up (the ONLY-on-a-real-append rule is pinned by behaviour in TASK-548's file)", () => {
    expect([t("mc_new_class", "TH"), t("mc_new_class", "EN"), t("mc_title", "TH"), t("mc_title", "EN")].join("\n")).not.toMatch(/ชดเชย|make-up|makeup|replac/i);
    expect(tb("mc_new_class", { date: "13-11-2026" })).toContain("13-11-2026");
  });
});

describe("🚫 no DRAFT marker left on either approved key", () => {
  for (const key of ["cal_web_link", "mc_new_class"]) {
    test(key, () => {
      const c = commentAbove(key);
      expect(c.length).toBeGreaterThan(0);
      expect(c).not.toMatch(/DRAFT|NOT approved|Pinned by FORM|Pinned by SHAPE/);
      expect(c).toContain("APPROVED by the owner, FINAL");
    });
  }
});
