// TASK-271 — a paused session reached a teacher's `ตาราง` and rendered as the literal `status_PAUSED`.
//
// ## Two defects, one shape
// 1. `line-i18n.ts` had SIX `status_*` keys against a database enum of NINE, and `t()` returns the KEY on a
//    miss — correctly, for genuinely dynamic keys. ⇒ a coach read `status_PAUSED`.
// 2. `checkin.service.ts` filtered `ne(b.status, "CANCELLED")` — one status, hand-written — so the paused row
//    was in the reply at all.
//
// 🔴 `CALENDAR_HIDDEN_STATUSES`'s own comment names this bug in these words: *"a hand-written exclusion of one
// status is exactly how the next status gets missed."* TASK-260 wrote that sentence, fixed the instance it
// found, and an identical line survived in another file.
//
// ⚠️ **The real control is the COMPILER, not this file.** `STATUS_LABELS` is a `Record<BookingStatus, Entry>`,
// so the next `ALTER TYPE … ADD VALUE` fails the build. What is asserted here is the CONSEQUENCE — that no
// status can reach a phone as a raw key — enumerated from the DB enum so it cannot become a second copy.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./line-i18n";
import { renderSchedule } from "./line-schedule";
import { bookingStatus, CALENDAR_HIDDEN_STATUSES } from "../db/schema";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("TASK-271 — no status can render as a raw key", () => {
  test("🔑 EVERY value of the DB enum has a label, in both languages — read from the enum", () => {
    // Enumerated, not listed: a hand-written list here would be exactly the fifth copy this task removes.
    for (const status of bookingStatus.enumValues) {
      for (const lang of ["TH", "EN"] as const) {
        const label = t(`status_${status}`, lang);
        // The defect, stated as its symptom: `t()` returns the KEY when there is no entry.
        expect({ status, lang, label }).not.toEqual({ status, lang, label: `status_${status}` });
        expect(label.startsWith("status_")).toBe(false);
        expect(label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("🔴 the three that had no label — PAUSED, PENDING_RESCHEDULE, CANCELLED", () => {
    // Named as well as covered by the loop: `PAUSED` is @Tanya's incident and `PENDING_RESCHEDULE` is the one
    // that had been rendering as jargon for far longer without anyone reporting it.
    expect(t("status_PAUSED", "TH")).toBe("พัก");
    expect(t("status_PAUSED", "EN")).toBe("Paused");
    expect(t("status_PENDING_RESCHEDULE", "TH")).toBe("รอย้ายคาบ");
    expect(t("status_CANCELLED", "TH")).toBe("ยกเลิก");
  });

  test("⚠️ the PENDING_RESCHEDULE label is marked as a PLACEHOLDER in the source", () => {
    // §5 — it is not the customer's word and @Porter is asking. The comment is what stops the next reader
    // treating it as ratified, so the comment is part of the deliverable.
    const raw = src("src/lib/line-i18n.ts");
    const at = raw.indexOf("PENDING_RESCHEDULE:");
    expect(raw.slice(Math.max(0, at - 600), at)).toContain("PLACEHOLDER, @Porter is asking the customer");
  });

  test("🚫 `t()`'s defensive fall-through is untouched — it is right for genuinely dynamic keys", () => {
    expect(t("some_key_that_does_not_exist")).toBe("some_key_that_does_not_exist");
  });

  test("🔑 the labels come from ONE exhaustive map, not from loose table entries", () => {
    const c = code(src("src/lib/line-i18n.ts"));
    expect(c).toContain("const STATUS_LABELS: Record<BookingStatus, Entry> = {");
    expect(c).toContain("...STATUS_LABEL_ENTRIES,");
    // The old shape must not come back: a loose `status_X:` line in the table would be outside the Record and
    // therefore outside the compiler's question.
    expect(c).not.toMatch(/^\s*status_[A-Z_]+:/m);
  });
});

describe("TASK-271 — a paused session leaves the teacher's schedule", () => {
  const row = (status: string) => ({
    date: "2026-09-10",
    startTime: "10:00",
    studentName: "น้องเอ",
    subjectName: "Freeskate",
    status,
    attendeeNote: null,
  });

  test("🔴 the filter is CALENDAR_HIDDEN_STATUSES, not a hand-written CANCELLED", () => {
    const c = code(src("src/services/checkin.service.ts"));
    expect(c).toContain("notInArray(b.status, [...CALENDAR_HIDDEN_STATUSES])");
    expect(c).not.toContain('ne(b.status, "CANCELLED")');
    // 🚫 And no sixth list was invented to say the same thing.
    expect(c).not.toContain("TEACHER_SCHEDULE_HIDDEN");
  });

  test("📌 CANCELLED's behaviour is UNCHANGED — it was hidden before and it is hidden now", () => {
    // The reused list contains it, so the one row that was already excluded still is. A fix that quietly
    // started showing cancelled classes to coaches would be a worse defect than the one being fixed.
    expect([...CALENDAR_HIDDEN_STATUSES]).toContain("CANCELLED");
    expect([...CALENDAR_HIDDEN_STATUSES]).toContain("PAUSED");
    expect(CALENDAR_HIDDEN_STATUSES.length).toBe(2);
  });

  test("🔑 …and PENDING_RESCHEDULE stays VISIBLE, with a readable label", () => {
    // §5 — its move has not been accepted, so the coach is still rostered for the original slot. Hiding it
    // would remove a class that may well happen. Rendered here rather than argued: this is what a coach sees.
    const out = renderSchedule([row("PENDING_RESCHEDULE")], "TH", "today");
    expect(out).toContain("รอย้ายคาบ");
    expect(out).not.toContain("status_");
  });

  test("🔴 a paused row would render readably if it ever reached the composer", () => {
    // Belt and braces: the query is what keeps it out, but a raw key must not be the fallback if some other
    // caller ever hands `renderSchedule` one. The two defects were independent and so are their fixes.
    const out = renderSchedule([row("PAUSED")], "TH", "today");
    expect(out).toContain("พัก");
    expect(out).not.toContain("status_PAUSED");
  });
});
