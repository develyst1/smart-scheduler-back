// SPEC-055 / TASK-155 (REQ-058 req 6) — the PURE matrix decision behind `teacher-subjects:link-all`.
//
// A program only appears in the booking dropdown once a teacher is linked to it (`teacher.subjectOptions`). The
// owner chose "every teacher can teach every program", which is 24 × 19 = 456 links — far too many to do one
// command at a time without a half-finished pass leaving a roster that *looks* configured.
//
// 🔴 **That choice was revoked for `uat` on 2026-08-29** (owner: *"ตั้งใจจำกัด"* — TASK-223). Open-by-default is
// no longer current policy there, so this file describes what `link-all` **computes**, not what any roster is
// meant to be. Where it is safe to apply is the caller's question, and the answer is in the danger paragraph of
// `scripts/link-all-teacher-subjects.ts`: `sid`-only, and the tool can never unlink.
//
// Two exclusions, and they are not the same idea:
//   · **archived** = offboarded. The teacher is hidden from bookings entirely, so a link would be dead config.
//   · **active:false** = paused — an availability state, not a capability one. A paused teacher still teaches
//     these programs, so they ARE linked; leaving them out would silently break their dropdown on un-pause.

export interface TeacherRow {
  id: string;
  nickname: string;
  archived: boolean;
}
export interface SubjectRow {
  id: string;
  name: string;
  active: boolean;
}
export interface Pair {
  teacherId: string;
  subjectId: string;
}

export interface BulkLinkPlan {
  teacherCount: number;
  subjectCount: number;
  /** The links that do not exist yet — what `--commit` would insert. */
  toCreate: Pair[];
  /** Already linked; left completely alone. */
  skipped: Pair[];
  /** Per-teacher tally for the operator's evidence line (AC-10). */
  perTeacher: Array<{ nickname: string; created: number; skipped: number }>;
}

const key = (p: Pair) => `${p.teacherId}::${p.subjectId}`;

export function planBulkLinks(input: {
  teachers: readonly TeacherRow[];
  subjects: readonly SubjectRow[];
  existingPairs: readonly Pair[];
}): BulkLinkPlan {
  const teachers = input.teachers.filter((t) => !t.archived);
  const subjects = input.subjects.filter((s) => s.active);
  const have = new Set(input.existingPairs.map(key));

  const toCreate: Pair[] = [];
  const skipped: Pair[] = [];
  const perTeacher: BulkLinkPlan["perTeacher"] = [];

  for (const t of teachers) {
    let created = 0;
    let already = 0;
    for (const s of subjects) {
      const pair = { teacherId: t.id, subjectId: s.id };
      if (have.has(key(pair))) {
        skipped.push(pair);
        already++;
      } else {
        toCreate.push(pair);
        created++;
      }
    }
    perTeacher.push({ nickname: t.nickname, created, skipped: already });
  }

  return { teacherCount: teachers.length, subjectCount: subjects.length, toCreate, skipped, perTeacher };
}

/** Counts + staff/catalogue names only — no student or parent data is involved in this command at all. */
export function formatBulkLinkPlan(plan: BulkLinkPlan): string {
  const total = plan.teacherCount * plan.subjectCount;
  const head = [
    `  ครู ${plan.teacherCount} × โปรแกรม ${plan.subjectCount} = ${total} ลิงก์`,
    `  จะสร้างใหม่ ${plan.toCreate.length} · มีอยู่แล้ว ${plan.skipped.length}`,
  ];
  const rows = plan.perTeacher.map((t) => `    ${t.nickname}: +${t.created} / =${t.skipped}`);
  return [...head, ...rows].join("\n");
}
