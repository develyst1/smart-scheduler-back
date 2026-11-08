// 🔻 TASK-888 (REQ-120 R1.5) - the LINE reminder to confirm a pay slip, to the contract Sober/Silver settled (TASK-887 §"remind <-> send"):
//   * BB (backoffice-back) owns WHO is unconfirmed: `GET /api/v1/internal/salary/unconfirmed?date=` (SERVICE_TOKEN) -> { periodId, lockAt, teacherIds } (DRAFT only).
//   * SB (this repo) owns the SEND: `sendSalaryRemind` = `POST /internal/salary-remind` (x-internal-secret) { teacherIds, reason } -> { sent, skipped }.
//   * The 09:00 / 11:00 jobs ask BB for the list on the last day of the month and call the sender in-process. "Remind now" is BB's route calling the same endpoint.
// SB NEVER reads `bo.*`: the only table it reads is `public.teachers` (the coach's LINE id, which is SB's own binding).
//
// HOW IT SENDS (TASK-888 step 0): it QUEUES a `notification_outbox` row per person (`enqueueLine`, send-once key) and the existing outbox worker delivers it with
// `pushMessage` (retries + audit trail included). `sent` therefore means "accepted for delivery", normally pushed within the worker's 15 s tick.
//
// 🔒 FAIL CLOSED, in this order, BEFORE any read or write: no LINE token => every id skipped NO_TOKEN; the token's account not on LINE_OA_WRITE_ALLOW (or unreadable)
// => every id skipped OA_NOT_ALLOWED. Dev and test never message a real coach.
import { inArray } from "drizzle-orm";
import { db } from "../db";
import { jobRuns, teachers } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { enqueueLine } from "../lib/line";
import { lineConfigured } from "../lib/line-client";
import { decideOaWrite, getBotIdentity, oaWriteAllowList } from "../lib/oa-guard";
import { isLastDayOfMonth, lastDayOfMonth, reminderKey, reminderPayload, type RemindReason } from "../lib/pay-confirm-reminder";

export type SkipReason = "NO_LINE_ID" | "OA_NOT_ALLOWED" | "NO_TOKEN" | "ALREADY_SENT";
export interface RemindResult {
  sent: string[];
  skipped: { teacherId: string; reason: SkipReason }[];
}
export interface Unconfirmed {
  periodId: string | null;
  lockAt?: string;
  teacherIds?: string[];
}

export interface RemindDeps {
  lineConfigured: () => boolean;
  /** Is the account this token holds on LINE_OA_WRITE_ALLOW (and readable)? Only asked once the token exists. */
  oaAllowed: () => Promise<boolean>;
  now: () => { date: string; time: string; instant: Date };
  /** teacherId -> LINE user id, for ordinary (not system, not archived) teachers only; an unknown / system / archived id is absent. */
  readLineIds: (ids: string[]) => Promise<Map<string, string | null>>;
  enqueue: (o: { teacherId: string; lineUserId: string; payload: ReturnType<typeof reminderPayload>; key: string }) => Promise<"queued" | "duplicate" | "skipped">;
  /** BB's list for the pay period that contains `date`. Throws when BB is not configured / unreachable. */
  fetchUnconfirmed: (date: string) => Promise<Unconfirmed>;
}

/** The ONE producer of a pay-confirm reminder row: a named coach (the one whose slip it is), send-once by `key`. */
async function enqueuePayConfirm(o: { teacherId: string; lineUserId: string; payload: ReturnType<typeof reminderPayload>; key: string }): Promise<"queued" | "duplicate" | "skipped"> {
  const r = await enqueueLine({
    recipientType: "teacher",
    recipientLineUserId: o.lineUserId,
    payload: o.payload,
    idempotencyKey: o.key,
  });
  return r.status === "queued" ? "queued" : r.status === "duplicate" ? "duplicate" : "skipped";
}

let oaCache: { at: number; ok: boolean } | null = null;
const OA_TTL_MS = 5 * 60_000;

