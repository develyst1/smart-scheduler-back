// 🔻 TASK-727 — Khwan's workbook, the APPROVED LINE wording (owner "ชุด 1 อนุมัติทั้งหมด", COPY-REVIEW-2026-09-29.md:592-608 item 4), one by-value pin per row.
// ⚙️ EVERY expected text below was COPIED BY MACHINE from the "her text" cells of COPY-SET-khwan-workbook-2026-10-11.md (rules: one language filled ⇒ the other stays;
// verbatim; leading/trailing spaces of a cell dropped; ⏎ = a line break) — never retyped. The inputs are her sample values (Student A · Private FREESKATE 6 HR · Coach B …).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { formatOutboxMessage } from "./line-message";
import { renderCampDeduction } from "./camp-deduction";
import { t } from "./line-i18n";
import { db } from "../db";
import { bookingContext } from "../services/outbox.service";
import { studentNamesOf } from "../db/mappers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const course = { studentName: "Student A", subject: "Private FREESKATE", coach: "Coach B" };
const slotA = { date: "2026-10-15", startTime: "10:00", endTime: "11:00" };
const slotB = { date: "2026-10-22", startTime: "10:00", endTime: "11:00" };
const render = (payload: any, ctx: any, lang: "TH" | "EN", who: "parent" | "teacher") => formatOutboxMessage(payload, ctx, lang, who);

