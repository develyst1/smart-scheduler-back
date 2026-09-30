// TASK-590 (F-C, REQ-110 item 10 + ruling 4) — THE ONE ADDRESS RULE, for BOTH doors (the LIFF page and the LINE chat):
// an address is PROVINCE + DISTRICT + SUB-DISTRICT — three non-empty parts, the province one of the 77 we own.
//
// 🔴 THE LIMIT — read this before you write "full address validated" anywhere:
//   · we check the SHAPE we receive: three parts present, the province a real one;
//   · we do NOT check that the district belongs to that province, nor the sub-district to that district, nor that either
//     name exists at all. There is no district geography in the backend, BY RULING (Sober, TASK-590 §1): a second dataset
//     that can disagree with the page's picker is the defect class, and districts are not a list we own. The page's picker
//     makes its parts consistent; the chat's typed parts are what the parent typed.
//
// Pure — no DB, no clock, no copy.
import { THAI_PROVINCES, isThaiProvince } from "./thai-provinces";

export type AddressParts = { province?: string | null; district?: string | null; subDistrict?: string | null };
/** A checked address: the three parts, and the ONE line both doors store (the page's `joinAddress` order and spelling). */
export type FullAddress = { province: string; district: string; subDistrict: string; line: string };
export type AddressCheck =
  | { ok: true; address: FullAddress }
  | { ok: false; outcome: "address-required" } // nothing given at all
  | { ok: false; outcome: "address-incomplete"; missing: Array<"province" | "district" | "subDistrict"> }
  | { ok: false; outcome: "province-unknown"; province: string };

/** The everyday short form the customer writes on the ONE line (the page's `everydayProvinceName`, the same single entry). */
const EVERYDAY: Record<string, string> = { กรุงเทพมหานคร: "กทม" };
export const addressLine = (a: { province: string; district: string; subDistrict: string }) =>
  [a.subDistrict, a.district, EVERYDAY[a.province] ?? a.province].join(" ");

/** 🔑 THE rule. Both doors call it; the one LINE-side writer calls it again at the write (the floor). */
export function checkFullAddress(parts: AddressParts): AddressCheck {
  const province = parts.province?.trim() || "";
  const district = parts.district?.trim() || "";
  const subDistrict = parts.subDistrict?.trim() || "";
  if (!province && !district && !subDistrict) return { ok: false, outcome: "address-required" };
  const missing = ([["province", province], ["district", district], ["subDistrict", subDistrict]] as const).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { ok: false, outcome: "address-incomplete", missing: [...missing] };
  if (!isThaiProvince(province)) return { ok: false, outcome: "province-unknown", province };
  return { ok: true, address: { province, district, subDistrict, line: addressLine({ province, district, subDistrict }) } };
}

/**
 * The CHAT's typed province ⇒ the full form, or null. The page PICKS from the 77; a parent TYPES — so a leading "จังหวัด" is
 * dropped and Bangkok's everyday spellings are recognised. 🚫 Nothing fuzzy: anything else must be one of the 77 exactly.
 */
const ALIASES: Record<string, string> = { กทม: "กรุงเทพมหานคร", "กทม.": "กรุงเทพมหานคร", กรุงเทพ: "กรุงเทพมหานคร", "กรุงเทพฯ": "กรุงเทพมหานคร", bangkok: "กรุงเทพมหานคร", bkk: "กรุงเทพมหานคร" };
export function provinceFromTyped(text: string): string | null {
  const t = text.trim().replace(/^จังหวัด\s*/, "");
  const alias = ALIASES[t.toLowerCase()] ?? ALIASES[t];
  if (alias) return alias;
  return THAI_PROVINCES.includes(t) ? t : null;
}
