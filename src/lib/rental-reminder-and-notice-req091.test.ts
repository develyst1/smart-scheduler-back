// TASK-375 (`REQ-091 §9`, Deploy B, T4-BE) — the teacher (and the parent) learn of a rental: (1) a `Rental :`
// line in the daily reminder, `Remark`'s twin, rendered ONCE by `rentalPrintLine`; (2) a `rental_added_teacher`
// notice ONLY when a rental is added TODAY after the reminder already went. The print rule and the reminder line
// are pinned with values (the customer's example); the notice's FORM is pinned (the stamp is a placeholder); the
// gate is pinned at the source.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rentalPrintLine, RENTAL_TIER_WORDS } from "./rental-row";
import { renderTodaySchedule, type TodayRow } from "./line-today-schedule";
import { formatOutboxMessage } from "./line-message";
import { AUDIENCE_OMITS, TEMPLATE_FIELDS } from "./line-message-fields";
import { groupReminders } from "./daily-reminder";
import { REMINDER_JOB, reminderRanOn } from "./reminder-run";
import { readSrc } from "./read-src";
import { t } from "./line-i18n";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
};

describe("🔑 the print rule — the customer's shape, one source on the BE", () => {
  test("the customer's own example, byte for byte", () => {
    expect(rentalPrintLine("rental-set", "inline skate size 18-19 CM")).toBe("Rent 200 / Full Set (inline skate size 18-19 CM)");
  });
  test("every tier: the customer's words and the card price; no remark ⇒ no parentheses; blank remark ⇒ none", () => {
    expect(rentalPrintLine("rental-helmet", null)).toBe("Rent 50 / Helmet");
    expect(rentalPrintLine("rental-pads", "")).toBe("Rent 50 / Pad");
    expect(rentalPrintLine("rental-helmet-pads", "   ")).toBe("Rent 100 / Helmet + Pad");
    expect(rentalPrintLine("rental-ride", "size 38")).toBe("Rent 150 / Ride only (size 38)");
    expect(Object.keys(RENTAL_TIER_WORDS).sort()).toEqual(["rental-helmet", "rental-helmet-pads", "rental-pads", "rental-ride", "rental-set"]);
  });
  test("an unknown code prints honestly (no price, the raw code) rather than throwing inside a message", () => {
    expect(rentalPrintLine("rental-boat", null)).toBe("Rent — / rental-boat");
  });
});

const row = (extra: Partial<TodayRow> = {}): TodayRow => ({ date: "2026-09-17", startTime: "12:00", endTime: "13:00", studentName: "มะขิด", subjectName: "Freeskate", bookingType: "COURSE_PACKAGE", size: 6, remaining: "3/6", expiryDate: "2026-12-01", coach: "Ek", ...extra });

describe("🔑 (1) the reminder line — `Remark`'s twin, after it, only when present, BOTH audiences", () => {
  test("a session with a rental ⇒ `Rental : …` right after `Remark`; without ⇒ no line, byte for byte", () => {
    const withBoth = renderTodaySchedule([row({ attendeeNote: "พาน้องมาด้วย", rental: rentalPrintLine("rental-set", "size 38") })], "TH", "teacher").split("\n");
    expect(withBoth.slice(-2)).toEqual(["Remark : พาน้องมาด้วย", "Rental : Rent 200 / Full Set (size 38)"]);
    const without = renderTodaySchedule([row({ attendeeNote: "พาน้องมาด้วย" })], "TH", "teacher");
    expect(without).toBe(withBoth.slice(0, -1).join("\n"));
    expect(renderTodaySchedule([row()], "TH", "teacher")).not.toContain("Rental");
  });
  test("a rental with no Remark ⇒ the Rental line alone, in the same position", () => {
    const lines = renderTodaySchedule([row({ rental: "Rent 50 / Helmet" })], "EN", "teacher").split("\n");
    expect(lines.at(-1)).toBe("Rental : Rent 50 / Helmet");
    expect(lines.some((l) => l.startsWith("Remark"))).toBe(false);
  });
  test("multi-entry: the line rides under ITS entry, indented like Remark", () => {
    const out = renderTodaySchedule([row({ startTime: "10:00", endTime: "11:00", studentName: "A" }), row({ studentName: "B", rental: "Rent 100 / Helmet + Pad" })], "TH", "teacher");
    expect(out).toContain("   Rental : Rent 100 / Helmet + Pad");
    const [first, second] = out.split("\n\n").slice(-2);
    expect(first).not.toContain("Rental");
    expect(second).toContain("Rental");
  });
  test("📌 the PARENT sees it too — what the omit table implies: nothing is hidden from either audience", () => {
    expect(AUDIENCE_OMITS).toEqual({ parent: [], teacher: [] });
    expect(renderTodaySchedule([row({ rental: "Rent 200 / Full Set" })], "TH", "parent")).toContain("Rental : Rent 200 / Full Set");
  });
  test("`groupReminders` carries the rendered string onto the TodayRow untouched (the job renders, the builder routes)", () => {
    const g = groupReminders([{ id: "b", date: "2026-09-17", startTime: "12:00:00", status: "CONFIRMED", studentName: "มะขิด", teacherId: "t", teacherLineUserId: "U1", studentId: "s", parentId: null, parentLineUserId: null, parentLineUserIds: [], rental: "Rent 50 / Pad" } as any]);
    expect(g[0]!.rows[0]!.rental).toBe("Rent 50 / Pad");
    const JOBS = code(src("src/services/jobs.service.ts"));
    expect(JOBS).toContain("rental: r.rental ? rentalPrintLine(r.rental.code, r.rental.remark ?? null) : null,");
    expect(JOBS).toContain("      rental: true,");
  });
});

