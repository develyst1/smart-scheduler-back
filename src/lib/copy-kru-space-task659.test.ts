// TASK-659 (owner APPROVED 10-06, "1-5 ตามแนะนำ" — ruling 5, the 3b drafts approved as drafted) — COPY, verbatim, never "improved".
//   3a — a SPACE after `ครู`, ALWAYS (no helper that decides by script): five sites in our files.
//   3b — «วันนี้» said "today" about a PICKED date: two sentences now name what they mean.
// 🚫 The SIXTH site, `camp.service.ts` (Team B's file), is NOT here — @Porter routes it with the same approved rule.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { slotClashMessage } from "./slot-clash";
import { TEACHER_ON_LEAVE } from "./teacher-leave";
import { assertTeacherBookable } from "../services/scheduler.service";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const raw = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/\r\n/g, "\n");
const code = (f: string) => raw(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const OURS = ["src/lib/slot-clash.ts", "src/lib/teacher-leave.ts", "src/services/scheduler.service.ts"];

const teacherExec = (t: any) => ({ query: { teachers: { findFirst: async () => t } } });
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.message as string; } return null; };

describe("🔴 TASK-659 — the seven strings, exactly as approved (by value, through the real producers)", () => {
  test("1 · slot-clash — `ครู ` + the name", () => {
    expect(slotClashMessage({ teacherName: "หนึ่ง", bookingName: "น้องเอ", time: "10:00-11:00" } as any)).toBe("ครู หนึ่ง มีคาบสอนช่วงเวลานี้อยู่แล้ว (น้องเอ 10:00-11:00) กรุณาเลือกเวลาอื่น");
  });
  test("2 · TEACHER_ON_LEAVE — a space, and «ในวันนั้น» instead of «วันนี้» (it is about the PICKED date)", () => {
    const e = TEACHER_ON_LEAVE("Ek", "2026-10-21") as any;
    expect(e.code).toBe("TEACHER_ON_LEAVE");
    expect(e.message).toBe("ครู Ek ลาวันที่ 2026-10-21 — เพิ่มคาบกับครูในวันนั้นไม่ได้ กรุณาเลือกครูอื่นหรือวันอื่น");
    expect(e.message).not.toContain("วันนี้");
  });
  test("3 · an ARCHIVED teacher — a space", async () => {
    expect(await refusal(assertTeacherBookable(teacherExec({ id: "t", nickname: "Bank", archived: true, workDays: [1], type: "FULL_TIME" }), "t", "2026-10-12"))).toBe("ครู Bank ถูกปิดการใช้งานแล้ว");
  });
  test("4 · a teacher who does not work that weekday — a space, the weekday NAMED, never «วันนี้» (the date is the PICKED one)", async () => {
    // 2026-10-12 is a Monday, 2026-10-14 a Wednesday: the name comes from the picked date, from the codebase's existing `ob_dow_*` names
    const t = { id: "t", nickname: "Bank", archived: false, workDays: [2], type: "FULL_TIME" }; // works Tuesdays only
    expect(await refusal(assertTeacherBookable(teacherExec(t), "t", "2026-10-12"))).toBe("ครู Bank ไม่ได้สอนวันจันทร์ — กรุณาเลือกครูอื่นหรือวันอื่น");
    expect(await refusal(assertTeacherBookable(teacherExec(t), "t", "2026-10-14"))).toBe("ครู Bank ไม่ได้สอนวันพุธ — กรุณาเลือกครูอื่นหรือวันอื่น");
    expect(await refusal(assertTeacherBookable(teacherExec(t), "t", "2026-10-18"))).toBe("ครู Bank ไม่ได้สอนวันอาทิตย์ — กรุณาเลือกครูอื่นหรือวันอื่น"); // Sunday = index 0
  });
  test("5 · a freelance teacher with no budget — a space (the string, from the code: its branch needs a database read)", () => {
    expect(code("src/services/scheduler.service.ts")).toContain("throw badRequest(`ครู ${teacher.nickname} ยังไม่ได้ตั้งงบ — ตั้งงบก่อนจึงจะจองได้`);");
  });
});

describe("🔴 TASK-659 — no `ครู${` is left in OUR files (asked of the CODE: statements, not comments)", () => {
  for (const f of OURS) {
    test(`${f}`, () => {
      expect({ f, left: [...code(f).matchAll(/ครู\$\{/g)].length }).toEqual({ f, left: 0 });
    });
  }
  test("«ไม่มาสอนวันนี้» and «เพิ่มคาบกับครูวันนี้ไม่ได้» are gone from the code", () => {
    for (const f of OURS) {
      expect(code(f)).not.toContain("ไม่มาสอนวันนี้");
      expect(code(f)).not.toContain("เพิ่มคาบกับครูวันนี้ไม่ได้");
    }
  });
  test("🚫 NO second weekday table: the sentence reads the existing `ob_dow_*` names, and none was added", () => {
    expect(code("src/services/scheduler.service.ts")).toContain("tr(`ob_dow_${weekdayOf(date)}`, \"TH\")");
    expect(raw("src/services/scheduler.service.ts")).not.toMatch(/\["อาทิตย์", "จันทร์"/);
    expect((raw("src/lib/line-i18n.ts").match(/ob_dow_\d:/g) ?? []).length).toBe(7);
  });
  test("the sixth site — `camp.service.ts`, Team B's — now carries the approved space too (Team B's change; asserted here by value)", () => {
    expect(raw("src/services/camp.service.ts")).toContain("`วันที่ ${d.date} ${hour} ครู ${coachName.get(teacherId) ?? teacherId} มีคาบแล้ว — ไม่ได้บันทึกอะไร`"); // 🔻 TASK-671 (Team B, granted by Porter) — FLIPPED BY VALUE: the sixth site now carries the approved space, whole sentence. The test's TITLE above still says "old spelling"; it is left as granted (this assertion only).
  });
});

describe("🔴 ruling 5 follow-up — a space after ครู in the {teacher} TEMPLATES too (a `${`-grep cannot see them)", () => {
  test("no `ครู{` anywhere in the dictionary or the code (asked of the CODE)", () => {
    for (const f of [...OURS, "src/lib/line-i18n.ts", "src/lib/line-message.ts"]) {
      expect({ f, left: [...code(f).matchAll(/ครู\{/g)].length }).toEqual({ f, left: 0 });
    }
  });
  test("the two templates, by value: the parent's course row and the leave notice", async () => {
    const { t } = await import("./line-i18n");
    expect(t("course_row", "TH", { course: "C", teacher: "Bank", remaining: "3", total: "4", expiry: "2026-11-11" })).toBe("· C · ครู Bank · เหลือ 3/4 · หมดอายุ 2026-11-11");
    expect(t("ob_leave_admin", "TH", { student: "S", date: "d", time: "10:00", teacher: "Bank", program: "P", by: "x" })).toContain("· ครู Bank ·");
  });
  test("🔴 the parent's course reply carries NO leave count — not in the template, not in either language, and no `leaveRemaining` is passed in", async () => {
    const { t } = await import("./line-i18n");
    for (const lang of ["TH", "EN"] as const) {
      const row = t("course_row", lang, { course: "C", teacher: "Bank", remaining: "3", total: "4", expiry: "2026-11-11", leave: "2" });
      expect(row).not.toMatch(/สิทธิ์ลา|leave left/);
      expect(row).not.toContain("2 ");
    }
    expect(code("src/services/line-webhook.service.ts")).not.toContain("leaveRemaining: s.leaveRemaining");
    expect(code("src/lib/line-course-view.ts")).not.toMatch(/leaveRemaining\s*:/); // the field is gone from the row type
  });
});
