// TASK-486 (REQ-109 §3/§5/§6) — the teacher schedule format, by value. Khwan's sample is the contract: the EN week view must be
// BYTE-IDENTICAL to it (with her own correction applied: 3-letter days for EVERY day). The status sets are pinned against the
// REAL enum, so a status added next year fails here instead of appearing silently in a coach's message.
import { describe, expect, test } from "bun:test";
import { bookingStatus } from "../db/schema";
import { t } from "./line-i18n";
import { TEACHER_SCHEDULE_WORDS, TEACHER_VISIBLE, isTeacherVisible, renderTeacherSchedule, renderTeacherScheduleBody, teacherDayHeader, teacherProgram, type TeacherSchedRow } from "./teacher-schedule";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupWeekRows, renderWeeklySchedule } from "./weekly-digest";
import { checkinLine } from "./line-v2-lines";

const r = (date: string, time: string, name: string, program: string | null, status: string, note: string | null = null): TeacherSchedRow =>
  ({ date, startTime: `${time}:00`, name, program, status, note });

// Khwan's sample (REQ-109 §3), as rows. Subject names carry the real "Private " prefix the teacher view must drop.
const SAMPLE_ROWS: TeacherSchedRow[] = [
  r("2026-09-07", "09:00", "ของขวัญ", "Private FREESKATE", "ATTENDED"),
  r("2026-09-09", "09:00", "มะขิด", "Private SURFSKATE", "ATTENDED"),
  r("2026-09-09", "17:00", "มะขิด", "Private SURFSKATE", "ATTENDED"),
  r("2026-09-10", "11:00", "สโรนี", "Private SURFSKATE", "CONFIRMED"),
  r("2026-09-10", "12:00", "มะขิด", "Private FREESKATE", "CONFIRMED"),
  r("2026-09-10", "15:00", "ส้ม", "Private SURFSKATE", "CONFIRMED", "เตรียมอุปกรณ์ให้น้องด้วยค่ะ"),
  r("2026-09-11", "12:00", "ส้ม", "Private SKATEBOARD", "CONFIRMED"),
  r("2026-09-11", "13:00", "ส้มตำ", "Private INLINE SKATE", "CONFIRMED", "เตรียมอุปกรณ์ให้น้องครบเซ็ทนะคะ"),
  r("2026-09-11", "14:00", "ปลางา", "Private INLINE SKATE", "CONFIRMED", "6y / No Experience"),
  r("2026-09-11", "15:00", "เหมียว", "Private ONEWHEEL E-SKATE", "ATTENDED"),
  r("2026-09-11", "16:00", "ส้ม", "BALANCE PLAY (Private)", "ATTENDED", "คุณแม่ฝากให้น้องใส่แมสทุกคลาส"),
  r("2026-09-12", "16:00", "Anya", "Private ONEWHEEL E-SKATE", "CONFIRMED"),
  r("2026-09-13", "10:00", "ดิววี่", "Private FREESKATE", "ATTENDED"),
];
/** Her sample, verbatim — except `SATURDAY`/`SUNDAY` → `SAT`/`SUN`, which is HER correction (§5 answer 2). */
const SAMPLE = `⏱️ THIS WEEK'S SCHEDULE

▸ MON / 07/09
@ 09:00 / ของขวัญ
　FREESKATE / Attended

▸ WED / 09/09
@ 09:00 / มะขิด
　SURFSKATE / Attended
@ 17:00 / มะขิด
　SURFSKATE / Attended

▸ THU / 10/09
@ 11:00 / สโรนี
　SURFSKATE / Confirmed
@ 12:00 / มะขิด
　FREESKATE / Confirmed
@ 15:00 / ส้ม
　SURFSKATE / Confirmed
　📝 เตรียมอุปกรณ์ให้น้องด้วยค่ะ

▸ FRI / 11/09
@ 12:00 / ส้ม
　SKATEBOARD / Confirmed
@ 13:00 / ส้มตำ
　INLINE SKATE / Confirmed
　📝 เตรียมอุปกรณ์ให้น้องครบเซ็ทนะคะ
@ 14:00 / ปลางา
　INLINE SKATE / Confirmed
　📝 6y / No Experience
@ 15:00 / เหมียว
　ONEWHEEL E-SKATE / Attended
@ 16:00 / ส้ม
　BALANCE PLAY (Private) / Attended
　📝 คุณแม่ฝากให้น้องใส่แมสทุกคลาส

▸ SAT / 12/09
@ 16:00 / Anya
　ONEWHEEL E-SKATE / Confirmed

▸ SUN / 13/09
@ 10:00 / ดิววี่
　FREESKATE / Attended`;

