// TASK-488 — the check-in provenance, split: a CHANNEL (a closed set we choose) and an ACTOR (free text a human typed).
//
// 🔴 They must never share a column, a mask rule or a lookup (TASK-481: a parent one default away from an admin's username;
// TASK-482: a free-text value used as a map key). The CHANNEL is this closed type — a sixth channel is a compile error at every
// writer, and the database's CHECK (migration 0057) is pinned EQUAL to this list. The ACTOR is a plain `string | null`:
// never a map key, never compared against this list, never shown to a parent.

/** The closed set of ways a session or camp day came to be marked. `staff` is an admin in the app (their username → actor). */
export const CHECKIN_CHANNELS = ["checkin-qr", "line", "shopfront-qr", "staff", "end-of-day"] as const;
export type CheckinChannel = (typeof CHECKIN_CHANNELS)[number];

export const isCheckinChannel = (v: unknown): v is CheckinChannel =>
  typeof v === "string" && (CHECKIN_CHANNELS as readonly string[]).includes(v);

/** What a writer records: ALWAYS a channel; an actor only for a person (the staff path). */
export interface Provenance {
  channel: CheckinChannel;
  actor?: string | null;
}

/**
 * The old single column's value for a provenance — `checkin_source` / `marked_by` are still written exactly as before until the
 * drop: the person when there is one, else the channel.
 */
export const legacySourceOf = (p: Provenance | null | undefined): string | null => (p ? (p.actor ?? p.channel) : null);

/**
 * The BACKFILL's rule, as a pure function — migration 0057's SQL is its mirror (pinned) and the report script uses it to say
 * where every old value goes: a known channel ⇒ that channel; anything else non-null ⇒ an actor, via `staff`; null ⇒ nothing.
 */
export function classifyLegacySource(v: string | null | undefined): { channel: CheckinChannel | null; actor: string | null } {
  if (v === null || v === undefined) return { channel: null, actor: null };
  return isCheckinChannel(v) ? { channel: v, actor: null } : { channel: "staff", actor: v };
}

/**
 * How a READ carries the provenance (sessions and camp alike):
 * - `"raw"` — an unscoped admin read: the channel and the actor as stored, untranslated;
 * - `"masked"` — a scoped (linked-teacher) read: both `null` (Sober's ruling B, TASK-481);
 * - omitted — every other read, incl. the PUBLIC scan: the fields are ABSENT. A parent never sees an actor — not masked, absent.
 */
export type ProvenanceView = "raw" | "masked";
