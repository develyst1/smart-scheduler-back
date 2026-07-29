import { describe, expect, test } from "bun:test";
import { isLang, langFromLocale, t } from "./line-i18n";

describe("line-i18n (REQ-015 / TASK-039)", () => {
  test("renders the requested language", () => {
    expect(t("btn_checkin", "TH")).toBe("เช็คอิน");
    expect(t("btn_checkin", "EN")).toBe("Check-in");
  });

  test("interpolates {vars}", () => {
    expect(t("verify_teacher_notfound", "EN", { nick: "Mark" })).toContain("Mark");
    expect(t("checkin_ok", "EN", { name: "A", time: "09:00" })).toBe("Checked in ✅\nA 09:00");
    // nested/empty var slots resolve cleanly (leave line composed of other keys)
    expect(t("leave_ok", "EN", { name: "A", extended: "", locked: "" })).toBe("Leave recorded ✅ (A)");
  });

  test("never leaks a raw key; unknown key returns itself defensively (no throw)", () => {
    expect(t("welcome", "EN")).not.toBe("welcome");
    expect(t("welcome", "TH")).not.toBe("welcome");
    expect(t("no_such_key", "EN")).toBe("no_such_key");
  });

  test("langFromLocale seeds EN only for en* locales; isLang guards", () => {
    expect(langFromLocale("en-US")).toBe("EN");
    expect(langFromLocale("th-TH")).toBe("TH");
    expect(langFromLocale(null)).toBe("TH");
    expect(isLang("EN")).toBe(true);
    expect(isLang("FR")).toBe(false);
  });
});
