// 🔻 TASK-737 (REQ-119) — the PURE counters of `GET /api/reports/daily`, Palm's contract (`smart-scheduler-front` → `docs/backend-daily-report.md` §2–§5, §8; his counting
// `src/lib/scheduler/daily-report.ts` L11–34). No database, no clock: the service reads the day's rows and hands them here, so every rule below is asserted with values.
//
// Palm's answers to his own open questions (Q1–Q6) are TEMPORARY — they live here as one exported constant/predicate each, mirroring his file, so that when the owner or ฟีน answers,
// the back and the front change together. 🚫 Nothing here "improves" them.

/** The four LESSON types — every stat card counts only these (ECA/Free/KOL/CAMP are `OTHER`, a DUO/Group row is `GROUP`). Fixed order = the order of `byBookingType*`. */
export const LESSON_TYPES = ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"] as const;
export type LessonType = (typeof LESSON_TYPES)[number];

/**
 * 🔒 THE ONE SWITCH (REQ-119 ❓) — RULED by Khwan, 2026-10-13: **A**, "ไม่นับคลาสที่ยังไม่คอนเฟิร์ม" ⇒ `false`.
 *   false = the customer's Excel (the RULE): Total booked = Confirmed + On leave — Pending and Extended are OUT (a class not yet confirmed is not counted), and so is PAUSED / CANCELLED;
 *   true  = Palm's earlier choice (every lesson that is neither CANCELLED nor PAUSED, Pending and Extended IN). Kept as the injectable `includePending` option below so both paths stay tested and documented.
 * The attendance circle follows by itself (`attended / totalBooked`).
 */
export const TOTAL_BOOKED_INCLUDES_PENDING = false;

/** Palm Q1: NO_SHOW counts as Confirmed. */
export const CONFIRMED_STATUSES: ReadonlySet<string> = new Set(["CONFIRMED", "ATTENDED", "NO_SHOW"]);
/** Palm Q2: EXTENDED counts as Pending. */
export const PENDING_STATUSES: ReadonlySet<string> = new Set(["PENDING", "EXTENDED"]);
/** Palm Q4: Awaiting = a PAUSED 1st-trial / 1-hour class (a PAUSED voucher session appears on no card — his open question). */
export const AWAITING_TYPES: ReadonlySet<string> = new Set(["FIRST_TRIAL", "SINGLE_SESSION"]);
/**
 * 🔒 REQ-129 = B (Khwan, 2026-10-25: «แบบ A แต่นับงานกลุ่มเป็นชั่วโมง») — what adds to a coach's workload `total` (+Group): ONLY a row in a CONFIRMED status (CONFIRMED · ATTENDED · NO_SHOW). A lesson on leave, a pending
 * / extended one, a paused one (awaiting) and a cancelled one are OUT; so a leave and its same-slot replacement count ONCE (the replacement). One row = one hour, so a 2-hour ECA is +2 and a 5-hour camp +5.
 * ONE rule: a later ruling is a one-line change here.
 */
export const WORKLOAD_STATUSES: ReadonlySet<string> = CONFIRMED_STATUSES;
/** Palm Q5: Total booked excludes PAUSED (and CANCELLED). */
export const NOT_BOOKED_STATUSES: ReadonlySet<string> = new Set(["CANCELLED", "PAUSED"]);

/** One booking row of the day, already reduced to what the counters need. `coachIds[0]` is the primary coach (`bookings.teacher_id`), the rest are `booking_teachers`. */
export interface ReportRow {
  status: string;
  bookingType: string;
  coachIds: readonly string[];
}

export interface ByType { type: LessonType; count: number }
export interface ByTeacher { teacherId: string; count: number; attended: number; total: number }
export interface DailyReportCounts {
  totalBooked: number;
  attended: number;
  confirmed: number;
  pending: number;
  awaiting: number;
  onLeave: number;
  cancelled: number;
  attendanceRate: number;
  noShow: number; // legacy, kept (harmless; Palm allows it)
  byBookingType: ByType[]; // legacy, kept: the booked lessons per type
  byBookingTypeAttended: ByType[];
  byBookingTypeConfirmed: ByType[];
  byTeacher: ByTeacher[];
}

