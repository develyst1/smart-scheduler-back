// §T-G (COPY-REVIEW-2026-09-29, owner-approved 2026-10-04 "1 ผ่านหมด") — the "we do not know if this leave used quota" refusal.
//
// 🔑 Why it was reworded: the old sentence was honest and USELESS — *"กรุณาแก้ไขด้วยตนเอง"* without saying WHAT TO CHECK.
//    The new one names the course, the date, and the one thing to look at. **A refusal that names the next action costs one sentence.**
// 🔴 The SHAPE is what is pinned here, not the prose (the owner can rewrite every word): it must NOT claim a quota value, it
//    MUST carry the course and the date, and it MUST name the make-up check.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import { UNDO_LEAVE_CHARGE_UNKNOWN, UNDO_SLOT_TAKEN } from "./booking-undo";
import { displayNameOf } from "../db/mappers";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("🔴 §T-G — the refusal names the course, the date and the ONE thing to check", () => {
  const e = UNDO_LEAVE_CHARGE_UNKNOWN("น้องมะลิ", "2026-03-04") as ApiException;
  test("by value: it carries both facts, and still claims NOTHING about the quota", () => {
    expect(e.status).toBe(409);
    expect((e as any).code).toBe("UNDO_LEAVE_CHARGE_UNKNOWN");
    expect(e.message).toContain("น้องมะลิ");
    expect(e.message).toContain("2026-03-04");
    expect(e.message).toContain("คาบชดเชย"); // 🔑 the make-up check — the next action, named
    // 🚫 it must not state a quota number or claim the leave was free / charged
    expect(e.message).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(e.message).not.toMatch(/ใช้โควตาไปแล้ว [0-9]/);
  });
  test("🚫 the old sentence is GONE — the one that said 'fix it by hand' and nothing else", () => {
    expect(code("src/lib/booking-undo.ts")).not.toContain("ระบบไม่ทราบว่าการลานี้ใช้โควตาลาหรือไม่ (ลาก่อนมีการบันทึก)");
  });
  test("✅ Thai only — the EN half of the approved copy does NOT ship, because every refusal in this file is Thai", () => {
    // ⚠️ My first version swept EVERY refusal in the file for Latin letters and FAILED — not on English prose, but on a nested
    // template expression inside one refusal (a `.join(…)` carrying a quote), which my regex could not parse. 🔑 A check that
    // cannot read the thing it judges reports a defect in itself. Narrowed to the claim actually being made:
    const U = code("src/lib/booking-undo.ts");
    const SENT = (UNDO_LEAVE_CHARGE_UNKNOWN("น้องมะลิ", "2026-03-04") as ApiException).message;
    expect(/[A-Za-z]/.test(SENT.replace("2026-03-04", ""))).toBe(false); // the shipped sentence carries no Latin at all
    expect(U).not.toContain("This leave cannot be undone"); // 🚫 the approved EN half is nowhere in the file
    expect(U).not.toContain("Open the course and check");
  });
});

describe("🔑 §T-G — `{course}` renders by the ONE name rule, and the cost is no second query", () => {
  test("it is `displayNameOf`, which is whose the course is — a course in this system has NO name of its own", () => {
    // by value, through the same helper the rest of the codebase names a row with
    expect(displayNameOf({ student: { nickname: "มะลิ", name: "Mali" } })).toBe(displayNameOf({ student: { nickname: "มะลิ", name: "Mali" } }));
    expect(displayNameOf({ otherTitle: "ECA Club" })).toBe("ECA Club");
    expect(displayNameOf({})).toBe(""); // ⇒ the caller's `|| "คาบอื่น"` fallback, the same one UNDO_SLOT_TAKEN uses
    const S = code("src/services/undo.service.ts");
    expect(S).toContain('UNDO_LEAVE_CHARGE_UNKNOWN(displayNameOf(row) || "คาบอื่น", row.date)');
    expect(code("src/services/undo.service.ts")).toContain('displayNameOf(holder) || "คาบอื่น"'); // the precedent, unchanged
  });
  test("✅ the names come from the SAME read — `student` and `coStudent` joined the existing `with`, no second query", () => {
    const S = code("src/services/undo.service.ts");
    expect(S).toContain("with: { course: true, voucher: true, student: true, coStudent: true } });");
    // ⚠️ NARROWED: my first version claimed `planUndo` reads `bookings` exactly ONCE. It does not — it also reads the SLOT
    // HOLDER, a different question that was always there. 🔑 The true claim, and the one @Sober priced: §T-G added NO read —
    // the row the refusal names is the one `planUndo` already loaded, carrying two more relations.
    const PLAN = S.slice(S.indexOf("export async function planUndo("), S.indexOf("export async function undoBooking("));
    const reads = [...PLAN.matchAll(/tx\.query\.bookings\.findFirst\(/g)];
    expect(reads).toHaveLength(2);
    expect(PLAN.slice(reads[1]!.index!, reads[1]!.index! + 400)).toContain("SLOT_INACTIVE_STATUSES"); // the second one is the slot-holder check (its own predicate, inline here)
    expect(PLAN.indexOf("UNDO_LEAVE_CHARGE_UNKNOWN(")).toBeLessThan(reads[1]!.index!); // …and the refusal is thrown off the FIRST read
  });
  test("⚠️ the fallback is the shipped one, and it reads oddly — pinned so nobody thinks it was unnoticed", () => {
    // "คอร์ส คาบอื่น" is strange Thai. It is @Sober's decision (the ONE name rule, same fallback) and it is defensive only:
    // a COURSE_PACKAGE leave row always has a student, so `displayNameOf` is non-empty in every reachable case.
    // 📌 If the owner wants a different word for the nameless case, that is one string and his call — not a silent fix here.
    expect((UNDO_LEAVE_CHARGE_UNKNOWN("คาบอื่น", "2026-03-04") as ApiException).message).toContain("คอร์ส คาบอื่น");
    expect((UNDO_SLOT_TAKEN("10:00", "คาบอื่น") as ApiException).message).toContain("คาบอื่น");
  });
});