describe("🔴 TASK-727 §1 — the push renderers, by value (her sample ⇒ her text)", () => {
  test("P13 class_moved_teacher — TH = EN: the new title and `Previous Schedule`", () => {
    const p = { kind: "class_moved_teacher", bookingType: "COURSE_PACKAGE", size: 6, from: slotA, to: slotB };
    expect(render(p, course, "TH", "teacher")).toBe("CLASS RESCHEDULED / แก้ไขตารางเรียน ‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nDate : 22-10-2026\nTime : 10:00-11:00\nCoach : Coach B\nPrevious Schedule : 15-10-2026 10:00-11:00");
    expect(render(p, course, "EN", "teacher")).toBe("CLASS RESCHEDULED / แก้ไขตารางเรียน ‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nDate : 22-10-2026\nTime : 10:00-11:00\nCoach : Coach B\nPrevious Schedule : 15-10-2026 10:00-11:00");
  });
  test("P14 class_moved_parent — the family gets the COACH's message word for word (a `Coach` line it did not carry)", () => {
    const p = { kind: "class_moved_parent", bookingType: "COURSE_PACKAGE", size: 6, from: slotA, to: slotB };
    expect(render(p, course, "TH", "parent")).toBe("CLASS RESCHEDULED / แก้ไขตารางเรียน ‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nDate : 22-10-2026\nTime : 10:00-11:00\nCoach : Coach B\nPrevious Schedule : 15-10-2026 10:00-11:00");
    expect(render(p, course, "EN", "parent")).toBe("CLASS RESCHEDULED / แก้ไขตารางเรียน ‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nDate : 22-10-2026\nTime : 10:00-11:00\nCoach : Coach B\nPrevious Schedule : 15-10-2026 10:00-11:00");
  });
  test("P15 course_dropped_teacher — the title `… / ดร็อปคอร์ส` (her EN cell repeats the Thai sample reason: the reason stays in the reader's language)", () => {
    const p = { kind: "course_dropped_teacher", cause: "dropped", bookingType: "COURSE_PACKAGE", size: 6, dates: ["2026-10-22", "2026-10-29"], startTime: "10:00", endTime: "11:00", cancelReason: "PROGRAM_CHANGED", note: null };
    expect(render(p, course, "TH", "teacher")).toBe("COURSE PAUSED / ดร็อปคอร์ส ‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nCoach : Coach B\nSessions : 2\nDate : 22-10-2026, 29-10-2026\nTime : 10:00-11:00\nReason : เปลี่ยนโปรแกรม");
    expect(render(p, course, "EN", "teacher")).toBe("COURSE PAUSED / ดร็อปคอร์ส ‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nCoach : Coach B\nSessions : 2\nDate : 22-10-2026, 29-10-2026\nTime : 10:00-11:00\nReason : Program changed");
  });
  test("P16 course ended — the title `คอร์ส CANCEL‼️` (no space before ‼️, as she wrote it)", () => {
    const p = { kind: "course_dropped_teacher", cause: "ended", bookingType: "COURSE_PACKAGE", size: 6, dates: ["2026-10-22", "2026-10-29"], startTime: "10:00", endTime: "11:00", cancelReason: "CUSTOMER_CANCELLED", note: null };
    expect(render(p, course, "TH", "teacher")).toBe("คอร์ส CANCEL‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nCoach : Coach B\nSessions : 2\nDate : 22-10-2026, 29-10-2026\nTime : 10:00-11:00\nReason : ลูกค้ายกเลิก");
    expect(render(p, course, "EN", "teacher")).toBe("คอร์ส CANCEL‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nCoach : Coach B\nSessions : 2\nDate : 22-10-2026, 29-10-2026\nTime : 10:00-11:00\nReason : Customer cancelled");
  });
  test("P17 rental_added_teacher — her TH cell is the title for BOTH languages", () => {
    const p = { kind: "rental_added_teacher", bookingType: "COURSE_PACKAGE", size: 6, rental: { code: "rental-helmet", remark: null } };
    const ctx = { ...course, date: "2026-10-15", startTime: "10:00", endTime: "11:00" };
    expect(render(p, ctx, "TH", "teacher")).toBe("RENT/ อุปกรณ์เช่า ‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nDate : 15-10-2026\nTime : 10:00-11:00\nCoach : Coach B\nRental : Rent 50 / Helmet");
    expect(render(p, ctx, "EN", "teacher")).toBe("RENT/ อุปกรณ์เช่า ‼️\nStudent : Student A\nProgram : Private FREESKATE 6 HR\nDate : 15-10-2026\nTime : 10:00-11:00\nCoach : Coach B\nRental : Rent 50 / Helmet");
  });
  test("P21 other_teacher_removed — the title and the sentence are ONE line", () => {
    const p = { kind: "other_teacher_removed", title: "Event C", startTime: "10:00", endTime: "11:00", dates: ["2026-10-15", "2026-10-22"] };
    expect(render(p, {}, "TH", "teacher")).toBe("❌ คุณถูกนำออกจากตารางสอน\nรายการ: Event C\nTime: 10:00-11:00\nวันที่:\n  - 15-10-2026\n  - 22-10-2026");
    expect(render(p, {}, "EN", "teacher")).toBe("❌ You have been removed from a schedule\nItem: Event C\nTime: 10:00-11:00\nDates:\n  - 15-10-2026\n  - 22-10-2026");
  });
  test("P22 other_series_cancelled — one line, the TH wording of the line changes", () => {
    const p = { kind: "other_series_cancelled", title: "Event C", startTime: "10:00", endTime: "11:00", reason: "ADMIN_ERROR", dates: ["2026-10-15", "2026-10-22"] };
    expect(render(p, {}, "TH", "teacher")).toBe("❌ ตารางสอนถูกยกเลิกทั้งหมด\nรายการ: Event C\nTime: 10:00-11:00\nเหตุผล: จองผิด (แอดมิน)\nวันที่:\n  - 15-10-2026\n  - 22-10-2026");
    expect(render(p, {}, "EN", "teacher")).toBe("❌ Your teaching schedule has been cancelled\nProgram: Event C\nTime: 10:00-11:00\nReason: Booking error (admin)\nDate:\n  - 15-10-2026\n  - 22-10-2026");
  });
  test("P35 teacher_leave_lifted — EN only (title + line); the TH stays as it was", () => {
    const p = { kind: "teacher_leave_lifted", date: "2026-10-22" };
    expect(render(p, {}, "EN", "teacher")).toBe("🗓️ LEAVE CANCELLED\nDate: 22-10-2026\nBookings with you are open again.");
    expect(render(p, {}, "TH", "teacher")).toBe("🗓️ แอดมินยกเลิกวันลาของคุณแล้ว\nDate: 22-10-2026\nวันนั้นรับจองคาบกับคุณได้ตามปกติแล้ว");
  });
  test("P18 teacher_assigned — TH only: `Remark :` / `Rental :` print ONLY when they have a value (never a bare label); EN stays as it was", () => {
    const ctx = { studentName: "Student A", subject: "Private FREESKATE", date: "2026-10-15", startTime: "10:00", endTime: "11:00" };
    const her = "👩‍🏫 คุณได้รับมอบหมายคาบสอนใหม่\nนักเรียน: Student A\nวิชา: Private FREESKATE\nเวลา: 15-10-2026 10:00-11:00\nRemark :\nRental :".split("\n");
    const base = her.slice(0, 4).join("\n"); // her sample, minus the two labels she showed EMPTY
    expect(render({ kind: "teacher_assigned" }, ctx, "TH", "teacher")).toBe(base); // hidden when empty
    expect(render({ kind: "teacher_assigned", attendeeNote: "   ", rental: "" }, ctx, "TH", "teacher")).toBe(base); // blank is empty
    expect(render({ kind: "teacher_assigned", attendeeNote: "แพ้ถั่ว", rental: "Rent 50 / Helmet" }, ctx, "TH", "teacher")).toBe(base + "\n" + her[4].replace(/ ?:$/, " : แพ้ถั่ว") + "\n" + her[5].replace(/ ?:$/, " : Rent 50 / Helmet"));
    expect(render({ kind: "teacher_assigned", attendeeNote: "แพ้ถั่ว" }, ctx, "TH", "teacher")).toBe(base + "\nRemark : แพ้ถั่ว"); // one shown, one hidden
    const en = render({ kind: "teacher_assigned", attendeeNote: "x", rental: "y" }, ctx, "EN", "teacher");
    expect(en).toBe("👩‍🏫 A class has been assigned to you\nStudent: Student A\nSubject: Private FREESKATE\nTime: 15-10-2026 10:00-11:00"); // EN: she gave nothing ⇒ unchanged
    expect(render({ kind: "teacher_unassigned", attendeeNote: "x", rental: "y" }, ctx, "TH", "teacher")).not.toContain("Remark"); // only the ASSIGNED notice
  });
});

