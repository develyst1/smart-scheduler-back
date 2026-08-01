// The ONE producer of "what needs attention" (REQ-023 / TASK-053). Both the 08:00 LINE digest and the web
// panel read this, so the two can never disagree.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { boMovement, jobRuns } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { addDays } from "../lib/time";
import {
  ATTENTION_CHECKS,
  EXPIRING_WITHIN_DAYS,
  NOT_POSTED_WINDOW_DAYS,
  buildDigestMessage,
  decideDigest,
  type AttentionCtx,
} from "../lib/attention";
import { t } from "../lib/line-i18n";
import { notifyAdmins } from "../lib/line-admin";
import { getCourses, getVouchers, listFreelanceCeilings } from "./scheduler.service";
import { countPendingTeacherLinks } from "./teacher-link.service";

export const DIGEST_JOB = "daily-digest";

export interface AttentionCheckResult {
  key: string;
  /** i18n key so the FE panel can render TH **and** EN without keeping a second copy of the labels. */
  titleKey: string;
  /** TH default, for callers that just want a string. */
  title: string;
  /** null = this check failed to run (degraded); the rest of the digest still goes out. */
  count: number | null;
  items: Array<{ id: string; label: string; hint?: string }>;
  error?: string;
}

function buildCtx(today: string): AttentionCtx {
  // Loaders are memoised per run so several checks sharing a source hit the DB once.
  let courses: Promise<any[]> | null = null;
  let vouchers: Promise<any[]> | null = null;
  let teachers: Promise<any[]> | null = null;
  let ceilings: Promise<any[]> | null = null;
  let studentsWithParent: Promise<Array<{ student: any; parent: any | null }>> | null = null;
  let salesState: Promise<{
    sold: Array<{ id: string; label: string }>;
    postedRefIds: Set<string>;
  }> | null = null;
  let pendingLinks: Promise<number> | null = null;
  const salesWindowStart = addDays(today, -NOT_POSTED_WINDOW_DAYS);

  return {
    today,
    tomorrow: addDays(today, 1),
    yesterday: addDays(today, -1),
    expiryCutoff: addDays(today, EXPIRING_WITHIN_DAYS),
    salesWindowStart,
    load: {
      bookings: (dates) =>
        db.query.bookings.findMany({
          where: (b, { inArray: inA }) => inA(b.date, dates),
          with: { student: true, teacher: true },
          orderBy: (b, { asc }) => [asc(b.date), asc(b.startTime)],
        }),
      teachers: () => (teachers ??= db.query.teachers.findMany()),
      courses: () => (courses ??= getCourses()),
      vouchers: () => (vouchers ??= getVouchers()),
      freelanceCeilings: () => (ceilings ??= listFreelanceCeilings()) as any,
      studentsWithParent: () =>
        (studentsWithParent ??= (async () => {
          // LEFT-join semantics: a walk-in / First-Trial student has `parent_id = null` BY DESIGN and must
          // never be dropped from the count by an inner join (the badge-report failure mode).
          const students = await db.query.students.findMany();
          const parents = await db.query.parents.findMany();
          const byId = new Map(parents.map((p) => [p.id, p]));
          return students.map((s) => ({
            student: s,
            parent: s.parentId ? (byId.get(s.parentId) ?? null) : null,
          }));
        })()),
      pendingTeacherLinks: () => (pendingLinks ??= countPendingTeacherLinks()),
      // TASK-067. The three things `recordSale` is called for — a course sale, a voucher sale, and an
      // ATTENDED trial/single (revenue recognised at day-end) — against the refIds that actually reached
      // `bo.movement`. The movement carries the entitlement's own id as `ref_id`, so absence IS the signal.
      //
      // ⚠️ The window is a Bangkok *date* compared against a `timestamptz`, so at the boundary it can reach
      // back up to 7h further than 7×24h. That is deliberate and the safe direction: a detector that
      // over-includes shows something a few hours early, one that under-includes hides the fault it exists
      // to find. It is not a money figure — nothing is bucketed by month here (cf. TASK-062).
      salesPostingState: () =>
        (salesState ??= (async () => {
          const [courseRows, voucherRows, bookingRows, movements] = await Promise.all([
            db.query.coursePackages.findMany({
              where: (c, { gte: g }) => g(c.createdAt, sql`${salesWindowStart}::date`),
            }),
            db.query.vouchers.findMany({
              where: (v, { gte: g }) => g(v.createdAt, sql`${salesWindowStart}::date`),
            }),
            db.query.bookings.findMany({
              where: (b, { and: a, gte: g, lte: l, eq: e, inArray: inA }) =>
                a(
                  g(b.date, salesWindowStart),
                  l(b.date, today),
                  e(b.status, "ATTENDED"),
                  inA(b.bookingType, ["FIRST_TRIAL", "SINGLE_SESSION"]),
                ),
            }),
            db
              .select({ refId: boMovement.refId })
              .from(boMovement)
              .where(eq(boMovement.refType, "SALE")),
          ]);

          return {
            sold: [
              ...courseRows.map((c) => ({ id: c.id, label: `course ${c.size}` })),
              ...voucherRows.map((v) => ({ id: v.id, label: `voucher ${v.totalHours}h` })),
              ...bookingRows.map((b) => ({ id: b.id, label: `${b.bookingType} ${b.date}` })),
            ],
            postedRefIds: new Set(
              movements.map((m) => m.refId).filter((r): r is string => r !== null),
            ),
          };
        })()),
    },
  };
}

