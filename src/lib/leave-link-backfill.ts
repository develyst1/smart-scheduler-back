// TASK-553 (§2) — the BACKFILL for rows that already answer a leave WITHOUT its link, PURE: no DB, no clock. The script
// (`scripts/backfill-leave-links.ts`, owner-run, dry run by default) feeds it and writes only what it returns as `link`.
//
// 🔑 THE RULE: link ONLY on unique evidence; an ambiguous row is LEFT ALONE and COUNTED, never assigned on a best guess — this
// whole defect came from treating an assumed link as a real one, and a backfill that guessed would industrialise it.
// Per course:
//   · the LEAVES to look for = `leavesAwaitingReanswer` (answered once, that answer cancelled, no live answer by link);
//   · the CANDIDATE answers = rows of the plan that are NOT cancelled / a leave / paused, carry NO link, were NOT written with
//     the course (created after it — the creation batch shares the course's timestamp), and were written no earlier than the
//     leave's cancelled answer (an answer comes after the answer it replaces);
//   · exactly ONE such leave and exactly ONE candidate ⇒ `link`. Anything else ⇒ `ambiguous`, with the reason.
// Every other leave of the course is `notApplicable` (answered by a live linked row, or never answered at all).
import { isCoursePlanRow, leavesAwaitingReanswer } from "./course-plan";

export interface BackfillRow { id: string; status: string; date: string; extendedFromId: string | null; bookingType?: string; createdAt: Date }
export interface BackfillCourse { id: string; createdAt: Date; rows: BackfillRow[] }
export type AmbiguousReason = "several-leaves" | "several-candidates" | "no-candidate";
export interface BackfillPlan {
  link: Array<{ courseId: string; rowId: string; leaveId: string }>;
  ambiguous: Array<{ courseId: string; leaveId: string; reason: AmbiguousReason; candidates: number }>;
  notApplicable: number;
}

const NOT_AN_ANSWER = new Set(["CANCELLED", "SICK_LEAVE", "PAUSED"]);

export function planLeaveLinkBackfill(courses: BackfillCourse[]): BackfillPlan {
  const out: BackfillPlan = { link: [], ambiguous: [], notApplicable: 0 };
  for (const c of courses) {
    const rows = c.rows.filter(isCoursePlanRow);
    const leaves = rows.filter((r) => r.status === "SICK_LEAVE");
    const awaiting = leavesAwaitingReanswer(rows);
    out.notApplicable += leaves.length - awaiting.length;
    if (!awaiting.length) continue;
    const candidatesFor = (leaveId: string) => {
      const cancelledAnswers = rows.filter((r) => r.extendedFromId === leaveId).map((r) => +r.createdAt);
      const since = Math.max(...cancelledAnswers);
      return rows.filter((r) => !NOT_AN_ANSWER.has(r.status) && r.extendedFromId === null && +r.createdAt > +c.createdAt && +r.createdAt >= since);
    };
    if (awaiting.length > 1) {
      for (const leaveId of awaiting) out.ambiguous.push({ courseId: c.id, leaveId, reason: "several-leaves", candidates: candidatesFor(leaveId).length });
      continue;
    }
    const leaveId = awaiting[0]!;
    const candidates = candidatesFor(leaveId);
    if (candidates.length === 1) out.link.push({ courseId: c.id, rowId: candidates[0]!.id, leaveId });
    else out.ambiguous.push({ courseId: c.id, leaveId, reason: candidates.length ? "several-candidates" : "no-candidate", candidates: candidates.length });
  }
  return out;
}

/** The three numbers the dry run prints (and the ambiguous ones by reason) — counts only. */
export const backfillSummary = (p: BackfillPlan) => ({
  linked: p.link.length,
  ambiguous: p.ambiguous.length,
  notApplicable: p.notApplicable,
  ambiguousByReason: {
    "several-leaves": p.ambiguous.filter((a) => a.reason === "several-leaves").length,
    "several-candidates": p.ambiguous.filter((a) => a.reason === "several-candidates").length,
    "no-candidate": p.ambiguous.filter((a) => a.reason === "no-candidate").length,
  },
});
