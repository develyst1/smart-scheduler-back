// TASK-803 — DOPA's English area names override the upstream file's wrong ones, by CODE. What is pinned:
//   · the override file is GENERATED from DOPA's ccaatt.xlsx (re-generating gives the same bytes), 583 rows, every row cites the source, upstream `thai-geography.json` is untouched;
//   · the effective names equal DOPA's (the check prints WRONG 0), the 107 case-only rows and the LISTED 450109 keep upstream;
//   · a bad override (wrong Thai name / matches no row) THROWS — never half-applied;
//   · the overrides are EMBEDDED in a compiled binary (a real `bun build --compile` probe), because a runtime file read fails there (TASK-802).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { areaName, buildGeography, loadGeography } from "./area-codes";

const ROOT = resolve(import.meta.dir, "..", "..");
const bytes = (rel: string) => readFileSync(resolve(ROOT, rel));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const OVERRIDES = JSON.parse(bytes("src/data/thai-geography.en-overrides.json").toString("utf8")) as { code: string; level: string; th: string; en: string; source: string }[];
const RAW = JSON.parse(bytes("src/data/thai-geography.json").toString("utf8")) as unknown[];

describe("TASK-803 — the inputs are the approved files, untouched", () => {
  test("DOPA's ccaatt.xlsx is the approved one: 374,371 B, SHA-256 5977e39e…", () => {
    const b = bytes("src/data/dopa-ccaatt.xlsx");
    expect(b.length).toBe(374371);
    expect(sha(b)).toBe("5977e39e689d229668dabb2ff47f1a1a4bec341bd1efa0792cb45cad8e16d6e9");
  });
  test("upstream thai-geography.json is UNTOUCHED: 7,436 rows whose content hash (line-ending proof) is the shipped one", () => {
    expect(RAW).toHaveLength(7436);
    expect(sha(Buffer.from(JSON.stringify(RAW)))).toBe("759bd146861ba668aafd29ba3b75f407d7ed6d4b5d7e3589deb2decd3f54234d");
  });
});

