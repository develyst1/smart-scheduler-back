// TASK-800 (REQ-118, owner GO 2026-10-12) — THE ONE reader of the Thai administrative geography: the official DOPA codes
// (province 2 digits · district 4 · sub-district 6) with their Thai and English names, from the static, versioned dataset
// `src/data/thai-geography.json` (thailand-geography-json, MIT — see `src/data/thai-geography.LICENSE`), EMBEDDED in the compiled binary by a static import (TASK-802).
//
// 🔑 WHY a static file and not a table: it never changes at runtime, and a table is one more thing to migrate. 🚫 NEVER hand-edited:
// `scripts/cross-check-area-codes.ts` (THE GATE) proves every code the page's picker can send exists here with the SAME Thai name,
// and that the 77 province names equal our own list (`thai-provinces.ts`) — a mismatch means a parent could pick a place the server
// refuses, so the gate STOPS and lists them.
//
// Pure apart from the one file read (lazy, once). 🚫 No fuzzy matching anywhere: exact codes, exact names.
import { readFileSync } from "node:fs";
// 🔴 TASK-802 (TEST-099 F2) — the default dataset is a STATIC import, so `bun build --compile` EMBEDS it in the binary. It used to be read at runtime from
// `resolve(import.meta.dir, "..", "data", …)`: inside a compiled binary `import.meta.dir` is a VIRTUAL root (`B:\~BUN\…`), the file was not there, and every
// `/api/areas/*` call and every code PATCH answered 500 on sid — while every test passed, because under `bun run` / `bun test` that path is the real source folder.
// 🚫 NEVER read the default dataset from the file system again (a test pins it). `loadGeography(path)` — an explicit path, for the scripts — still reads a file on purpose.
import DATASET from "../data/thai-geography.json" with { type: "json" };

export type AreaLang = "TH" | "EN";
export type AreaTriple = { provinceCode: string; districtCode: string; subdistrictCode: string };
/** One row of the dataset, codes normalised to TEXT (the file holds numbers). */
export type AreaRow = {
  provinceCode: string; provinceNameTh: string; provinceNameEn: string;
  districtCode: string; districtNameTh: string; districtNameEn: string;
  subdistrictCode: string; subdistrictNameTh: string; subdistrictNameEn: string;
};
type Named = { th: string; en: string };
export type Geography = {
  rows: AreaRow[];
  provinces: Map<string, Named>;
  districts: Map<string, Named & { province: string }>;
  subDistricts: Map<string, Named & { district: string }>;
};


const text = (v: unknown): string => String(v ?? "").trim();

/** Build the indexes from raw rows. Throws on a row without a code or a Thai name — a half-read dataset must never be used. */
export function buildGeography(raw: unknown[]): Geography {
  const rows: AreaRow[] = raw.map((r: any, i) => {
    const row: AreaRow = {
      provinceCode: text(r.provinceCode), provinceNameTh: text(r.provinceNameTh), provinceNameEn: text(r.provinceNameEn),
      districtCode: text(r.districtCode), districtNameTh: text(r.districtNameTh), districtNameEn: text(r.districtNameEn),
      subdistrictCode: text(r.subdistrictCode), subdistrictNameTh: text(r.subdistrictNameTh), subdistrictNameEn: text(r.subdistrictNameEn),
    };
    for (const k of ["provinceCode", "provinceNameTh", "districtCode", "districtNameTh", "subdistrictCode", "subdistrictNameTh"] as const) {
      if (!row[k]) throw new Error(`thai-geography: row ${i} has no ${k}`);
    }
    return row;
  });
  const provinces = new Map<string, Named>();
  const districts = new Map<string, Named & { province: string }>();
  const subDistricts = new Map<string, Named & { district: string }>();
  for (const r of rows) {
    provinces.set(r.provinceCode, { th: r.provinceNameTh, en: r.provinceNameEn });
    districts.set(r.districtCode, { th: r.districtNameTh, en: r.districtNameEn, province: r.provinceCode });
    subDistricts.set(r.subdistrictCode, { th: r.subdistrictNameTh, en: r.subdistrictNameEn, district: r.districtCode });
  }
  return { rows, provinces, districts, subDistricts };
}

let loaded: Geography | null = null;
let override: Geography | null = null;

/** The dataset (built lazily, once, from the EMBEDDED import). `path` ⇒ read THAT file instead (the scripts' `--dataset`). */
export function loadGeography(path?: string): Geography {
  if (override && !path) return override;
  if (path) return buildGeography(JSON.parse(readFileSync(path, "utf8")));
  loaded ??= buildGeography(DATASET as unknown as unknown[]);
  return loaded;
}
/** TESTS ONLY — serve a fixture geography; `null` restores the real file. */
export function useGeographyForTests(g: Geography | null): void { override = g; }

/** The level a code is at, by its length (DOPA numbering: 2 / 4 / 6 digits). */
export const areaLevel = (code: string): "province" | "district" | "subdistrict" | null =>
  /^\d{2}$/.test(code) ? "province" : /^\d{4}$/.test(code) ? "district" : /^\d{6}$/.test(code) ? "subdistrict" : null;

/** The name of ANY code in the reader's language; `null` when the code is not in the dataset. (English may be empty in the file ⇒ falls back to the Thai name — never blank.) */
export function areaName(code: string | null | undefined, lang: AreaLang, g: Geography = loadGeography()): string | null {
  const c = text(code);
  const level = areaLevel(c);
  const hit = level === "province" ? g.provinces.get(c) : level === "district" ? g.districts.get(c) : level === "subdistrict" ? g.subDistricts.get(c) : undefined;
  if (!hit) return null;
  return lang === "EN" ? hit.en || hit.th : hit.th;
}

