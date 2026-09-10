// TASK-344 (`REQ-087 §7`) — every rendered DATE is `DD-MM-YYYY`. Owner: *"เอา แก้ให้เป็น 08-09-2026 เหมือนกันทุกที่"*.
//
// 🔑 **ONE assertion per LIVE message, in one place**, because the defect this file exists to prevent is not a
// wrong date in one message — it is **two messages in one conversation disagreeing about what a date looks
// like.** ⇒ *a per-message test cannot see that; this one can.*
//
// 🔻 It is the FIFTH application of `ddmmyyyy` in three days, each time to the message somebody happened to be
// looking at. **That is the finding, and it is on the owner's list, not in this file.**
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { renderTodaySchedule, type TodayRow } from "./line-today-schedule";
import { ddmmyyyy } from "./time";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const ISO = "2026-09-08"; // a Tuesday
const DMY = "08-09-2026";
const ctx = {
  studentName: "น้องเอ", subject: "Freeskate", date: ISO,
  startTime: "10:00", endTime: "11:00", coach: "Ek", teacherNickname: "Ek",
} as any;
const render = (payload: Record<string, unknown>, audience: "parent" | "teacher" = "parent") =>
  formatOutboxMessage(payload as any, ctx, "TH", audience);

describe("🔴 TASK-344 — every LIVE message that names a date names it as `DD-MM-YYYY`", () => {
  /** kind → the payload it needs. The audience matters only where a field is family-private. */
  const LIVE: Array<[string, Record<string, unknown>, ("parent" | "teacher")?]> = [
    ["booking_confirmed (§7.3)", { kind: "booking_confirmed", bookingType: "SINGLE_SESSION" }],
    ["leave_notice (§9.1)", { kind: "leave_notice", bookingType: "COURSE_PACKAGE", size: 6 }, "teacher"],
    ["course_deduction", { kind: "course_deduction", bookingType: "COURSE_PACKAGE", total: 6, remaining: "2/6 HR" }],
    ["booking_paused", { kind: "booking_paused" }],
    ["booking_resumed", { kind: "booking_resumed" }],
    // 🔻 THE TWO NEITHER LIST FOUND. ⚠️ **Their date is not in a `date:` field** — it is interpolated into a
    // combined `Time` value — so a sweep grepping the field name walks past them. Both are LIVE.
    ["teacher_assigned (TASK-094)", { kind: "teacher_assigned" }, "teacher"],
    ["teacher_unassigned (TASK-094)", { kind: "teacher_unassigned" }, "teacher"],
  ];

  test("🔑 all five render the date in ONE format", () => {
    for (const [name, payload, audience] of LIVE) {
      const out = render(payload, audience ?? "parent");
      expect({ name, dmy: out.includes(DMY) }).toEqual({ name, dmy: true });
    }
  });

  test("🚫 …and NOT ONE of them lets the raw ISO reach a reader", () => {
    // ⚠️ **The absence is the half worth asserting**: a message could gain the new format and keep the old one
    // somewhere else in the same block, and every positive above would still pass.
    for (const [name, payload, audience] of LIVE) {
      const out = render(payload, audience ?? "parent");
      expect({ name, iso: out.includes(ISO) }).toEqual({ name, iso: false });
    }
  });

  test("🔴 the AUTO daily schedule too — the instance the OWNER actually saw", () => {
    // 📌 The message a coach reads every morning, and the only place a reader met the machine's own format.
    const row: TodayRow = {
      date: ISO, startTime: "10:00", endTime: "11:00", studentName: "Aiwa",
      subjectName: "Freeskate", bookingType: "SINGLE_SESSION", status: "CONFIRMED",
    } as any;
    const out = renderTodaySchedule([row], "TH", "teacher");
    expect(out).toContain(`Date : ${DMY}`);
    expect(out).not.toContain(ISO);
  });

  test("📌 it is `time.ts`'s ONE helper — not a second date function", () => {
    expect(ddmmyyyy(ISO)).toBe(DMY);
    // 🚫 …and a value that is not an ISO date passes through UNCHANGED, which is what lets it sit inside the
    // daily schedule's `dash()` guard without swallowing the empty case.
    expect(ddmmyyyy("")).toBe("");
    expect(ddmmyyyy("   ")).toBe("   ");
    expect(code(src("src/lib/line-today-schedule.ts"))).toContain("date: dash(ddmmyyyy(r.date)),");
  });
});

