import { describe, expect, test } from "bun:test";
import { SETTINGS, isSettingKey, resolveSetting } from "./settings";

describe("resolveSetting — override-or-default-with-notice (TASK-101, AC #4)", () => {
  test("no row → coded default, isDefault, reason (never zero/null)", () => {
    const r = resolveSetting("teacher_change_notice_days", undefined);
    expect(r).toMatchObject({ value: 3, isDefault: true });
    expect(r.reason).toBeString();
    expect(resolveSetting("checkin_early_minutes", null)).toMatchObject({ value: 30, isDefault: true });
  });

  test("valid override → parsed value, not default", () => {
    expect(resolveSetting("teacher_change_notice_days", 5)).toEqual({ value: 5, isDefault: false });
    expect(resolveSetting("checkin_early_minutes", 45)).toEqual({ value: 45, isDefault: false });
  });

  test("numeric string override is coerced (jsonb could hold either)", () => {
    expect(resolveSetting("checkin_early_minutes", "60")).toEqual({ value: 60, isDefault: false });
  });

  test("malformed override → DEFAULT with a reason, NEVER zero/null (the whole point)", () => {
    for (const bad of ["abc", -1, 3.5, 1000, true, {}, [], ""]) {
      const r = resolveSetting("checkin_early_minutes", bad);
      expect(r.value).toBe(30); // default, not the junk, not 0, not null
      expect(r.isDefault).toBe(true);
      expect(r.reason).toContain("invalid");
    }
  });

  test("bounds are inclusive at the edges", () => {
    expect(resolveSetting("teacher_change_notice_days", 0)).toEqual({ value: 0, isDefault: false }); // ≥0 ok
    expect(resolveSetting("teacher_change_notice_days", 30)).toEqual({ value: 30, isDefault: false });
    expect(resolveSetting("teacher_change_notice_days", 31).isDefault).toBe(true); // over bound → default
  });
});

describe("registry shape (TASK-101)", () => {
  // TASK-136 added the first non-numeric rule (`notify_on_leave`), so the shape check now covers both kinds.
  test("the registered keys, each with type/default/unit/label/parse", () => {
    expect(Object.keys(SETTINGS).sort()).toEqual([
      "checkin_early_minutes",
      "notify_on_leave",
      "teacher_change_notice_days",
    ]);
    for (const spec of Object.values(SETTINGS)) {
      expect(["days", "minutes", "option"]).toContain(spec.unit);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.parse).toBeFunction();
      if (spec.type === "number") {
        expect(spec.default).toBeInteger();
      } else {
        // an enum's default must be one of its options
        expect([...(spec.options as readonly string[])]).toContain(String(spec.default));
      }
    }
  });

  test("isSettingKey guards unknown keys", () => {
    expect(isSettingKey("checkin_early_minutes")).toBe(true);
    expect(isSettingKey("leave_quota")).toBe(false); // deliberately deferred — not configurable yet
    expect(isSettingKey("__proto__")).toBe(false); // prototype-pollution safe
  });
});