describe("✅ the format — Khwan's sample, byte for byte (EN week view)", () => {
  test("the whole message, including the U+3000 indent, 3-letter days for EVERY day, and the 📝 line only when a note exists", () => {
    expect(renderTeacherSchedule(SAMPLE_ROWS, "week")).toBe(SAMPLE);
    expect(SAMPLE).toContain("　FREESKATE / Attended");
    expect(SAMPLE).not.toMatch(/SATURDAY|SUNDAY|MONDAY/);
  });
  test("every day in 3 letters; the date DD/MM", () => {
    expect(["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"].map(teacherDayHeader))
      .toEqual(["▸ MON / 07/09", "▸ TUE / 08/09", "▸ WED / 09/09", "▸ THU / 10/09", "▸ FRI / 11/09", "▸ SAT / 12/09", "▸ SUN / 13/09"]);
  });
  test("🔴 'Private' is dropped for a TEACHER only — a leading prefix; `(Private)` inside a name stays", () => {
    expect(teacherProgram("Private FREESKATE")).toBe("FREESKATE");
    expect(teacherProgram("BALANCE PLAY (Private)")).toBe("BALANCE PLAY (Private)");
    expect(teacherProgram(null)).toBeNull();
  });
  test("🔴 …and the PARENT's format still carries it (a rule reversed in one place must not leak)", () => {
    const b = { date: "2026-09-25", startTime: "10:00:00", student: { name: "Feen", nickname: "Feen" }, teacher: { nickname: "KK" }, subject: { name: "Private BALLET" } };
    expect(checkinLine(b)).toBe("Feen: Private BALLET / Teacher KK @ 10.00");
  });
  test("a GROUP/OTHER row: its title in the student's place, no program segment", () => {
    expect(renderTeacherScheduleBody([r("2026-09-07", "10:00", "Skate Kids", null, "CONFIRMED")], "week").body).toBe("▸ MON / 07/09\n@ 10:00 / Skate Kids\n　Confirmed");
  });
});

describe("🔑 WHICH sessions — pinned as SETS against the REAL enum (one fixture row per status)", () => {
  const ALL = bookingStatus.enumValues;
  const fixture = ALL.map((s, i) => r("2026-09-07", `${String(8 + i).padStart(2, "0")}:00`, `kid-${s}`, "Private FREESKATE", s));
  const shown = (view: "today" | "week"): string[] => ALL.filter((s) => renderTeacherScheduleBody(fixture, view).body.includes(`kid-${s}\n`) || renderTeacherScheduleBody(fixture, view).body.endsWith(`kid-${s}`));
  test("the table has EXACTLY the enum's statuses as keys (and the type makes a tenth one a compile error)", () => {
    expect(Object.keys(TEACHER_VISIBLE).sort()).toEqual([...ALL].sort());
  });
  test("THIS WEEK = Confirmed · Attended · EXTENDED", () => {
    expect(shown("week").sort()).toEqual(["ATTENDED", "CONFIRMED", "EXTENDED"].sort());
  });
  test("TODAY = the week's + Pending · Leave · Pending-reschedule · No-show (the day's full picture)", () => {
    expect(shown("today").sort()).toEqual(["ATTENDED", "CONFIRMED", "EXTENDED", "NO_SHOW", "PENDING", "PENDING_RESCHEDULE", "SICK_LEAVE"].sort());
  });
  test("CANCELLED and PAUSED are hidden in BOTH", () => {
    for (const v of ["today", "week"] as const) expect(shown(v)).not.toContain("CANCELLED"), expect(shown(v)).not.toContain("PAUSED");
  });
});

