// TASK-800 (REQ-118) — THE GATE. Run once (and again whenever either dataset is bumped); its output goes into the report.
//
//   bun run scripts/cross-check-area-codes.ts <path to the front's node_modules/thai-address-universal> [--dataset <path>]
//
// What it proves: EVERY (province, district, sub-district) code the registration PAGE's picker (`thai-address-universal@2.2.0`, ISC) can send
//   · exists in our dataset (`src/data/thai-geography.json`, thailand-geography-json, MIT) WITH THE SAME THAI NAME at all three levels, and nests the same way (the sub-district under that district, the district under that province);
//   · and our 77 province names equal `thai-provinces.ts` (the list `parents.province` is checked against) — the SAME set, both ways.
// ⛔ ANY mismatch ⇒ the script LISTS them and exits 1 — STOP: a parent could pick a place the server would refuse. Codes the dataset has and the picker does not are listed as INFORMATIONAL only.
// Read-only: it reads two files and prints. Nothing is written, nothing is connected to.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_GEOGRAPHY_PATH, loadGeography } from "../src/lib/area-codes";
import { THAI_PROVINCES } from "../src/lib/thai-provinces";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const pkg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--dataset");
if (!pkg) { console.error("usage: bun run scripts/cross-check-area-codes.ts <path to thai-address-universal> [--dataset <path>]"); process.exit(2); }

const geo = loadGeography(flag("--dataset") ? resolve(flag("--dataset")!) : undefined);
const picker: any = await import(pathToFileURL(join(resolve(pkg), "dist", "esm", "index.js")).href);

type Entry = { nameTh: string; nameEn: string; code: string };
const mismatches: string[] = [];
const seen = { provinces: new Set<string>(), districts: new Set<string>(), subDistricts: new Set<string>() };

// ── our 77 vs the picker's 77 vs thai-provinces.ts ──
const pickerProvinces: Entry[] = await picker.getProvinces();
const ours = new Set(THAI_PROVINCES);
const datasetNames = new Set([...geo.provinces.values()].map((p) => p.th));
for (const n of datasetNames) if (!ours.has(n)) mismatches.push(`dataset province name not in thai-provinces.ts: ${n}`);
for (const n of ours) if (!datasetNames.has(n)) mismatches.push(`thai-provinces.ts name not in the dataset: ${n}`);

for (const p of pickerProvinces) {
  seen.provinces.add(p.code);
  const dp = geo.provinces.get(p.code);
  if (!dp) { mismatches.push(`province ${p.code} ${p.nameTh}: code missing from the dataset`); continue; }
  if (dp.th !== p.nameTh) mismatches.push(`province ${p.code}: picker "${p.nameTh}" ≠ dataset "${dp.th}"`);
  const districts: Entry[] = await picker.getDistricts(p.code);
  for (const d of districts) {
    seen.districts.add(d.code);
    const dd = geo.districts.get(d.code);
    if (!dd) { mismatches.push(`district ${d.code} ${d.nameTh} (province ${p.code}): code missing from the dataset`); continue; }
    if (dd.th !== d.nameTh) mismatches.push(`district ${d.code}: picker "${d.nameTh}" ≠ dataset "${dd.th}"`);
    if (dd.province !== p.code) mismatches.push(`district ${d.code}: picker nests it under ${p.code}, dataset under ${dd.province}`);
    const subs: Entry[] = await picker.getSubDistricts(d.code);
    for (const s of subs) {
      seen.subDistricts.add(s.code);
      const ds = geo.subDistricts.get(s.code);
      if (!ds) { mismatches.push(`sub-district ${s.code} ${s.nameTh} (district ${d.code}): code missing from the dataset`); continue; }
      if (ds.th !== s.nameTh) mismatches.push(`sub-district ${s.code}: picker "${s.nameTh}" ≠ dataset "${ds.th}"`);
      if (ds.district !== d.code) mismatches.push(`sub-district ${s.code}: picker nests it under ${d.code}, dataset under ${ds.district}`);
    }
  }
}

const only = (have: Map<string, unknown>, got: Set<string>) => [...have.keys()].filter((c) => !got.has(c));
const infoP = only(geo.provinces, seen.provinces), infoD = only(geo.districts, seen.districts), infoS = only(geo.subDistricts, seen.subDistricts);

console.log(`dataset : ${flag("--dataset") ?? DEFAULT_GEOGRAPHY_PATH}`);
console.log(`picker  : ${resolve(pkg)}`);
console.log(`dataset rows ${geo.rows.length} · provinces ${geo.provinces.size} · districts ${geo.districts.size} · sub-districts ${geo.subDistricts.size}`);
console.log(`picker   provinces ${seen.provinces.size} · districts ${seen.districts.size} · sub-districts ${seen.subDistricts.size}`);
console.log(`our list (thai-provinces.ts): ${ours.size} provinces`);
console.log(`\nINFORMATIONAL — in the dataset, not offered by the picker: provinces ${infoP.length} · districts ${infoD.length} · sub-districts ${infoS.length}`);
if (infoS.length) console.log(`  first sub-district codes: ${infoS.slice(0, 10).join(", ")}`);
console.log(`\nPICKER-CODE MISMATCHES: ${mismatches.length}`);
const cap = args.includes("--all") ? Infinity : 200; // --all prints every mismatch (for the report file)
for (const m of mismatches.slice(0, cap)) console.log(`  ✗ ${m}`);
if (mismatches.length > cap) console.log(`  … and ${mismatches.length - cap} more (--all prints them)`);
if (mismatches.length) { console.log("\n⛔ GATE FAILED — STOP. Do not use this dataset until the mismatches are explained."); process.exit(1); }
console.log("\n✅ GATE PASSED — every picker code exists in the dataset with the SAME Thai name at all three levels, nested the same way; the 77 province names equal thai-provinces.ts.");
