// TASK-304 (REQ-085 §7.2) — the daily schedule: BOTH shapes gain `Remark`, and only COMMAND loses a language.
//
// 🔴 §1 is a NARROWING, and the next reader will meet the wider version first: `REQ-085 §4` reads as *"the
// daily schedule must be ONE language"*, and @Porter corrected himself — **it applies to the COMMAND version
// only.** *"Format แจ้งเตือน Auto โอเคแล้วค่ะ"* ⇒ **AUTO gains one field and nothing else.**
//
// ⚠️ §4 — third message in a row where the risk is CARRYING a rule across: `Remark` here is the `*ถ้ามี` kind,
// like §7.3. 🚫 **No `(-)` on either shape** — that belongs only to §7.1's `**Advance Leave Notice`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderTodaySchedule, type TodayRow } from "./line-today-schedule";
import { renderSchedule } from "./line-schedule";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

/** A ONE-HOUR entry: no balance, no expiry — the row a coach must be able to tell from a course. */
const hour: TodayRow = {
  date: "2026-09-08",
  startTime: "10:00",
  endTime: "11:00",
  studentName: "Aiwa",
  subjectName: "Private Freeskate",
  bookingType: "SINGLE_SESSION",
  attendeeNote: "เตรียมเฉพาะ Freeskate ให้น้อง",
};
/** A COURSE entry: the two lines that tell it apart. */
const course: TodayRow = {
  ...hour,
  startTime: "13:00",
  endTime: "14:00",
  studentName: "Bee",
  bookingType: "COURSE_PACKAGE",
  size: 6,
  // 🔻 TASK-335 — the daily reminder reads the SAME `remainingLabel`, so `ครั้ง` was in THIS message too.
  remaining: "4/6",
  expiryDate: "2026-12-31",
  attendeeNote: "มาสาย 10 นาที",
};

describe("🔑 TASK-304 — AUTO: one field added, nothing else", () => {
  test("the ONE-entry shape, pinned in full", () => {
    expect(renderTodaySchedule([hour], "TH", "teacher")).toBe(
      "⏱️TODAY'S SCHEDULE:\nStudent : Aiwa\nProgram : Private Freeskate 1 HR\nDate : 2026-09-08\n" +
        "Time : 10:00-11:00\nRemark : เตรียมเฉพาะ Freeskate ให้น้อง",
    );
  });

  test("🔑 the NUMBERED shape — and `Remark` is per BOOKING, not per message", () => {
    // ⚠️ §4: the customer's own example shows two entries with DIFFERENT remarks, so a per-message note would
    // be visibly wrong. Asserted with two, carrying different text, in one render.
    const out = renderTodaySchedule([hour, course], "TH", "teacher");
    expect(out).toContain("   Remark : เตรียมเฉพาะ Freeskate ให้น้อง");
    expect(out).toContain("   Remark : มาสาย 10 นาที");
    // …each under its own numbered block, in order.
    expect(out.indexOf("1) ")).toBeLessThan(out.indexOf("เตรียมเฉพาะ"));
    expect(out.indexOf("เตรียมเฉพาะ")).toBeLessThan(out.indexOf("2) "));
    expect(out.indexOf("2) ")).toBeLessThan(out.indexOf("มาสาย"));
  });

  test("🚫 AUTO's language is UNCHANGED — the requirement that reached us first said otherwise", () => {
    // 🔴 Asserted because the next reader will meet the wider version of `§4` before this narrowing. AUTO's
    // labels were already English by `REQ-079 §18`; what matters is that nothing about its language, layout or
    // field ORDER moved in this task — only a line was appended to each entry.
    const withNote = renderTodaySchedule([hour], "TH", "teacher");
    const without = renderTodaySchedule([{ ...hour, attendeeNote: null }], "TH", "teacher");
    expect(withNote).toBe(without + "\nRemark : เตรียมเฉพาะ Freeskate ให้น้อง");
  });
});

