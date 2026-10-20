// TASK-827 (REQ-125 ruling B, DESIGN §4, D5) — the LINE notices, approved word for word (COPY-REVIEW 2026-10-20, «ข้อความ OK»):
//   · to each REMAINING coach, ONE per coach per day: «{name} is away on {date}. These classes go on with you: {list}», plus «(you are now the main teacher of this class)» on the class where they were promoted;
//   · the LEAVING teacher's `teacher_leave_recorded` gains «{n} co-taught class(es) continue with the other teachers» when n > 0 — and is byte-identical when there is none;
//   · FAMILIES are never told about a class that continues (the by-value proof of the senders is in the 825 / 826 files, next to the acts that send them).
// This file pins the WORDS and the renderer; the three strings are pinned verbatim, in both languages.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { t } from "./line-i18n";

const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const ctx = { date: "", startTime: "", endTime: "" } as any;
const render = (payload: any, lang: "TH" | "EN") => formatOutboxMessage(payload, ctx, lang, "teacher");
const APPROVED = "✅ APPROVED by the owner 2026-10-20 (REQ-125 ruling B), COPY-REVIEW-2026-09-29.md, verbatim";

describe("✅ the three strings — the owner's APPROVED wording, verbatim, TH + EN", () => {
  test("the LINE to a remaining coach, its “now the main teacher” suffix, and the leaver's extra line", () => {
    expect(t("ob_tl_coach_continues", "TH")).toBe("ครู {name} ลาวันที่ {date} — คาบต่อไปนี้ยังเรียนตามปกติกับคุณ: {list}");
    expect(t("ob_tl_coach_continues", "EN")).toBe("{name} is away on {date}. These classes go on with you: {list}");
    expect(t("ob_tl_coach_now_main", "TH")).toBe("(คุณเป็นครูหลักของคาบนี้แทน)");
    expect(t("ob_tl_coach_now_main", "EN")).toBe("(you are now the main teacher of this class)");
    expect(t("ob_tl_co_taught_continue", "TH", { n: 2 })).toBe("คาบที่สอนร่วม 2 คาบ ครูท่านอื่นจะสอนต่อ");
    expect(t("ob_tl_co_taught_continue", "EN", { n: 2 })).toBe("2 co-taught class(es) continue with the other teachers");
  });
  test("each is marked APPROVED in the table (not a draft)", () => {
    const I = read("src/lib/line-i18n.ts");
    expect(I).toContain(`// 🔻 TASK-827 (REQ-125 ruling B, D5) — ${APPROVED}. To a REMAINING coach`);
    expect(I).toContain(`// 🔻 TASK-827 — ${APPROVED}. One extra line on the LEAVING teacher's`);
    expect(I).not.toMatch(/ob_tl_(coach_continues|coach_now_main|co_taught_continue)[^\n]*DRAFT/);
  });
});

describe("🔴 the LINE to a remaining coach — «{name} is away on {date}. These classes go on with you: {list}»", () => {
  const p = (classes: object[]) => ({ kind: "teacher_coleave_continues", leaver: "Mod", date: "2026-10-23", classes });
  test("EN: the leaver, the date as dd-mm-yyyy, each class «title HH:mm», and the suffix ONLY on the class where they became main", () => {
    expect(render(p([{ startTime: "10:00", title: "Camp STA", becameMain: true }, { startTime: "12:00", title: "Yoga", becameMain: false }]), "EN"))
      .toBe("Mod is away on 23-10-2026. These classes go on with you: Camp STA 10:00 (you are now the main teacher of this class), Yoga 12:00");
  });
  test("TH: the same, in the chat's language", () => {
    expect(render(p([{ startTime: "14:00", title: "STA ECA", becameMain: true }]), "TH"))
      .toBe("ครู Mod ลาวันที่ 23-10-2026 — คาบต่อไปนี้ยังเรียนตามปกติกับคุณ: STA ECA 14:00 (คุณเป็นครูหลักของคาบนี้แทน)");
  });
  test("a class without a title shows its time alone; nothing crashes on an empty list; no raw ISO date and no leftover «{…}» placeholder", () => {
    expect(render(p([{ startTime: "09:30", title: null, becameMain: false }]), "EN")).toBe("Mod is away on 23-10-2026. These classes go on with you: 09:30");
    for (const lang of ["TH", "EN"] as const) {
      const out = render(p([]), lang);
      expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(out).not.toMatch(/\{[a-z]+\}/);
    }
  });
  test("one message, no trailing whitespace, no “booking” furniture: it is a plain sentence about a DAY", () => {
    const out = render(p([{ startTime: "10:00", title: "Camp", becameMain: false }]), "EN");
    expect(out).toBe(out.trimEnd());
    expect(out.split("\n")).toHaveLength(1);
  });
});

