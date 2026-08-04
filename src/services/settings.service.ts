// SPEC-029 / TASK-101 — the DB edge for the settings registry. The pure resolver/registry live in `lib/settings.ts`;
// this is the ONLY place that reads/writes `app_settings` for these rules. Mirrors the `lib/line-admin.ts`
// read + `onConflictDoUpdate` write pattern (the codebase precedent for KV settings).

import { sql } from "drizzle-orm";
import { db } from "../db";
import { appSettings } from "../db/schema";
import { badRequest } from "../lib/http";
import { SETTINGS, resolveSetting, type SettingKey } from "../lib/settings";

/** Resolve one rule at ACTION TIME (SPEC-029 §3, AC #5): fetch its override row, run the pure resolver. */
export async function getSetting(key: SettingKey, exec: any = db) {
  const row = await exec.query.appSettings.findFirst({
    where: (s: any, { eq }: any) => eq(s.key, key),
  });
  return resolveSetting(key, row?.value);
}

/** Validate via the registry's `parse`, then upsert the override jsonb. Malformed → 400 with the reason (never
 *  writes junk — the DB must never hold a value the resolver would have to reject on the way back out). */
export async function setSetting(key: SettingKey, value: unknown, exec: any = db) {
  const spec = SETTINGS[key];
  const parsed = spec.parse(value);
  if (parsed === null) {
    throw badRequest(`ค่าไม่ถูกต้องสำหรับ "${spec.label}" — ต้องเป็นจำนวนเต็ม (${spec.unit}) ในช่วงที่กำหนด`);
  }
  await exec
    .insert(appSettings)
    .values({ key, value: parsed })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: parsed, updatedAt: sql`now()` } });
  return { key, label: spec.label, unit: spec.unit, value: parsed, default: spec.default, isOverridden: true };
}

/** The whole configurable set for the Settings screen (SPEC-029 §3) — one entry per registered rule. */
export async function listSettings(exec: any = db) {
  const keys = Object.keys(SETTINGS) as SettingKey[];
  const rows = await exec.query.appSettings.findMany({
    where: (s: any, { inArray }: any) => inArray(s.key, keys),
  });
  const byKey = new Map<string, unknown>(rows.map((r: any) => [r.key, r.value]));
  return keys.map((key) => {
    const spec = SETTINGS[key];
    const resolved = resolveSetting(key, byKey.get(key));
    return {
      key,
      label: spec.label,
      unit: spec.unit,
      value: resolved.value,
      default: spec.default,
      isOverridden: !resolved.isDefault,
    };
  });
}
