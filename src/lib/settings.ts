// SPEC-029 / TASK-101 — the configurable-business-rules registry + resolver (PURE, no DB).
//
// Principle (SPEC-029 §1): defaults live in CODE; `app_settings` holds OVERRIDES only. A missing or malformed
// override falls back to the coded default AND says so — NEVER to zero/null/"no rule" (AC #4). This file is a
// hand-listed registry, NOT a config framework: adding a rule later is one entry here + one screen row, no schema
// change (AC). The DB read/write lives at the service edge (`settings.service.ts`); nothing here touches the DB.

export interface SettingSpec {
  key: string;
  default: number;
  unit: "days" | "minutes";
  label: string; // staff-facing (TH) — the Settings screen row
  /** Validate + coerce + bounds-check a raw value (from DB or an API body). `null` = malformed → caller falls back. */
  parse: (raw: unknown) => number | null;
}

/** An integer in `[min, max]` — accepts a JSON number or a numeric string; anything else is malformed. */
const intInRange =
  (min: number, max: number) =>
  (raw: unknown): number | null => {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };

// The two go-live rules (SPEC-029 §4). The other six configurable-looking constants stay in code on purpose —
// "a setting nobody has ever wanted to change is a constant with extra steps." Add one here the moment demand is real.
export const SETTINGS = {
  teacher_change_notice_days: {
    key: "teacher_change_notice_days",
    default: 3,
    unit: "days",
    label: "แจ้งเปลี่ยนครูล่วงหน้า (วัน)",
    parse: intInRange(0, 30),
  },
  checkin_early_minutes: {
    key: "checkin_early_minutes",
    default: 30,
    unit: "minutes",
    label: "เปิดเช็คอินก่อนเริ่มคลาส (นาที)",
    parse: intInRange(0, 240),
  },
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;

export const isSettingKey = (k: string): k is SettingKey => Object.prototype.hasOwnProperty.call(SETTINGS, k);

export interface ResolvedSetting {
  value: number;
  /** True when the coded default is in force (no override, or the stored override was malformed). */
  isDefault: boolean;
  /** Present only on fallback — WHY the default is in force (AC #4: "fall back and say so"). */
  reason?: string;
}

/**
 * Resolve a setting to a usable value: the parsed override, else the coded default with `isDefault:true` + a reason.
 * Pure — `rawFromDb` is the `app_settings.value` (or `undefined`/`null` when there is no row). Never returns
 * zero/null when the intent was "use the rule": a malformed override degrades to the default, not to "no rule".
 */
export function resolveSetting(key: SettingKey, rawFromDb: unknown): ResolvedSetting {
  const spec = SETTINGS[key];
  if (rawFromDb === undefined || rawFromDb === null) {
    return { value: spec.default, isDefault: true, reason: "no override set — using default" };
  }
  const parsed = spec.parse(rawFromDb);
  if (parsed === null) {
    return { value: spec.default, isDefault: true, reason: `stored override is invalid — using default (${spec.default})` };
  }
  return { value: parsed, isDefault: false };
}
