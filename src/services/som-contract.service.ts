// 🔻 TASK-741 (REQ-124) — `GET /api/reports/som`, Palm's contract. The READS: bookings (with their badges), courses, vouchers (+ their expiry moves), students, active parents, subjects — handed to the pure counters in
// `lib/som-contract.ts`. 🚫 The old `getSomReport` (`som-report.service.ts`) is untouched; the route merges this into its result.
import { db } from "../db";
import { courseExpiryChanges, voucherExpiryChanges } from "../db/schema";
import { areaName } from "../lib/area-codes";
import { bangkokNow } from "../lib/bangkok-time";
import { duoStudentIds } from "../lib/duo-course";
import { activeParentWhere } from "../lib/parent-archive";
import * as teacherLeave from "../lib/teacher-leave"; // THE reader of the recorded advance-leave days (TASK-561)
import { countNvr, countSom, monthEnd, type ExpiryChange, type NvrBucket, type NvrDetailRow, type SomBooking, type SomContractInput, type SomContractSections } from "../lib/som-contract";

export { mergeSom } from "../lib/som-contract"; // the route's merge (one import there)

/** `"<district TH>, <province TH>"` — the district name repeats across provinces, so the province rides with it. null = the code is not in the dataset. */
export function districtLabel(code: string): string | null {
  const district = areaName(code, "TH");
  const province = areaName(code.slice(0, 2), "TH");
  return district && province ? `${district}, ${province}` : null;
}

const groupChanges = <T extends { fromDate: string; changedAt: Date | string }>(rows: Array<T & Record<string, any>>, key: string): Map<string, ExpiryChange[]> => {
  const map = new Map<string, ExpiryChange[]>();
  for (const r of rows) map.set(r[key], [...(map.get(r[key]) ?? []), { fromDate: r.fromDate, changedAt: r.changedAt }]);
  return map;
};

type SomQuery = { month?: string; badgeValueIds?: readonly string[] };

/** The ONE read behind every section AND the New-vs-Renewing list, so a card and its list are computed from the same rows. */
async function loadInput(q: SomQuery): Promise<SomContractInput> {
  // «Today» and «this month» are resolved SERVER-side in Bangkok (the old report's rule).
  const { date: today } = bangkokNow();
  const month = q.month ?? today.slice(0, 7);

  const [bookingRows, courseRows, voucherRows, courseMoves, voucherMoves, students, parents, subjects, teachers, leaveRows] = await Promise.all([
    db.query.bookings.findMany({
      columns: { studentId: true, coStudentId: true, bookingType: true, status: true, date: true, subjectId: true, courseId: true, voucherId: true, groupId: true, teacherId: true, startTime: true, endTime: true },
      where: (b: any, { eq }: any) => eq(b.pendingSlot, false),
      with: { badges: { columns: { badgeValueId: true } }, additionalTeachers: { columns: { teacherId: true } } },
    }),
    db.query.coursePackages.findMany(),
    db.query.vouchers.findMany(),
    db.select({ courseId: courseExpiryChanges.courseId, fromDate: courseExpiryChanges.fromDate, changedAt: courseExpiryChanges.changedAt }).from(courseExpiryChanges),
    db.select({ voucherId: voucherExpiryChanges.voucherId, fromDate: voucherExpiryChanges.fromDate, changedAt: voucherExpiryChanges.changedAt }).from(voucherExpiryChanges),
    db.query.students.findMany(),
    db.query.parents.findMany({ where: activeParentWhere() }), // an archived household is not counted (TASK-411) — its students fall to `unknown`
    db.query.subjects.findMany(),
    db.query.teachers.findMany(), // 🔻 742 — Coach Capacity's roster
    teacherLeave.recordedLeaveDays(db, `${month}-01`, monthEnd(month)), // 🔻 742 — the recorded leave days of the month, through THE reader (a past window is just a window)
  ]);

  const parentById = new Map(parents.map((p: any) => [p.id, p]));
  const bookings: SomBooking[] = bookingRows.map((b: any) => ({
    studentIds: duoStudentIds(b), // a DUO row is both children's session
    bookingType: b.bookingType,
    status: b.status,
    date: b.date,
    subjectId: b.subjectId ?? null,
    courseId: b.courseId ?? null,
    voucherId: b.voucherId ?? null,
    badgeIds: (b.badges ?? []).map((x: any) => x.badgeValueId),
    isSeat: b.groupId != null,
    teacherId: b.teacherId ?? null,
    extraTeacherIds: (b.additionalTeachers ?? []).map((x: any) => x.teacherId),
    startTime: b.startTime,
    endTime: b.endTime,
  }));
  const courseMovesBy = groupChanges(courseMoves, "courseId");
  const voucherMovesBy = groupChanges(voucherMoves, "voucherId");

  return {
    month,
    today,
    badgeValueIds: q.badgeValueIds ?? [],
    bookings,
    courses: courseRows.map((c: any) => ({
      id: c.id,
      subjectId: c.subjectId ?? null,
      studentIds: duoStudentIds(c),
      createdAt: c.createdAt,
      size: c.size,
      usedSessions: c.usedSessions,
      expiryDate: c.expiryDate,
      endedAt: c.endedAt ?? null,
      droppedAt: c.droppedAt ?? null,
      expiryChanges: courseMovesBy.get(c.id) ?? [],
    })),
    vouchers: voucherRows.map((v: any) => ({
      id: v.id,
      studentId: v.studentId,
      createdAt: v.createdAt,
      totalHours: v.totalHours,
      usedHours: v.usedHours,
      expiryDate: v.expiryDate,
      endedAt: v.endedAt ?? null,
      expiryChanges: voucherMovesBy.get(v.id) ?? [],
    })),
    students: students.map((s: any) => {
      const parent: any = s.parentId ? (parentById.get(s.parentId) ?? null) : null;
      return { id: s.id, name: s.name, nickname: s.nickname ?? null, gender: s.gender ?? null, nationality: s.nationality ?? null, birthDate: s.birthDate ?? null, province: parent?.province ?? null, districtCode: parent?.districtCode ?? null, subdistrictCode: parent?.subdistrictCode ?? null };
    }),
    subjects: subjects.map((s: any) => ({ id: s.id, name: s.name, active: s.active })),
    districtLabel,
    subdistrictLabel: (code: string) => areaName(code, "TH"), // 🔻 744
    teachers: teachers.map((t: any) => ({ id: t.id, nickname: t.nickname, type: t.type, active: t.active, archived: t.archived, workDays: t.workDays ?? [] })),
    leaveDays: leaveRows.map((l: any) => ({ teacherId: l.teacherId, date: l.date })),
  };
}

export async function getSomContract(q: SomQuery = {}): Promise<SomContractSections> {
  return countSom(await loadInput(q));
}

/** 🔻 742 — `GET /reports/som/new-vs-renewing/:bucket`: the rows behind one card; `rows.length` IS the card's number (one function feeds both). */
export async function getNvrRows(bucket: NvrBucket, q: SomQuery = {}): Promise<{ rows: NvrDetailRow[] }> {
  return { rows: countNvr(await loadInput(q)).rows[bucket] };
}