export const realRemindDeps: RemindDeps = {
  lineConfigured,
  async oaAllowed() {
    if (oaCache && Date.now() - oaCache.at < OA_TTL_MS) return oaCache.ok;
    const id = await getBotIdentity(); // GET /v2/bot/info: read-only, and only reached when a token exists
    const ok = !!id && decideOaWrite(id, id.basicId ?? id.displayName ?? undefined, oaWriteAllowList()).ok;
    oaCache = { at: Date.now(), ok };
    return ok;
  },
  now: () => {
    const n = bangkokNow();
    return { date: n.date, time: n.time, instant: new Date() };
  },
  async readLineIds(ids) {
    if (!ids.length) return new Map();
    const rows = await db.select({ id: teachers.id, lineUserId: teachers.lineUserId, isSystem: teachers.isSystem, archived: teachers.archived }).from(teachers).where(inArray(teachers.id, ids));
    return new Map(rows.filter((r) => !r.isSystem && !r.archived).map((r) => [r.id, r.lineUserId?.trim() || null]));
  },
  enqueue: enqueuePayConfirm,
  async fetchUnconfirmed(date) {
    const base = process.env.OPS_API_URL?.replace(/\/$/, "");
    if (!base) throw new Error("OPS_API_URL not set");
    const headers: Record<string, string> = {};
    if (process.env.SERVICE_TOKEN) headers["X-Service-Token"] = process.env.SERVICE_TOKEN;
    const res = await fetch(`${base}/api/v1/internal/salary/unconfirmed?date=${encodeURIComponent(date)}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`backoffice unconfirmed ${res.status}`);
    return (await res.json()) as Unconfirmed;
  },
};

/**
 * THE SENDER (`POST /internal/salary-remind`). Queues one "please confirm your pay slip" LINE per coach in `teacherIds`. No pay figure in the message.
 * Idempotent per (period, teacher, reason): a re-tick or a retry is `skipped: ALREADY_SENT`, never a second message. `periodId` is optional (falls back to the month).
 */
export async function sendSalaryRemind(input: { teacherIds: string[]; reason: RemindReason; periodId?: string }, deps: RemindDeps = realRemindDeps): Promise<RemindResult> {
  const ids = [...new Set(input.teacherIds)];
  const skipAll = (reason: SkipReason): RemindResult => ({ sent: [], skipped: ids.map((teacherId) => ({ teacherId, reason })) });
  if (!deps.lineConfigured()) return skipAll("NO_TOKEN"); // 🔒 1st: before ANY read, write or network call
  if (!(await deps.oaAllowed())) return skipAll("OA_NOT_ALLOWED"); // 🔒 2nd: the account must be on this machine's allow-list
  const now = deps.now();
  const payload = reminderPayload(input.reason, lastDayOfMonth(now.date));
  const period = input.periodId ?? now.date.slice(0, 7);
  const lineIds = await deps.readLineIds(ids);
  const out: RemindResult = { sent: [], skipped: [] };
  for (const teacherId of ids) {
    const lineUserId = lineIds.get(teacherId);
    if (!lineUserId) {
      out.skipped.push({ teacherId, reason: "NO_LINE_ID" });
      continue;
    }
    const r = await deps.enqueue({ teacherId, lineUserId, payload, key: reminderKey(period, teacherId, input.reason, now.date, now.time) });
    if (r === "queued") out.sent.push(teacherId);
    else out.skipped.push({ teacherId, reason: r === "duplicate" ? "ALREADY_SENT" : "NO_LINE_ID" });
  }
  return out;
}

export type JobResult =
  | { ran: false; reason: "no-channel-token" | "not-confirm-day" | "no-period" | "after-lock-time" | "backoffice-unavailable" }
  | ({ ran: true; periodId: string; targets: number } & RemindResult);

/**
 * The 09:00 / 11:00 job body: on the LAST day of the month ask BB which coaches are unconfirmed (BB owns the rule; this never re-derives it), then call the sender
 * in-process with `reason` = the slot. Does nothing without a LINE token (so no call to BB either), off the confirm day, or at / after the period's lock time.
 */
export async function runPayConfirmReminder(slot: "0900" | "1100", date?: string, deps: RemindDeps = realRemindDeps): Promise<JobResult> {
  if (!deps.lineConfigured()) return { ran: false, reason: "no-channel-token" }; // 🔒 before the call to BB
  const now = deps.now();
  const today = date ?? now.date;
  if (!isLastDayOfMonth(today)) return { ran: false, reason: "not-confirm-day" };
  let list: Unconfirmed;
  try {
    list = await deps.fetchUnconfirmed(today);
  } catch {
    return { ran: false, reason: "backoffice-unavailable" };
  }
  if (!list.periodId) return { ran: false, reason: "no-period" };
  if (list.lockAt && now.instant.getTime() >= new Date(list.lockAt).getTime()) return { ran: false, reason: "after-lock-time" };
  const teacherIds = list.teacherIds ?? [];
  const r = await sendSalaryRemind({ teacherIds, reason: slot, periodId: list.periodId }, { ...deps, now: () => ({ ...now, date: today }) });
  return { ran: true, periodId: list.periodId, targets: teacherIds.length, ...r };
}

/** The scheduled entry point: runs the slot and ALWAYS writes a `job_runs` row (TASK-208's lesson: a job never registered on the box must stay visible). */
export async function runPayConfirmReminderJob(slot: "0900" | "1100", date?: string) {
  const runDate = date ?? bangkokNow().date;
  const result = await runPayConfirmReminder(slot, runDate);
  const failed = !result.ran && result.reason === "backoffice-unavailable";
  await db.insert(jobRuns).values({ job: `pay-confirm-${slot}`, runDate, status: failed ? "failed" : "success", summary: result as unknown as Record<string, unknown>, finishedAt: new Date() });
  return { date: runDate, slot, ...result };
}

export type NowResult =
  | { ran: false; reason: "no-channel-token" | "no-period" | "period-mismatch" | "after-lock-time" | "backoffice-unavailable" }
  | ({ ran: true; periodId: string; targets: number } & RemindResult);

/**
 * THE CEO's "remind now" (`POST /internal/salary-remind-now { periodId }`): any day, for `periodId` only. BB owns the unconfirmed rule, so we ask it for the list of the pay period that
 * contains TODAY and send only if that IS the period asked for (`period-mismatch` otherwise: never remind coaches of a period the list does not belong to). Same sender, same
 * fail-closed order, same 5-minute double-click bucket as the scheduled path.
 */
export async function runPayConfirmNow(periodId: string, deps: RemindDeps = realRemindDeps): Promise<NowResult> {
  if (!deps.lineConfigured()) return { ran: false, reason: "no-channel-token" }; // 🔒 before the call to BB
  const now = deps.now();
  let list: Unconfirmed;
  try {
    list = await deps.fetchUnconfirmed(now.date);
  } catch {
    return { ran: false, reason: "backoffice-unavailable" };
  }
  if (!list.periodId) return { ran: false, reason: "no-period" };
  if (list.periodId !== periodId) return { ran: false, reason: "period-mismatch" };
  if (list.lockAt && now.instant.getTime() >= new Date(list.lockAt).getTime()) return { ran: false, reason: "after-lock-time" };
  const teacherIds = list.teacherIds ?? [];
  const r = await sendSalaryRemind({ teacherIds, reason: "now", periodId: list.periodId }, deps);
  return { ran: true, periodId: list.periodId, targets: teacherIds.length, ...r };
}

/** The route's entry: runs remind-now and ALWAYS writes a `job_runs` row (who pressed it is BB's audit; this records that SB acted and what it did). */
export async function runPayConfirmNowJob(periodId: string) {
  const result = await runPayConfirmNow(periodId);
  const failed = !result.ran && result.reason === "backoffice-unavailable";
  await db.insert(jobRuns).values({ job: "pay-confirm-now", runDate: bangkokNow().date, status: failed ? "failed" : "success", summary: { ...result, periodId } as unknown as Record<string, unknown>, finishedAt: new Date() });
  return result;
}
