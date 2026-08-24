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
import { weekdayOf } from "./recurring";
import { teacherWorksOnDay } from "./work-days";

// ── Thresholds — ONE named-constant block (placeholders until คุณฟีน gives real numbers) ─────────────
export const EXPIRING_WITHIN_DAYS = 14;
export const NEARLY_FINISHED_SESSIONS = 2;
export const FREELANCE_NEAR_CAP_HOURS = 2;
/** How far back "sold but not posted to backoffice" looks (TASK-067). */
export const NOT_POSTED_WINDOW_DAYS = 7;

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

// REQ-070 / TASK-180 — `isYesterdayNoShow` and its `yesterday_no_shows` registry entry are GONE. The day-end
// job was NO_SHOW's only writer and now writes ATTENDED, so the check could only ever report 0 — and a digest
// line that is structurally always zero teaches everyone to skim past the ones that aren't.
//
// Not replaced on spec: "attended but never checked in" is the signal actually worth watching now (it is the
// same cohort the CRM level is about), but it needs a reliable was-checked-in marker, which is its own piece
// of grounding. Flagged as a follow-up rather than guessed at here.
/** Voucher still active and expiring soon. Delegates to `voucherEligible` for "still active". */
export const isVoucherExpiringSoon = (
  v: { totalHours: number; usedHours: number; expiryDate: string },
  today: string,
  cutoff: string,
): boolean => voucherEligible(v, today) && isExpiringSoon(v.expiryDate, today, cutoff);

/**
 * A sale that reached the books. `postedRefIds` is the set of `bo.movement.ref_id` with
 * `refType: "SALE"`; a sale is **unposted** when its own id isn't in it (TASK-067).
 *
 * Deliberately a set-membership test and not "does a movement exist for this course": the movement is
 * written with the entitlement's id as `refId`, so absence — not any status field — is the whole signal.
 */
export const isSaleUnposted = (sale: { id: string }, postedRefIds: Set<string>): boolean =>
  !postedRefIds.has(sale.id);

/**
 * SPEC-059 / TASK-163 (REQ-063) — a **dropped discount**: the day-end sale posted, the booking still carries the
 * `discount_*` the admin promised, and no DISCOUNT movement ever landed on that refId.
 *
 * That is exactly what `safeStoredDiscount` does when the catalogue price moved between the promise and the
 * posting: it drops the discount and shouts. **A `console.error` is only read by someone already looking**, and
 * the customer has by then been charged the full price for a session someone told them would be cheaper. This
 * puts it in front of the person who opens the digest every morning.
 *
 * 🔴 **`postedRefIds.has(b.id)` is load-bearing, not a tidy-up.** Without it, every trial booked with a discount
 * whose day-end has simply not run yet would be flagged — including today's, every day. That is a detector that
 * cries wolf, and `sales_not_posted` already owns the "sale never posted" case. This check only fires once the
 * sale is a settled fact and the discount is provably missing from it.
 */
export const isDiscountNotApplied = (
  b: { id: string; discountKind?: string | null },
  postedRefIds: Set<string>,
  discountedRefIds: Set<string>,
): boolean => !!b.discountKind && postedRefIds.has(b.id) && !discountedRefIds.has(b.id);

/** Course still active and expiring soon. */
export const isCourseExpiringSoon = (
  c: { size: number; usedSessions: number; expiryDate: string },
  today: string,
  cutoff: string,
): boolean => courseEligible(c, today) && isExpiringSoon(c.expiryDate, today, cutoff);

/**
 * A future course session whose teacher can no longer take it — **archived** or **no longer works that
 * weekday** (SPEC-028 §7.5). LIVE only (a delivered/cancelled session is settled). The re-planning to fix it
 * exists (the editor); this is the missing *detection*.
 */
