// TASK-495 — keep a freshly generated migration's `when` in our series. PURE: journal TEXT in, journal TEXT out; the script
// (`scripts/db-generate.ts`) does the I/O around `drizzle-kit generate`.
//
// 🔴 Why: `drizzle-kit generate` hardcodes `when: +new Date()` (~1790…), above our hand-assigned 1783… series, and drizzle
// applies a migration only when its `when` is GREATER than the ledger's newest `created_at` — skipping everything else in
// silence, exit 0 (TASK-085/TASK-494). One generated `when` left as is would make every later migration skip forever.
//
// 🔑 WHAT IT MAY TOUCH — provably only an entry that did not exist a moment ago:
//  · it is handed the journal as it was BEFORE `generate` ran and as it is AFTER;
//  · every entry present BEFORE must be byte-for-byte unchanged AFTER, or it refuses — so it never edits one;
//  · the only candidate is the ONE entry `generate` added in this run. An entry born in this run cannot have been applied
//    on any box: it did not exist when any box last migrated. ⇒ applied history is out of reach by construction.
// 🔑 It never guesses: an unexpected journal shape, more than one new entry, an in-place change, or a target outside the
// series ⇒ `JournalSeriesError`, and the caller writes NOTHING.
// 📌 TASK-494's test (`migration-when-series.test.ts`) stays as the backstop for hand-edited journals and bad merges.

/** Our series (TASK-494): starts at 0004 = 1783000000000, one per migration; a million of headroom below any real clock. */
export const SERIES_START = 1_783_000_000_000;
export const SERIES_CEILING = SERIES_START + 1_000_000;

export interface JournalEntry { idx: number; version: string; when: number; tag: string; breakpoints: boolean }
export interface Journal { version: string; dialect: string; entries: JournalEntry[] }
export type WhenChange = { tag: string; from: number; to: number };

export class JournalSeriesError extends Error {
  constructor(message: string) {
    super(`journal-series: ${message} — NOTHING was changed.`);
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The shape drizzle writes, checked field by field. Anything else is refused, never repaired. */
export function parseJournal(text: string, label: string): Journal {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new JournalSeriesError(`${label} is not valid JSON`); }
  if (!isObj(j) || typeof j.version !== "string" || typeof j.dialect !== "string" || !Array.isArray(j.entries)) {
    throw new JournalSeriesError(`${label} is not a drizzle journal ({ version, dialect, entries[] })`);
  }
  j.entries.forEach((e: unknown, i: number) => {
    const where = `${label} entry #${i}`;
    if (!isObj(e)) throw new JournalSeriesError(`${where} is not an object`);
    if (e.idx !== i) throw new JournalSeriesError(`${where} has idx ${String(e.idx)} (expected ${i})`);
    if (typeof e.version !== "string") throw new JournalSeriesError(`${where} has no string version`);
    if (!Number.isSafeInteger(e.when) || (e.when as number) <= 0) throw new JournalSeriesError(`${where} has a when that is not a positive integer`);
    if (typeof e.tag !== "string" || !e.tag.startsWith(`${String(i).padStart(4, "0")}_`)) throw new JournalSeriesError(`${where} has tag ${JSON.stringify(e.tag)} (expected "${String(i).padStart(4, "0")}_…")`);
    if (typeof e.breakpoints !== "boolean") throw new JournalSeriesError(`${where} has no boolean breakpoints`);
  });
  return j as unknown as Journal;
}

const inSeries = (w: number) => w >= SERIES_START && w < SERIES_CEILING;

/**
 * The journal text to write after `generate`, and what changed. `changes` is empty when there is nothing to do (no new entry,
 * or the new entry is already in series and above the previous one) — which also makes a second run a no-op.
 */
export function planSeriesRenumber(beforeText: string, afterText: string): { text: string; changes: WhenChange[] } {
  const before = parseJournal(beforeText, "the journal before generate");
  const after = parseJournal(afterText, "the journal after generate");
  if (after.entries.length < before.entries.length) throw new JournalSeriesError("generate REMOVED journal entries");
  before.entries.forEach((b, i) => {
    if (JSON.stringify(after.entries[i]) !== JSON.stringify(b)) {
      throw new JournalSeriesError(`existing entry ${b.tag} changed during generate — an entry that may be applied is never edited here`);
    }
  });
  const added = after.entries.slice(before.entries.length);
  if (added.length === 0) return { text: afterText, changes: [] };
  if (added.length > 1) throw new JournalSeriesError(`generate added ${added.length} entries; this tool renumbers exactly one`);
  const prev = before.entries.at(-1);
  if (!prev) throw new JournalSeriesError("the journal had no entries before generate — there is no series to follow");
  const e = added[0]!;
  if (e.when > prev.when && inSeries(e.when)) return { text: afterText, changes: [] }; // already right (hand-numbered, or a re-run)
  const to = prev.when + 1;
  if (!inSeries(to)) throw new JournalSeriesError(`the previous entry ${prev.tag} (${prev.when}) is itself outside the series [${SERIES_START}, ${SERIES_CEILING}) — fix the journal by hand`);
  // Replace ONLY that entry's value, in place — never re-serialise (the file's line endings and layout stay byte-identical).
  const needle = `"when": ${e.when}`;
  const hits = afterText.split(needle).length - 1;
  if (hits !== 1) throw new JournalSeriesError(`expected exactly one "${needle}" in the journal, found ${hits}`);
  const text = afterText.replace(needle, `"when": ${to}`);
  const check = parseJournal(text, "the renumbered journal");
  const want = after.entries.map((x, i) => (i === after.entries.length - 1 ? { ...x, when: to } : x));
  if (JSON.stringify(check.entries) !== JSON.stringify(want)) throw new JournalSeriesError("the in-place edit did not produce exactly the intended journal");
  return { text, changes: [{ tag: e.tag, from: e.when, to }] };
}
