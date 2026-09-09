// TASK-284 (REQ-085 §3 / §7.1) — the three fixes the owner ruled on the COURSE-level `CONFIRMED SCHEDULE`.
//
// 🔻 (a) is a limitation I wrote down and chose not to fix, failing in front of the owner: `note` read
// `rows[0]?.attendeeNote`, the EARLIEST session's note, so a note put on any other session rendered nothing.
// **The record was accurate and the decision was wrong.**
//
// 🔴 §8.1 — THE TRAP, and it is the easiest mistake in the batch: **two OPPOSITE empty-field rules, both at the
// bottom of THIS message.** `**Advance Leave Notice` ALWAYS prints, showing `(-)`; `Remark` does not print at
// all. ⚠️ They get SEPARATE assertions below, because one "empty fields" test cannot catch a swap — and a swap
// is invisible to every reader who has not read that table.
import { describe, expect, test } from "bun:test";
import { formatOutboxMessage } from "./line-message";
import { TEMPLATE_LANG, TEMPLATE_NONE } from "./line-message-fields";
import { courseNote } from "./course-plan";

const COURSE = {
  kind: "course_confirmed",
  studentName: "น้องดีซี",
  subject: "Private Freeskate",
  bookingType: "COURSE_PACKAGE",
  size: 6,
  expiryDate: "2026-12-31",
  coach: "ครูหนึ่ง",
  startDate: "2026-09-06",
  weekday: 0, // a Sunday
  startTime: "10:00",
  endTime: "11:00",
  plannedLeaveDates: ["2026-09-14"],
  note: "เตรียมเฉพาะ Freeskate ให้น้อง",
} as any;
const render = (o: Record<string, unknown> = {}, lang: "TH" | "EN" = "TH") =>
  formatOutboxMessage({ ...COURSE, ...o }, {}, lang, "parent");
const lineOf = (msg: string, label: string) =>
  msg.split("\n").find((l) => l.startsWith(`${label} : `));

describe("🔴 TASK-284 §8.1 — the trap: two OPPOSITE rules, asserted SEPARATELY", () => {
  test("🔑 `**Advance Leave Notice` ALWAYS prints — `(-)` when there is none", () => {
    // The owner's reason IS the acceptance criterion: a field that vanishes when empty is indistinguishable
    // from a field that was never sent. `(-)` is the parent being told *we checked, and there is none.*
    expect(lineOf(render({ plannedLeaveDates: [] }), "**Advance Leave Notice")).toBe(
      "**Advance Leave Notice : (-)",
    );
    // …and a payload that never carried the field at all behaves the same, rather than crashing.
    const { plannedLeaveDates: _d, ...missing } = COURSE;
    expect(formatOutboxMessage(missing, {}, "TH", "parent")).toContain("**Advance Leave Notice : (-)");
  });

  test("🔑 `Remark` is ABSENT — the whole line — when there is no note", () => {
    // ⚠️ The opposite rule, and asserted on its own so a swap between the two fails here. An absent `Remark`
    // is an admin with nothing to say; a missing leave notice is something a parent must trust we checked.
    const out = render({ note: null });
    expect(lineOf(out, "Remark")).toBeUndefined();
    expect(out).not.toContain("Remark");
    // 🚫 …and the leave line above it still prints, in the SAME message — which is the swap this catches.
    expect(out).toContain("**Advance Leave Notice :");
  });

  test("…and with BOTH empty, one line survives and the other does not", () => {
    const out = render({ note: null, plannedLeaveDates: [] });
    expect(out).toContain("**Advance Leave Notice : (-)");
    expect(out).not.toContain("Remark");
  });
});