describe("🔑 (2) the notice — `leave_notice`'s FORM, the customer's print line; the stamp is the owner's (TASK-376)", () => {
  const CTX = { studentName: "มะขิด", subject: "Freeskate", date: "2026-09-17", startTime: "12:00", endTime: "13:00", coach: "Ek" } as any;
  const render = (lang: "TH" | "EN") =>
    formatOutboxMessage({ kind: "rental_added_teacher", bookingType: "COURSE_PACKAGE", size: 6, rental: { code: "rental-set", remark: "inline skate size 18-19 CM" } } as any, CTX, lang, "teacher");

  test("the stamp's shape, the customer's block, then `Rental :` with his example", () => {
    const lines = render("TH").split("\n");
    expect(lines[0]).toMatch(/^[A-Z ]+ \/ \S+ ‼️$/); // the form
    expect(lines[0]).toBe("RENTAL ADDED / เพิ่มอุปกรณ์เช่า ‼️"); // 🔒 …and the owner's bytes (TASK-376)
    expect(lines.slice(1)).toEqual(["Student : มะขิด", "Program : Freeskate 6 HR", "Date : 17-09-2026", "Time : 12:00-13:00", "Coach : Ek", "Rental : Rent 200 / Full Set (inline skate size 18-19 CM)"]);
    expect(TEMPLATE_FIELDS.rental_added).toEqual(TEMPLATE_FIELDS.leave_notice);
  });
  test("EN: identical labels and stamp; the value is language-invariant", () => {
    expect(render("EN")).toBe(render("TH"));
  });
  test("no rental on the payload ⇒ no bare `Rental :` label", () => {
    const out = formatOutboxMessage({ kind: "rental_added_teacher" } as any, CTX, "TH", "teacher");
    expect(out).not.toContain("Rental");
  });
  test("🔒 the stamp is APPROVED and byte-frozen beside the key (TASK-376); the placeholder marker is gone; the label is the customer's section word", () => {
    const I18N = src("src/lib/line-i18n.ts");
    expect(I18N).toContain("APPROVED by the owner as drafted** — the stamp of the same-day");
    expect(I18N).not.toMatch(/PLACEHOLDER — MINE[^\n]*TASK-375/);
    expect(t("ob_rental_added_title", "TH")).toBe("RENTAL ADDED / เพิ่มอุปกรณ์เช่า ‼️");
    expect(t("ob_rental_added_title", "EN")).toBe("RENTAL ADDED / เพิ่มอุปกรณ์เช่า ‼️");
    expect(I18N).toContain('ob_f_rental: { TH: "Rental", EN: "Rental" },');
  });
});

describe("🔴 the gate — today (Bangkok) AND the reminder already ran; otherwise nothing (source)", () => {
  const SVC = code(src("src/services/rental.service.ts"));
  const GATE = () => region(SVC, "async function notifyRentalAddedSameDay(", "export async function payBookingRental(");
  test("the two conditions, in order, each returning null; then ONE teacher enqueue with the row's code + remark", () => {
    const G = GATE();
    expect(G).toContain("const today = bangkokNow().date;");
    expect(G).toContain("if (booking.date !== today) return null;");
    expect(G).toContain("if (!(await reminderRanOn(today))) return null;");
    expect(G.indexOf("booking.date !== today")).toBeLessThan(G.indexOf("reminderRanOn(today)"));
    expect((G.match(/enqueueLine\(/g) ?? []).length).toBe(1);
    expect(G).toContain('recipientType: "teacher"');
    expect(G).toContain('kind: "rental_added_teacher"');
    expect(G).toContain("rental: { code: row.code, remark: row.remark }");
    expect(G).toContain("recipientLineUserId: coach.lineUserId ?? null,"); // unlinked ⇒ SKIPPED by enqueueLine — 🔻 TASK-513: per coach (every coach of the session)
    expect(G).toContain("for (const coach of await teachersOfBooking(db, booking.id)) {");
  });
  test("called ONLY from the session-rental writer, after the row is written; not from paid, remove, the course create or the reconcile", () => {
    const REC = region(SVC, "export async function recordBookingRental(", "async function notifyRentalAddedSameDay(");
    expect(REC).toContain("await notifyRentalAddedSameDay(booking, row);");
    expect(REC.indexOf("notifyRentalAddedSameDay")).toBeGreaterThan(REC.indexOf(".insert(bookingRentals)"));
    expect((SVC.match(/notifyRentalAddedSameDay\(/g) ?? []).length).toBe(2); // the definition + the one call
    const SCHED = code(src("src/services/scheduler.service.ts"));
    expect(SCHED).not.toContain("rental_added_teacher");
    const PAY = region(SVC, "export async function payBookingRental(", "export async function removeBookingRental(");
    expect(PAY).not.toContain("rental_added");
  });
  test("the predicate moved to `lib/reminder-run.ts` (the import-cycle reason), same read: the job's rows on that date, `attempted === true`", () => {
    expect(REMINDER_JOB).toBe("daily-reminder");
    expect(typeof reminderRanOn).toBe("function");
    const RUN = code(src("src/lib/reminder-run.ts"));
    expect(RUN).toContain("and(eq(jobRuns.job, REMINDER_JOB), eq(jobRuns.runDate, runDate))");
    expect(RUN).toContain("attempted === true");
    const JOBS = code(src("src/services/jobs.service.ts"));
    expect(JOBS).toContain("const reminderRanToday = (runDate: string): Promise<boolean> => reminderRanOn(runDate);");
    expect(JOBS).not.toContain("from(jobRuns)\n    .where(and(eq(jobRuns.job, REMINDER_JOB)");
    // and no cycle: rental.service imports the lib, never jobs.service
    expect(SVC).toContain('from "../lib/reminder-run"');
    expect(SVC).not.toContain("jobs.service");
  });
});