describe("TASK-803 — the override list", () => {
  test("583 rows, each {code, level, th, en, source}; every source cites DOPA's file, its date, URL and SHA-256; codes unique", () => {
    expect(OVERRIDES).toHaveLength(583);
    expect(new Set(OVERRIDES.map((o) => o.code)).size).toBe(583);
    for (const o of OVERRIDES) {
      expect(Object.keys(o).sort()).toEqual(["code", "en", "level", "source", "th"]);
      expect(o.en.length).toBeGreaterThan(0);
      expect(o.source).toContain("ccaatt.xlsx");
      expect(o.source).toContain("2023-10-02");
      expect(o.source).toContain("https://stat.bora.dopa.go.th/dload/ccaatt.xlsx");
      expect(o.source).toContain("5977e39e689d229668dabb2ff47f1a1a4bec341bd1efa0792cb45cad8e16d6e9");
    }
    const byLevel = (l: string) => OVERRIDES.filter((o) => o.level === l).length;
    expect([byLevel("province"), byLevel("district"), byLevel("subdistrict")]).toEqual([2, 39, 542]);
  });

  test("GENERATED, not typed: re-running the generator from DOPA's file yields the SAME bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "area-en-"));
    try {
      const out = join(dir, "overrides.json");
      const r = Bun.spawnSync(["bun", "run", "scripts/check-area-english.ts", "--dataset", "src/data/thai-geography.json", "--write-overrides", out], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
      // TASK-804: content with line endings normalised — Git (core.autocrlf) writes this file with CRLF on Windows checkouts; the committed blob is the generator's LF output
      const lf = (b: Buffer) => sha(Buffer.from(b.toString("utf8").replace(/\r\n/g, "\n")));
      expect(lf(readFileSync(out))).toBe(lf(bytes("src/data/thai-geography.en-overrides.json")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);

  test("the check REFUSES any file but the approved one (size/SHA-256 gate) — exit 2, nothing compared", () => {
    const dir = mkdtempSync(join(tmpdir(), "area-en-bad-"));
    try {
      const bad = join(dir, "other.xlsx");
      const b = Buffer.from(bytes("src/data/dopa-ccaatt.xlsx"));
      b[b.length - 1] ^= 1;
      writeFileSync(bad, b);
      const r = Bun.spawnSync(["bun", "run", "scripts/check-area-english.ts", "--dopa", bad], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(2);
      expect(r.stdout.toString()).not.toContain("MATCHED");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);

  test("the check on the EFFECTIVE names prints WRONG 0 · case-only 107 · LISTED 1", () => {
    const r = Bun.spawnSync(["bun", "run", "scripts/check-area-english.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    expect(out).toContain("MATCHED 8333 · WRONG 0 · case-only 107 · LISTED 1");
  }, 60000);
});

describe("TASK-803 — the effective names", () => {
  test("DOPA's spelling wins where upstream was wrong", () => {
    expect(areaName("16", "EN")).toBe("Lop Buri");
    expect(areaName("82", "EN")).toBe("Phang-nga");
    expect(areaName("3117", "EN")).toBe("Non Suwan");
    expect(areaName("4904", "EN")).toBe("Dong Luang");
    expect(areaName("5402", "EN")).toBe("Rong Kwang");
  });
  test("Thai names are never changed by an override", () => {
    const g = loadGeography(), raw = buildGeography(RAW);
    for (const [c, v] of raw.subDistricts) expect(g.subDistricts.get(c)!.th).toBe(v.th);
    for (const [c, v] of raw.districts) expect(g.districts.get(c)!.th).toBe(v.th);
    expect(g.rows).toHaveLength(raw.rows.length);
  });
  test("the 107 case-only rows keep upstream's casing; 450109 (LISTED) is untouched", () => {
    expect(areaName("1406", "EN")).toBe("Bang Pa-In");
    expect(areaName("450109", "EN")).toBe(buildGeography(RAW).subDistricts.get("450109")!.en);
    const codes = new Set(OVERRIDES.map((o) => o.code));
    expect(codes.has("1406")).toBe(false);
    expect(codes.has("450109")).toBe(false);
  });
  test("every override really changed its row (no no-op rows)", () => {
    const raw = buildGeography(RAW), g = loadGeography();
    for (const o of OVERRIDES) {
      const [a, b] = o.level === "province" ? [raw.provinces.get(o.code)!, g.provinces.get(o.code)!] : o.level === "district" ? [raw.districts.get(o.code)!, g.districts.get(o.code)!] : [raw.subDistricts.get(o.code)!, g.subDistricts.get(o.code)!];
      expect(b.en).toBe(o.en);
      expect(a.en).not.toBe(o.en);
    }
  });
});

describe("TASK-803 — a bad override list is refused, never half-applied", () => {
  const first = OVERRIDES[0];
  test("an override whose Thai name is not the row's THROWS", () => {
    expect(() => buildGeography(RAW, [{ ...first, level: first.level as "province", th: "ผิด" }])).toThrow(/English override/);
  });
  test("an override that matches no row THROWS", () => {
    expect(() => buildGeography(RAW, [{ ...first, level: first.level as "province", code: "99" }])).toThrow(/match no row/);
  });
  test("no overrides ⇒ the raw upstream names", () => {
    expect(buildGeography(RAW).provinces.get("16")!.en).toBe("Loburi");
  });
});

describe("TASK-803 — EMBEDDED in a compiled build (a runtime read of the file fails there — TASK-802)", () => {
  const SRC = readFileSync(resolve(import.meta.dir, "area-codes.ts"), "utf8").replace(/\r\n/g, "\n");
  test("the overrides are a STATIC JSON import", () => {
    expect(SRC).toContain('import EN_OVERRIDES from "../data/thai-geography.en-overrides.json" with { type: "json" };');
    expect(SRC).toContain("EN_OVERRIDES as unknown as EnglishOverride[]");
  });
  test("🔴 a real `bun build --compile` binary, run from another folder, serves the DOPA names", () => {
    const dir = mkdtempSync(join(tmpdir(), "area-probe-"));
    try {
      const exe = join(dir, process.platform === "win32" ? "probe.exe" : "probe");
      const b = Bun.spawnSync(["bun", "build", "scripts/probe-area-english.ts", "--compile", "--outfile", exe], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(b.exitCode).toBe(0);
      expect(statSync(exe).size).toBeGreaterThan(1000000);
      const r = Bun.spawnSync([exe], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.toString().trim())).toEqual({ rows: 7436, lopBuri: "Lop Buri", nonSuwan: "Non Suwan", dongLuang: "Dong Luang", caseOnlyKept: "Bang Pa-In" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180000);
});
