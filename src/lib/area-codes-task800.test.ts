// TASK-800 (REQ-118) — the Thai area codes: the dataset, `areaName` TH/EN, the consistency rule, the pickers' routes, and THE GATE AS A TEST.
//
// 🔑 THE GATE AS A TEST (ruled B, Sober 2026-10-12): the cross-check script proved the OLD picker package's geocodes wrong for ~21 % of its rows, so the back end now serves the pickers' lists
// (`GET /api/areas/*`). The promise that replaces the cross-check: EVERY code those routes can return is accepted by the register / admin validation — walked here over ALL 77 / 928 / 7,436.
// Two layers: a small SYNTHETIC fixture for the rule's shape (ambiguity, a missing English name) and the REAL dataset (`src/data/thai-geography.json`, 2,920,644 bytes, SHA-256 recorded in TASK-800) for the counts and the walk.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  areaAddress, areaLevel, areaName, buildGeography, checkAreaCodes, isConsistent, listDistricts, listProvinces, listSubDistricts, loadGeography,
  provinceCodeByThaiName, triplesByThaiNames, useGeographyForTests,
} from "./area-codes";
import { THAI_PROVINCES } from "./thai-provinces";
import { parentAddressPatch } from "../services/parent.service";
import { checkAddress } from "../services/line-register.service";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const FIXTURE = buildGeography(JSON.parse(readFileSync(resolve(import.meta.dir, "__fixtures__", "thai-geography.fixture.json"), "utf8")));
afterEach(() => useGeographyForTests(null));
const HAVE_DATA = true; // 🔻 TASK-802 — the default dataset is EMBEDDED (a static import): it cannot be missing, so the real-data suites always run

describe("🔴 TASK-802 (TEST-099 F2) — the default dataset is EMBEDDED in the build, never read from the file system at runtime", () => {
  // The failure this pins: sid runs the COMPILED binary, where `import.meta.dir` is a VIRTUAL root (`B:\~BUN\…`). A runtime `readFileSync(resolve(import.meta.dir, …))` found nothing ⇒ every /api/areas/* and
  // every code PATCH answered 500 — while every test passed, because under `bun run` / `bun test` that path is the real source folder. A test cannot run inside the compiled binary, so the property is pinned by SOURCE.
  const SRC = readFileSync(resolve(import.meta.dir, "area-codes.ts"), "utf8").replace(/\r\n/g, "\n");
  const stripComments = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  const CODE = stripComments(SRC);
  test("the default dataset is a STATIC JSON import (`bun build --compile` embeds it)", () => {
    expect(CODE).toContain('import DATASET from "../data/thai-geography.json" with { type: "json" };');
    // TASK-803: the same static dataset, now with the generated English overrides (also a static import) as the second argument
    expect(CODE).toContain("buildGeography(DATASET as unknown as unknown[], EN_OVERRIDES as unknown as EnglishOverride[])");
  });
  test("no runtime file-system read of the default: no `import.meta.dir`, no `__dirname`, no default path constant — the ONLY `readFileSync` is the explicit-path branch the scripts use", () => {
    expect(CODE).not.toMatch(/import\.meta\.dir|__dirname|__filename|DEFAULT_GEOGRAPHY_PATH/);
    expect([...CODE.matchAll(/readFileSync\(/g)]).toHaveLength(1);
    expect(CODE).toContain('if (path) return buildGeography(JSON.parse(readFileSync(path, "utf8")));');
  });
  test("nothing else in `src/` reads the dataset file at runtime either (the same defect, anywhere else it could hide)", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(resolve(d, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [resolve(d, e.name)] : []));
    for (const f of walk(resolve(import.meta.dir, ".."))) {
      const code = stripComments(readFileSync(f, "utf8"));
      const name = f.split(/[\\/]src[\\/]/).pop();
      if (name === "lib\\area-codes.ts" || name === "lib/area-codes.ts") continue; // the loader itself — pinned by the two tests above (static import; the one explicit-path read)
      expect({ name, readsIt: /thai-geography\.json/.test(code) && /readFileSync|Bun\.file/.test(code) }).toEqual({ name, readsIt: false });
    }
  });
  test("the embedded default really serves: 7,436 rows through the no-path loader", () => {
    expect(loadGeography().rows).toHaveLength(7436);
  });
});

