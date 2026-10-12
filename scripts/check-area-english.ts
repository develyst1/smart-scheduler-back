// TASK-803 — THE EXHAUSTIVE BY-CODE CHECK of our English area names against DOPA's own file.
//
//   bun run scripts/check-area-english.ts [--dopa <path to ccaatt.xlsx>] [--dataset <path>] [--list <file to write the full listing>] [--write-overrides <json path>]
//
// Source of truth: `src/data/dopa-ccaatt.xlsx` (กรมการปกครอง, https://stat.bora.dopa.go.th/dload/ccaatt.xlsx, file dated 2023-10-02), kept UNTOUCHED — its SHA-256 is checked first.
// For EVERY code of our dataset (provinces 2 / districts 4 / sub-districts 6 digits) it finds DOPA's row by CODE (DOPA writes 8 digits: CC000000 · CCAA0000 · CCAATT00)
// and compares:
//   · the THAI name — equal, or equal once DOPA's level word (เขต / อำเภอ / กิ่งอำเภอ / แขวง / ตำบล) is dropped. A Thai name that still differs ⇒ LISTED, never fixed (the code may mean another place);
//   · the ENGLISH name — equal (after trimming/collapsing spaces) ⇒ MATCHED; equal ignoring letter case only ⇒ CASE-ONLY (reported, NOT overridden — owner ruling via SA 2026-10-12); different ⇒ WRONG (DOPA's spelling is the correction).
// It checks the EFFECTIVE names (upstream + `thai-geography.en-overrides.json`), so once the overrides are in it must print WRONG 0.
// Generate the override file from the RAW upstream:  --dataset src/data/thai-geography.json --write-overrides src/data/thai-geography.en-overrides.json
// LISTED = anything unclear, never guessed: the code is not a current DOPA row · only a cancelled («*») row · Thai names differ · DOPA's English is empty.
// Output: three numbers (matched · wrong · listed) and the listings. `--write-overrides` writes the WRONG rows as `{code, level, th, en, source}` — GENERATED, never typed.
// Read-only otherwise: nothing is connected to.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGeography } from "../src/lib/area-codes";
import { readFirstSheet } from "./lib-xlsx-min";

export const DOPA_SIZE = 374371;
export const DOPA_SHA256 = "5977e39e689d229668dabb2ff47f1a1a4bec341bd1efa0792cb45cad8e16d6e9";
export const DOPA_SOURCE = `DOPA ทำเนียบท้องที่ ccaatt.xlsx, file dated 2023-10-02, https://stat.bora.dopa.go.th/dload/ccaatt.xlsx, sha256 ${DOPA_SHA256}`;

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dopaPath = resolve(flag("--dopa") ?? "src/data/dopa-ccaatt.xlsx");

const bytes = readFileSync(dopaPath);
const sha = createHash("sha256").update(bytes).digest("hex");
if (bytes.length !== DOPA_SIZE || sha !== DOPA_SHA256) {
  console.error(`⛔ ${dopaPath} is not the approved file: ${bytes.length} B / ${sha} (expected ${DOPA_SIZE} B / ${DOPA_SHA256}). STOP.`);
  process.exit(2);
}

const geo = loadGeography(flag("--dataset") ? resolve(flag("--dataset")!) : undefined);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const LEVEL_WORD = /^(?:กิ่งอำเภอ|อำเภอ|เขต|แขวง|ตำบล)\s*/;

type Dopa = { code8: string; th: string; en: string; date: string; cancelled: boolean };
const current = new Map<string, Dopa>(); // key = OUR code (2 / 4 / 6 digits)
const cancelled = new Map<string, Dopa[]>();
for (const r of readFirstSheet(dopaPath)) {
  const code8 = (r[0] ?? "").trim();
  if (!/^\d{8}$/.test(code8)) continue;
  const th0 = norm(r[1] ?? "");
  const star = th0.includes("*");
  const row: Dopa = { code8, th: norm(th0.replace(/\*/g, "")), en: norm(r[2] ?? ""), date: norm(r[3] ?? ""), cancelled: star || (r[3] ?? "").trim() !== "0" };
  const ourCode = code8.endsWith("000000") ? code8.slice(0, 2) : code8.endsWith("0000") ? code8.slice(0, 4) : code8.endsWith("00") ? code8.slice(0, 6) : code8;
  if (row.cancelled) { (cancelled.get(ourCode) ?? cancelled.set(ourCode, []).get(ourCode)!).push(row); }
  else current.set(ourCode, row);
}