describe("🔴 TASK-304 §3 — `Remaining` and `*Expiry date` tell a COURSE row from a one-off", () => {
  // The owner, ruling §9: *"ใช่ ไม่งั้นมันจะแยกยังไง"* — **yes, otherwise how would you tell them apart.**
  // ⇒ 🔑 the ABSENCE is the requirement. A positive-only test passes while the distinction is broken.
  test("🔑 ABSENT on a non-course entry", () => {
    const out = renderTodaySchedule([hour], "TH", "teacher");
    expect(out).not.toContain("Remaining");
    expect(out).not.toContain("Expiry date");
  });

  test("…and PRESENT on the course one, in the same render", () => {
    // Both in one message, because that is where a coach actually compares them.
    const out = renderTodaySchedule([hour, course], "TH", "teacher");
    expect(out).toContain("   Remaining : 4/6");
    expect(out).toContain("   *Expiry date : 2026-12-31");
    // 🔑 …and the one-hour block above still carries neither — asserted on the BLOCK, not the message.
    const first = out.slice(out.indexOf("1) "), out.indexOf("2) "));
    expect(first).not.toContain("Remaining");
    expect(first).not.toContain("Expiry date");
  });
});

describe("🔑 TASK-304 — COMMAND: one language, and the same `Remark`", () => {
  const row = {
    date: "2026-09-08",
    startTime: "10:00:00",
    studentName: "Aiwa",
    subjectName: "Private Freeskate",
    status: "CONFIRMED",
    attendeeNote: "เตรียมเฉพาะ Freeskate ให้น้อง",
  };

  test("the entry, pinned in full", () => {
    expect(renderSchedule([row], "EN", "today")).toBe(
      // 🔻 TASK-323 (`§16g`) — only the HEADER moved, to the customer's own form. **The rest of this pin is
      // byte-identical**, which is the point: `§16f`'s *unify the shapes* reading was withdrawn, and this
      // assertion is what proves the body did not follow the header.
      "⏱️TODAY'S SCHEDULE:\n10:00  Aiwa\n   Private Freeskate · Confirmed\n" +
        "   Remark : เตรียมเฉพาะ Freeskate ให้น้อง",
    );
  });

  test("🔴 it is sent ONCE, not once per language", () => {
    // *"แบบคำสั่งให้เป็นภาษาเดียวพอ"*. It was wrapped in `both()`, so a teacher asking for their schedule got
    // the WHOLE list twice. 🔑 Asserted at the call site, because the renderer never knew it was doubled.
    const SVC = code(src("src/services/line-webhook.service.ts"));
    expect(SVC).toContain("renderSchedule(rows, TEMPLATE_LANG, range)");
    expect(SVC).not.toContain("both((l) => renderSchedule(rows, l, range))");
  });

  test("`Remark` uses the customer's label, not the old 📝", () => {
    expect(renderSchedule([row], "EN", "today")).not.toContain("📝");
  });
});

describe("⚠️ TASK-304 §4 — the rule that must NOT have travelled: `(-)`", () => {
  test("🔑 `Remark` is absent entirely when there is no note — BOTH shapes", () => {
    expect(renderTodaySchedule([{ ...hour, attendeeNote: null }], "TH", "teacher")).not.toContain("Remark");
    expect(
      renderSchedule(
        [{ date: "2026-09-08", startTime: "10:00:00", studentName: "Aiwa", subjectName: "X", status: "CONFIRMED", attendeeNote: null }],
        "EN",
        "today",
      ),
    ).not.toContain("Remark");
  });

  test("🚫 `(-)` NEVER appears on either shape, whatever is missing", () => {
    // Third message in a row where the risk was carrying a rule across rather than forgetting one. `(-)`
    // belongs only to §7.1's `**Advance Leave Notice`, and this message has no such field.
    for (const note of [null, "", "   "]) {
      expect(renderTodaySchedule([{ ...hour, attendeeNote: note }], "TH", "teacher")).not.toContain("(-)");
      expect(
        renderSchedule(
          [{ date: "2026-09-08", startTime: "10:00:00", studentName: "A", subjectName: "X", status: "CONFIRMED", attendeeNote: note }],
          "EN",
          "today",
        ),
      ).not.toContain("(-)");
    }
  });
});
