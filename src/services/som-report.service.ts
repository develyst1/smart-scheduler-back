// SOM dashboard snapshot (REQ-013 / TASK-062). ONE endpoint returning all five sections, so they describe the
// same instant and the FE stays a renderer. Read-only: no writes, no migration.
//
// Reuse, not re-derivation: "active" entitlements come from `lib/eligibility.ts` (the same rule the booking
// picker uses) and today's numbers come from `getDailyReport` verbatim. Bucketing is pure (`lib/som-report.ts`).

import { db } from "../db";
import { bangkokNow } from "../lib/bangkok-time";
import { addDays } from "../lib/time";
import { courseEligible, voucherEligible } from "../lib/eligibility";
import {
  ageBand,
  breakdown,
  inMonth,
  monthOf,
  primarySport,
  type SportBooking,
} from "../lib/som-report";
import { getCourses, getDailyReport, getVouchers } from "./scheduler.service";

/** FIRST_TRIAL within this many days counts the student as a current customer. */
const RECENT_TRIAL_DAYS = 90; // ~3 months

export async function getSomReport() {
  // "Today" and "this month" are resolved SERVER-side in Bangkok — otherwise two staff either side of a month
  // boundary see different months and both conclude the dashboard is wrong.
  const { date: today } = bangkokNow();
  const month = monthOf(today);
  const trialSince = addDays(today, -RECENT_TRIAL_DAYS);

  const [students, parents, bookings, courses, vouchers, todayReport] = await Promise.all([
    db.query.students.findMany(),
    db.query.parents.findMany(),
    db.query.bookings.findMany({ with: { subject: true } }),
    getCourses(),
    getVouchers(),
    getDailyReport(today),
  ]);

  const parentById = new Map(parents.map((p) => [p.id, p]));
  // LEFT-join semantics in JS: a student with `parent_id = null` (walk-in / First-Trial, nullable BY DESIGN)
  // keeps a row here with `parent: null`, so they land in the `unknown` province bucket instead of vanishing.
  const withParent = students.map((s) => ({
    student: s,
    parent: s.parentId ? (parentById.get(s.parentId) ?? null) : null,
  }));

  // ── 1. Existing customers ───────────────────────────────────────────────────────────────────────
  const byCourse = new Set(
    courses.filter((c: any) => courseEligible(c, today)).map((c: any) => c.student.id as string),
  );
  const byVoucher = new Set(
    vouchers.filter((v: any) => voucherEligible(v, today)).map((v: any) => v.student.id as string),
  );
  const byRecentTrial = new Set(
    bookings
      .filter((b) => b.bookingType === "FIRST_TRIAL" && b.date >= trialSince && b.date <= today)
      .map((b) => b.studentId),
  );
  const existingCustomers = {
    byCourse: byCourse.size,
    byVoucher: byVoucher.size,
    byRecentTrial: byRecentTrial.size,
    total: new Set([...byCourse, ...byVoucher, ...byRecentTrial]).size, // distinct across all three
    recentTrialSince: trialSince,
  };

  // ── 2. Sport share — one unit per student, so the shares sum to 100% ────────────────────────────
  const bookingsByStudent = new Map<string, SportBooking[]>();
  for (const b of bookings) {
    const list = bookingsByStudent.get(b.studentId) ?? [];
    list.push({
      subjectId: b.subjectId,
      subjectName: (b as any).subject?.name ?? null,
      date: b.date,
      startTime: b.startTime,
    });
    bookingsByStudent.set(b.studentId, list);
  }
  const sportOf = new Map<string, { id: string; name: string | null } | null>(
    students.map((s) => [s.id, primarySport(bookingsByStudent.get(s.id) ?? [])]),
  );
  const sportShare = breakdown(
    students,
    (s) => sportOf.get(s.id)?.id ?? null, // no bookings → unknown, never a crash
    (key) =>
      [...sportOf.values()].find((v) => v?.id === key)?.name ?? undefined,
  );

  // ── 3. New vs renewing (this month) ─────────────────────────────────────────────────────────────
  // The two "new" numbers stay SEPARATE — they answer different questions and a student can be in both.
  const firstTrialThisMonth = new Set(
    bookings.filter((b) => b.bookingType === "FIRST_TRIAL" && monthOf(b.date) === month).map((b) => b.studentId),
  );
  const registeredThisMonth = students.filter((s) => inMonth(s.createdAt, month));
  // Renewing = bought a course/voucher this month while already holding an earlier one.
  const entitlements = [
    ...courses.map((c: any) => ({ studentId: c.student.id as string, createdAt: c.createdAt })),
    ...vouchers.map((v: any) => ({ studentId: v.student.id as string, createdAt: v.createdAt })),
  ];
  const renewing = new Set(
    entitlements
      .filter((e) => inMonth(e.createdAt, month))
      .filter((e) =>
        entitlements.some((prior) => prior.studentId === e.studentId && !inMonth(prior.createdAt, month)),
      )
      .map((e) => e.studentId),
  );
  const newVsRenewing = {
    month,
    newByFirstTrial: firstTrialThisMonth.size,
    newByRegistration: registeredThisMonth.length,
    renewing: renewing.size,
  };

  // ── 4. Demographics — every breakdown carries its unknowns ──────────────────────────────────────
  const demographics = {
    gender: breakdown(students, (s) => s.gender),
    ageBand: breakdown(students, (s) => ageBand(s.birthDate, today)),
    province: breakdown(withParent, (r) => r.parent?.province), // parentless → unknown, not dropped
    nationality: breakdown(students, (s) => s.nationality),
  };

  // ── 5. Today — `getDailyReport` verbatim, never a second count ──────────────────────────────────
  const todaySection = {
    date: today,
    expected: todayReport.totalBooked,
    attended: todayReport.attended,
  };

  return {
    existingCustomers,
    sportShare,
    newVsRenewing,
    demographics,
    today: todaySection,
    generatedAt: new Date().toISOString(),
  };
}