describe("✅ the two headers and the chat's language", () => {
  test("TODAY keeps `⏱️TODAY'S SCHEDULE:` — EQUAL to the approved AUTO message's title (§B4)", () => {
    expect(renderTeacherSchedule([r("2026-09-25", "10:00", "Feen", "Private FREESKATE", "PENDING")], "today").split("\n")[0]).toBe(t("ob_today_title", "EN"));
    expect(t("tsched_title_today", "EN")).toBe(t("ob_today_title", "EN"));
  });
  test("the today view: the same format, one day header, Pending shown", () => {
    expect(renderTeacherSchedule([r("2026-09-25", "10:00", "Feen", "Private FREESKATE", "PENDING")], "today")).toBe("⏱️TODAY'S SCHEDULE:\n\n▸ FRI / 25/09\n@ 10:00 / Feen\n　FREESKATE / Pending");
  });
  // 🔨 TASK-493 — MOVED: the Thai labels proposed in TASK-486 §4 are gone. The owner answered for Khwan: ENGLISH words in a
  // Thai chat too (her coaches' readability). The pin below is the old TH fixture, now byte-identical to the EN one.
  test("🇹🇭 a THAI chat reads the SAME English words as an English one — the headers and every status (TASK-493, Khwan's choice)", () => {
    const rows = [r("2026-09-07", "09:00", "ของขวัญ", "Private FREESKATE", "ATTENDED"), r("2026-09-07", "10:00", "ส้ม", "Private SURFSKATE", "CONFIRMED")];
    expect(renderTeacherSchedule(rows, "week")).toBe("⏱️ THIS WEEK'S SCHEDULE\n\n▸ MON / 07/09\n@ 09:00 / ของขวัญ\n　FREESKATE / Attended\n@ 10:00 / ส้ม\n　SURFSKATE / Confirmed");
    // (the Thai CHAT through the real dispatcher — byte-identical to the English one — is pinned in teacher-schedule-tap-req109)
    // every status a coach can be shown, in a Thai chat, is its ENGLISH word
    const every = bookingStatus.enumValues.map((s, i) => r("2026-09-07", `${String(8 + i).padStart(2, "0")}:00`, `k${i}`, "Private FREESKATE", s));
    const th = renderTeacherSchedule(every, "today");
    for (const s of bookingStatus.enumValues.filter((x) => isTeacherVisible(x, "today"))) expect(th).toContain(`FREESKATE / ${t(`status_${s}`, "EN")}`);
    expect(th.split("\n").filter((l) => !l.startsWith("@ ")).join("\n")).not.toMatch(/[\u0E00-\u0E7F]/); // no Thai outside the names
  });
  // 🔨 TASK-493 follow-up (Sober): the two lines outside Khwan's sample are English too — ONE message, ONE language — so the
  // formatter takes no language at all (a parameter nothing reads is a comment that lies later).
  test("📌 the empty line and '…and N more' are ENGLISH too, and the formatter takes NO language", () => {
    expect(renderTeacherSchedule([r("2026-09-07", "09:00", "x", null, "CANCELLED")], "week")).toBe("⏱️ THIS WEEK'S SCHEDULE\nNo classes in this range");
    const many = Array.from({ length: 3 }, (_, i) => r("2026-09-07", `0${7 + i}:00`, `k${i}`, null, "CONFIRMED"));
    expect(renderTeacherSchedule(many, "week", 2).split("\n").at(-1)).toBe("…and 1 more");
    expect(TEACHER_SCHEDULE_WORDS).toBe("EN");
    expect(readFileSync(resolve(import.meta.dir, "teacher-schedule.ts"), "utf8")).toContain("export function renderTeacherSchedule(rows: TeacherSchedRow[], view: TeacherView, cap = 20): string {");
    // …and the SHARED key keeps its Thai for the surface that still follows the chat (the AUTO "today" message)
    expect(t("tsched_empty", "TH")).toBe("ไม่มีคาบสอนในช่วงนี้");
  });
  test("⚠️ the REASON sits beside the English strings (so nobody 'fixes' them back to Thai)", () => {
    const I = readFileSync(resolve(import.meta.dir, "line-i18n.ts"), "utf8"), S = readFileSync(resolve(import.meta.dir, "teacher-schedule.ts"), "utf8");
    expect(I).toContain("her coaches read the English");
    expect(S).toContain("This is\n * the customer's own choice, not an oversight");
  });
  test("🔴 the PARENTS' surfaces keep their Thai — the shared status vocabulary's Thai column and the parent replies", () => {
    expect(bookingStatus.enumValues.map((s) => /[\u0E00-\u0E7F]/.test(t(`status_${s}`, "TH")))).toEqual(bookingStatus.enumValues.map(() => true));
    for (const k of ["suspended_notice", "checkin_too_late", "checkin_bad_link", "menu_body", "empty_checkin"]) expect({ k, thai: /[\u0E00-\u0E7F]/.test(t(k, "TH")) }).toEqual({ k, thai: true });
  });
  test("nothing to show ⇒ the header and the existing empty line", () => {
    expect(renderTeacherSchedule([r("2026-09-07", "09:00", "x", null, "CANCELLED")], "week")).toBe(`⏱️ THIS WEEK'S SCHEDULE\n${t("tsched_empty", "EN")}`);
  });
});

