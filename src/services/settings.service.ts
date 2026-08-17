// SPEC-029 / TASK-101 — the DB edge for the settings registry. The pure resolver/registry live in `lib/settings.ts`;
// this is the ONLY place that reads/writes `app_settings` for these rules. Mirrors the `lib/line-admin.ts`
// read + `onConflictDoUpdate` write pattern (the codebase precedent for KV settings).

import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { appSettings } from "../db/schema";
import { badRequest } from "../lib/http";
import { SETTINGS, resolveSetting, type SettingKey, type SettingSpec } from "../lib/settings";

/** Resolve one rule at ACTION TIME (SPEC-029 §3, AC #5): fetch its override row, run the pure resolver. */
export async function getSetting<K extends SettingKey>(key: K, exec: any = db) {
  const row = await exec.query.appSettings.findFirst({
    where: (s: any, { eq }: any) => eq(s.key, key),
  });
  return resolveSetting(key, row?.value);
}

/** Validate via the registry's `parse`, then upsert the override jsonb. Malformed → 400 with the reason (never
 *  writes junk — the DB must never hold a value the resolver would have to reject on the way back out). */
export async function setSetting(key: SettingKey, value: unknown, exec: any = db) {
  const spec: SettingSpec = SETTINGS[key];
  const parsed = spec.parse(value);
  if (parsed === null) {
    // TASK-136: an enum rule's error names the allowed options — "must be an integer in range" would be a lie.
    throw badRequest(
      spec.type === "enum"
        ? `ค่าไม่ถูกต้องสำหรับ "${spec.label}" — ต้องเป็นหนึ่งใน: ${(spec.options ?? []).join(", ")}`
        : `ค่าไม่ถูกต้องสำหรับ "${spec.label}" — ต้องเป็นจำนวนเต็ม (${spec.unit}) ในช่วงที่กำหนด`,
    );
  }
  await exec
    .insert(appSettings)
    .values({ key, value: parsed })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: parsed, updatedAt: sql`now()` } });
  return { key, label: spec.label, type: spec.type, options: spec.options ?? null, unit: spec.unit, value: parsed, default: spec.default, isOverridden: true };
}

/**
 * TASK-122 — a TRUE reset-to-default: DELETE the override row so the resolver falls back to the coded default with
 * `isOverridden:false`. A PUT-the-default would leave a lying override row (`isOverridden` stays true), so reset must
 * REMOVE the row. Idempotent — deleting a key with no override is a no-op success (already at default), not a 404.
 */
export async function resetSetting(key: SettingKey, exec: any = db) {
  await exec.delete(appSettings).where(eq(appSettings.key, key));
  const spec: SettingSpec = SETTINGS[key];
  return { key, label: spec.label, type: spec.type, options: spec.options ?? null, unit: spec.unit, value: spec.default, default: spec.default, isOverridden: false };
}

/** The whole configurable set for the Settings screen (SPEC-029 §3) — one entry per registered rule. */
export async function listSettings(exec: any = db) {
  const keys = Object.keys(SETTINGS) as SettingKey[];
  const rows = await exec.query.appSettings.findMany({
    where: (s: any, { inArray }: any) => inArray(s.key, keys),
  });
  const byKey = new Map<string, unknown>(rows.map((r: any) => [r.key, r.value]));
  return keys.map((key) => {
    const spec: SettingSpec = SETTINGS[key];
    const resolved = resolveSetting(key, byKey.get(key));
    return {
      key,
      label: spec.label,
      // TASK-136 → TASK-137 contract: the FE picks its editor from `type` (+ `options` for an enum row).
      type: spec.type,
      options: spec.options ?? null,
      unit: spec.unit,
      value: resolved.value,
      default: spec.default,
      isOverridden: !resolved.isDefault,
    };
  });
}
