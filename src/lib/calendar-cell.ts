// TASK-368 (REQ-089 §5) — which booking a calendar CELL shows when two rows share `date|teacher|startTime`.
//
// The grid is one booking per cell. Two rows can share a key because a status that frees the slot
// (`SLOT_INACTIVE_STATUSES`) lets the admin book into it again: a SICK_LEAVE and its replacement (UC-004), and —
// once cancelled sessions are shown on request — a CANCELLED row and whatever took its slot.
//
// Precedence LIVE > SICK_LEAVE > CANCELLED: a cancelled row never displaces anything and anything displaces it;
// a leave yields to a live row (the UC-004 rule, unchanged); equal ranks keep the first read. Pure, so the rule
// is pinned by itself.

const RANK: Record<string, number> = { CANCELLED: 0, SICK_LEAVE: 1 };

/** Higher wins the cell. Every status not named is LIVE for the cell's purpose. */
export const cellRank = (status: string): number => RANK[status] ?? 2;
