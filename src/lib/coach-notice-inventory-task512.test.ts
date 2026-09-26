// TASK-512 — ONE statement about every coach message: WHO decides its recipients.
//
// The rule (TASK-510/512): every coach of a class is told when that class stops happening, starts again, or moves — and "every
// coach of a class" has ONE answer, `teachersOfBooking` (THE predicate, `ownScopeWhere`). Four hand-written copies of that answer
// were found in a week; a copy that currently agrees is the dangerous kind, because nothing fails until it drifts.
//
// 🔑 The list of producers is DERIVED from the source (every function that builds a `recipientType: "teacher"` row), so a NEW
// coach message fails here until someone decides which kind it is — that decision is the point. The class-event ones must ask
// `teachersOfBooking` and must not look a teacher up for themselves. The rest are named, each with why.
// ⚠️ Limit, stated: a producer that passes `recipientType` through a variable is not seen by the scan.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const files: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
  }
};
walk("src");

/** `file#function` → that function's source (from its column-0 declaration to the next column-0 declaration). */
const producers = new Map<string, string>();
for (const f of files) {
  const L = readSrc(readFileSync(join(root, f), "utf8")).split("\n");
  const decl = (l: string) => l.match(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+) = (?:async )?\(/);
  L.forEach((l, i) => {
    if (!/recipientType: "teacher"(,| as const)/.test(l)) return;
    let start = i;
    while (start > 0 && !decl(L[start]!)) start--;
    const name = decl(L[start]!)?.slice(1).find(Boolean) ?? "?";
    let end = i + 1;
    while (end < L.length && !decl(L[end]!)) end++;
    producers.set(`${f}#${name}`, L.slice(start, end).join("\n"));
  });
}

const S = "src/services/scheduler.service.ts";
/** A class stops / starts / is cancelled ⇒ EVERY coach, through THE predicate. */
const VIA_PREDICATE = [`${S}#sendLeaveNotice`, `${S}#sendClassCancelledToCoaches`, `${S}#sendClassCancelledToOtherTeachers`, `${S}#sendCourseDroppedToTeachers`, "src/services/undo.service.ts#undoBooking",
  // TASK-513 — the three the inventory found, converged
  `${S}#pauseBooking`, `${S}#resumeBooking`, "src/services/rental.service.ts#notifyRentalAddedSameDay"];
/** The recipient is a NAMED person, not "the coaches of a class" — correct by design. */
const NAMED_BY_DESIGN: Record<string, string> = {
  [`${S}#sendTeacherReassigned`]: "the coach taken off and the coach put on — two named people",
  "src/services/other-series.service.ts#swapOtherSeriesTeacher": "the same, for an อื่นๆ series",
  "src/services/teacher-link.service.ts#approveTeacherLinkRequest": "the coach who asked to link",
  "src/lib/camp-reminder.ts#campReminderSends": "camp's own day-teacher model (`camp_week_day_teachers`), not a booking",
  // TASK-513 — argued, not converted: a course has ONE coach by construction — validation refuses `additionalTeacherIds` on every
  // lesson type (AC-20, pinned below), and a course seat on a GROUP keeps the group's extras on the GROUP row, not the seat — so
  // `teachersOfBooking` on any course row IS the primary. The message is a COURSE summary with ONE `Coach :` (rows[0].teacher):
  // if a multi-coach course ever exists, that is a message-design decision, not a recipient loop.
  [`${S}#confirmCourse`]: "a COURSE summary to its one coach — one coach per course by construction (AC-20)",
};
/** Reaches the additional teachers TODAY, but through its own answer — a copy that currently agrees (named, not yet converged). */
const OWN_COPY_REACHES_ALL: Record<string, string> = {
  [`${S}#updateBookingStatus`]: "`booking_confirmed` — `assignedTeacherIds` (teacher_id + booking_teachers)",
  "src/services/other-series.service.ts#notifySeriesTeachers": "`teacherId` + `extrasOf(r)`",
  "src/lib/daily-reminder.ts#groupReminders": "`teacherId` + `additionalTeachers` of each session",
  "src/services/jobs.service.ts#runWeeklyTeacherDigestJob": "the week's rows with `additionalTeachers`",
};
/** 🔴 STILL PRIMARY-ONLY — an additional teacher is NOT told. Named in TASK-512's report; this list may only SHRINK. */
// 🔻 TASK-513 — EMPTY: pause / resume / same-day rental converged; `confirmCourse` argued as named-by-design (above).
const OPEN_PRIMARY_ONLY: Record<string, string> = {};

describe("🔑 TASK-512 — every coach message, and who decides its recipients", () => {
  test("the producers found in the source are EXACTLY the classified ones — a new coach message must be classified here first", () => {
    const classified = [...VIA_PREDICATE, ...Object.keys(NAMED_BY_DESIGN), ...Object.keys(OWN_COPY_REACHES_ALL), ...Object.keys(OPEN_PRIMARY_ONLY)].sort();
    expect([...producers.keys()].sort()).toEqual(classified);
  });

  test("🔴 the class-event notices ask `teachersOfBooking` — and none looks a teacher up, or reads `teacherId`, for a recipient", () => {
    for (const key of VIA_PREDICATE) {
      const body = producers.get(key)!;
      expect({ key, asks: body.includes("teachersOfBooking(") }).toEqual({ key, asks: true });
      expect({ key, looksUp: /\.query\.teachers\.find(First|Many)/.test(body) }).toEqual({ key, looksUp: false });
      expect({ key, readsTeacherId: /recipientLineUserId: [^,]*teacher(Id)?\b/.test(body) }).toEqual({ key, readsTeacherId: false });
      expect({ key, family: body.includes('recipientType: "parent"') }).toEqual({ key, family: false }); // TASK-513 — never the family on these paths
    }
  });

  test("🔑 the known-bad list is EMPTY (TASK-513) — a primary-only coach notice now has nowhere to hide", () => {
    expect(OPEN_PRIMARY_ONLY).toEqual({});
  });

  test("📌 the ground under `confirmCourse`'s exemption: every lesson type REFUSES additional teachers (AC-20) — if this goes, so does the exemption", () => {
    const V = readSrc(readFileSync(join(root, "src/validation.ts"), "utf8"));
    expect(V).toContain('d.bookingType === "OTHER" ||');
    expect(V).toContain("d.additionalTeacherIds === undefined &&");
  });
});
