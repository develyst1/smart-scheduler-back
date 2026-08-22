// SPEC-054 / TASK-154 (REQ-060 Part A) — normalise gender + nationality ON WRITE.
//
// The product reads lowercase `male`/`female` and the Thai `ไทย`; the customer's sheet says `Male` and `Thai`. So
// every imported child showed **no gender**, and every Thai child was displayed as **Foreign**. Fixing it here —
// at the write — means no reader changes: the stored value simply becomes the one they already understand.
//
// Two deliberate asymmetries, both from the REQ's own analysis of the real rows:
//   · **An empty cell is a legitimate "not recorded"**, so it stores null and is NOT reported. Reporting blanks
//     would bury the handful of genuinely unreadable values in noise.
//   · **An unrecognised NATIONALITY passes through verbatim** (`Japan`, `Taiwan`, `Foreign`) — the world has more
//     nationalities than we can enumerate, and dropping one loses information the sheet actually had. Only
//     gender, a closed set, can be "unreadable".

export type Gender = "male" | "female" | "other";

export interface Normalised<T> {
  value: T | null;
  /** The original text, when it was non-empty and could NOT be understood — the operator gets a report line. */
  unreadable: string | null;
}

const GENDER_ALIASES: Record<string, Gender> = {
  male: "male",
  m: "male",
  ช: "male",
  ชาย: "male",
  female: "female",
  f: "female",
  ญ: "female",
  หญิง: "female",
  other: "other",
  อื่น: "other",
  อื่นๆ: "other",
};

export function normalizeGender(raw: string): Normalised<Gender> {
  const v = (raw ?? "").trim();
  if (!v) return { value: null, unreadable: null }; // a blank cell is "no gender recorded", not an error
  const hit = GENDER_ALIASES[v.toLowerCase()];
  return hit ? { value: hit, unreadable: null } : { value: null, unreadable: v };
}

const THAI_ALIASES = new Set(["thai", "th", "ไทย"]);

export function normalizeNationality(raw: string): Normalised<string> {
  const v = (raw ?? "").trim();
  if (!v) return { value: null, unreadable: null };
  // `ไทย` is the one value the product keys on (the SOM Thai/Foreign split); everything else is kept as written.
  return THAI_ALIASES.has(v.toLowerCase()) ? { value: "ไทย", unreadable: null } : { value: v, unreadable: null };
}
