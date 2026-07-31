// Attention-check registry (REQ-023 / TASK-053) — what the daily digest and the web panel both read.
//
// Extensibility is deliberately boring: **adding a check = appending one entry to `ATTENTION_CHECKS`**.
// No plugin system, no dynamic loading, no config table.
//
// Every condition is expressed as a **pure predicate** here so it can be unit-tested independently of the
// query that feeds it. The predicates for "still active" (courses/vouchers) and "over cap" (freelance)
// **delegate to the existing rules** — a second copy of those definitions is exactly the drift TASK-051 exists
// to prevent.

import { courseEligible, courseRemainingSessions, voucherEligible } from "./eligibility";
import { overLimit } from "./freelance-budget";
import { t, type Lang } from "./line-i18n";

// ── Thresholds — ONE named-constant block (placeholders until คุณฟีน gives real numbers) ─────────────
export const EXPIRING_WITHIN_DAYS = 14;
export const NEARLY_FINISHED_SESSIONS = 2;
export const FREELANCE_NEAR_CAP_HOURS = 2;

/** Max people named in a single LINE list before it truncates (privacy + message size). */
export const DIGEST_LIST_LIMIT = 5;

// ── Pure predicates (one per check) ──────────────────────────────────────────────────────────────────

/** PENDING on today or tomorrow (Bangkok). */
export const isUnconfirmedSoon = (
  b: { status: string; date: string },
  today: string,
  tomorrow: string,
): boolean => b.status === "PENDING" && (b.date === today || b.date === tomorrow);

/** Active, non-archived teacher with no LINE link — they can't receive schedule pushes. */
export const teacherNeedsLine = (t: {
  lineUserId?: string | null;
  active?: boolean;
  archived?: boolean;
}): boolean => !t.lineUserId && t.active === true && t.archived !== true;

/** Expiry falls within the window (inclusive) and is not already past. */
export const isExpiringSoon = (expiryDate: string, today: string, cutoff: string): boolean =>
  expiryDate >= today && expiryDate <= cutoff;

/** Still-active course that is nearly used up. Delegates to `courseEligible` for "still active". */
export const isNearlyFinishedCourse = (
  c: { size: number; usedSessions: number; expiryDate: string },
  today: string,
): boolean => courseEligible(c, today) && courseRemainingSessions(c) <= NEARLY_FINISHED_SESSIONS;

/**
 * Freelance ceiling at/near its cap — reads the SAME `remaining` (hours) the calendar's `overLimit` uses.
 * Includes already-over (negative) ceilings: `overLimit` is the existing over-cap rule, reused not re-derived.
 */
export const isFreelanceNearCap = (remainingQty: number): boolean =>
  overLimit(remainingQty) || remainingQty <= FREELANCE_NEAR_CAP_HOURS;

/**
 * Student missing any demographic, **or** whose parent has no province.
 *
 * LEFT-join semantics: `parent` is `null` for a walk-in / First-Trial student (`students.parent_id` is
 * nullable **by design**). Such a student is still counted when their own demographics are incomplete, and is
 * **never silently dropped** — but a missing *province* is only charged against students who actually have a
 * parent, since a parentless student has no household record to fill in. (Stated, per the task.)
 */
export const isStudentIncomplete = (
  s: { gender?: string | null; birthDate?: string | null; nationality?: string | null },
  parent: { province?: string | null } | null | undefined,
): boolean => {
  const ownMissing = !s.gender || !s.birthDate || !s.nationality;
  const provinceMissing = !!parent && !parent.province;
  return ownMissing || provinceMissing;
};

/** NO_SHOW on the given (previous) day. */
export const isYesterdayNoShow = (b: { status: string; date: string }, yesterday: string): boolean =>
  b.status === "NO_SHOW" && b.date === yesterday;