describe("🔴 the leaver's `teacher_leave_recorded` — the extra line only when n > 0; otherwise BYTE-IDENTICAL", () => {
  const base = { kind: "teacher_leave_recorded", date: "2026-10-22", classes: 2, actor: "Admin D" };
  test("without `continued` (or 0) the notice is exactly today's (the approved P33 shape)", () => {
    const today = "🗓️ LEAVE RECORDED\nDate: 22-10-2026\nNo new class will be booked.\nThe 2 class(es) that already booked, still on. \nRecorded by: Admin D";
    expect(render(base, "EN")).toBe(today);
    expect(render({ ...base, continued: 0 }, "EN")).toBe(today);
  });
  test("with `continued: 2` the approved line rides between the «still on» line and «Recorded by» — EN and TH", () => {
    expect(render({ ...base, continued: 2 }, "EN")).toBe("🗓️ LEAVE RECORDED\nDate: 22-10-2026\nNo new class will be booked.\nThe 2 class(es) that already booked, still on. \n2 co-taught class(es) continue with the other teachers\nRecorded by: Admin D");
    expect(render({ ...base, continued: 2 }, "TH")).toContain("คาบที่สอนร่วม 2 คาบ ครูท่านอื่นจะสอนต่อ");
  });
  test("it also rides a notice with NO «still on» classes (everything of theirs continued), and a RANGE notice; the LIFT notice never carries it", () => {
    const none = render({ ...base, classes: 0, continued: 1 }, "EN");
    expect(none).toContain("1 co-taught class(es) continue with the other teachers");
    expect(none).not.toContain("still on");
    expect(render({ ...base, to: "2026-10-24", continued: 3 }, "EN")).toContain("3 co-taught class(es) continue with the other teachers");
    expect(render({ kind: "teacher_leave_lifted", date: "2026-10-22", actor: "Admin D", continued: 3 }, "EN")).not.toContain("co-taught");
  });
});

describe("🔑 by source — the senders: one place, the same transaction, never a family", () => {
  const SVC = read("src/services/scheduler.service.ts").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  const region = (s: string, from: string, to: string) => { const a = s.indexOf(from); expect(a).toBeGreaterThan(-1); return s.slice(a, s.indexOf(to, a + from.length)); };
  test("the coach notice is enqueued in ONE function, `sendCoLeaveNotices`, in the caller's transaction, to a TEACHER recipient, kind `teacher_coleave_continues`; no family sender is reachable from it", () => {
    const F = region(SVC, "async function sendCoLeaveNotices(", "\n}\n");
    expect([...SVC.matchAll(/kind: "teacher_coleave_continues"/g)]).toHaveLength(1);
    expect(F).toContain('recipientType: "teacher"');
    expect(F).toContain("}, tx);");
    expect(F).not.toMatch(/sendClassCancelledToFamilies|enqueueParentCopies|recipientType: "parent"|familyAccountsOfRow/);
  });
  test("both paths call it: the same-day act (after its loop, inside its transaction) and the advance take-off (end of the per-day function)", () => {
    expect(region(SVC, "export async function reportTeacherLeave(", "export type SameDayContinuedClass")).toContain("await sendCoLeaveNotices(tx, me, input.date, [...coachNotices.values()]);");
    expect(region(SVC, "async function takeOffCoTaughtForLeaveDay(", "\n}\n")).toContain("await sendCoLeaveNotices(tx, me, date, remainingCoaches);");
    expect([...SVC.matchAll(/sendCoLeaveNotices\(/g)]).toHaveLength(3); // the definition + the two callers
  });
  test("the leaver's own notice carries `continued` only when > 0, on the advance paths (single day and range)", () => {
    expect(SVC).toContain("...(split?.continues.length ? { continued: split.continues.length } : {}), actor })");
    expect(SVC).toContain("...(continued ? { continued } : {}), actor })");
  });
});