const ORPHAN_LIVE = new Set(["PENDING", "CONFIRMED", "EXTENDED"]);
export const isOrphanedSession = (
  b: { status: string; date: string },
  teacher: { archived?: boolean | null; workDays?: number[] | null } | null | undefined,
  today: string,
): boolean => {
  if (!ORPHAN_LIVE.has(b.status)) return false;
  if (b.date < today) return false; // only future/today sessions can still be disrupted
  if (!teacher) return false;
  return teacher.archived === true || !teacherWorksOnDay(teacher.workDays ?? [], weekdayOf(b.date));
};

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
  /** Start of the "sold recently" window — `today − NOT_POSTED_WINDOW_DAYS` (TASK-067). */
  salesWindowStart: string;
  /** Data loaders — supplied by the service so the registry stays free of query plumbing. */
  load: {
    bookings: (dates: string[]) => Promise<any[]>;
    teachers: () => Promise<any[]>;
    courses: () => Promise<any[]>;
    vouchers: () => Promise<any[]>;
    studentsWithParent: () => Promise<Array<{ student: any; parent: any | null }>>;
    freelanceCeilings: () => Promise<Array<{ teacherId: string; nickname: string; remainingQty: number }>>;
    /** How many teacher link requests are waiting for staff (TASK-075). */
    pendingTeacherLinks: () => Promise<number>;
    /** Future bookings (date >= today) with their teacher joined — for the orphaned-session check (TASK-096). */
    orphanedCandidates: () => Promise<Array<{ booking: any; teacher: any }>>;
    /** Entitlements sold since `salesWindowStart`, plus the refIds that DID reach `bo.movement` (TASK-067). */
    /**
     * TASK-163 — the two extra facts the dropped-discount check needs, from the same load: the in-window
     * bookings that stored a discount, and the refIds a DISCOUNT movement actually reached.
     */
    salesPostingState: () => Promise<{
      sold: Array<{ id: string; label: string }>;
      postedRefIds: Set<string>;
      storedDiscounts: Array<{ id: string; label: string; discountKind: string | null }>;
      discountedRefIds: Set<string>;
    }>;
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
    // TASK-067 — the detector for the failure that cost us all course/voucher revenue: the sale write was
    // best-effort, so when it broke it broke silently. TASK-066 makes it log loudly, but a log line is only
    // read by someone already looking. This puts it where someone looks every morning.
    // Counts only in the digest: an unposted sale is an ops fault, not a person, and a name adds nothing an
    // admin can act on. The web panel shows which ones, behind login.
    // TASK-075 — a queue nobody is told about is a queue nobody empties, and ~22 of ~23 teachers are about
    // to claim during the launch fortnight. Counts-only: it's a worklist, not a person.
    key: "pending_teacher_links",
    titleKey: "att_pending_teacher_links",
    run: async (ctx) => {
      const count = await ctx.load.pendingTeacherLinks();
      return { count, items: [] };
    },
  },
  {
    key: "sales_not_posted",
    titleKey: "att_sales_not_posted",
    run: async (ctx) => {
      const { sold, postedRefIds } = await ctx.load.salesPostingState();
      const rows = sold.filter((s) => isSaleUnposted(s, postedRefIds));
      return { count: rows.length, items: rows.map((s) => ({ id: s.id, label: s.label })) };
    },
  },
  {
    // SPEC-059 / TASK-163 (REQ-063) — the visibility half of `safeStoredDiscount`'s drop-and-log. A discount
    // that was promised, stored, and then silently not applied is a customer charged more than they were told;
    // the log line that records it is read by nobody. Counts-only in the digest for the same reason as
    // `sales_not_posted` — it is an ops fault, not a person — and the panel names which bookings, behind login.
    key: "discount_not_applied",
    titleKey: "att_discount_not_applied",
    run: async (ctx) => {
      const { postedRefIds, storedDiscounts, discountedRefIds } = await ctx.load.salesPostingState();
      const rows = storedDiscounts.filter((b) => isDiscountNotApplied(b, postedRefIds, discountedRefIds));
      return { count: rows.length, items: rows.map((b) => ({ id: b.id, label: b.label })) };
    },
  },
  {
    // SPEC-028 §7.5 (TASK-096) — a future course session whose teacher was archived or stopped working that
    // weekday. Names people (time · student · teacher) so an admin can act; re-plan via the editor.
    key: "orphaned_sessions",
    titleKey: "att_orphaned_sessions",
    namesPeopleInDigest: true,
    run: async (ctx) => {
      const rows = (await ctx.load.orphanedCandidates()).filter(({ booking, teacher }) =>
        isOrphanedSession(booking, teacher, ctx.today),
      );
      return {
        count: rows.length,
        items: rows.map(({ booking, teacher }) => ({
          id: booking.id,
          label: `${booking.date} ${hhmm(booking.startTime)} · ${booking.student?.nickname ?? booking.student?.name ?? "-"} · ${teacher?.nickname ?? "-"}`,
        })),
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