/** Voucher still active and expiring soon. Delegates to `voucherEligible` for "still active". */
export const isVoucherExpiringSoon = (
  v: { totalHours: number; usedHours: number; expiryDate: string },
  today: string,
  cutoff: string,
): boolean => voucherEligible(v, today) && isExpiringSoon(v.expiryDate, today, cutoff);

/** Course still active and expiring soon. */
export const isCourseExpiringSoon = (
  c: { size: number; usedSessions: number; expiryDate: string },
  today: string,
  cutoff: string,
): boolean => courseEligible(c, today) && isExpiringSoon(c.expiryDate, today, cutoff);

// ── Registry ─────────────────────────────────────────────────────────────────────────────────────────

export interface AttentionItem {
  id: string;
  label: string;
  hint?: string;
}
export interface AttentionResult {
  count: number;
  items: AttentionItem[];
}
export interface AttentionCtx {
  today: string;
  tomorrow: string;
  yesterday: string;
  expiryCutoff: string;
  /** Data loaders — supplied by the service so the registry stays free of query plumbing. */
  load: {
    bookings: (dates: string[]) => Promise<any[]>;
    teachers: () => Promise<any[]>;
    courses: () => Promise<any[]>;
    vouchers: () => Promise<any[]>;
    studentsWithParent: () => Promise<Array<{ student: any; parent: any | null }>>;
    freelanceCeilings: () => Promise<Array<{ teacherId: string; nickname: string; remainingQty: number }>>;
  };
}
export interface AttentionCheck {
  key: string;
  /** i18n key — resolved TH for the API, per-recipient language for the digest (one source, no duplicates). */
  titleKey: string;
  /** Only these two checks may name people in the LINE digest (REQ-020 privacy lesson). */
  namesPeopleInDigest?: boolean;
  run: (ctx: AttentionCtx) => Promise<AttentionResult>;
}

const hhmm = (t: string) => (t ?? "").slice(0, 5);

/** ⬇️ Adding an eighth check = appending one entry here. That is the whole extensibility story. */
export const ATTENTION_CHECKS: AttentionCheck[] = [
  {
    key: "unconfirmed_bookings",
    titleKey: "att_unconfirmed_bookings",
    namesPeopleInDigest: true, // time · student NICKNAME · teacher nickname
    run: async (ctx) => {
      const rows = (await ctx.load.bookings([ctx.today, ctx.tomorrow])).filter((b) =>
        isUnconfirmedSoon(b, ctx.today, ctx.tomorrow),
      );
      return {
        count: rows.length,
        items: rows.map((b) => ({
          id: b.id,
          label: `${b.date} ${hhmm(b.startTime)} · ${b.student?.nickname ?? b.student?.name ?? "-"} · ${b.teacher?.nickname ?? "-"}`,
        })),
      };
    },
  },
  {
    key: "teachers_without_line",
    titleKey: "att_teachers_without_line",
    namesPeopleInDigest: true, // teacher nickname only
    run: async (ctx) => {
      const rows = (await ctx.load.teachers()).filter(teacherNeedsLine);
      return { count: rows.length, items: rows.map((t) => ({ id: t.id, label: t.nickname })) };
    },
  },
  {
    key: "expiring_entitlements",
    titleKey: "att_expiring_entitlements",
    run: async (ctx) => {
      const courses = (await ctx.load.courses()).filter((c) =>
        isCourseExpiringSoon(c, ctx.today, ctx.expiryCutoff),
      );
      const vouchers = (await ctx.load.vouchers()).filter((v) =>
        isVoucherExpiringSoon(v, ctx.today, ctx.expiryCutoff),
      );
      return {
        count: courses.length + vouchers.length,
        items: [
          ...courses.map((c) => ({ id: c.id, label: `course ${c.size} · ${c.expiryDate}` })),
          ...vouchers.map((v) => ({ id: v.id, label: `voucher ${v.totalHours}h · ${v.expiryDate}` })),
        ],
      };
    },
  },
  {
    key: "nearly_finished_courses",
    titleKey: "att_nearly_finished_courses",
    run: async (ctx) => {
      const rows = (await ctx.load.courses()).filter((c) => isNearlyFinishedCourse(c, ctx.today));
      return {
        count: rows.length,
        items: rows.map((c) => ({
          id: c.id,
          label: `course ${c.size} · เหลือ ${courseRemainingSessions(c)}`,
        })),
      };
    },
  },
  {
    key: "freelance_near_cap",
    titleKey: "att_freelance_near_cap",
    run: async (ctx) => {
      const rows = (await ctx.load.freelanceCeilings()).filter((f) =>
        isFreelanceNearCap(f.remainingQty),
      );
      return {
        count: rows.length,
        items: rows.map((f) => ({ id: f.teacherId, label: `${f.nickname} · เหลือ ${f.remainingQty} ชม.` })),
      };
    },
  },
  {
    key: "incomplete_students",
    titleKey: "att_incomplete_students",
    run: async (ctx) => {
      const rows = (await ctx.load.studentsWithParent()).filter(({ student, parent }) =>
        isStudentIncomplete(student, parent),
      );
      // Counts only in the digest — names stay behind login (privacy).
      return { count: rows.length, items: rows.map(({ student }) => ({ id: student.id, label: student.nickname ?? student.name })) };
    },
  },
  {
    key: "yesterday_no_shows",
    titleKey: "att_yesterday_no_shows",
    run: async (ctx) => {
      const rows = (await ctx.load.bookings([ctx.yesterday])).filter((b) =>
        isYesterdayNoShow(b, ctx.yesterday),
      );
      return {
        count: rows.length,
        items: rows.map((b) => ({ id: b.id, label: `${hhmm(b.startTime)} · ${b.student?.nickname ?? "-"}` })),
      };
    },
  },
];

