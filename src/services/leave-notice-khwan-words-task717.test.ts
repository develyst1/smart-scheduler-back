// TASK-717 (R147, owner-approved COPY-REVIEW-2026-09-29.md:592 item 4) — the leave cut-off refusal in KHWAN's words, the number from the SETTING. One function feeds both doors: the parent's «ลา» in LINE
// (the reader's language) and the calendar's `LEAVE_NOTICE_TOO_LATE` refusal (Thai). Her sentence drops "this one starts at {time}" — the `startTime` argument is kept in the signature (the callers are
// unchanged) and is IGNORED.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { leaveNoticeMessage } from "../lib/leave-notice";

const TH = (n: number) => `ขออภัยค่ะ การลาต้องแจ้งล่วงหน้าอย่างน้อย ${n} ชม. ก่อนเริ่มคลาส\nกรณีฉุกเฉิน กรุณาติดต่อแอดมินค่ะ`;
const EN = (n: number) => `Sorry, absences must be requested at least ${n} hour(s) before the class starts.\nFor emergencies, please contact Admin.`;

describe("🔴 R147 — Khwan's words, byte for byte, the number from the setting", () => {
  for (const n of [1, 3, 24]) {
    test(`cutoffHours = ${n}: TH and EN exact, two lines`, () => {
      expect(leaveNoticeMessage(n, "13:00:00", "TH")).toBe(TH(n));
      expect(leaveNoticeMessage(n, "13:00:00", "EN")).toBe(EN(n));
    });
  }
  test("Thai is the default reader (the calendar refusal passes no language)", () => {
    expect(leaveNoticeMessage(3, "09:00")).toBe(TH(3));
  });
  test("the session's start time is NOT in the sentence (her sentence has none): any startTime ⇒ the same text", () => {
    expect(leaveNoticeMessage(3, "09:00")).toBe(leaveNoticeMessage(3, "21:30:00"));
    expect(leaveNoticeMessage(3, "09:00", "EN")).not.toMatch(/\d\d:\d\d/);
  });
  test("a number that is not a whole hour is printed as the setting holds it (no rounding, no fixed 1)", () => {
    expect(leaveNoticeMessage(1.5, "10:00", "TH")).toBe(TH(1.5));
  });
});

describe("🔑 by source — both doors read this one function, in the right language", () => {
  const read = (f: string) => readFileSync(resolve(import.meta.dir, f), "utf8").replace(/\r\n/g, "\n");
  test("the calendar's refusal (TH, no language passed) ×2 and the LINE reply (the reader's language)", () => {
    const S = read("scheduler.service.ts");
    expect([...S.matchAll(/conflict\("LEAVE_NOTICE_TOO_LATE", leaveNoticeMessage\(cutoffHours, (?:b|current)\.startTime\)\)/g)]).toHaveLength(2);
    expect(read("line-webhook.service.ts")).toContain("leaveNoticeMessage(cutoffHours, b.startTime, lang)");
  });
});
