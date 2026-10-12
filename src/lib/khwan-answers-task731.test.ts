// 🔻 TASK-731 — Khwan's answers 1–4 (2026-10-12): P11 · P33/P34 · R48 · R58. ⚙️ The expected texts are COPIED BY MACHINE from her COPY-SET cells (+ her answers, verbatim in
// COPY-DRAFT-khwan-questions-2026-10-11.md): P11 "Reason and Note, both languages; no new-class date" · P33/P34 title "LEAVE RECORDED" · R48 `แตะปุ่ม "เพิ่มนักเรียน"` · R58 `{n} children found`.
import { describe, expect, test } from "bun:test";
import { formatOutboxMessage } from "./line-message";
import { t } from "./line-i18n";

const ctx = { studentName: "Student A", subject: "Private FREESKATE", date: "2026-10-15", startTime: "10:00", endTime: "11:00" };
const render = (payload: any, lang: "TH" | "EN", who: "parent" | "teacher" = "parent") => formatOutboxMessage(payload, ctx, lang, who);

describe("🔴 TASK-731 — P11 makeup_cancelled_parent: her EN shape (Reason + Note) for BOTH languages, NO new-class date", () => {
  const base = { kind: "makeup_cancelled_parent", bookingType: "COURSE_PACKAGE", size: 6, newClassDates: ["2026-10-22"] }; // a class WAS appended
  test("EN = her cell byte for byte (Teacher leave + the make-up Note) when the re-plan appended a class", () => {
    expect(render({ ...base, cancelReason: "TEACHER_LEAVE" }, "EN")).toBe("❌ CLASS CANCELLED:\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nDate : 15-10-2026\nTime : 10:00-11:00\nReason : Teacher leave\nNote : A make-up session has been added to the schedule.");
  });
  test("TH = the same shape in the chat's language (title, `เหตุผล`, Note) — English labels as every family notice", () => {
    expect(render({ ...base, cancelReason: "TEACHER_LEAVE" }, "TH")).toBe(["❌ ยกเลิกคาบเรียน:", "Student : Student A", "Program : Private FREESKATE 6 HR", "Date : 15-10-2026", "Time : 10:00-11:00", "เหตุผล : ครูลา", "Note : ระบบเพิ่มคาบชดเชยให้แล้ว"].join("\n"));
  });
  test("🔑 the Note is CONDITIONAL (TASK-537 / 548): NO append ⇒ NO Note, in both languages and with or without a Reason — the sentence would be false for a trim", () => {
    for (const lang of ["TH", "EN"] as const) {
      for (const p of [{ ...base, newClassDates: undefined }, { ...base, newClassDates: [] }, { ...base, newClassDates: [""], cancelReason: "TEACHER_LEAVE" }]) {
        const out = render(p, lang);
        expect(out).not.toContain("Note");
        expect(out.split("\n")).toHaveLength((p as any).cancelReason ? 6 : 5);
      }
    }
  });
  test("no Reason line unless it was a teacher's leave (the shop's other codes are its own business); the Note rides when appended", () => {
    for (const cancelReason of [undefined, null, "ADMIN_ERROR", "CUSTOMER_CANCELLED"]) {
      const en = render({ ...base, cancelReason }, "EN");
      expect(en).not.toContain("Reason");
      expect(en.split("\n").at(-1)).toBe("Note : A make-up session has been added to the schedule.");
    }
  });
  test("🚫 the new class's DATE is gone: a payload that still carries `newClassDates` prints no date of it", () => {
    for (const lang of ["TH", "EN"] as const) {
      const out = render({ ...base, newClassDates: ["2026-10-22", "2026-11-05"], cancelReason: "TEACHER_LEAVE" }, lang);
      expect(out).not.toMatch(/22-10-2026|05-11-2026|2026-10-22/);
      expect(out.split("\n").filter((l) => l.startsWith("Date : "))).toEqual(["Date : 15-10-2026"]); // only the cancelled class's own date
    }
  });
});

describe("🔴 TASK-731 — P33 / P34 teacher_leave_recorded: the EN title is `LEAVE RECORDED`, the rest her lines (TH as today)", () => {
  const p = (classes: number) => ({ kind: "teacher_leave_recorded", date: "2026-10-22", classes, actor: "Admin D" });
  test("P33 (classes that day) and P34 (none) in EN = her cells (title swapped to RECORDED, as answered)", () => {
    expect(render(p(2), "EN", "teacher")).toBe("🗓️ LEAVE RECORDED\nDate: 22-10-2026\nNo new class will be booked.\nThe 2 class(es) that already booked, still on. \nRecorded by: Admin D");
    expect(render(p(0), "EN", "teacher")).toBe("🗓️ LEAVE RECORDED\nDate: 22-10-2026\nNo new class will be booked.\nRecorded by: Admin D");
  });
  test("TH unchanged", () => {
    expect(render(p(2), "TH", "teacher")).toBe("🗓️ แอดมินบันทึกวันลาของคุณแล้ว\nDate: 22-10-2026\nวันนั้นจะไม่มีการจองคาบใหม่กับคุณ\nคาบที่จองไว้แล้ว 2 คาบยังอยู่ในตารางและยังไม่ได้ยกเลิก — กรุณาถือว่าสอนตามปกติจนกว่าแอดมินจะแจ้ง\nบันทึกโดย: Admin D");
  });
  test("the lifted notice (P35) keeps LEAVE CANCELLED — 727's words", () => {
    expect(t("ob_teacher_leave_lifted_title", "EN")).toBe("🗓️ LEAVE CANCELLED");
  });
});

describe("🔴 TASK-731 — R48 children_none · R58 verify_parent_children_count", () => {
  test("R48: TH `แตะปุ่ม \"เพิ่มนักเรียน\"` (her doubled word corrected, as proposed) · EN her cell", () => {
    expect(t("children_none", "TH")).toBe('ยังไม่มีนักเรียน — แตะปุ่ม "เพิ่มนักเรียน"');
    expect(t("children_none", "EN")).toBe("No children yet — tap \"Add child\"");
    expect(t("children_none", "TH")).not.toContain("เพื่อ");
  });
  test("R58: EN `{n} children found` · TH as today (the scope guard)", () => {
    expect(t("verify_parent_children_count", "EN", { n: 3 })).toBe("\n3 children found");
    expect(t("verify_parent_children_count", "TH", { n: 3 })).toBe("\nพบนักเรียน 3 คนในบัญชีนี้");
  });
});