type Level = "province" | "district" | "subdistrict";
type Item = { code: string; level: Level; th: string; en: string };
const items: Item[] = [
  ...[...geo.provinces].map(([code, v]) => ({ code, level: "province" as const, th: v.th, en: v.en })),
  ...[...geo.districts].map(([code, v]) => ({ code, level: "district" as const, th: v.th, en: v.en })),
  ...[...geo.subDistricts].map(([code, v]) => ({ code, level: "subdistrict" as const, th: v.th, en: v.en })),
];

const matched: Item[] = [];
const wrong: (Item & { dopaEn: string })[] = [];
const caseOnly: (Item & { dopaEn: string })[] = [];
const listed: (Item & { why: string })[] = [];
for (const it of items) {
  const d = current.get(it.code);
  if (!d) {
    const c = cancelled.get(it.code);
    listed.push({ ...it, why: c ? `only a CANCELLED row in DOPA (${c.map((x) => `${x.code8} ${x.th} / ${x.en} / ${x.date}`).join("; ")})` : "code is not in DOPA's file" });
    continue;
  }
  const thOk = d.th === it.th || d.th.replace(LEVEL_WORD, "") === it.th;
  if (!thOk) { listed.push({ ...it, why: `Thai differs: ours "${it.th}" · DOPA "${d.th}" (${d.code8})` }); continue; }
  if (!d.en) { listed.push({ ...it, why: `DOPA's English is EMPTY (${d.code8} ${d.th})` }); continue; }
  if (norm(it.en) === d.en) matched.push(it);
  else if (norm(it.en).toLowerCase() === d.en.toLowerCase()) caseOnly.push({ ...it, dopaEn: d.en });
  else wrong.push({ ...it, dopaEn: d.en });
}
const ours = new Set(items.map((i) => i.code));
const dopaOnly = [...current.keys()].filter((c) => !ours.has(c));

const lines: string[] = [];
const out = (s = "") => { lines.push(s); console.log(s); };
out(`source  : ${DOPA_SOURCE}`);
out(`file    : ${dopaPath} · ${bytes.length} B · sha256 ${sha} (verified)`);
out(`ours    : ${geo.provinces.size} provinces · ${geo.districts.size} districts · ${geo.subDistricts.size} sub-districts = ${items.length} codes`);
out(`DOPA    : ${current.size} current rows · ${[...cancelled.values()].reduce((a, b) => a + b.length, 0)} cancelled rows`);
out();
out(`MATCHED ${matched.length} · WRONG ${wrong.length} · case-only ${caseOnly.length} · LISTED ${listed.length}   (sum ${matched.length + wrong.length + caseOnly.length + listed.length} of ${items.length})`);
const by = (xs: { level: Level }[]) => (["province", "district", "subdistrict"] as const).map((l) => `${l} ${xs.filter((x) => x.level === l).length}`).join(" · ");
out(`  matched: ${by(matched)}`);
out(`  wrong  : ${by(wrong)}`);
out(`  case-only (not overridden): ${by(caseOnly)}`);
out(`  listed : ${by(listed)}`);
out(`  DOPA current codes our dataset does not have (informational): ${dopaOnly.length}`);
out();
out("── WRONG (ours → DOPA) ──");
for (const w of wrong) out(`${w.level.padEnd(11)} ${w.code.padEnd(6)} ${w.th} : "${w.en}" → "${w.dopaEn}"`);
out();
out("── CASE-ONLY — not overridden (ours | DOPA) ──");
for (const w of caseOnly) out(`${w.level.padEnd(11)} ${w.code.padEnd(6)} ${w.th} : "${w.en}" | "${w.dopaEn}"`);
out();
out("── LISTED (unclear — not fixed, not guessed) ──");
for (const l of listed) out(`${l.level.padEnd(11)} ${l.code.padEnd(6)} ${l.th} / "${l.en}" — ${l.why}`);
out();
out("── DOPA current codes not in our dataset (informational) ──");
for (const c of dopaOnly) { const d = current.get(c)!; out(`${c.padEnd(6)} ${d.code8} ${d.th} / ${d.en}`); }

if (flag("--list")) writeFileSync(resolve(flag("--list")!), lines.join("\n") + "\n", "utf8");
if (flag("--write-overrides")) {
  const rows = wrong.map((w) => ({ code: w.code, level: w.level, th: w.th, en: w.dopaEn, source: DOPA_SOURCE }));
  writeFileSync(resolve(flag("--write-overrides")!), JSON.stringify(rows, null, 2) + "\n", "utf8");
  out(`\nwrote ${rows.length} override rows → ${flag("--write-overrides")}`);
}