const isLesson = (r: ReportRow): boolean => (LESSON_TYPES as readonly string[]).includes(r.bookingType);
const isBooked = (r: ReportRow): boolean => !NOT_BOOKED_STATUSES.has(r.status);
const isConfirmed = (r: ReportRow): boolean => CONFIRMED_STATUSES.has(r.status);
const byType = (rows: ReportRow[], pred: (r: ReportRow) => boolean): ByType[] => LESSON_TYPES.map((type) => ({ type, count: rows.filter((r) => r.bookingType === type && pred(r)).length }));

/**
 * The whole report from the day's rows. `teacherId` filters EVERY counter: a row belongs to a coach if he is the primary coach OR one of the extras. `byTeacher` then lists only that coach
 * (declared: the other coaches of a shared row are not this coach's report). `includePending` is the switch above, injectable only so BOTH paths are tested.
 */
export function countDaily(rowsOfDay: readonly ReportRow[], opts: { teacherId?: string; includePending?: boolean } = {}): DailyReportCounts {
  const includePending = opts.includePending ?? TOTAL_BOOKED_INCLUDES_PENDING;
  const rows = opts.teacherId ? rowsOfDay.filter((r) => r.coachIds.includes(opts.teacherId!)) : [...rowsOfDay];
  const lessons = rows.filter(isLesson);
  const n = (pred: (r: ReportRow) => boolean) => lessons.filter(pred).length;

  const attended = n((r) => r.status === "ATTENDED");
  const confirmed = n(isConfirmed);
  const onLeave = n((r) => r.status === "SICK_LEAVE");
  const totalBooked = includePending ? n(isBooked) : confirmed + onLeave;

  // workload (REQ-129 = B): a coach is LISTED for every row that is neither cancelled nor paused (lesson + OTHER incl. camp hour rows + GROUP), but `total` grows by 1 — one hour — only for a row in `WORKLOAD_STATUSES` (confirmed), for the primary AND each extra coach; `count`/`attended` from lessons only
  const per = new Map<string, ByTeacher>();
  for (const r of rows) {
    if (!isBooked(r)) continue;
    for (const id of new Set(r.coachIds)) {
      if (opts.teacherId && id !== opts.teacherId) continue;
      const t = per.get(id) ?? { teacherId: id, count: 0, attended: 0, total: 0 };
      if (WORKLOAD_STATUSES.has(r.status)) t.total += 1;
      if (isLesson(r)) {
        if (isConfirmed(r)) t.count += 1;
        if (r.status === "ATTENDED") t.attended += 1;
      }
      per.set(id, t);
    }
  }
  // order: total desc, count desc, then teacherId asc (declared: the stable tie-break)
  const byTeacher = [...per.values()].sort((a, b) => b.total - a.total || b.count - a.count || (a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0));

  return {
    totalBooked,
    attended,
    confirmed,
    pending: n((r) => PENDING_STATUSES.has(r.status)),
    awaiting: n((r) => r.status === "PAUSED" && AWAITING_TYPES.has(r.bookingType)),
    onLeave,
    cancelled: n((r) => r.status === "CANCELLED"),
    attendanceRate: totalBooked > 0 ? Math.round((attended / totalBooked) * 100) : 0,
    noShow: n((r) => r.status === "NO_SHOW"),
    byBookingType: byType(lessons, isBooked),
    byBookingTypeAttended: byType(lessons, (r) => r.status === "ATTENDED"),
    byBookingTypeConfirmed: byType(lessons, isConfirmed),
    byTeacher,
  };
}

// ═════════════════════ 🔻 TASK-743 (REQ-124 3/3) — «Others Program»: `kidsByProgram` (Palm `backend-daily-report.md` §10) ═════════════════════
// Counts CHILDREN (not classes) of the day's group work, in 4 fixed programs. Pure: the service reads the rows (+ the group's seats, + the camp week's kid count) and hands them here.