describe("🔴 TASK-727 §1 — the admin notices P40–P42 (one text for both languages; a missing name ⇒ the generic bell)", () => {
  for (const lang of ["TH", "EN"] as const) {
    test("P40 student_registered / P41 parent_asked_for_admin / P42 teacher_asked_for_admin — " + lang, () => {
      expect(render({ kind: "student_registered", studentName: "B" }, {}, lang, "parent")).toBe("🔔 Student: B registered");
      expect(render({ kind: "parent_asked_for_admin", studentNames: ["B"] }, {}, lang, "parent")).toBe("🔔 Please support Parent of Student B.");
      expect(render({ kind: "parent_asked_for_admin", studentNames: ["A", "B"] }, {}, lang, "parent")).toBe("🔔 Please support Parent of Student A & B."); // a parent with two children ⇒ `A & B` (her answer)
      expect(render({ kind: "teacher_asked_for_admin", coachName: "B" }, {}, lang, "parent")).toBe("🔔 Please support Coach B."); // owner-APPROVED 2026-10-07 (her cell was blank)
    });
    test("no name on the payload ⇒ the generic bell, never NO message — " + lang, () => {
      for (const p of [{ kind: "student_registered" }, { kind: "parent_asked_for_admin" }, { kind: "parent_asked_for_admin", studentNames: [] }, { kind: "teacher_asked_for_admin", coachName: "  " }])
        expect(render(p as any, {}, lang, "parent")).toBe(t("ob_default", lang));
    });
  }
});

