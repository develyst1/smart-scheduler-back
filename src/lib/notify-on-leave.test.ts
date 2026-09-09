// 🔻 TASK-306 §3 (REQ-085 §9) — **`notify_on_leave` was REMOVED, and this file is the record of why.**
//
// It used to assert the setting's shape: an enum of `admin_only` / `admin_and_teacher`, defaulting to
// `admin_only`, choosing who is told when a student takes leave.
//
// 🔴 The owner's instruction is unconditional — *"เฉพาะแชทครู / แอดมิน"* — so **a setting offering that choice
// can only ever be wrong**, and an admin who set it would believe they had changed something.
//
// 📌 The finding underneath it is the one worth keeping: **the teacher notification was never un-built.** It sat
// behind `if (notifyOnLeave === "admin_and_teacher")` with the default `admin_only`, so on a default install
// that branch never ran — and the owner reported the feature as missing, **twice**.
// 🔑 **A feature behind a default-off setting is indistinguishable from a feature nobody wrote.**
//
// 🚫 This file is REWRITTEN rather than deleted: a control removed on a ruling deserves an assertion that it
// stays removed, so the next person to add one has to mean it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SETTINGS, resolveSetting } from "./settings";
import { formatOutboxMessage } from "./line-message";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));

describe("🔻 TASK-306 — the removed control stays removed", () => {
  test("🔑 `notify_on_leave` is gone from the registry", () => {
    // 📌 The settings SCREEN is `Object.keys(SETTINGS)` (`settings.service.ts:52`), so removing the row removes
    // the field — there is no second list to keep in step, and no FE change was needed.
    expect(Object.keys(SETTINGS)).not.toContain("notify_on_leave");
  });

  test("🚫 …and nothing reads it — asserted on the source, not remembered", () => {
    // ⚠️ The ruling rested on *"unread by any code path"*. This is that claim, kept true rather than trusted.
    for (const f of [
      "src/lib/settings.ts",
      "src/services/scheduler.service.ts",
      "src/services/settings.service.ts",
    ]) {
      // ⚠️ Comments stripped first — the gravestone in `settings.ts` NAMES the removed key and the branch it
      // sat behind, so a raw grep would count my own explanation as a reader. (It did, on the first run.)
      const code = src(f).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      const hits = (code.match(/notifyOnLeave|SETTINGS\.notify_on_leave|"notify_on_leave"/g) ?? []).length;
      expect({ f, hits }).toEqual({ f, hits: 0 });
    }
  });

  test("📌 the reason is written where the row was — a gravestone, not a silent gap", () => {
    // A removed control with no note reads as an oversight to the next person, who adds it back.
    const S = src("src/lib/settings.ts");
    expect(S).toContain("`notify_on_leave` was REMOVED");
    expect(S).toContain("indistinguishable from a feature nobody wrote");
  });

  test("the other rules are untouched by the removal", () => {
    expect(resolveSetting("checkin_early_minutes", 45)).toEqual({ value: 45, isDefault: false });
    expect(resolveSetting("teacher_change_notice_days", undefined).value).toBe(3);
  });
});

describe("🔻 TASK-306 — two message kinds that nothing sends any more", () => {
  // ⚠️ **A consequence I created and am naming rather than leaving to be found.** TASK-305 replaced the admin's
  // `sick_leave` alert and the gated `leave_teacher` push with ONE `leave_notice`. ⇒ **neither kind is enqueued
  // by any non-test code now.** Their renderers still work, and these tests still pass — which is exactly the
  // shape that makes dead code look alive.
  // 🚫 Not removed here: TASK-306 says remove nothing else, and whether they go is @Sober's call.
  const ctx = { studentName: "น้องซี", teacherNickname: "ก้อง", subject: "Surfskate", date: "2026-09-01", startTime: "10:00" };

  test("🔴 neither `leave_teacher` nor `sick_leave` is enqueued anywhere", () => {
    // The assertion that makes the finding durable: if either is wired up again, this fails and whoever did it
    // reads the note above.
    const SVC = src("src/services/scheduler.service.ts");
    expect(SVC).not.toContain('kind: "leave_teacher"');
    expect(SVC).not.toContain('kind: "sick_leave"');
  });

  test("…and their renderers still work, which is why nothing else notices", () => {
    expect(formatOutboxMessage({ kind: "leave_teacher", studentName: "น้องซี" }, ctx, "TH")).toBe(
      "น้องซี ลาคาบ 2026-09-01 10:00 น. (Surfskate) — ช่วงเวลานี้ว่างแล้วค่ะ",
    );
    expect(formatOutboxMessage({ kind: "sick_leave", studentName: "น้องซี", via: "line" }, ctx, "TH")).toContain(
      "แจ้งลา",
    );
  });

  test("a missing field renders '-', never a raw {placeholder}", () => {
    const msg = formatOutboxMessage({ kind: "leave_teacher" }, {}, "TH");
    expect(msg).not.toContain("{");
    expect(msg).toContain("-");
  });
});