describe("✅ the Monday digest — the SAME body, the owner's title/greeting/footer kept, English words, the week set", () => {
  const T1 = "11111111-1111-4111-8111-111111111111";
  const row = (id: string, date: string, time: string, status: string, extra: Record<string, unknown> = {}) => ({ id, date, startTime: `${time}:00`, endTime: null, status, teacherId: T1, teacher: { lineUserId: "U1" }, subject: { name: "Private FREESKATE" }, student: { name: "ส้ม", nickname: "ส้ม" }, coStudent: null, otherTitle: null, additionalTeachers: [], attendeeNote: null, ...extra });
  test("🔴 EXTENDED now reaches the Monday week (it was CONFIRMED-only — a make-up class was missing); PENDING / NO_SHOW / CANCELLED never", () => {
    const g = groupWeekRows([row("a", "2026-09-07", "09:00", "CONFIRMED"), row("b", "2026-09-08", "09:00", "EXTENDED"), row("c", "2026-09-09", "09:00", "PENDING"), row("d", "2026-09-09", "10:00", "NO_SHOW"), row("e", "2026-09-10", "09:00", "CANCELLED"), row("f", "2026-09-10", "10:00", "ATTENDED")]);
    expect(g[0]!.rows.map((x) => x.status)).toEqual(["CONFIRMED", "EXTENDED", "ATTENDED"]);
  });
  test("by value: the owner's words around Khwan's body; ⚠️ no end time any more; the FIXED words carry no Thai (the names do, by design)", () => {
    const g = groupWeekRows([row("a", "2026-09-07", "09:00", "CONFIRMED", { endTime: "10:00:00", attendeeNote: "แพ้ถั่ว" })]);
    const out = renderWeeklySchedule(g[0]!.rows);
    expect(out).toBe("📅 THIS WEEK'S SCHEDULE\nHello, here is your teaching schedule for this week:\n\n▸ MON / 07/09\n@ 09:00 / ส้ม\n　FREESKATE / Confirmed\n　📝 แพ้ถั่ว\n\nPlease review your schedule.");
    expect(out).not.toContain("10:00"); // the end time the old digest printed
    expect(out.replaceAll("ส้ม", "").replaceAll("แพ้ถั่ว", "")).not.toMatch(/[฀-๿]/);
  });
});
