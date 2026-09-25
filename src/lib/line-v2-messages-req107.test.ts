// TASK-470 (REQ-107 §3) — the four message formats, EVERY BYTE from the customer's sheet
// (`project-docs/customer-2026-09-25-richmenu/rich-menu-messages.html`: sheet column D = EN, F = TH).
//
// 🔑 Whole strings, both languages, blank lines included — a rendered message is what a parent reads, so the assertion
// is the message, not its parts. The pieces are the ones the handlers use (`line-v2-lines.ts` + the i18n keys), and the
// handlers' own composition of them is pinned by source at the end.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./line-i18n";
import { checkinLine, courseLineV2, ddmm, ddmmyyDot, dow3, joinItems, leaveLine, timeDot } from "./line-v2-lines";
import { CMD_CHILDREN, CMD_MENU, CMD_QR, isReservedWord } from "./line-commands";
import { readSrc } from "./read-src";
import { renderMyCourses } from "./line-course-view";
import { studentNamesOf } from "../db/mappers";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(readSrc(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8")));

const KK = { nickname: "KK" };
const BALLET = { name: "Private BALLET" };
const feen = { name: "Feen Full", nickname: "Feen" };
const pun = { name: "Pun Full", nickname: "Pun" };
const at = (date: string, startTime: string, extra: Record<string, unknown> = {}) => ({ id: `${date}-${startTime}`, date, startTime, student: feen, teacher: KK, subject: BALLET, ...extra });

describe("🔑 the formats' own pieces — her dates and times, copied exactly (and flagged against DD-MM-YYYY)", () => {
  test("check-in time is `10.00` (a DOT) · leave date is `FRI 25/09` · expiry is `27.10.26` (DD.MM.YY)", () => {
    expect(timeDot("10:00:00")).toBe("10.00");
    expect(dow3("2026-09-25")).toBe("FRI"); // English, uppercase, in BOTH of her columns
    expect(dow3("2026-09-27")).toBe("SUN");
    expect(ddmm("2026-09-25")).toBe("25/09");
    expect(ddmmyyDot("2026-10-27")).toBe("27.10.26");
  });
  test("🔑 the name leads through the ONE rule — a DUO row reads BOTH children", () => {
    expect(checkinLine(at("2026-09-25", "10:00:00"))).toBe("Feen: Private BALLET / Teacher KK @ 10.00");
    expect(checkinLine(at("2026-09-25", "10:00:00", { coStudent: pun }))).toBe("Feen & Pun: Private BALLET / Teacher KK @ 10.00");
  });
});

describe("✅ CHECK IN — prompt · lines with a blank line between · success · none", () => {
  const two = [at("2026-09-25", "10:00:00"), at("2026-09-25", "11:00:00")];
  test("EN, whole message", () => {
    expect(`${t("pick_checkin", "EN")}\n${joinItems(two.map(checkinLine))}`).toBe(
      "Pick class👇\nFeen: Private BALLET / Teacher KK @ 10.00\n\nFeen: Private BALLET / Teacher KK @ 11.00",
    );
  });
  test("TH, whole message", () => {
    expect(`${t("pick_checkin", "TH")}\n${joinItems(two.map(checkinLine))}`).toBe(
      "กรุณาเลือกคลาส 👇\nFeen: Private BALLET / Teacher KK @ 10.00\n\nFeen: Private BALLET / Teacher KK @ 11.00",
    );
  });
  test("success — `Checked in ✅` + the line, in BOTH columns (⚠️ her TH cell is English — copied, flagged)", () => {
    for (const lang of ["EN", "TH"] as const) {
      expect(t("checkin_ok", lang, { line: checkinLine(two[0]) })).toBe("Checked in ✅\nFeen: Private BALLET / Teacher KK @ 10.00");
    }
  });
  test("no class today", () => {
    expect([t("empty_checkin", "EN"), t("empty_checkin", "TH")]).toEqual(["No class today", "วันนี้ไม่มีคลาส"]);
  });
});

describe("✅ REQUEST LEAVE — which child · the list · the success line (her spelling kept)", () => {
  const two = [at("2026-09-25", "16:00:00"), at("2026-09-26", "15:00:00")];
  test("which child", () => {
    expect([t("pick_leave_child", "EN"), t("pick_leave_child", "TH")]).toEqual(["Which child? 👇", "กรุณาเลือกนักเรียนค่ะ"]);
  });
  test("the list, whole message — `· ` on every item, a blank line between (⚠️ her TH prompt is English — copied, flagged)", () => {
    const body = (lang: "EN" | "TH") => `${t("pick_leave", lang)}\n${joinItems(two.map((b) => `· ${leaveLine(b)}`))}`;
    const want = "Pick class to request leave 👇\n· FRI 25/09 @ 16:00 : Private BALLET / Teacher KK\n\n· SAT 26/09 @ 15:00 : Private BALLET / Teacher KK";
    expect(body("EN")).toBe(want);
    expect(body("TH")).toBe(want);
  });
  test("🔑 success — `Record Leave:` / `บันทึการลา :` (HER spelling) + 🔴 THE CHILD'S NAME (TASK-471, owner ruling), and 🚫 nothing about the end of the course", () => {
    // 📌 Her sheet has NO name here. The OWNER ruled 2026-09-25 (TASK-471) that TASK-135 Q2 stands: a parent of three must see
    // WHICH child was excused. Decided twice in opposite directions — this pin is the standing answer; do not match her sheet.
    expect(t("leave_ok_session", "EN", { name: "Feen", line: leaveLine(two[0]), locked: "" })).toBe("Record Leave: Feen — FRI 25/09 @ 16:00 : Private BALLET / Teacher KK");
    expect(t("leave_ok_session", "TH", { name: "Feen", line: leaveLine(two[0]), locked: "" })).toBe("บันทึการลา : Feen — FRI 25/09 @ 16:00 : Private BALLET / Teacher KK");
    for (const lang of ["EN", "TH"] as const) {
      expect(t("leave_ok_session", lang, { line: "x", locked: "" })).not.toMatch(/end of the course|ต่อท้ายคอร์ส|Make-up|คาบขยาย/);
    }
  });
  test("🔴 TASK-471 — a DUO session names BOTH children (the ONE rule), and the ruling's comment stays beside the key", () => {
    const duo = at("2026-09-25", "16:00:00", { coStudent: pun });
    expect(t("leave_ok_session", "EN", { name: studentNamesOf(duo)!, line: leaveLine(duo), locked: "" })).toBe(
      "Record Leave: Feen & Pun — FRI 25/09 @ 16:00 : Private BALLET / Teacher KK",
    );
    // The line was decided twice, opposite ways: the file must keep saying which way, on whose word, and why.
    const I18N = readFileSync(resolve(root, "src/lib/line-i18n.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(I18N).toContain("the OWNER ruled on 2026-09-25 (via Sober, TASK-471) that");
    expect(I18N).toContain("a parent with three children must see WHICH child was excused");
  });
  test("the QUOTA warning survives — a conditional line her normal-case example never shows", () => {
    expect(t("leave_ok_session", "EN", { name: "Feen", line: leaveLine(two[0]), locked: t("leave_lockline", "EN") })).toBe(
      "Record Leave: Feen — FRI 25/09 @ 16:00 : Private BALLET / Teacher KK\n⚠️ Leave quota used up — needs admin unlock",
    );
  });
});

describe("✅ MY COURSE — heading · lines with a blank line between · no leave quota", () => {
  const c = { studentName: "Feen", subjectName: "Private BALLET", teacherNickname: "KK", size: 6, usedSessions: 2, leaveRemaining: 2, expiryDate: "2026-10-27" };
  test("the line, byte for byte — including the `.  ` her sheet starts it with", () => {
    expect(courseLineV2(c)).toBe(".  Feen: Private BALLET / Teacher KK [Remain: 4/6] *EXPIRE: 27.10.26");
  });
  test("headings", () => {
    expect([t("course_title", "EN"), t("course_title", "TH")]).toEqual(["My Course:", "คอร์สของฉัน :"]);
  });
  test("🔑 Sober's ruling (f): the heading in BOTH languages, every class line EXACTLY ONCE", () => {
    const msg = renderMyCourses([c, { ...c, studentName: "Pun" }]);
    expect(msg).toBe(
      "คอร์สของฉัน :\nMy Course:\n.  Feen: Private BALLET / Teacher KK [Remain: 4/6] *EXPIRE: 27.10.26\n\n.  Pun: Private BALLET / Teacher KK [Remain: 4/6] *EXPIRE: 27.10.26",
    );
    expect(msg.split(".  Feen:").length - 1).toBe(1);
    expect(renderMyCourses([])).toBe("ยังไม่มีคอร์สที่ใช้งานอยู่ค่ะ\nNo active courses."); // words stay bilingual
  });
});

describe("✅ LANGUAGE / HELP — the confirmation AND the shorter list, in one message", () => {
  test("EN, whole message", () => {
    expect(`${t("lang_switched", "EN")}\n${t("menu_body", "EN")}`).toBe(
      "Switched to English ✅\nAvailable Commands:\n\n· Add Student — Up to 5\n· My Course — Registered Course\n· Check-in — Check in today's class\n· Request Leave",
    );
  });
  test("TH, whole message", () => {
    expect(`${t("lang_switched", "TH")}\n${t("menu_body", "TH")}`).toBe(
      "เปลี่ยนเป็นภาษาไทยแล้ว ✅\nคำสั่งที่ใช้ได้:\n\n· เพิ่มนักเรียน — สูงสุด 5 คน\n· คอร์สของฉัน — คอร์สเรียนที่มี\n· เช็คอิน — ลงทะเบียนเข้าเรียน\n· แจ้งลา",
    );
  });
  test("🔑 `qr`, `menu` and `children` leave the LIST only — every one of them still WORKS as a command", () => {
    const listed = (lang: "EN" | "TH") => t("menu_body", lang).split("\n").filter((l) => l.startsWith("· ")).map((l) => l.slice(2).split(" — ")[0]);
    expect(listed("EN")).toEqual(["Add Student", "My Course", "Check-in", "Request Leave"]);
    expect(listed("TH")).toEqual(["เพิ่มนักเรียน", "คอร์สของฉัน", "เช็คอิน", "แจ้งลา"]);
    for (const w of ["qr", "menu", "เมนู", "children", "นักเรียน"]) expect({ w, works: isReservedWord(w) }).toEqual({ w, works: true });
    expect(SVC).toContain("inList(CMD_QR, cmd)");
    expect([...CMD_MENU]).toContain("menu");
    expect([...CMD_QR]).toContain("qr");
    expect([...CMD_CHILDREN]).toContain("children");
  });
});

describe("🔑 the handlers compose exactly these pieces (by source)", () => {
  test("check-in body: the prompt, then the lines with a blank line between — no bullet", () => {
    expect(SVC).toContain("? `${prompt}\\n${joinItems(chosen.map((b) => checkinLine(b)))}`");
  });
  test("leave body: the prompt, then `· ` + each line, a blank line between", () => {
    expect(SVC).toContain("? `${prompt}\\n${joinItems(chosen.map((b) => `· ${leaveLine(b)}`))}`");
  });
  test("the successes take the ONE line; the make-up date is no longer printed", () => {
    expect(SVC).toContain("const body = t(key, lang, { line: checkinLine(b) });");
    expect(SVC).toContain('const body = t("leave_ok_session", lang, { name: studentNamesOf(b) ?? "-", line: leaveLine(b), locked });'); // TASK-471 — the ONE name rule
    expect(SVC).not.toContain('t("leave_extline"');
  });
  test("🔴 My Course fills the name through the ONE rule, and loads both children to do it (break-and-watch I found this unpinned)", () => {
    const fn = SVC.slice(SVC.indexOf("async function doMyCourses"), SVC.indexOf("\n}\n", SVC.indexOf("async function doMyCourses")));
    expect(fn).toContain("studentName: studentNamesOf(c),");
    expect(fn).toContain("with: { subject: true, student: true, coStudent: true, bookings: { with: { teacher: true } } }");
  });
  test("the language toggle answers with the confirmation AND the list, in the NEW language", () => {
    expect(SVC).toContain('textReply(`${t("lang_switched", next)}\\n\\n${t("menu_body", next)}`, next)'); // TASK-473 K1 — the blank line
  });
});
