// TASK-635 — the two APPROVED refusals (`§T-609-CAP`, `§T-629-MERGE`), owner-ruled 2026-10-04 through @Porter.
//
// 🔑 Both are pinned BY SHAPE, not by string equality — @Sober's instruction and the right one: **the owner can rewrite every
//    word, and a test that asserts the bytes turns his next edit into a test failure instead of a copy change.** What may not
//    change silently is what each sentence PROMISES.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import { NOT_ON_ROW } from "../services/other-series.service";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const raw = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (f: string) => raw(f).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SCHED = code("src/services/scheduler.service.ts");
const OS = code("src/services/other-series.service.ts");

describe("🔻 §T-609-CAP — RETIRED by TASK-643: the refusal is GONE, and that is ASSERTED, not merely unasserted", () => {
  // ⚠️ This block used to pin the approved sentence by SHAPE — the count, the lever it names, the unlock it refuses to promise.
  // The owner then abolished the RULE (TASK-636 §1): the customer does not limit pre-start absences, and on the deployed build
  // never did. 🔑 *A refusal for a rule that no longer exists is worse than no refusal.*
  // 🔴 **An absent check and a check for ABSENCE are different things** — so the block stays, INVERTED, rather than deleted.
  // 📌 Not wasted: the words were right for the rule in force, and the owner approved them the day before he removed it.
  test("the sentence, its code, and its interpolated count are all gone from the service", () => {
    expect(SCHED).not.toContain("DECLARED_ABSENCE_CAP");
    expect(SCHED).not.toContain("โควตาลาที่ซื้อไว้แล้ว");
    expect(SCHED).not.toMatch(/\$\{pre\.declared\}/);
  });
  test("🔑 and NOTHING replaced it — no second refusal took its place on that path", () => {
    const at = SCHED.indexOf("const declaredFree = await preStartDeclaration(tx, current);");
    expect(at).toBeGreaterThan(0); // 🔑 the anchor is checked BEFORE it is sliced on (TASK-635's own lesson)
    const LEAVE = SCHED.slice(at);
    const upToWrite = LEAVE.slice(0, LEAVE.indexOf('.set({ status: "SICK_LEAVE"'));
    expect(upToWrite).not.toMatch(/throw |conflict\(/);
  });
  test("✅ the OTHER unlock-bearing refusal is untouched — the contrast rule outlives its own subject", () => {
    // 🔑 TASK-635's finding still holds in both directions: the refusal for a rule that CAN be unlocked must keep offering it.
    const at = SCHED.indexOf('conflict("LEAVE_LOCKED"');
    expect(at).toBeGreaterThan(0);
    expect(SCHED.slice(at, at + 200)).toContain("ปลดล็อก");
  });
  test("📌 what the rule WAS, kept as a record for whoever reinstates a limit one day", () => {
    // 🚫 A record, NOT a template: if a cap ever returns, its sentence is written from the rule then in force.
    const WAS = "คอร์สนี้ประกาศวันหยุดล่วงหน้าครบตามโควตาลาที่ซื้อไว้แล้ว {declared}/{quota} วัน — ถ้าต้องการมากกว่านี้ ต้องแก้โควตาลาของคอร์สก่อน หรือเริ่มเรียนแล้วจึงแจ้งลาตามปกติ";
    expect(WAS).toContain("{declared}/{quota}"); // it named the count
    expect(WAS).toContain("โควตาลาของคอร์ส"); // …and the one lever that existed
    expect(WAS).not.toContain("ปลดล็อก"); // 🔑 because no unlock existed on that path — the finding that caused the reword
    expect(SCHED).not.toContain(WAS.slice(0, 30)); // …and it is not in the product any more
  });
});

describe("🔴 §T-629-MERGE — ONE sentence for both cases, and exactly ONE producer of it", () => {
  test("by value: both cases raise the same sentence, naming the date that disagreed", () => {
    const e = NOT_ON_ROW("2026-10-19") as ApiException;
    expect(e.status).toBe(400);
    expect(e.message).toContain("2026-10-19");
    expect(e.message).toBe("วันที่ 2026-10-19 ครูที่ระบุไม่ได้อยู่ในตารางของวันนั้น");
  });
  test("🔴 exactly ONE producer — two copies of a merged sentence is the merge undone at the first edit", () => {
    expect((OS.match(/NOT_ON_ROW =/g) ?? []).length).toBe(1);
    expect((OS.match(/NOT_ON_ROW\(/g) ?? []).length).toBe(1); // one call site, both branches reaching it
    // 🔑 nothing else in the codebase writes either sentence
    for (const f of ["src/services/other-series.service.ts", "src/services/scheduler.service.ts", "src/routes/api.ts", "src/lib/booking-undo.ts"]) {
      expect({ f, hits: (code(f).match(/ไม่ได้อยู่ในตารางของวันนั้น/g) ?? []).length }).toEqual({ f, hits: f.endsWith("other-series.service.ts") ? 1 : 0 });
    }
  });
  test("🚫 the two sentences it replaced are GONE from the source — including the one that had shipped", () => {
    const ALL = ["src/services/other-series.service.ts", "src/services/scheduler.service.ts"].map(code).join("\n");
    expect(ALL).not.toContain("ครูคนแรกไม่ใช่คนที่ระบุ"); // TASK-428's shipped sentence
    expect(ALL).not.toContain("ครูคนนี้ไม่ได้อยู่ในตารางของวันนี้"); // my TASK-629 draft
  });
  test("⚠️ the `onExtra` argument is gone from the signature — a parameter that no longer changes the answer is a lie waiting to be used", () => {
    expect(OS).toContain("export const NOT_ON_ROW = (date: string) =>");
    expect(OS).not.toMatch(/NOT_ON_ROW\(r\.date, onExtra\)/);
    // …and the BRANCH itself is untouched: which location `from` occupies still decides the act, it just no longer decides the words
    expect(OS).toContain("if (onExtra ? !extrasOf(r).includes(input.from) : r.teacherId !== input.from) throw NOT_ON_ROW(r.date);");
  });
  test("📌 the owner's ruling is recorded AT the code, so the next reader knows a shipped sentence was replaced deliberately", () => {
    const R = raw("src/services/other-series.service.ts");
    expect(R).toContain("§T-629-MERGE");
    expect(R).toContain("owner-approved 2026-10-04");
    expect(raw("src/services/scheduler.service.ts")).toContain("§T-609-CAP");
  });
});