describe("🔴 TASK-727 §1 — the chat / label strings, by value", () => {
  test("R39 empty_leave_cutoff · R46 enter_ask_phone · R62 verify_parent_other_family · R63 add_dup_detail · R82 checkin_err · R83 leave_err · R125 cl_note_hour — her TH and EN", () => {
    const rows: Array<[string, any]> = [["empty_leave_cutoff", {"key":"`empty_leave_cutoff`","TH":"คลาสเรียนใกล้ถึงเวลาเรียนแล้ว ไม่สามารถแจ้งลาในระบบได้ค่ะ กรุณาติดต่อแอดมินเพื่อ support นะคะ","EN":"Class is about to start. Absence requests can no longer be made in the system. Please contact Admin for assistance."}], ["enter_ask_phone", {"key":"`enter_ask_phone`","TH":"กรุณากรอกเบอร์โทร.ที่ลงทะเบียนไว้ในระบบ Line ค่ะ","EN":"Please enter your mobile phone that linked with Line app."}], ["verify_parent_other_family", {"key":"`verify_parent_other_family`","TH":"บัญชี LINE นี้ได้มีการผูกในระบบไว้แล้วค่ะ กรุณาติดต่อแอดมินค่ะ","EN":"Someone has linked this LINE account in the system already. Please contact our Admin."}], ["add_dup_detail", {"key":"`add_dup_detail`","TH":"มีน้องลงทะเบียนชื่อนี้แล้ว — กรุณาใช้ชื่อเล่น + ชื่อจริงของน้องค่ะ","EN":"This name is already registered. Please use your child’s nickname + first name."}], ["checkin_err", {"key":"`checkin_err`","TH":"ไม่สามารถเช็คอินได้ในขณะนี้ค่ะ กรุณาติดต่อแอดมิน","EN":"You can't check in right now. Please contact Admin."}], ["leave_err", {"key":"`leave_err`","TH":"ไม่สามารถแจ้งลาได้ในขณะนี้ค่ะ กรุณาติดต่อแอดมิน","EN":"You can't request an absence right now. Please contact Admin."}], ["cl_note_hour", {"key":"`cl_note_hour`","TH":"คืนชั่วโมงเรียนให้แล้วค่ะ","EN":"The lesson hour has been returned to your course."}]];
    for (const [key, her] of rows) { expect(t(key, "TH")).toBe(her.TH); expect(t(key, "EN")).toBe(her.EN); }
  });
  test("R59 · R60 · R61 · R120 — EN only: the TH stays as it was", () => {
    expect(t("verify_parent_children_names", "EN")).toBe("\nFound your children — {names}");
    expect(t("verify_parent_children_names", "TH")).toBe("\nพบข้อมูลของคุณแล้วค่ะ — {names}");
    expect(t("verify_parent_archived", "EN")).toBe("This number was registered before — please contact our Admin.");
    expect(t("verify_parent_archived", "TH")).toBe("เบอร์นี้เคยลงทะเบียนไว้แล้ว กรุณาติดต่อร้านเพื่อคืนสถานะ");
    expect(t("generic_error", "EN")).toBe("Sorry — something went wrong. Please contact our Admin.");
    expect(t("generic_error", "TH")).toBe("ขออภัย ระบบมีปัญหาชั่วคราว กรุณาติดต่อแอดมิน");
    expect(t("ob_l_planned_leave", "EN")).toBe("Leave already requested (dates)");
    expect(t("ob_l_planned_leave", "TH")).toBe("แจ้งลาล่วงหน้าไว้ (วันที่)");
  });
  test("R38 empty_leave — TH only, the doubled `ที่สามารถ` removed (house rule); EN stays", () => {
    expect(t("empty_leave", "TH")).toBe("ไม่มีคลาสที่สามารถแจ้งลาได้ค่ะ");
    expect(t("empty_leave", "TH")).not.toContain("ที่สามารถที่สามารถ");
    expect(t("empty_leave", "EN")).toBe("You have no upcoming classes to cancel");
  });
});

