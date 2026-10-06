// Leave-quota / extension rules — the AUTHORITATIVE copy (ported from the
// frontend's src/lib/scheduler/leave.ts). The FE may mirror these for instant UX,
// but this server result is the source of truth.

import { courseStatus, type CourseStatus } from "./course-status";
import { bangkokNow } from "./bangkok-time";

export type PackageSize = 4 | 6 | 10;

/** Leave quota bound to course size: 4→1, 6→2, 10→3. */
export const LEAVE_QUOTA_BY_SIZE: Record<number, number> = { 4: 1, 6: 2, 10: 3 };

/**
 * Max week the schedule may extend to: **4→5, 6→8, 10→13** — all three CONFIRMED by the owner (FIX-007,
 * 2026-08-28), which is also where course expiry comes from (`courseExpiry` = start + these weeks).
 *
 * The `6→8` entry carried "an ASSUMPTION — confirm" from the first week of this project and has been quoted as
 * doubtful ever since, including in both repos' CLAUDE.md. It is now the owner's own rule, derived from the
 * same table as 4 and 10 — so the caveat is deleted rather than softened. A stale warning on a settled number
 * costs someone a re-investigation every time they meet it.
 */
export const MAX_WEEK_BY_SIZE: Record<number, number> = Object.fromEntries(
  Object.entries(LEAVE_QUOTA_BY_SIZE).map(([size, quota]) => [size, Number(size) + quota]),
);

/**
 * 🔴 TASK-213 — **`maxWeek = size + leaveQuota`**, at every size. That IS the owner's rule (4+1=5 · 6+2=8 ·
 * 10+3=13), and `MAX_WEEK_BY_SIZE` above is now *derived* from it rather than being a second table typed by
 * hand — two tables that must agree are two tables that eventually don't.
 *
 * It also answers for a size the card has never heard of, which is the whole point: an off-card import used to
 * fall through both tables to `quota = 0, maxWeek = 0` — a course with **no leave allowance and an expiry in
 * its own first week** — and nothing said so.
 */
export const maxWeekFor = (size: number, quota: number): number => size + quota;

/**
 * The leave quota this course actually has: the **stored** one when it was imported off-card, otherwise the
 * card's. Stored wins because an off-card course's quota is a fact somebody entered, not something derivable.
 */
export const courseLeaveQuota = (c: { size: number; leaveQuota?: number | null }): number =>
  c.leaveQuota ?? LEAVE_QUOTA_BY_SIZE[c.size] ?? 0;

export interface CourseLike {
  id: string;
  /** TASK-573 §3 — the course's start (`course_packages.start_date`, NOT NULL), which TASK-570's start-date move writes. */
  startDate: string;
  size: number;
  usedSessions: number;
  /**
   * 🔴 TASK-656 (REQ-112) — **THE MEANING OF THIS COLUMN CHANGED.** It was "leaves spent out of a LIMITED allowance"; it is now a
   * plain COUNT of the leaves taken on the course, with NO limit — incremented once per COUNTED leave on every door, and never
   * compared against anything that can refuse a leave. A pre-start declaration is FREE and is not counted (unchanged, TASK-609).
   * ⚠️ It is NOT zero-sum with `leaveQuota`: `leaveUsed` may now exceed it, and `leaveRemaining` is then floored at 0.
   * 🔑 What bounds a course now is its EXPIRY — and an ORDINARY leave does NOT move it (the customer: "ถ้าลาปกติไม่เพิ่มให้นะคะ"). Only the
   * three triggers do (`LEAVE_WEEK_TRIGGERS`, `addLeaveWeek`): a pre-start declared absence, a coach's leave, a school cancel with
   * `SCHOOL_ISSUE`. Anything that still reads "x of y" from these two numbers is reading a rule the owner has retired.
   * 📌 The column's own definition is in `db/schema.ts`, which is outside this task's claim — so the statement lives HERE, on the
   * type every reader goes through, and in SYSTEM-FACTS.
   */
  leaveUsed: number;
  adminUnlocked: boolean;
  expiryDate: string;
  /** TASK-213 — an off-card import stores its own leave quota; `null` means "use the card's". */
  leaveQuota?: number | null;
  /** TASK-181 (REQ-036) — ended early (null for a live course). Read via `CourseLike` so every screen that
   *  renders a course summary sees it, rather than only the one that ended it. */
  endedAt?: Date | string | null;
  endReason?: string | null;
  /** TASK-198 — set while the course is PAUSED, cleared on resume. Reversible, unlike `endedAt`. */
  droppedAt?: Date | string | null;
  dropReason?: string | null;
}

export interface CourseSummary {
  id: string;
  /** TASK-573 §3 — the real column (TASK-545 removed an INVENTED one; the real reader arrived as a compile error, as designed). */
  startDate: string;
  size: PackageSize;
  usedSessions: number;
  leaveUsed: number;
  leaveQuota: number;
  leaveRemaining: number;
  maxWeek: number;
  leaveLocked: boolean;
  adminUnlocked: boolean;
  expiryDate: string;
  endedAt: string | null;
  endReason: string | null;
  /** SPEC-065 / TASK-198 — when the course was paused, and why. `null` for a course that is not paused. */
  droppedAt: string | null;
  dropReason: string | null;
  /**
   * SPEC-064 / TASK-188 (REQ-036 B3) — the lifecycle status the badge renders AND the filter filters on.
   * Computed HERE, in the one builder every course response flows through, so the two cannot diverge — which
   * is what let a cancelled course wear a green `ปกติ` badge in the first place.
   */
  status: CourseStatus;
}

