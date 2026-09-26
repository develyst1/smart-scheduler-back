// TASK-495 — `db:generate`'s renumber, by value, on the REAL journal (read, never written). The generated entry is built the
// way drizzle writes it: the last entry's block copied, with the next idx, a new tag, and a `Date.now()`-shaped `when`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JournalSeriesError, SERIES_CEILING, SERIES_START, parseJournal, planSeriesRenumber } from "./journal-series";

const root = resolve(import.meta.dir, "..", "..");
const REAL = readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8");
const real = parseJournal(REAL, "real");
const last = real.entries.at(-1)!;
const NOW_SHAPED = 1_790_467_200_000; // what `drizzle-kit generate` writes today (`when: +new Date()`)

/** The real journal + ONE entry appended in drizzle's own layout (the last block copied: same indentation, same EOLs). */
const generated = (text: string, when: number, tag?: string) => {
  const tail = parseJournal(text, "base").entries.at(-1)!; // the LAST entry of the journal given (so two calls append idx +1, +2)
  const newTag = tag ?? `${String(tail.idx + 1).padStart(4, "0")}_probe`;
  const start = text.lastIndexOf("{", text.lastIndexOf(`"idx": ${tail.idx}`));
  const end = text.indexOf("}", text.lastIndexOf(`"idx": ${tail.idx}`)) + 1;
  const block = text.slice(start, end)
    .replace(`"idx": ${tail.idx}`, `"idx": ${tail.idx + 1}`)
    .replace(`"when": ${tail.when}`, `"when": ${when}`)
    .replace(`"tag": "${tail.tag}"`, `"tag": "${newTag}"`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.slice(text.lastIndexOf(eol, start) + eol.length, start);
  return text.slice(0, end) + "," + eol + indent + block + text.slice(end);
};

describe("✅ a freshly generated migration lands in our series — previous + 1, with nothing else touched", () => {
  test("drizzle's Date.now() `when` ⇒ the previous entry's `when` + 1, and the change is reported", () => {
    const after = generated(REAL, NOW_SHAPED);
    const { text, changes } = planSeriesRenumber(REAL, after);
    expect(changes).toEqual([{ tag: `${String(real.entries.length).padStart(4, "0")}_probe`, from: NOW_SHAPED, to: last.when + 1 }]);
    const out = parseJournal(text, "out");
    expect(out.entries.at(-1)!.when).toBe(last.when + 1);
    expect(out.entries.slice(0, -1)).toEqual(real.entries); // every existing entry, by value
    expect(text.slice(0, REAL.lastIndexOf("}", REAL.lastIndexOf("]")))).toBe(REAL.slice(0, REAL.lastIndexOf("}", REAL.lastIndexOf("]")))); // …and byte for byte
    expect(text).toBe(after.replace(`"when": ${NOW_SHAPED}`, `"when": ${last.when + 1}`)); // ONE value edited in place, layout and EOLs kept
  });
  test("🔑 the result satisfies TASK-494's rules: strictly increasing, and in the series from 0004", () => {
    const out = parseJournal(planSeriesRenumber(REAL, generated(REAL, NOW_SHAPED)).text, "out").entries;
    out.forEach((e, i) => { if (i) expect(e.when).toBeGreaterThan(out[i - 1]!.when); });
    for (const e of out.slice(4)) expect(e.when >= SERIES_START && e.when < SERIES_CEILING).toBe(true);
  });
  test("idempotent: a second run changes nothing — against the old journal AND against itself", () => {
    const once = planSeriesRenumber(REAL, generated(REAL, NOW_SHAPED)).text;
    expect(planSeriesRenumber(REAL, once)).toEqual({ text: once, changes: [] });
    expect(planSeriesRenumber(once, once)).toEqual({ text: once, changes: [] });
  });
  test("a new entry ALREADY in series (hand-numbered) is left as it is; no new entry ⇒ nothing to do", () => {
    const hand = generated(REAL, last.when + 1);
    expect(planSeriesRenumber(REAL, hand)).toEqual({ text: hand, changes: [] });
    expect(planSeriesRenumber(REAL, REAL)).toEqual({ text: REAL, changes: [] });
  });
  test("the bounds are TASK-494's: the series starts at 1783000000000, a million of headroom", () => {
    expect([SERIES_START, SERIES_CEILING]).toEqual([1_783_000_000_000, 1_783_001_000_000]);
  });
});

describe("🔴 applied history is out of reach — only the entry generate added in THIS run is ever a candidate", () => {
  test("the four pre-series entries (real clock stamps, OUT of series) are never touched", () => {
    const out = parseJournal(planSeriesRenumber(REAL, generated(REAL, NOW_SHAPED)).text, "out");
    expect(out.entries.slice(0, 4).map((e) => e.when)).toEqual(real.entries.slice(0, 4).map((e) => e.when));
    expect(real.entries.slice(0, 4).every((e) => e.when < SERIES_START)).toBe(true);
  });
  test("an EXISTING entry that changed during generate ⇒ refused, nothing written", () => {
    const tampered = generated(REAL, NOW_SHAPED).replace(`"when": ${last.when},`, `"when": ${last.when + 7},`);
    expect(() => planSeriesRenumber(REAL, tampered)).toThrow(JournalSeriesError);
    expect(() => planSeriesRenumber(REAL, tampered)).toThrow(`existing entry ${last.tag} changed during generate`);
  });
  test("an existing entry already OUT of series (a bad merge) is not 'fixed' — the new entry cannot follow it, so it refuses", () => {
    const badMerge = REAL.replace(`"when": ${last.when},`, `"when": ${NOW_SHAPED - 5},`);
    expect(() => planSeriesRenumber(badMerge, generated(badMerge, NOW_SHAPED))).toThrow("is itself outside the series");
  });
});

describe("🔴 an unexpected journal FAILS LOUDLY and changes nothing — it never guesses", () => {
  const refuses = (before: string, after: string, why: string) => {
    let err: unknown;
    try { planSeriesRenumber(before, after); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(JournalSeriesError);
    expect((err as Error).message).toContain(why);
    expect((err as Error).message).toContain("NOTHING was changed");
  };
  test("not JSON · not a journal · an idx out of place · a tag that does not match its idx · a non-integer when", () => {
    refuses(REAL, "{ not json", "not valid JSON");
    refuses(REAL, JSON.stringify({ entries: [] }), "is not a drizzle journal");
    const two = generated(REAL, NOW_SHAPED);
    refuses(REAL, two.replace(`"idx": ${last.idx + 1}`, `"idx": ${last.idx + 3}`), `has idx ${last.idx + 3}`);
    refuses(REAL, two.replace(`_probe"`, `"`).replace(`"tag": "${String(real.entries.length).padStart(4, "0")}"`, `"tag": "9999_probe"`), `has tag "9999_probe"`);
    refuses(REAL, two.replace(`"when": ${NOW_SHAPED}`, `"when": "soon"`), "when that is not a positive integer");
  });
  test("two new entries in one run · entries removed · an empty journal before", () => {
    const twoNew = generated(generated(REAL, NOW_SHAPED), NOW_SHAPED + 1);
    expect(parseJournal(twoNew, "x").entries.length).toBe(real.entries.length + 2); // a well-formed journal with TWO new entries…
    refuses(REAL, twoNew, "generate added 2 entries; this tool renumbers exactly one"); // …is still refused
    refuses(generated(REAL, NOW_SHAPED), REAL, "REMOVED journal entries");
    refuses(JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }), REAL.replace(/"entries": \[[\s\S]*\]/, '"entries": [{"idx":0,"version":"7","when":1790467200000,"tag":"0000_x","breakpoints":true}]'), "no entries before generate");
  });
  test("the same `when` text twice (it cannot be edited unambiguously) ⇒ refused", () => {
    const dup = generated(REAL, last.when + 0).replace(`"when": ${last.when}`, `"when": ${last.when}`);
    // a new entry with the SAME when as the previous one is not above it ⇒ a renumber is needed, but the text is ambiguous
    refuses(REAL, dup, `expected exactly one "\\"when\\": ${last.when}"`.replace(/\\"/g, '"'));
  });
});

describe("🔑 by source: the wrapper is what `db:generate` runs, and it writes only what the planner returned", () => {
  test("package.json · the script reads BEFORE generate, writes only on changes, exits non-zero on a refusal", () => {
    expect(readFileSync(resolve(root, "package.json"), "utf8")).toContain('"db:generate": "bun run scripts/db-generate.ts"');
    const S = readFileSync(resolve(root, "scripts/db-generate.ts"), "utf8");
    expect(S.indexOf("before = readFileSync(journalPath")).toBeLessThan(S.indexOf('spawnSync("bunx", ["drizzle-kit", "generate"'));
    expect((S.match(/writeFileSync\(/g) ?? []).length).toBe(1);
    expect(S).toContain("if (!changes.length) {");
    expect(S.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/DATABASE_URL|from "\.\.\/src\/db"|drizzle\.config/); // code only — the header comment names what it never touches
  });
});
