// TASK-657 §R (REQ-112) — the "we do not know if this leave used quota" refusal DISSOLVED.
//
// 🔑 History: §T-G (COPY-REVIEW-2026-09-29, owner-approved 2026-10-04 "1 ผ่านหมด") reworded `UNDO_LEAVE_CHARGE_UNKNOWN` so it named the course, the date
//    and the one thing to check. REQ-112 then removed the quota itself — no leave consumes one — so "did this leave use quota?" has no subject, and the
//    refusal that asked it is gone. Its approved sentence is NOT shipped anywhere else: it simply stops being reachable.
// ⚠️ This file was `undo-charge-unknown-sentence-tg.test.ts`, which pinned that sentence's SHAPE. A test named for a sentence that no longer exists is a
//    claim nobody can check, so it is retired and renamed, and what it still protects (the SLOT_TAKEN name rule, the planner's single decision point) is below.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import * as BU from "./booking-undo";
import { UNDO_SLOT_TAKEN } from "./booking-undo";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("🔴 TASK-657 §R — `UNDO_LEAVE_CHARGE_UNKNOWN` is GONE, asked of the CODE (statements, not comments)", () => {
  test("the export, the sentence and every caller are deleted", () => {
    expect(Object.keys(BU)).not.toContain("UNDO_LEAVE_CHARGE_UNKNOWN");
    for (const f of ["src/lib/booking-undo.ts", "src/services/undo.service.ts", "src/routes/api.ts"]) {
      expect({ f, hit: /UNDO_LEAVE_CHARGE_UNKNOWN/.test(code(f)) }).toEqual({ f, hit: false });
    }
    expect(code("src/lib/booking-undo.ts")).not.toContain("ย้อนการลานี้ไม่ได้ เพราะเป็นการลาที่บันทึกไว้ก่อนระบบจะเก็บว่าใช้โควตาหรือไม่"); // the approved sentence is nowhere
  });
  test("`leaveChargeOf` can no longer answer \"unknown\" — two answers, one argument", () => {
    expect(BU.leaveChargeOf.length).toBe(1);
    expect(BU.leaveChargeOf({ leaveCharged: null, courseId: "c", plannedAtCreation: false })).toBe("charged");
    expect(code("src/lib/booking-undo.ts")).not.toContain('"unknown"');
  });
});

describe("✅ what survives of §T-G: the ONE name rule on the slot-holder refusal, and the planner's decisions", () => {
  test("`UNDO_SLOT_TAKEN` still names the holder by `displayNameOf(...) || \"คาบอื่น\"`", () => {
    expect(code("src/services/undo.service.ts")).toContain('displayNameOf(holder) || "คาบอื่น"');
    expect((UNDO_SLOT_TAKEN("10:00", "คาบอื่น") as ApiException).message).toContain("คาบอื่น");
  });
  test("the planner reads the row, then (only) the slot holder — no read was added for the removed refusal, and none for the removed expiry rule", () => {
    const S = code("src/services/undo.service.ts");
    const PLAN = S.slice(S.indexOf("export async function planUndo("), S.indexOf("export async function undoBooking("));
    const reads = [...PLAN.matchAll(/tx\.query\.bookings\.findFirst\(/g)];
    expect(reads).toHaveLength(2);
    expect(PLAN.slice(reads[1]!.index!, reads[1]!.index! + 400)).toContain("SLOT_INACTIVE_STATUSES");
    expect(PLAN).not.toMatch(/courseExpiryChanges|expiryRecordingMarker/); // the expiry reads are gone with the rule
  });
});