describe("🔴 TASK-727 §2 — the camp renderers (P25 / P27 by value; P26 only the label)", () => {
  test("P25 camp_reminder (coach roster) — `Camp :` and the split in her words, both languages", () => {
    const p = { kind: "camp_reminder", audience: "teacher", rows: [{ weekName: "Week 1", date: "2026-10-15", total: 3, full: 1, am: 1, pm: 1, names: ["Student A", "Student B", "Student C"] }] };
    expect(render(p, {}, "TH", "teacher")).toBe("⏱️TODAY'S SCHEDULE:\n\nCamp : Week 1\nDate : 15-10-2026\nStudents : 3 (ทั้งวัน 1 ·เช้า 1 · บ่าย 1)\n  - Student A\n  - Student B\n  - Student C");
    expect(render(p, {}, "EN", "teacher")).toBe("⏱️TODAY'S SCHEDULE:\n\nCamp : Week 1\nDate : 15-10-2026\nStudents : 3 (Full day 1 · Morning 1 · Afternoon 1)\n  - Student A\n  - Student B\n  - Student C");
  });
  test("P26 camp_reminder (family) — only the TH label `Camp :` here; the Time line is NOT touched (the real hours wait on the SA)", () => {
    const p = { kind: "camp_reminder", audience: "parent", rows: [{ child: "Student A", weekName: "Week 1", date: "2026-10-15", half: "AM" }] };
    const th = render(p, {}, "TH", "parent");
    expect(th).toContain("\nCamp : Week 1\n");
    expect(th).not.toContain("แคมป์");
    expect(th).toContain("ช่วง : ช่วงเช้า"); // unchanged
    expect(render(p, {}, "EN", "parent")).toContain("Time : Morning (AM)"); // unchanged
  });
  test("P27 camp_deduction — her title, ENGLISH ONLY for both languages", () => {
    const body = { studentName: "Student A", date: "2026-10-15", remainingDays: 1, totalDays: 5 };
    expect(renderCampDeduction(body)).toBe("🏕️ CAMP DEDUCTION: \nStudent: Student A\nDate: 15-10-2026\nRemaining: 1 / 5 days");
    expect(render({ kind: "camp_deduction", ...body }, {}, "TH", "parent")).toBe("🏕️ CAMP DEDUCTION: \nStudent: Student A\nDate: 15-10-2026\nRemaining: 1 / 5 days");
    expect(render({ kind: "camp_deduction", ...body }, {}, "EN", "parent")).toBe("🏕️ CAMP DEDUCTION: \nStudent: Student A\nDate: 15-10-2026\nRemaining: 1 / 5 days");
  });
});

describe("🚫 TASK-727 scope guard — the rows still NOT approved stay untouched (P11 · P33/P34 · R48 · R58 were approved by Khwan's answers 2026-10-12: TASK-731)", () => {
  test("R35 (the approved A′) keeps its words; the TH halves of the rows that changed EN-only stay as they were", () => {
    expect(t("empty_checkin", "TH")).toContain("วันนี้ไม่พบคลาสที่ยืนยันแล้วสำหรับบัญชีนี้ค่ะ"); // R35 — the approved A′ stays
    expect(t("verify_parent_children_count", "TH")).toBe("\nพบนักเรียน {n} คนในบัญชีนี้"); // R58's TH is as today
    expect(t("ob_teacher_leave_recorded_title", "TH")).toBe("🗓️ แอดมินบันทึกวันลาของคุณแล้ว"); // P33/P34's TH is as today
    expect(t("ob_tl_blocked", "TH")).toBe("วันนั้นจะไม่มีการจองคาบใหม่กับคุณ");
  });
});

describe("🔴 TASK-727 §2 — the producer of P41/P42 passes the NAMES, and a failed lookup never costs the alert", () => {
  const WEBHOOK = readFileSync(resolve(import.meta.dir, "../services/line-webhook.service.ts"), "utf8").replace(/\r\n/g, "\n");
  const doCallAdmin = WEBHOOK.slice(WEBHOOK.indexOf("async function doCallAdmin("), WEBHOOK.indexOf("async function doTeacherSchedule("));
  test("a parent's children (`studentNames`) and a coach's nickname (`coachName`) ride the alert; admin / unlinked look nothing up", () => {
    expect(doCallAdmin).toContain("names = { studentNames: (parent ? await listStudentsOfParent(parent.id) : []).map((k: any) => studentNamesOf({ student: k })) };");
    expect(doCallAdmin).toContain("names = { coachName: teacher?.nickname };");
    expect(doCallAdmin).toContain("await notifyAdmins({ kind: adminAskKind(who), lineUserId, ...names });");
    expect(doCallAdmin).toContain('if (who === "customer") {');
    expect(doCallAdmin).toContain('else if (who === "teacher") {');
  });
  test("the lookup sits in a try/catch BEFORE the alert and the mute — the one button that must never fail (TASK-234)", () => {
    const tryAt = doCallAdmin.indexOf("try {"), catchAt = doCallAdmin.indexOf("} catch (e) {"), alertAt = doCallAdmin.indexOf("await notifyAdmins(");
    expect(tryAt).toBeGreaterThan(-1);
    expect(tryAt).toBeLessThan(catchAt);
    expect(catchAt).toBeLessThan(alertAt);
    expect(doCallAdmin.indexOf("lineLinkSessions")).toBeGreaterThan(alertAt); // the mute still follows the alert
  });
});