export const leaveQuota = (size: number) => LEAVE_QUOTA_BY_SIZE[size] ?? 0;

/**
 * 🔴 TASK-650 — the WEEK NUMBER a stored expiry stands for: the inverse of `courseExpiry`, which is
 * `expiry = start + (week − 1) × 7 days` ⇒ `week = days(start → expiry) / 7 + 1`.
 * 🔑 Rounded UP, so an expiry that is not on a week boundary reports the week it falls INSIDE rather than the one before it —
 * the label promises a ceiling, and a ceiling rounded down is a promise the system does not keep.
 * 🚫 It never reports LESS than the course's own base ceiling (`fallback`): a stored expiry behind the base would be a data
 * fault, and the label is not the place to surface one. ⚠️ A missing or unparseable expiry falls back for the same reason.
 */
export function weekOfExpiry(startDate: string, expiryDate: string | null | undefined, fallback: number): number {
  if (!expiryDate) return fallback;
  const days = (Date.parse(expiryDate) - Date.parse(startDate)) / 86_400_000;
  if (!Number.isFinite(days)) return fallback;
  return Math.max(fallback, Math.ceil(days / 7) + 1);
}

export function toCourseSummary(c: CourseLike, today?: string): CourseSummary {
  // TASK-213: the STORED quota wins (an off-card import carries its own), and `maxWeek` is derived from it —
  // so an off-card course no longer reports "0 leaves, expiry in week 0" by falling through two tables that
  // had never heard of its size.
  const quota = courseLeaveQuota(c);
  // 🔴 TASK-650 (QA re-test item 1) — the label *"ขยายได้ถึงสัปดาห์ที่ N"* is read from the course's OWN STORED EXPIRY, not
  // re-derived from `size + quota`. 🔑 It used to be `maxWeekFor(c.size, quota)`, which is the CAPPED rule the owner deleted:
  // since TASK-646 the expiry STRETCHES one week per declared pre-start day, so a 4-session course with 3 of them expires in
  // week 8 while the card still said week 5. **The dates were right; the label understated them.**
  // 🔑 This is TASK-646's own cause ONE LEVEL UP: the expiry rule changed and a second READER of the old rule was left behind.
  // ⇒ fixed at the SOURCE, once. 🚫 Not on the card: the next screen that shows a week number would be wrong again.
  // ✅ The SAME line also makes an admin-EXTENDED expiry honest — it was mislabelled before for exactly the same reason.
  // 📌 `maxWeekFor` itself is untouched: `courseExpiry` still builds the BASE expiry from it at creation. Only this READER moved.
  const maxWeek = weekOfExpiry(c.startDate, c.expiryDate, maxWeekFor(c.size, quota));
  const leaveRemaining = Math.max(0, quota - c.leaveUsed);
  // 🔻 TASK-656 (REQ-112) — leaves are UNLIMITED ("ไม่จำกัดจำนวน"), so a course is NEVER locked for leave. Kept as a field only so the
  // DTO's shape does not change under the front; always `false`, pinned by value.
  const leaveLocked = false;
  return {
    id: c.id,
    startDate: c.startDate,
    size: c.size as PackageSize,
    usedSessions: c.usedSessions,
    leaveUsed: c.leaveUsed,
    leaveQuota: quota,
    leaveRemaining,
    maxWeek,
    leaveLocked,
    adminUnlocked: c.adminUnlocked,
    // SPEC-064 / TASK-181 (REQ-036) — an ended course must LOOK ended everywhere it appears, or staff will
    // keep booking into it from a screen that shows nothing wrong. `size` deliberately still reads what the
    // family bought; this is the flag that says the plan is finished.
    endedAt: c.endedAt ? (typeof c.endedAt === "string" ? c.endedAt : c.endedAt.toISOString()) : null,
    endReason: c.endReason ?? null,
    // TASK-198: carried like `endedAt` so the FE can say WHEN a course was paused and why, not merely that it is.
    droppedAt: c.droppedAt
      ? typeof c.droppedAt === "string"
        ? c.droppedAt
        : c.droppedAt.toISOString()
      : null,
    dropReason: c.dropReason ?? null,
    // The clock is resolved once, here, in Bangkok — never inside the pure rule, which takes `today` so it
    // stays testable and cannot pick up the server's timezone by accident.
    //
    // The whole row goes in — the two `?? null`s are only bridging `CourseLike`'s optional fields (fixtures may
    // omit them; a DB row never does) to `CourseStatusInput`'s now-REQUIRED ones. This is a coalesce at ONE
    // named seam, not a hand-copied projection: the field list is not restated here, so it cannot go stale
    // the way `listCoursesPaged`'s did (TASK-205).
    status: courseStatus({ ...c, endedAt: c.endedAt ?? null, droppedAt: c.droppedAt ?? null }, today ?? bangkokNow().date),
    expiryDate: c.expiryDate,
  };
}

/** true = may still take leave / extend the schedule. */
export function canTakeLeave(c: CourseLike): boolean {
  return toCourseSummary(c).leaveRemaining > 0 || c.adminUnlocked;
}
