// TASK-829 (REQ-125 K1 b) — when a teacher's SAME-DAY leave leaves a class AS IT IS (D4: nobody could take the main seat), an ADMIN is told: ONE message for the whole act listing every such class.
// ✅ The sentence is APPROVED by the owner (2026-10-21, exactly as drafted): this file pins the approved text word for word, the renderer, and that the sender is reachable from the same-day act ONLY.
// The by-value behaviour of the act (1 D4 + 1 continuing + 1 sole ⇒ one alert listing only the D4 class; no D4 ⇒ none) lives in the 825 file next to the act's fake.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { t } from "./line-i18n";

const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
const render = (payload: any, lang: "TH" | "EN") => formatOutboxMessage(payload, { date: "", startTime: "", endTime: "" } as any, lang, "teacher"); // the renderer's audience is parent|teacher; this kind ignores it (admins are sent the same text)

describe("✅ the alert's sentence is the owner's APPROVED text, word for word — no «copy pending» marker", () => {
  test("TH + EN are the approved sentence exactly; no marker; the table comment says APPROVED", () => {
    expect(t("ob_tl_left_as_is_admin", "TH")).toBe("⚠️ ครู {name} แจ้งลาวันนี้ ({date}) — คาบต่อไปนี้ยังไม่มีครูรับแทน เพราะครูท่านอื่นของคาบไม่ว่างในเวลานั้น กรุณาจัดการในปฏิทิน: {list}");
    expect(t("ob_tl_left_as_is_admin", "EN")).toBe("⚠️ {name} reported leave for today ({date}). These classes have no teacher to take over (their other teachers aren't free then). Please handle them in the calendar: {list}");
    expect(read("src/lib/line-i18n.ts")).toContain("// 🔻 TASK-829 (REQ-125 K1 b) — ✅ APPROVED by the owner 2026-10-21");
    expect(t("ob_tl_left_as_is_admin", "TH") + t("ob_tl_left_as_is_admin", "EN")).not.toContain("copy pending");
  });
});

describe("🔴 the renderer — the leaver, the date as dd-mm-yyyy, one line per class «HH:mm · title»", () => {
  const p = (classes: object[]) => ({ kind: "teacher_leave_left_as_is_admin", leaver: "Mod", date: "2026-10-21", classes });
  test("EN: the sentence, then ONE LINE PER CLASS", () => {
    expect(render(p([{ startTime: "10:00", title: "Camp STA" }, { startTime: "14:00", title: "Yoga" }]), "EN"))
      .toBe("⚠️ Mod reported leave for today (21-10-2026). These classes have no teacher to take over (their other teachers aren't free then). Please handle them in the calendar: \n10:00 · Camp STA\n14:00 · Yoga");
  });
  test("a class without a title shows its time alone; no raw ISO date and no leftover placeholder in either language, even for an empty list", () => {
    expect(render(p([{ startTime: "09:30", title: null }]), "EN")).toContain("\n09:30");
    for (const lang of ["TH", "EN"] as const) {
      for (const classes of [[], [{ startTime: "10:00", title: "X" }]]) {
        const out = render(p(classes), lang);
        expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(out).not.toMatch(/\{[a-z]+\}/);
      }
    }
  });
});

describe("🔑 by source — the alert is reachable from the SAME-DAY act only, through THE admin helper, in the act's transaction", () => {
  const SVC = code(read("src/services/scheduler.service.ts"));
  test("one function sends it, through `notifyAdmins`, kind `teacher_leave_left_as_is_admin`, in the caller's transaction; no coach sender, no family sender, no `recipientType: \"parent\"`", () => {
    const F = region(SVC, "async function sendLeftAsIsAlertToAdmins(", "\n}\n");
    expect([...SVC.matchAll(/kind: "teacher_leave_left_as_is_admin"/g)]).toHaveLength(1);
    expect(F).toContain("await notifyAdmins({ kind: \"teacher_leave_left_as_is_admin\"");
    expect(F).toContain("}, tx, left[0]!.bookingId);");
    expect(F).not.toMatch(/sendCoLeaveNotices|sendClassCancelledToFamilies|enqueueParentCopies|recipientType: "parent"|enqueueLine\(/);
  });
  test("exactly ONE caller — the same-day act, with ALL its D4 classes at once; the advance record, the range, the lift and the PREVIEW never reach it", () => {
    expect([...SVC.matchAll(/sendLeftAsIsAlertToAdmins\(/g)]).toHaveLength(2); // the definition + the one call
    expect(region(SVC, "export async function reportTeacherLeave(", "export type SameDayContinuedClass")).toContain("await sendLeftAsIsAlertToAdmins(tx, me, input.date, toHandle);");
    for (const [from, to] of [["async function takeOffCoTaughtForLeaveDay(", "\n}\n"], ["async function reportTeacherLeaveRange(", "export async function reportTeacherLeave("], ["export async function previewTeacherLeave(", "\n}\n"], ["export async function liftTeacherLeave(", "\n}\n"]] as const) {
      expect({ fn: from, reaches: region(SVC, from, to).includes("sendLeftAsIsAlertToAdmins") }).toEqual({ fn: from, reaches: false });
    }
  });
});
