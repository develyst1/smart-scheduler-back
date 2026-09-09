// TASK-316 (`REQ-085 §14`) — `ลา` scanned ONE DAY, and the picker labelled a session by its RECURRING attributes.
//
// 🔑 The flow the owner asked for already existed: scan → which child → which session, with a question skipped
// when it has one answer. **The only thing wrong was the WINDOW**, one day wide — *"a parent whose child has a
// class on THURSDAY is told, on Tuesday, that there is nothing to do"*.
//
// 🔴 And the widening CREATES a defect unless the label moves with it: `time · teacher · program` was correct
// only while the date was implied by the question. **One weekly course becomes three identical rows.** That is
// `§15`'s defect on the parent's side, arriving BEFORE the act rather than after it — so both halves are
// asserted here, together.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { childrenWithSessions, needsChildStep, sessionLabel, sessionPick, shortDate, type LeaveSession } from "./line-leave";
import { hasEnoughLeaveNotice } from "./leave-notice";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));
const CHECKIN_SVC = code(src("src/services/checkin.service.ts"));
const fn = (sig: string) => {
  const i = SVC.indexOf(sig);
  if (i < 0) throw new Error("no " + sig);
  return SVC.slice(i, SVC.indexOf("\n}\n", i));
};

/** One weekly course: the same time, teacher and program, three Tuesdays running. */
const tuesday = (date: string, id: string): LeaveSession => ({
  id,
  studentId: "s1",
  date,
  startTime: "15:00:00",
  student: { name: "มิลล่า" },
  teacher: { nickname: "Bank" },
  subject: { name: "Skateboard" },
});
const WEEKLY = [tuesday("2026-09-15", "b1"), tuesday("2026-09-22", "b2"), tuesday("2026-09-29", "b3")];

describe("🔴 TASK-316 §2 — two sessions of the SAME weekly course are DISTINGUISHABLE", () => {
  test("🔴 the old label CANNOT tell them apart — the defect the widening would otherwise create", () => {
    // Asserted first and on purpose: it is the reason this task is not just a `where` clause.
    const rows = WEEKLY.map((b) => sessionLabel(b, "TH"));
    expect(new Set(rows).size).toBe(1); // three rows, one string
  });

  test("🔑 …and the picker's rows ARE distinct — asserted on the rendered strings, both forms", () => {
    const buttons = WEEKLY.map((b) => sessionPick(b, "TH").button);
    const bodies = WEEKLY.map((b) => sessionPick(b, "TH").body);
    expect(new Set(buttons).size).toBe(3);
    expect(new Set(bodies).size).toBe(3);
    expect(buttons).toEqual(["15/09 15:00", "22/09 15:00", "29/09 15:00"]);
  });

  test("🔑 the BODY names the date in full — weekday first, then the date that tells one Tuesday from the next", () => {
    expect(sessionPick(WEEKLY[1]!, "TH").body).toBe("อังคาร 22/09 · 15:00 · ครูBank · Skateboard");
    expect(sessionPick(WEEKLY[1]!, "EN").body).toBe("Tuesday 22/09 · 15:00 · Bank · Skateboard");
  });

  test("🔴 §3 — the BUTTON fits LINE's 20 characters, and the old label did NOT", () => {
    // ⚠️ The decision, asserted rather than described: `time · teacher · program` already overflows, so a
    // prepended date would have been eaten at one end. The button carries the pair that distinguishes the rows.
    expect(sessionLabel(WEEKLY[0]!, "TH").length).toBeGreaterThan(20);
    for (const b of WEEKLY) {
      for (const lang of ["TH", "EN"] as const) {
        expect({ date: b.date, lang, len: sessionPick(b, lang).button.length }).toEqual({
          date: b.date,
          lang,
          len: 11,
        });
      }
    }
    // 🚫 …and the date in it is whole. A half-printed date looks like information.
    expect(shortDate("2026-09-22")).toBe("22/09");
  });

  test("🚫 check-in and `qr` keep the OLD label — they really are today-only lists", () => {
    // A date on a today-only picker is noise, not information. The date form is reached only for `leave`.
    const picker = fn("function sessionPicker(");
    expect(picker).toContain('const dated = action === "leave" ? sessionPick(b, lang) : null;');
    expect(picker).toContain("dated?.button ?? label");
    expect(picker).toContain("dated?.body ?? label");
  });
});

