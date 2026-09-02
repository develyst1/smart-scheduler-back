// SPEC-029 / TASK-101 — the configurable-business-rules registry + resolver (PURE, no DB).
//
// Principle (SPEC-029 §1): defaults live in CODE; `app_settings` holds OVERRIDES only. A missing or malformed
// override falls back to the coded default AND says so — NEVER to zero/null/"no rule" (AC #4). This file is a
// hand-listed registry, NOT a config framework: adding a rule later is one entry here + one screen row, no schema
// change (AC). The DB read/write lives at the service edge (`settings.service.ts`); nothing here touches the DB.

export interface SettingSpec {
  key: string;
  /** SPEC-044 (TASK-136): a rule is a number OR a named choice. `enum` rules carry `options`; the FE renders a
   *  segmented control instead of a number input, so staff never see a `0|1` standing in for a decision. */
  type: "number" | "enum";
  default: number | string;
  unit: "days" | "minutes" | "hours" | "option";
  options?: readonly string[];
  label: string; // staff-facing (TH) — the Settings screen row
  /** Validate + coerce + bounds-check a raw value (from DB or an API body). `null` = malformed → caller falls back. */
  parse: (raw: unknown) => number | string | null;
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
/** One of a fixed set of named values — anything else is malformed (→ the coded default, same as a bad number). */
const oneOf =
  (options: readonly string[]) =>
  (raw: unknown): string | null =>
    typeof raw === "string" && options.includes(raw) ? raw : null;

export const NOTIFY_ON_LEAVE_OPTIONS = ["admin_only", "admin_and_teacher"] as const;

/** SPEC-071 Amendment #2 / TASK-232 — the LINE parent 2FA step. Shipped `off`; see the entry below. */
export const LINE_PARENT_2FA_OPTIONS = ["off", "on"] as const;

export const SETTINGS = {
  teacher_change_notice_days: {
    key: "teacher_change_notice_days",
    type: "number",
    default: 3,
    unit: "days",
    label: "แจ้งเปลี่ยนครูล่วงหน้า (วัน)",
    parse: intInRange(0, 30),
  },
  checkin_early_minutes: {
    key: "checkin_early_minutes",
    type: "number",
    default: 30,
    unit: "minutes",
    label: "เปิดเช็คอินก่อนเริ่มคลาส (นาที)",
    parse: intInRange(0, 240),
  },
  // SPEC-048 / REQ-047 — the leave cut-off, per teacher type, editable by staff instead of hard-coded in
  // `lib/leave-notice.ts` (was 60/60/120 minutes). PART_TIME deliberately shares the full-time rule.
  leave_cutoff_hours_fulltime: {
    key: "leave_cutoff_hours_fulltime",
    type: "number",
    default: 3,
    unit: "hours",
    label: "แจ้งลาล่วงหน้า — ครูประจำ/พาร์ทไทม์ (ชั่วโมง)",
    parse: intInRange(0, 72),
  },
  leave_cutoff_hours_freelance: {
    key: "leave_cutoff_hours_freelance",
    type: "number",
    default: 3,
    unit: "hours",
    label: "แจ้งลาล่วงหน้า — ครูฟรีแลนซ์ (ชั่วโมง)",
    parse: intInRange(0, 72),
  },
  // SPEC-044 / REQ-049. Default `admin_only` = today's behaviour, so enabling the teacher push is a deliberate
  // opt-in and no real coach is messaged by an upgrade.
  notify_on_leave: {
    key: "notify_on_leave",
    type: "enum",
    default: "admin_only",
    unit: "option",
    options: NOTIFY_ON_LEAVE_OPTIONS,
    label: "แจ้งเตือนเมื่อมีการลา",
    parse: oneOf(NOTIFY_ON_LEAVE_OPTIONS),
  },
  // SPEC-071 Amendment #2 / TASK-232 (REQ-079 §2) — the 6-digit step between "the parent typed a phone" and
  // "here are your children".
  //
  // 🔴 `off` is the OWNER'S CHOICE, not a soft launch. He raised the risk with the customer — anyone who knows
  // a phone number can see that family's children and act for them — and **the customer refused the extra
  // step**. That refusal is on the record (REQ-079 §2, `SYSTEM-FACTS.md`), which is why this ships switchable
  // rather than hardened: re-adding the check quietly is as forbidden as re-opening the question.
  //
  // It is a SETTING and not a stub so that turning it on is a decision, never a rebuild — the branch, the
  // storage and the verification all ship today.
  line_parent_2fa: {
    key: "line_parent_2fa",
    type: "enum",
    default: "off",
    unit: "option",
    options: LINE_PARENT_2FA_OPTIONS,
    label: "ยืนยันตัวตน 6 หลัก ก่อนแสดงรายชื่อนักเรียน (LINE)",
    parse: oneOf(LINE_PARENT_2FA_OPTIONS),
  },
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;

export const isSettingKey = (k: string): k is SettingKey => Object.prototype.hasOwnProperty.call(SETTINGS, k);

/** The value type a key resolves to — numeric rules stay `number`, enum rules are `string`, so existing callers
 *  (`hasEnoughTeacherChangeNotice(…, noticeDays)`) keep their number without a cast. */
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]["type"] extends "number" ? number : string;

export interface ResolvedSetting<V extends number | string = number | string> {
  value: V;
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
export function resolveSetting<K extends SettingKey>(key: K, rawFromDb: unknown): ResolvedSetting<SettingValue<K>> {
  const spec: SettingSpec = SETTINGS[key];
  const fallback = (reason: string) => ({ value: spec.default as SettingValue<K>, isDefault: true, reason });
  if (rawFromDb === undefined || rawFromDb === null) return fallback("no override set — using default");
  const parsed = spec.parse(rawFromDb);
  if (parsed === null) return fallback(`stored override is invalid — using default (${spec.default})`);
  return { value: parsed as SettingValue<K>, isDefault: false };
}
