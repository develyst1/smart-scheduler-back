// SPEC-060 / TASK-166 (REQ-064 requirement 6 / AC-7) — which imported courses hold the wrong number of sessions.
//
// 🔴 **This file measures. It never corrects.** Some of the 16 imported courses live on `uat` already carry
// phantom EXTENDED sessions created by a leave taken before TASK-165 — sessions that real families have been
// told about. Deleting one is a decision about a child's lesson, so the audit produces a list for the owner and
// the reconciler is explicitly forbidden (`withholdImportCancels`) from acting on it.
//
// The rule is one comparison: an imported course's plan should hold exactly `size − priorSessions` live
// sessions. Anything else is drift, in one of two directions:
//   · **over** — phantoms. The give-away this REQ is about; correcting means removing appended EXTENDED rows.
//   · **under** — the plan holds fewer sessions than it should, so it owes make-ups nobody is tracking.
//
// The audit is deliberately NOT filtered to "over". The back-fill takes `priorSessions` from `usedSessions`,
// which has already grown if anything was attended after the import — such a course reads as "over" by exactly
// that many, with no EXTENDED rows to explain it, and its real problem is the opposite one: it will quietly
// under-append the family's next make-up. That shape is why the suggestion sends a mismatch it cannot explain
// to a human instead of proposing a removal.
//
// Pure — no DB, no I/O. The script hands it rows; every case below is unit-tested without a database.

export interface AuditCourseInput {
  id: string;
  nickname: string | null;
  size: number;
  priorSessions: number;
  usedSessions: number;
  source: string;
  /** Live COURSE_PACKAGE sessions on the plan (delivered + still-to-come; cancelled excluded by the caller). */
  liveCount: number;
  /** Of those, how many are appended `EXTENDED` rows — the only kind a correction could remove. */
  extendedCount: number;
}

export interface AuditFinding extends AuditCourseInput {
  planSize: number;
  /** liveCount − planSize. Positive = phantoms; negative = the plan is short. */
  delta: number;
  direction: "over" | "under";
  /**
   * What a correction would take — **information, not an instruction.** `over` and the excess is all appended
   * EXTENDED ⇒ removing that many would square it. If the excess exceeds the appended rows, a human has to look:
   * the surplus is hand-placed or delivered sessions, which no automated correction should ever touch.
   */
  suggestion: string;
}

export function auditImportedCourses(rows: AuditCourseInput[]): AuditFinding[] {
  return rows
    .filter((r) => r.source === "IMPORT")
    .map((r) => {
      const planSize = Math.max(0, r.size - r.priorSessions);
      const delta = r.liveCount - planSize;
      return { ...r, planSize, delta, direction: delta > 0 ? ("over" as const) : ("under" as const), suggestion: suggest(r, delta) };
    })
    .filter((f) => f.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.id.localeCompare(b.id));
}

function suggest(r: AuditCourseInput, delta: number): string {
  if (delta > 0) {
    return delta <= r.extendedCount
      ? `ลบคาบขยายที่เกิน ${delta} คาบ (มีคาบขยาย ${r.extendedCount} คาบ) — เจ้าของตัดสินใจ`
      : `เกิน ${delta} คาบ แต่มีคาบขยายเพียง ${r.extendedCount} — ต้องให้คนตรวจสอบ (คาบที่เกินไม่ใช่คาบขยาย)`;
  }
  return `แผนขาด ${-delta} คาบ — ตรวจสอบว่า prior_sessions (${r.priorSessions}) ตรงกับตอนนำเข้าจริงหรือไม่`;
}

/** Counts-only summary for the console — the owner sees scale before any names. */
export const auditSummary = (findings: AuditFinding[]) => ({
  affected: findings.length,
  over: findings.filter((f) => f.direction === "over").length,
  under: findings.filter((f) => f.direction === "under").length,
  phantomSessions: findings.filter((f) => f.direction === "over").reduce((n, f) => n + f.delta, 0),
});