// ── Digest decision + message (pure — the job just executes what these return) ────────────────────────

export type DigestAction = "skip-already-sent" | "send" | "record-only";

/**
 * What the 08:00 job should do.
 * - already sent today → **skip** (a second run must not re-send);
 * - anything outstanding → **send** one message;
 * - everything clear → **record-only**: send nothing, but STILL write the `job_runs` row so the panel can
 *   tell "ran and had nothing to say" apart from "never ran".
 *
 * A **degraded** check (`count === null`) counts as outstanding: we can't prove it's clear, and silence would
 * hide a broken check.
 */
export function decideDigest(
  checks: Array<{ count: number | null }>,
  alreadySent: boolean,
): DigestAction {
  if (alreadySent) return "skip-already-sent";
  const outstanding = checks.some((c) => c.count === null || c.count > 0);
  return outstanding ? "send" : "record-only";
}

/**
 * The single LINE digest message. **Privacy (REQ-020 lesson):** only checks flagged `namesPeopleInDigest`
 * may list people — everything else is a bare count, with names living behind login in the web panel. Lists
 * truncate at `DIGEST_LIST_LIMIT`.
 */
export function buildDigestMessage(
  checks: Array<{ key: string; count: number | null; items: AttentionItem[]; error?: string }>,
  lang: Lang = "TH",
): string {
  const lines: string[] = [t("digest_header", lang)];
  for (const c of checks) {
    if (c.count === 0) continue; // nothing to say about a clear check
    const label = t(`att_${c.key}`, lang);
    if (c.count === null) {
      lines.push(`• ${label}: ${t("digest_check_failed", lang)}`);
      continue;
    }
    lines.push(`• ${label}: ${c.count}`);
    const named = ATTENTION_CHECKS.find((d) => d.key === c.key)?.namesPeopleInDigest;
    if (named) {
      for (const it of c.items.slice(0, DIGEST_LIST_LIMIT)) lines.push(`   - ${it.label}`);
      const extra = c.items.length - DIGEST_LIST_LIMIT;
      if (extra > 0) lines.push(`   ${t("digest_more", lang, { n: extra })}`);
    }
  }
  lines.push(t("digest_footer", lang));
  return lines.join("\n");
}