describe("TASK-284 (b) — `Date` is an ENGLISH WEEKDAY", () => {
  test("🔑 asserted by the WORD, on a known date", () => {
    // `REQ-079 §18` already ruled notification labels English; `Date : อังคาร` was that ruling never applied to
    // a value. ⚠️ `Date` names a WEEKDAY, not a date — `REQ-085 §8.3` calls that out as surprising the first
    // time you build it, and `§7.3` does the same, so it is the product's convention rather than a quirk.
    expect(lineOf(render(), "Date")).toBe("Date : Sunday");
    expect(lineOf(render({ weekday: 2 }), "Date")).toBe("Date : Tuesday");
  });

  test("…in BOTH languages — the weekday is a value WE generate", () => {
    expect(lineOf(render({}, "EN"), "Date")).toBe("Date : Sunday");
    expect(lineOf(render({}, "TH"), "Date")).toBe("Date : Sunday");
  });
});

describe("🔑 TASK-284 — 'English' means LABELS and SYSTEM values. Never a human's words.", () => {
  test("🔴 a Thai student name and a Thai `Remark` are byte-identical to what was typed", () => {
    // ⚠️ This is the assertion that stops "English only" being applied to a human's words. Read literally,
    // *"eng ล้วน"* would romanise `น้องดีซี` and translate `เตรียมเฉพาะ Freeskate ให้น้อง` — and the customer's
    // own examples keep both in Thai. **Translating a Remark is putting words in an admin's mouth.**
    const out = render();
    expect(lineOf(out, "Student")).toBe("Student : น้องดีซี");
    expect(lineOf(out, "Remark")).toBe("Remark : เตรียมเฉพาะ Freeskate ให้น้อง");
    // …and the same in the EN rendering, because a human's words have no language switch.
    expect(lineOf(render({}, "EN"), "Remark")).toBe("Remark : เตรียมเฉพาะ Freeskate ให้น้อง");
  });

  test("📌 the convention has ONE definition site, ready to become a row for `REQ-086`", () => {
    // 🚫 Not a template store — one constant each, named where the customer's labels and separator already
    // live. The customer will edit these messages themselves, and `§7.1`'s text becomes the shipped default.
    expect(TEMPLATE_LANG).toBe("EN");
    expect(TEMPLATE_NONE).toBe("(-)");
  });

  test("⇒ the whole message is now language-INVARIANT, and that is the ruling rather than an accident", () => {
    // Everything left in it is either a label, a value we generate, or a human's own words — so there is
    // nothing to translate. 🔑 Asserted so a translation creeping back into any of those fails here.
    expect(render({}, "TH")).toBe(render({}, "EN"));
  });
});

describe("🔑 TASK-284 (a) — the COURSE's note, not the earliest session's", () => {
  // Rows arrive in date order (`loadCourseForEnd` orders `asc(date), asc(startTime)`), which is what makes
  // "earliest" mean anything at all.
  const s = (attendeeNote: string | null) => ({ attendeeNote });

  test("🔴 the owner's exact case: a note on a LATER session RENDERS", () => {
    // He put a note on a session that was not the earliest, confirmed the course, and got no `Remark`.
    expect(courseNote([s(null), s(null), s("23232sssss")])).toBe("23232sssss");
  });

  test("✅ a note on EVERY session renders that string — the normal path, unchanged", () => {
    // TASK-178 puts one note at creation onto every session, so `rows[0]` and this agree here. That is why
    // the defect could sit in production: the common path never exercised the difference.
    expect(courseNote([s("แพ้ถั่ว"), s("แพ้ถั่ว"), s("แพ้ถั่ว")])).toBe("แพ้ถั่ว");
  });

  test("⚠️ DIFFERING notes print the EARLIEST — a rule, not a guess", () => {
    // 🚫 Not several, not joined, no "and 2 more". A course summary has no true answer to *which session's
    // note*, and the earliest is at least a rule rather than an accident.
    expect(courseNote([s("first"), s("second"), s("third")])).toBe("first");
  });

  test("🚫 whitespace is not a note — and no note anywhere is `null`", () => {
    // The omit-empty rule downstream turns `null` into an absent line; a blank string would have printed
    // `Remark : ` — a label with nothing after it, which TASK-219 established reads as information that went
    // missing.
    expect(courseNote([s("   "), s("\n"), s("real")])).toBe("real");
    expect(courseNote([s(null), s("  ")])).toBeNull();
    expect(courseNote([])).toBeNull();
  });
});