/** The four programs, ALWAYS all present and in this order (an empty one is `{program, total: null, items: []}`). */
export const PROGRAMS = ["GROUP", "ECA", "CAMP", "OTHER"] as const;
export type Program = (typeof PROGRAMS)[number];

/**
 * 🔒 D1 (Porter, 2026-10-18: ONCE PER CLASS). An ECA / Other class is stored as ONE ROW PER HOUR and `headCount` repeats on each hour row of the same class (CHECK M10), so Palm's literal per-row sum
 * would show 10 for a 2-hour class of 5 kids. true = `headCount` once per class (same series / title + coach + date + CONTIGUOUS hours; two separate rounds still add: 5 + 6 = 11);
 * false = Palm's per-row sum. ONE switch, so a ruling is a one-line flip + its pin.
 */
export const KIDS_ONCE_PER_CLASS = true;
/** A row in one of these statuses is out of the section entirely (Palm §10.3). */
export const PROGRAM_EXCLUDED_STATUSES: ReadonlySet<string> = new Set(["CANCELLED", "PAUSED"]);
/** A GROUP's seat in one of these is not a child of the group today (M9: the seats are the kids, `headCount` is only the CAP). */
export const SEAT_NOT_A_KID_STATUSES: ReadonlySet<string> = new Set(["CANCELLED", "SICK_LEAVE", "PAUSED"]);

/** A day row with what the program counters need on top of `ReportRow`. Every extra field is optional: the 737 counters read none of them. */
export interface ProgramRow extends ReportRow {
  teacherId?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  otherKind?: string | null;
  /** `other_title` — the group's name, the school (ECA), the booking's title. */
  title?: string | null;
  headCount?: number | null;
  seriesKey?: string | null;
  /** A camp hour row's WEEK (via its `camp_week_day_id`). */
  campWeekId?: string | null;
  /** A GROUP row's seats' statuses (null / empty = no seat data). */
  seatStatuses?: readonly string[] | null;
}
export interface ProgramItem { name: string; kids: number | null }
export interface ProgramBlock { program: Program; total: number | null; items: ProgramItem[] }
/** The camp weeks of the day: their name and `camp_days` count for that date (the calendar's `campKidCount`, one number per week per date). */
export type CampKids = Readonly<Record<string, { name: string; kids: number | null }>>;

const hhmm5 = (t: string | undefined): string => (t ?? "").slice(0, 5);
/** `null + n = n`; all null / nothing ⇒ null (never 0 for «not recorded»). */
const addKids = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : a + b);

/** The program a row belongs to, or null for a lesson (not this section's business). */
function programOf(r: ProgramRow): Program | null {
  if (r.bookingType === "GROUP") return "GROUP";
  if (r.bookingType !== "OTHER") return null;
  if (r.campWeekId || r.otherKind === "CAMP") return "CAMP";
  return r.otherKind === "ECA" ? "ECA" : "OTHER";
}

/**
 * D1 in ONE function: collapse a program's hour rows into CLASSES — same series (else title) + coach + date and the next hour starting exactly where the last ended. A class carries its `headCount` once
 * (the first recorded one). With the switch off every row is its own class (Palm's per-row sum).
 */
export function classesOf(rows: readonly ProgramRow[], oncePerClass: boolean = KIDS_ONCE_PER_CLASS): Array<{ name: string; kids: number | null }> {
  const name = (r: ProgramRow) => (r.title ?? "").trim() || r.otherKind || "OTHER";
  if (!oncePerClass) return rows.map((r) => ({ name: name(r), kids: r.headCount ?? null }));
  const key = (r: ProgramRow) => `${r.seriesKey ?? name(r)}|${r.teacherId ?? ""}|${r.date ?? ""}`;
  const sorted = [...rows].sort((a, b) => key(a).localeCompare(key(b)) || hhmm5(a.startTime).localeCompare(hhmm5(b.startTime)));
  const out: Array<{ name: string; kids: number | null; k: string; end: string }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.k === key(r) && last.end === hhmm5(r.startTime)) {
      last.end = hhmm5(r.endTime);
      last.kids = last.kids ?? r.headCount ?? null; // the same number repeats on each hour row
    } else out.push({ name: name(r), kids: r.headCount ?? null, k: key(r), end: hhmm5(r.endTime) });
  }
  return out.map(({ name: n, kids }) => ({ name: n, kids }));
}