describe("🔴 TASK-727 (Porter's grant, Q1) — P18's data: `bookingContext` carries the booking's Remark and Rental, and the notice shows them", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });
  const row = (extra: any = {}) => ({ student: { name: "Student A", nickname: null }, coStudent: null, teacher: { nickname: "B" }, subject: { name: "Private FREESKATE" }, additionalTeachers: [], group: null, otherTitle: null, date: "2026-10-15", startTime: "10:00:00", endTime: "11:00:00", attendeeNote: null, rental: null, ...extra });
  test("a booking WITH a note and a rental ⇒ both ride the context (the rental as the customer's print line); WITHOUT ⇒ absent", async () => {
    let current: any = row({ attendeeNote: "แพ้ถั่ว", rental: { code: "rental-helmet", remark: null } });
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => current) as any));
    const ctx = await bookingContext("b-1");
    expect(ctx).toMatchObject({ attendeeNote: "แพ้ถั่ว", rental: "Rent 50 / Helmet" });
    current = row();
    const bare = await bookingContext("b-1");
    expect(bare.attendeeNote).toBeUndefined();
    expect(bare.rental).toBeUndefined();
  });
  test("end to end: the TH assigned notice prints the booking's Remark and Rental from the context; none ⇒ no label; the payload wins when it carries them", async () => {
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => row({ attendeeNote: "แพ้ถั่ว", rental: { code: "rental-helmet", remark: null } })) as any));
    const ctx = await bookingContext("b-1");
    const msg = render({ kind: "teacher_assigned", bookingId: "b-1" }, ctx, "TH", "teacher");
    expect(msg.split(String.fromCharCode(10)).slice(-2)).toEqual(["Remark : แพ้ถั่ว", "Rental : Rent 50 / Helmet"]);
    expect(render({ kind: "teacher_assigned", bookingId: "b-1" }, { ...ctx, attendeeNote: undefined, rental: undefined }, "TH", "teacher")).not.toMatch(/Remark|Rental/);
  });
});

describe("🔴 TASK-727 (review round 1, Q3) — the ONE name rule (nickname first, then name) for P40 and P41", () => {
  test("a child with a nickname ⇒ the nickname; without ⇒ the name; the notices print it", () => {
    expect(studentNamesOf({ student: { nickname: "Mola", name: "Mola Full" } })).toBe("Mola");
    expect(studentNamesOf({ student: { nickname: null, name: "Mola Full" } })).toBe("Mola Full");
    expect(render({ kind: "parent_asked_for_admin", studentNames: [studentNamesOf({ student: { nickname: "Mola", name: "Mola Full" } }), studentNamesOf({ student: { nickname: null, name: "Pun Full" } })] }, {}, "EN", "parent")).toBe("🔔 Please support Parent of Student Mola & Pun Full.");
  });
  test("by source: both producers go through `studentNamesOf` (never `k.name` / `student.name` alone)", () => {
    const W = readFileSync(resolve(import.meta.dir, "../services/line-webhook.service.ts"), "utf8");
    const G = readFileSync(resolve(import.meta.dir, "../services/line-register.service.ts"), "utf8");
    expect(W).toContain(".map((k: any) => studentNamesOf({ student: k }))");
    expect(W).not.toContain("studentNames: (parent ? await listStudentsOfParent(parent.id) : []).map((k: any) => k.name)");
    expect(G).toContain("studentName: studentNamesOf({ student: created.student }) ?? created.student.name");
  });
});