describe("🔑 TASK-316 §4(a) — the window is UPCOMING, and the owner's sentence is executable", () => {
  test("🔴 a class on THURSDAY can be cancelled on TUESDAY — the query asks for `>= today`, not `= today`", () => {
    // 🔴 THE LOAD-BEARING LINE, and my first version of this file did not pin it: narrowing `leavableSessions`
    // back to `findTodayBookingsForParent` left all 21 assertions GREEN. **The whole widening rests on which
    // query this one function calls**, so it is asserted before the query's own shape.
    expect(fn("async function leavableSessions(")).toContain(
      "const upcoming = await findUpcomingBookingsForParent(lineUserId, date);",
    );
    expect(fn("async function leavableSessions(")).not.toContain("findTodayBookingsForParent");
    expect(CHECKIN_SVC).toContain("export async function findUpcomingBookingsForParent(lineUserId: string, fromDate: string)");
    const upcoming = CHECKIN_SVC.slice(CHECKIN_SVC.indexOf("export async function findUpcomingBookingsForParent"));
    expect(upcoming).toContain("and(gte(b.date, fromDate), eq(b.status, \"CONFIRMED\"), inArray(b.studentId, ids))");
    // Soonest first, so the list reads as a diary and the 12 LINE can show are the 12 that matter.
    expect(upcoming).toContain("orderBy: (b, { asc }) => [asc(b.date), asc(b.startTime)],");
  });

  test("🚫 check-in and `qr` still look at TODAY — the widening is the leave flow's, not everyone's", () => {
    expect(CHECKIN_SVC).toContain("export async function findTodayBookingsForParent(lineUserId: string, date: string)");
    for (const flow of ["async function doCheckin(", "async function doQr("]) {
      expect(fn(flow)).toContain("findTodayBookingsForParent(lineUserId, date)");
    }
  });

  test("🔑 WHO the family is cannot differ between the two windows — one resolver, both queries", () => {
    // The window is the only thing that may differ. TASK-259's lesson, extracted the moment there were two.
    expect(CHECKIN_SVC).toContain("async function linkedStudentIds(lineUserId: string): Promise<string[]>");
    expect(CHECKIN_SVC.match(/const ids = await linkedStudentIds\(lineUserId\);/g)!.length).toBe(2);
    expect(CHECKIN_SVC.match(/findParentByLineUserId\(lineUserId\)/g)!.length).toBe(1);
  });
});

describe("🔴 TASK-316 §4(b) — a session inside the cut-off is NOT OFFERED, by the write's own helper", () => {
  test("🔑 the SAME helper the write refuses with — not a second copy of the rule", () => {
    const decide = fn("async function leavableSessions(");
    expect(decide).toContain("if (hasEnoughLeaveNotice(b.date, b.startTime, cutoffs.get(type)!)) eligible.push(b);");
    // …and it is the one the write throws LEAVE_NOTICE_TOO_LATE from (`§12.2` keeps that refusal).
    const WRITE = code(src("src/services/scheduler.service.ts"));
    expect(WRITE).toContain("if (!hasEnoughLeaveNotice(b.date, b.startTime, cutoffHours))");
    expect(WRITE).toContain('throw conflict("LEAVE_NOTICE_TOO_LATE"');
  });

  test("the cut-off is resolved per TEACHER TYPE, like the write — and once per type, not once per row", () => {
    const decide = fn("async function leavableSessions(");
    expect(decide).toContain('const type = (b as any).teacher?.type ?? "FULL_TIME";');
    expect(decide).toContain("if (!cutoffs.has(type)) cutoffs.set(type, Number((await getSetting(leaveCutoffKey(type))).value));");
  });

  test("🔑 the rule itself, on the boundary — `>=` is still allowed (AC-3)", () => {
    const now = { date: "2026-09-10", minutes: 9 * 60 }; // 09:00
    expect(hasEnoughLeaveNotice("2026-09-10", "15:00:00", 6, now as any)).toBe(true); // exactly 6h — allowed
    expect(hasEnoughLeaveNotice("2026-09-10", "14:00:00", 6, now as any)).toBe(false); // 5h — refused
    expect(hasEnoughLeaveNotice("2026-09-17", "15:00:00", 6, now as any)).toBe(true); // next week — offered
  });
});