describe("🚫 TASK-344 §2 — THE BOUNDARIES. Two things `ทุกที่` does NOT reach, and WHY", () => {
  test("🔴 `§7.1`'s course-wide `Date` is still a WEEKDAY — @Porter: *a WEEKDAY IS NOT A DATE*", () => {
    // 🔑 **`REQ-085 §15` is the OWNER'S OWN ruling** and he re-affirmed it by keeping `§7.1` out of `§6b`.
    // ⇒ ***"every date is `DD-MM-YYYY`" is about FORMAT; it does not turn a weekday into a date.***
    // ⚠️ Asserted HERE, in the sweep's own file, because a sweep is exactly where a rule like this gets lost.
    //
    // 🔻 **AND IT IS RENDERED WITH A FULL `ctx`, WHICH IS THE WHOLE POINT.** My first version passed `{}` —
    // ***and a mutation that made `§7.1` read `ctx.date` PASSED,*** because with no date in `ctx` the sweep's
    // own ternary fell straight back to the weekday. 🔴 **The guard guarded nothing.**
    // 🔑 A real `§7.1` message is enriched from the booking the row points at, so **`ctx.date` IS present in
    // production** — *the case I had left out was the only case that could fail.*
    const course = (c: Record<string, unknown>) =>
      formatOutboxMessage(
        { kind: "course_confirmed", studentName: "น้องเอ", subject: "Freeskate", bookingType: "COURSE_PACKAGE", size: 6, weekday: 2, plannedLeaveDates: [] } as any,
        c as any, "TH", "parent",
      );
    for (const [name, c] of [["enriched ctx (the PRODUCTION shape)", ctx], ["bare ctx", {}]] as const) {
      const out = course(c);
      expect({ name, weekday: out.includes("Date : Tuesday") }).toEqual({ name, weekday: true });
      expect({ name, dmy: out.includes(DMY) }).toEqual({ name, dmy: false });
      expect({ name, iso: out.includes(ISO) }).toEqual({ name, iso: false });
    }
    // 🚫 …and the branch reads `payload.weekday`, NOT `ctx.date` — asserted at the source, because that is
    // the fact the two renderings above depend on.
    expect(code(src("src/lib/line-message.ts"))).toContain("payload.weekday != null ? t(`ob_dow_${payload.weekday}`, TEMPLATE_LANG) : undefined");
  });

  test("🔴 the PICKER and the weekly HEADING are UNTOUCHED — a PENDING QUESTION, not an oversight", () => {
    // 🔑 `line-leave.ts` and `line-schedule.ts` both render **`อังคาร 22/09` — a WEEKDAY *plus* a date
    // fragment.** ⚠️ **That is a THIRD thing: neither a weekday nor `DD-MM-YYYY`, and it was CHOSEN.**
    // 📌 TASK-316 decided the picker's form deliberately and TASK-318 said in as many words that `§16d`'s
    // format must NOT be used there — ***"two surfaces, two audiences, two formats, both right"*** — and
    // @Sober ratified it.
    // ⇒ 🔴 ***`ทุกที่` either REVERSES a ratified decision or does not reach them, and neither @Sober nor I is
    // deciding which.*** **It is with @Porter.**
    // ✅ **Asserted as an ABSENCE so the next reader sees a pending question rather than an oversight** — and
    // so that whoever answers it changes this test on purpose.
    for (const f of ["src/lib/line-leave.ts", "src/lib/line-schedule.ts"]) {
      expect({ f, uses: code(src(f)).includes("ddmmyyyy") }).toEqual({ f, uses: false });
    }
    expect(src("src/lib/line-schedule.ts")).toContain("dayHeading");
  });
});

describe("⚪ TASK-344 — the two DEAD branches, fixed anyway and NAMED as dead", () => {
  test("🚫 `sick_leave` and `leave_teacher` have NO PRODUCER — nothing observable changed", () => {
    // 🔑 **A dead branch rendering the OLD format is a trap for whoever revives it**: they would ship the one
    // message in the product that disagrees about dates, having changed nothing.
    // 📌 Their deadness is asserted at the SOURCE, so this claim cannot quietly stop being true.
    const SVC = src("src/services/scheduler.service.ts");
    // 🔻 `reschedule_requested` joins them: also dead, also fixed, and it carried the ISO TWICE.
    for (const kind of ["sick_leave", "leave_teacher", "reschedule_requested"]) {
      expect({ kind, produced: SVC.includes(`kind: "${kind}"`) }).toEqual({ kind, produced: false });
      expect({ kind, dmy: render({ kind, studentName: "น้องซี", via: "line" }).includes(DMY) }).toEqual({ kind, dmy: true });
    }
  });
});
