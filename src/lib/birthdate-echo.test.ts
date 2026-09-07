// TASK-280 — the confirm step echoes the date in the order the parent typed it.
//
// 🔴 Not cosmetic. TASK-277 made this step **load-bearing for correctness** because `03-04-2024` is ambiguous to
// a HUMAN — 3 April or 4 March. The parser is unambiguous; the person is not, and the summary exists to let them
// catch their own slip. Echoing the stored ISO made the reader perform **exactly the conversion the step exists
// to spare them**, so on this one field it was close to no guard at all.
//
// 🔑 The DoD's own line: assert it END TO END, prompt to summary, not just on the formatter — because the
// formatter being right is not the claim. The claim is that what a parent types is what a parent is shown.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatBirthDateForDisplay, parseBirthDate, summaryLines } from "./line-add-student";
import { t } from "./line-i18n";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));

const labels = {
  name: t("add_l_name", "TH"),
  birthDate: t("add_l_birthdate", "TH"),
  province: t("add_l_province", "TH"),
  none: t("add_l_none", "TH"),
};

/** Type it, store it, read it back — the whole path the parent actually walks. */
const roundTrip = (typed: string) => {
  const parsed = parseBirthDate(typed);
  if (!parsed.ok) return { stored: null, shown: null };
  const stored = parsed.value;
  const line = summaryLines({ name: "น้องเอ", birthDate: stored ?? undefined, province: "ภูเก็ต" }, labels)[1]!;
  return { stored, shown: line.slice(line.indexOf(": ") + 2) };
};

describe("TASK-280 — what a parent types is what a parent is shown", () => {
  test("🔑 END TO END: `02-12-2024` → stored `2024-12-02` → shown `02-12-2024`", () => {
    // The formatter being right is not the claim; this is. Prompt to summary, through the real parser.
    expect(roundTrip("02-12-2024")).toEqual({ stored: "2024-12-02", shown: "02-12-2024" });
  });

  test("🔑 the AMBIGUOUS case, as its own test — it is the whole reason the step exists", () => {
    // A parent who means 4 March types `04-03-2024` and must be able to SEE that it was read as 4 March.
    // Before this, they saw `2024-03-04` and had to re-derive the order to be sure.
    expect(roundTrip("03-04-2024")).toEqual({ stored: "2024-04-03", shown: "03-04-2024" });
    expect(roundTrip("04-03-2024")).toEqual({ stored: "2024-03-04", shown: "04-03-2024" });
    // …and the two are visibly different in the echo, which is the property that matters.
    expect(roundTrip("03-04-2024").shown).not.toBe(roundTrip("04-03-2024").shown);
  });

  test("a single-digit input is echoed PADDED — the stored value decides the shape", () => {
    // `2-4-2018` parses to `2018-04-02`, so the echo is `02-04-2018`. That is not the literal keystrokes, and it
    // is right: it is what the system understood, which is what the parent is being asked to confirm.
    expect(roundTrip("2-4-2018")).toEqual({ stored: "2018-04-02", shown: "02-04-2018" });
  });

  test("🚫 the STORED value is still ISO — this is where the change could do harm", () => {
    for (const typed of ["02-12-2024", "31-12-1999", "1/1/2020"]) {
      const { stored } = roundTrip(typed);
      expect({ typed, iso: /^\d{4}-\d{2}-\d{2}$/.test(stored ?? "") }).toEqual({ typed, iso: true });
    }
    // And the parser is untouched: the retired order is still refused.
    expect(parseBirthDate("2024-12-02").ok).toBe(false);
  });

  test("a skipped date still renders the `none` label, not a formatted blank", () => {
    const lines = summaryLines({ name: "น้องต้น" }, labels);
    expect(lines[1]).toBe(`${labels.birthDate}: ${labels.none}`);
  });

  test("⚠️ a value that is not a well-formed ISO date passes through UNCHANGED", () => {
    // Same rule as the phone formatter: the display must not invent a shape for something it does not
    // recognise. Nothing produces these today; the guard is for whatever writes `birthDate` next.
    for (const odd of ["2024-12", "not-a-date", "", "02-12-2024", "2024/12/02"]) {
      expect({ odd, out: formatBirthDateForDisplay(odd) }).toEqual({ odd, out: odd });
    }
  });
});

describe("TASK-280 — display only, by contract", () => {
  test("🚫 it is NOT the inverse of the parser, and the code says so where someone would reach for it", () => {
    const c = src("src/lib/line-add-student.ts");
    expect(c).toContain("deliberately NOT the inverse of `parseBirthDate`");
    // The pair sit together, so the sentence is read by whoever is about to make the mistake.
    expect(c.indexOf("export function parseBirthDate")).toBeLessThan(
      c.indexOf("export function formatBirthDateForDisplay"),
    );
  });

  test("🔑 its ONLY caller is the summary — asserted by POSITION, not by a count", () => {
    // A count survives nothing; position survives someone adding a fourth call site.
    const c = src("src/lib/line-add-student.ts").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    const uses = [...c.matchAll(/formatBirthDateForDisplay\(/g)];
    for (const m of uses) {
      const declaring = c.slice(Math.max(0, m.index! - 16), m.index!) === "export function ";
      const before = c.slice(0, m.index!);
      const inSummary =
        before.lastIndexOf("export function summaryLines") > before.lastIndexOf("export function parseBirthDate");
      expect({ at: m.index, declaring, inSummary, ok: declaring || inSummary }).toMatchObject({ ok: true });
    }
  });

  test("🚫 no other module calls it", () => {
    for (const f of [
      "src/services/line-webhook.service.ts",
      "src/services/parent.service.ts",
      "src/services/scheduler.service.ts",
      "src/lib/line-message.ts",
    ]) {
      expect({ f, calls: src(f).includes("formatBirthDateForDisplay") }).toEqual({ f, calls: false });
    }
  });

  test("the confirm step's load-bearing comment was strengthened, not replaced", () => {
    const svc = src("src/services/line-webhook.service.ts");
    expect(svc).toContain("LOAD-BEARING FOR CORRECTNESS"); // TASK-277's sentence survives
    expect(svc).toContain("the echo below is DAY-FIRST for the same reason"); // TASK-280's addition
  });
});