describe("🔴 TASK-316 §4(c) — ONE source, every caller: a pick outside TODAY must not fail authorization", () => {
  test("🔑 all three callers read the same list", () => {
    // ⚠️ @Sober named two; the typed `ลา <n>` twin was a THIRD. A number must mean the same session on a phone
    // and on a PC, and the picker is what a parent counted.
    for (const caller of ["async function doLeave(", "async function doLeaveBooking("]) {
      expect(fn(caller)).toContain("await leavableSessions(lineUserId, date)");
    }
    const typed = SVC.slice(SVC.indexOf("const leaveMatch = cmd.match("));
    expect(typed.slice(0, typed.indexOf("\n  }"))).toContain("const { eligible } = await leavableSessions(lineUserId, date);");
    // 🚫 And no leave path reads the old one-day window any more.
    for (const caller of ["async function doLeave(", "async function doLeaveBooking("]) {
      expect(fn(caller)).not.toContain("findTodayBookingsForParent");
    }
  });

  test("🔑 the authorization IS the same list — the booking must be in `eligible`, not merely CONFIRMED", () => {
    const book = fn("async function doLeaveBooking(");
    expect(book).toContain("const b = eligible.find((x) => x.id === bookingId);");
    // Before this, a row could pass `status === "CONFIRMED"` and still be outside the offered window.
    expect(book).not.toContain('x.status === "CONFIRMED"');
  });
});

describe("🔴 TASK-316 §4(d) — the empty message became TRUE, and there are TWO of them", () => {
  test("🔑 nothing upcoming and everything-inside-the-cutoff are DIFFERENT sentences", () => {
    // The owner's distinction: *"too late for tomorrow's class, call the school" is help; "no class eligible"
    // is a shrug.* A parent could be TOO EARLY and TOO LATE and read the same line.
    expect(SVC).toContain('textReply(upcoming.length ? tb("empty_leave_cutoff") : tb("empty_leave"), lang)');
    const { t } = require("./line-i18n");
    expect(t("empty_leave", "TH")).not.toBe(t("empty_leave_cutoff", "TH"));
    expect(t("empty_leave", "EN")).not.toBe(t("empty_leave_cutoff", "EN"));
  });

  test("🚫 neither sentence says TODAY any more — that is what made the old one untrue", () => {
    const { t } = require("./line-i18n");
    for (const key of ["empty_leave", "empty_leave_cutoff"]) {
      expect(t(key, "TH")).not.toContain("วันนี้");
      expect(t(key, "EN").toLowerCase()).not.toContain("today");
    }
  });

  test("🚫 the cut-off sentence names no NUMBER — the hours are a per-teacher-type setting", () => {
    // A hardcoded "6 hours" would be a second copy of a rule that lives in `app_settings`.
    const { t } = require("./line-i18n");
    for (const lang of ["TH", "EN"] as const) expect(t("empty_leave_cutoff", lang)).not.toMatch(/[0-9]/);
  });

  test("📌 both point somewhere — a refusal that names no way forward is a shrug", () => {
    const { t } = require("./line-i18n");
    expect(t("empty_leave_cutoff", "TH")).toContain("แอดมิน");
    expect(t("empty_leave_cutoff", "EN").toLowerCase()).toContain("admin");
  });
});

describe("🚫 TASK-316 §5 — what must not change", () => {
  test("the child step still asks only when ≥2 children have an eligible session (AC-3/AC-5)", () => {
    const twoKids = [WEEKLY[0]!, { ...WEEKLY[1]!, studentId: "s2", student: { name: "มิลลิม" } }];
    expect(needsChildStep(WEEKLY)).toBe(false); // one child, three sessions → straight to the session picker
    expect(needsChildStep(twoKids)).toBe(true);
    expect(childrenWithSessions(WEEKLY)).toEqual([{ studentId: "s1", name: "มิลล่า" }]);
  });

  test("the one-session shortcut is unchanged — a question with one answer is not a question", () => {
    expect(fn("async function doLeave(")).toContain(
      "if (eligible.length === 1) return doLeaveBooking(lineUserId, eligible[0]!.id, replyToken, date, lang);",
    );
  });

  test("🚫 `LEAVE_NOTICE_TOO_LATE` still refuses at the write, and the parent still reads WHY", () => {
    // `§12.2`: removing that refusal is a regression. The picker not offering the session does not remove it —
    // a stale tap, or an admin edit between the offer and the pick, must still be refused with a reason.
    const book = fn("async function doLeaveBooking(");
    expect(book).toContain('if (e?.code === "LEAVE_NOTICE_TOO_LATE")');
    expect(book).toContain("leaveNoticeMessage(cutoffHours, b.startTime, lang)");
  });

  test("🚫 the body lists exactly what the buttons offer — LINE's 12, not a number I invented", () => {
    const picker = fn("function sessionPicker(");
    expect(picker).toContain("const shown = picks.slice(0, 12);");
    expect(picker).toContain("return bookingPicker(body, action, shown, lang);");
    // The limit is LINE's: `bookingPicker` reserves one quick-reply slot for back-to-menu out of 13.
    expect(code(src("src/lib/line-reply.ts"))).toContain("bookings.slice(0, 12)");
  });
});