/** The district inside the province, the sub-district inside the district — and all three exist. */
export function isConsistent(provinceCode: string, districtCode: string, subdistrictCode: string, g: Geography = loadGeography()): boolean {
  const d = g.districts.get(text(districtCode));
  const s = g.subDistricts.get(text(subdistrictCode));
  return g.provinces.has(text(provinceCode)) && !!d && d.province === text(provinceCode) && !!s && s.district === text(districtCode);
}

/**
 * The triple the doors check. ⇒ the Thai province NAME to write into `parents.province` (derived FROM the code), or the FIRST thing wrong:
 * `province-unknown` (the province code is not one of the 77) · `district-invalid` (not a district of that province) · `subdistrict-invalid`
 * (not a sub-district of that district). 🚫 Never repaired, never guessed.
 */
export type AreaCheck =
  | { ok: true; province: string; triple: AreaTriple }
  | { ok: false; outcome: "province-unknown"; code: string }
  | { ok: false; outcome: "district-invalid" }
  | { ok: false; outcome: "subdistrict-invalid" };
export function checkAreaCodes(t: AreaTriple, g: Geography = loadGeography()): AreaCheck {
  const triple = { provinceCode: text(t.provinceCode), districtCode: text(t.districtCode), subdistrictCode: text(t.subdistrictCode) };
  const p = g.provinces.get(triple.provinceCode);
  if (!p) return { ok: false, outcome: "province-unknown", code: triple.provinceCode };
  const d = g.districts.get(triple.districtCode);
  if (!d || d.province !== triple.provinceCode) return { ok: false, outcome: "district-invalid" };
  const s = g.subDistricts.get(triple.subdistrictCode);
  if (!s || s.district !== triple.districtCode) return { ok: false, outcome: "subdistrict-invalid" };
  return { ok: true, province: p.th, triple };
}

/** The address as a card prints it, in the page's own order: `{sub-district} {district} {province}`. `null` when there are no codes (or they are not in the dataset). */
export function areaAddress(t: { provinceCode?: string | null; districtCode?: string | null; subdistrictCode?: string | null }, lang: AreaLang, geo?: Geography): string | null {
  if (!t.provinceCode || !t.districtCode || !t.subdistrictCode) return null; // no codes ⇒ the dataset is not even read
  const g = geo ?? loadGeography();
  const parts = [areaName(t.subdistrictCode, lang, g), areaName(t.districtCode, lang, g), areaName(t.provinceCode, lang, g)];
  return parts.every(Boolean) ? parts.join(" ") : null;
}

/** BACKFILL ONLY — every code triple whose THREE Thai names match EXACTLY. One ⇒ usable; none ⇒ `name-not-in-dataset`; more ⇒ `ambiguous`. */
export function triplesByThaiNames(province: string, district: string, subDistrict: string, g: Geography = loadGeography()): AreaTriple[] {
  return g.rows
    .filter((r) => r.provinceNameTh === province && r.districtNameTh === district && r.subdistrictNameTh === subDistrict)
    .map((r) => ({ provinceCode: r.provinceCode, districtCode: r.districtCode, subdistrictCode: r.subdistrictCode }));
}
/** BACKFILL ONLY — the province code by EXACT Thai name (one of the 77), or `null`. */
export function provinceCodeByThaiName(name: string, g: Geography = loadGeography()): string | null {
  for (const [code, n] of g.provinces) if (n.th === name) return code;
  return null;
}

// ───────── 🔻 TASK-800 (ruled B, 2026-10-12) — the PICKERS' lists: the back end owns the ONE dataset and answers the pages ─────────
// The cross-check GATE found the old picker's own geocodes wrong for ~21 % of its rows (see GATE-REQ-118-cross-check-2026-10-12.txt), so both pickers (the registration page, the admin form) read THESE lists instead:
// every code they can send exists in the dataset by construction. In the dataset's own order; English falls back to the Thai name where the file has none (never a blank label).
export type AreaOption = { code: string; nameTh: string; nameEn: string };
type Lists = { provinces: AreaOption[]; districtsOf: Map<string, AreaOption[]>; subDistrictsOf: Map<string, AreaOption[]> };
const listsOf = new WeakMap<Geography, Lists>();
function lists(g: Geography): Lists {
  const hit = listsOf.get(g);
  if (hit) return hit;
  const opt = (code: string, n: Named): AreaOption => ({ code, nameTh: n.th, nameEn: n.en || n.th });
  const districtsOf = new Map<string, AreaOption[]>();
  const subDistrictsOf = new Map<string, AreaOption[]>();
  for (const [code, d] of g.districts) { const l = districtsOf.get(d.province) ?? []; l.push(opt(code, d)); districtsOf.set(d.province, l); }
  for (const [code, sd] of g.subDistricts) { const l = subDistrictsOf.get(sd.district) ?? []; l.push(opt(code, sd)); subDistrictsOf.set(sd.district, l); }
  const out: Lists = { provinces: [...g.provinces].map(([code, p]) => opt(code, p)), districtsOf, subDistrictsOf };
  listsOf.set(g, out);
  return out;
}
export const listProvinces = (g: Geography = loadGeography()): AreaOption[] => lists(g).provinces;
export const listDistricts = (provinceCode: string, g: Geography = loadGeography()): AreaOption[] => lists(g).districtsOf.get(text(provinceCode)) ?? [];
export const listSubDistricts = (districtCode: string, g: Geography = loadGeography()): AreaOption[] => lists(g).subDistrictsOf.get(text(districtCode)) ?? [];