describe("the rule's shape — over the synthetic fixture", () => {
  test("areaLevel by code length (DOPA numbering: 2 / 4 / 6 digits)", () => {
    expect([areaLevel("10"), areaLevel("1001"), areaLevel("100101"), areaLevel("100"), areaLevel("abcd"), areaLevel("")]).toEqual(["province", "district", "subdistrict", null, null, null]);
  });
  test("areaName TH / EN at every level; an unknown code ⇒ null; a missing English name falls back to the Thai (never blank)", () => {
    expect([areaName("10", "TH", FIXTURE), areaName("10", "EN", FIXTURE)]).toEqual(["กรุงเทพมหานคร", "Bangkok"]);
    expect([areaName("1001", "TH", FIXTURE), areaName("1001", "EN", FIXTURE)]).toEqual(["พระนคร", "Phra Nakhon"]);
    expect([areaName("100101", "TH", FIXTURE), areaName("100101", "EN", FIXTURE)]).toEqual(["พระบรมมหาราชวัง", "Phra Borom Maha Ratchawang"]);
    expect(areaName("99", "TH", FIXTURE)).toBeNull();
    expect(areaName("830101", "EN", FIXTURE)).toBe("ตลาดใหญ่"); // the fixture row has no English
  });
  test("isConsistent: the district inside the province, the sub-district inside the district", () => {
    expect(isConsistent("10", "1001", "100101", FIXTURE)).toBe(true);
    expect(isConsistent("10", "1002", "100101", FIXTURE)).toBe(false); // the sub-district belongs to 1001
    expect(isConsistent("12", "1001", "100101", FIXTURE)).toBe(false); // the district belongs to 10
    expect(isConsistent("10", "1001", "999999", FIXTURE)).toBe(false);
  });
  test("checkAreaCodes names the FIRST thing wrong, and derives the Thai province name FROM the code", () => {
    expect(checkAreaCodes({ provinceCode: "10", districtCode: "1001", subdistrictCode: "100101" }, FIXTURE)).toEqual({ ok: true, province: "กรุงเทพมหานคร", triple: { provinceCode: "10", districtCode: "1001", subdistrictCode: "100101" } });
    expect(checkAreaCodes({ provinceCode: "99", districtCode: "1001", subdistrictCode: "100101" }, FIXTURE)).toMatchObject({ ok: false, outcome: "province-unknown", code: "99" });
    expect(checkAreaCodes({ provinceCode: "10", districtCode: "1201", subdistrictCode: "100101" }, FIXTURE)).toMatchObject({ ok: false, outcome: "district-invalid" });
    expect(checkAreaCodes({ provinceCode: "10", districtCode: "1001", subdistrictCode: "100201" }, FIXTURE)).toMatchObject({ ok: false, outcome: "subdistrict-invalid" });
  });
  test("areaAddress: `{sub-district} {district} {province}` in each language; null without codes — and WITHOUT touching the dataset", () => {
    const t = { provinceCode: "10", districtCode: "1001", subdistrictCode: "100101" };
    expect(areaAddress(t, "TH", FIXTURE)).toBe("พระบรมมหาราชวัง พระนคร กรุงเทพมหานคร");
    expect(areaAddress(t, "EN", FIXTURE)).toBe("Phra Borom Maha Ratchawang Phra Nakhon Bangkok");
    expect(areaAddress({ provinceCode: null, districtCode: null, subdistrictCode: null }, "TH")).toBeNull();
    expect(areaAddress({ provinceCode: "10", districtCode: null, subdistrictCode: null }, "TH")).toBeNull(); // a half address renders nothing
  });
  test("the backfill's two name lookups are EXACT: a province by its Thai name; a triple by three Thai names — two codes under one name set ⇒ both returned (the caller calls it ambiguous)", () => {
    expect(provinceCodeByThaiName("เชียงใหม่", FIXTURE)).toBe("50");
    expect(provinceCodeByThaiName("เชียงใหม่ ", FIXTURE)).toBeNull(); // nothing fuzzy
    expect(triplesByThaiNames("กรุงเทพมหานคร", "พระนคร", "พระบรมมหาราชวัง", FIXTURE)).toHaveLength(1);
    expect(triplesByThaiNames("นนทบุรี", "บางกรวย", "บางซ้ำ", FIXTURE)).toHaveLength(2);
    expect(triplesByThaiNames("กรุงเทพมหานคร", "พระนคร", "ไม่มี", FIXTURE)).toEqual([]);
  });
  test("the pickers' list readers: dataset order, per parent; unknown parent ⇒ []", () => {
    expect(listProvinces(FIXTURE).map((p) => p.code)).toEqual(["10", "12", "50", "83"]);
    expect(listDistricts("12", FIXTURE).map((d) => d.code)).toEqual(["1201", "1202"]);
    expect(listSubDistricts("1202", FIXTURE).map((s) => s.code)).toEqual(["120201", "120210", "120211"]);
    expect(listDistricts("99", FIXTURE)).toEqual([]);
    expect(listProvinces(FIXTURE)[0]).toEqual({ code: "10", nameTh: "กรุงเทพมหานคร", nameEn: "Bangkok" });
  });
  test("a half-read dataset is refused: a row without a code or a Thai name throws", () => {
    expect(() => buildGeography([{ provinceCode: 10, provinceNameTh: "x", districtCode: 1001, districtNameTh: "y", subdistrictCode: "", subdistrictNameTh: "z" }])).toThrow(/subdistrictCode/);
  });
});