/**
 * Run every registered check. **One failing check must not kill the digest** — a failure is returned as a
 * degraded entry (`count: null` + error) and the others still report.
 */
export async function runAttentionChecks(date?: string): Promise<{ checks: AttentionCheckResult[] }> {
  const today = date ?? bangkokNow().date;
  const ctx = buildCtx(today);

  const checks = await Promise.all(
    ATTENTION_CHECKS.map(async (check): Promise<AttentionCheckResult> => {
      try {
        const { count, items } = await check.run(ctx);
        return { key: check.key, titleKey: check.titleKey, title: t(check.titleKey, "TH"), count, items };
      } catch (e) {
        console.error(`[attention] check "${check.key}" failed:`, e);
        return {
          key: check.key,
          titleKey: check.titleKey,
          title: t(check.titleKey, "TH"),
          count: null,
          items: [],
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
  return { checks };
}

/**
 * The query behind "when did the digest last run" — exported so its ORDERING is testable without a DB.
 *
 * Newest first on **both** keys, limit 1:
 * - `runDate desc` — the previous version ordered ascending and took the oldest 500, so after ~500 daily rows
 *   the panel would have frozen on a year-old date while looking healthy (the indicator lying in exactly the
 *   direction it exists to prevent);
 * - `finishedAt desc` — one business date can legitimately have two rows (a `sent:false` clear run at 08:00,
 *   then a `sent:true` re-run once something came up); the later one must win.
 */
export const lastDigestRunQuery = () =>
  db
    .select()
    .from(jobRuns)
    .where(eq(jobRuns.job, DIGEST_JOB))
    .orderBy(desc(jobRuns.runDate), desc(jobRuns.finishedAt))
    .limit(1);

/** The digest's last run — lets the panel distinguish "ran and had nothing to say" from "never ran". */
export async function getLastDigestRun(): Promise<{
  runDate: string;
  finishedAt: Date | null;
  sent: boolean;
} | null> {
  const [last] = await lastDigestRunQuery();
  if (!last) return null;
  return {
    runDate: last.runDate,
    finishedAt: last.finishedAt,
    sent: (last.summary as any)?.sent === true,
  };
}

/** `GET /api/attention` — live checks + when the digest last ran. */
export async function getAttention() {
  const [{ checks }, lastRun] = await Promise.all([runAttentionChecks(), getLastDigestRun()]);
  return { checks, lastRun };
}

/** Has the digest already been SENT for this business date? (The existing jobs only insert; this reads first.) */
async function alreadySent(runDate: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.job, DIGEST_JOB), eq(jobRuns.runDate, runDate)));
  return rows.some((r) => (r.summary as any)?.sent === true);
}

export { alreadySent as digestAlreadySent };

/**
 * The 08:00 digest job. Sends **one** LINE message to admins when anything is outstanding, **nothing** when
 * every check is clear — and **writes a `job_runs` row either way**, so the panel can distinguish "ran and had
 * nothing to say" from "never ran". (Two scheduled jobs in this project were never registered on the server and
 * nobody noticed for weeks; that row is how this one stops being invisible.) Re-running the same day sends
 * nothing.
 */
export async function runDailyDigestJob(date?: string) {
  const now = bangkokNow();
  const runDate = date ?? now.date;

  const { checks } = await runAttentionChecks(runDate);
  const action = decideDigest(checks, await alreadySent(runDate));

  if (action === "skip-already-sent") return { date: runDate, skipped: "already-sent" as const };

  const sent = action === "send";
  if (sent) {
    // ONE message through the outbox (never a direct push, never one message per check). The checks travel in
    // the payload so the worker can render it in each admin's own language.
    //
    // Privacy at the DATA layer, not just the renderer: only checks allowed to print people carry their
    // `items`; everything else is enqueued with `[]`. The persisted outbox row then never holds a name the
    // message wouldn't have shown — TASK-047 leaked precisely because data travelled where it wasn't needed.
    const namesAllowed = new Set(
      ATTENTION_CHECKS.filter((c) => c.namesPeopleInDigest).map((c) => c.key),
    );
    await notifyAdmins({
      kind: "daily_digest",
      checks: checks.map(({ key, count, items }) => ({
        key,
        count,
        items: namesAllowed.has(key) ? items : [],
      })),
    });
  }

  await db.insert(jobRuns).values({
    job: DIGEST_JOB,
    runDate,
    status: "success",
    summary: {
      sent,
      counts: Object.fromEntries(checks.map((c) => [c.key, c.count])),
      failed: checks.filter((c) => c.count === null).map((c) => c.key),
    },
    finishedAt: new Date(),
  });

  return { date: runDate, sent, checks: checks.map(({ key, count }) => ({ key, count })) };
}
