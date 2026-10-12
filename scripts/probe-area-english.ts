// TASK-803 — the COMPILED PROBE's entry. `bun build --compile` this file and run the binary: it prints the effective English names (upstream + DOPA overrides) of a few codes,
// so a test can prove the overrides are EMBEDDED in a compiled build (a runtime file read would fail there — TASK-802). Prints one JSON line. Nothing else.
import { areaName, loadGeography } from "../src/lib/area-codes";

const g = loadGeography();
console.log(JSON.stringify({
  rows: g.rows.length,
  lopBuri: areaName("16", "EN"),
  nonSuwan: areaName("3117", "EN"),
  dongLuang: areaName("4904", "EN"),
  caseOnlyKept: areaName("1406", "EN"),
}));