describe.skipIf(!HAVE_DATA)("the REAL dataset — counts, samples, and the 77", () => {
  test("77 provinces / 928 districts / 7,436 sub-districts, as the file that was gated", () => {
    const g = loadGeography();
    expect([g.provinces.size, g.districts.size, g.subDistricts.size, g.rows.length]).toEqual([77, 928, 7436, 7436]);
  });
  test("the 77 province NAMES equal `thai-provinces.ts` — the same set both ways (the list `parents.province` is checked against)", () => {
    const g = loadGeography();
    expect([...g.provinces.values()].map((p) => p.th).sort()).toEqual([...THAI_PROVINCES].sort());
  });
  test("areaName TH / EN on the samples the brief names; บึงกาฬ is `38` (the old picker said `97`)", () => {
    expect([areaName("10", "TH"), areaName("10", "EN")]).toEqual(["กรุงเทพมหานคร", "Bangkok"]);
    expect([areaName("100101", "TH"), areaName("100101", "EN")]).toEqual(["พระบรมมหาราชวัง", "Phra Borom Maha Ratchawang"]);
    expect(areaName("38", "TH")).toBe("บึงกาฬ");
    expect(areaName("97", "TH")).toBeNull();
  });
  test("every code nests: each sub-district's district is in the province the lists say", () => {
    const g = loadGeography();
    for (const [code, d] of g.districts) expect({ code, ok: g.provinces.has(d.province) }).toEqual({ code, ok: true });
    for (const [code, s] of g.subDistricts) expect({ code, ok: g.districts.has(s.district) }).toEqual({ code, ok: true });
  });
});

describe.skipIf(!HAVE_DATA)("🔴 THE GATE AS A TEST — every code the pickers' lists can serve is ACCEPTED by the validation", () => {
  test("walk ALL provinces → districts → sub-districts through the list readers: each triple passes `checkAreaCodes`, the admin door (`parentAddressPatch`) and the register door (`checkAddress`)", () => {
    let triples = 0;
    for (const p of listProvinces()) {
      for (const d of listDistricts(p.code)) {
        for (const s of listSubDistricts(d.code)) {
          triples++;
          const t = { provinceCode: p.code, districtCode: d.code, subdistrictCode: s.code };
          const c = checkAreaCodes(t);
          if (!c.ok || c.province !== p.nameTh) throw new Error(`REJECTED a served triple: ${JSON.stringify(t)} → ${JSON.stringify(c)}`);
          const patch = parentAddressPatch(t);
          if (patch.province !== p.nameTh || patch.subdistrictCode !== s.code) throw new Error(`admin door rewrote a served triple: ${JSON.stringify(t)}`);
          const reg = checkAddress({ name: "x", ...t });
          if (!reg.ok) throw new Error(`register door refused a served triple: ${JSON.stringify(t)}`);
        }
      }
    }
    expect(triples).toBe(7436);
  });
  test("every served province name is one of the 77 (the name `parents.province` will hold)", () => {
    for (const p of listProvinces()) expect({ p: p.nameTh, ok: THAI_PROVINCES.includes(p.nameTh) }).toEqual({ p: p.nameTh, ok: true });
  });
});

describe.skipIf(!HAVE_DATA)("the pickers' routes — through the ROOT app", () => {
  const rootApp = async () => (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
  const get = async (path: string) => { const r = await (await rootApp()).fetch(new Request(`http://localhost${path}`)); return { status: r.status, cache: r.headers.get("cache-control"), body: (await r.json()) as any }; };
  test("provinces: 77 rows of exactly { code, nameTh, nameEn }, no auth header, cacheable", async () => {
    const r = await get("/api/areas/provinces");
    expect(r.status).toBe(200);
    expect(r.cache).toContain("public");
    expect(r.body).toHaveLength(77);
    for (const row of r.body) expect(Object.keys(row).sort()).toEqual(["code", "nameEn", "nameTh"]);
    expect(r.body.find((p: any) => p.code === "38")).toEqual({ code: "38", nameTh: "บึงกาฬ", nameEn: "Bueng Kan" });
  });
  test("districts / sub-districts by parent code; a well-formed unknown code ⇒ 200 []; a malformed or missing one ⇒ 400", async () => {
    const d = await get("/api/areas/districts?province=10");
    expect(d.status).toBe(200);
    expect(d.body).toHaveLength(50);
    expect(d.body.every((x: any) => /^10\d\d$/.test(x.code))).toBe(true);
    const s = await get("/api/areas/subdistricts?district=1001");
    expect(s.body.find((x: any) => x.code === "100101")).toEqual({ code: "100101", nameTh: "พระบรมมหาราชวัง", nameEn: "Phra Borom Maha Ratchawang" });
    expect(await get("/api/areas/districts?province=99")).toMatchObject({ status: 200, body: [] });
    for (const bad of ["/api/areas/districts", "/api/areas/districts?province=x", "/api/areas/districts?province=100", "/api/areas/subdistricts", "/api/areas/subdistricts?district=10"]) {
      const r = await get(bad);
      expect({ bad, status: r.status, code: r.body.code }).toEqual({ bad, status: 400, code: "VALIDATION" });
    }
  });
  test("what the routes answer is geography ONLY — an allow-list of three fields per row, nothing else, at any depth", async () => {
    const r = await get("/api/areas/subdistricts?district=1001");
    expect(JSON.stringify(r.body)).not.toMatch(/phone|note|rate|token|admin/i);
    expect(Object.keys(r.body[0]).sort()).toEqual(["code", "nameEn", "nameTh"]);
  });
});