/** Merge items of the same name (Palm K1: two rounds of «STA» in a day are ONE item, 5 + 6 = 11), kids descending (not recorded last), then name. */
function mergeItems(items: readonly ProgramItem[]): ProgramItem[] {
  const byName = new Map<string, number | null>();
  for (const i of items) byName.set(i.name, addKids(byName.get(i.name) ?? null, i.kids));
  return [...byName].map(([name, kids]) => ({ name, kids })).sort((a, b) => (b.kids ?? -1) - (a.kids ?? -1) || a.name.localeCompare(b.name));
}

/**
 * The whole section from the day's rows. `teacherId` filters it (Palm K2): a row belongs to a coach if he is the primary coach OR an extra one — and a booking is ONE row, so an ECA with two coaches
 * is counted once. `camp` carries each camp week's name and kid count for the date.
 */
export function kidsByProgram(rowsOfDay: readonly ProgramRow[], opts: { teacherId?: string; camp?: CampKids; oncePerClass?: boolean } = {}): ProgramBlock[] {
  const rows = rowsOfDay.filter((r) => !PROGRAM_EXCLUDED_STATUSES.has(r.status) && (!opts.teacherId || r.coachIds.includes(opts.teacherId)));
  const of = (p: Program) => rows.filter((r) => programOf(r) === p);

  const items: Record<Program, ProgramItem[]> = { GROUP: [], ECA: [], CAMP: [], OTHER: [] };
  // GROUP: the kids are the SEATS that are live or delivered — never `headCount`, which on a group row is the cap
  for (const r of of("GROUP")) {
    const seats = r.seatStatuses ?? [];
    items.GROUP.push({ name: (r.title ?? "").trim() || "GROUP", kids: seats.length ? seats.filter((s) => !SEAT_NOT_A_KID_STATUSES.has(s)).length : null });
  }
  items.ECA = classesOf(of("ECA"), opts.oncePerClass);
  items.OTHER = classesOf(of("OTHER"), opts.oncePerClass);
  // CAMP: ONE item per camp WEEK, its kid count of the date — never multiplied by the hour rows
  const weeks = new Set<string>();
  for (const r of of("CAMP")) {
    const wk = r.campWeekId ?? `title:${(r.title ?? "").trim()}`;
    if (weeks.has(wk)) continue;
    weeks.add(wk);
    const w = r.campWeekId ? opts.camp?.[r.campWeekId] : undefined;
    items.CAMP.push({ name: w?.name ?? ((r.title ?? "").trim() || "CAMP"), kids: w?.kids ?? null });
  }

  // 🔻 TEST-109 F2 — «kids in camp that day» (Palm §10.1): a camp week with kids but NO coach has no hour row, yet its children are there. Every week of the day with kids > 0 is an item; a week with 0
  // kids and no row stays out. Under a coach filter only the weeks where THAT coach has a camp row show (a coach-less week belongs to no coach).
  for (const [weekId, w] of Object.entries(opts.camp ?? {})) {
    if (weeks.has(weekId) || opts.teacherId || (w.kids ?? 0) <= 0) continue;
    items.CAMP.push({ name: w.name, kids: w.kids });
  }

  return PROGRAMS.map((program) => {
    const merged = mergeItems(items[program]);
    return { program, total: merged.reduce<number | null>((t, i) => addKids(t, i.kids), null), items: merged };
  });
}
