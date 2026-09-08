// TASK-290 — the plan DTO could not say a session was cancelled BY A PAUSE.
//
// 🔴 The symptom @Fern hit: the plan modal shows **8 rows for a 4-session course**, because `toSessionRow`
// carried `status` and not the reason. Every `CANCELLED` row looks the same on the wire.
//
// 🔑 She stopped and asked rather than matching on the note client-side, and her reason is the ruling: shipping
// `"พักคอร์สชั่วคราว"` would put **two copies of one Thai sentence in two repos, one of them a UI-language
// literal.** ⇒ the client receives a FACT; the sentence stays server-side.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COURSE_PAUSE_NOTE, isCancelledByPause } from "./course-plan";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("TASK-290 — true ONLY for a pause, and the other cancels are the test", () => {
  test("🔑 a pause-cancelled session is `true`", () => {
    expect(isCancelledByPause({ status: "CANCELLED", note: COURSE_PAUSE_NOTE })).toBe(true);
  });

  test("🔑 a HAND-cancelled session is `false` — the distinction the whole field exists for", () => {
    // A hand cancel is a decision somebody took about the plan; a pause cancel is the plan being replaced.
    // ⚠️ This is why the plan view does not simply hide every CANCELLED row — it would hide both kinds.
    expect(isCancelledByPause({ status: "CANCELLED", note: "ผู้ปกครองขอยกเลิก" })).toBe(false);
    // …and a hand cancel with no reason at all.
    expect(isCancelledByPause({ status: "CANCELLED", note: null })).toBe(false);
    expect(isCancelledByPause({ status: "CANCELLED" })).toBe(false);
  });

  test("🔴 the OTHER two sentences this codebase writes onto a CANCELLED row are `false`", () => {
    // Not invented for the test — these are the literals at `scheduler.service.ts:2169` (the reconciler
    // trimming an appended make-up) and `:3929` (a course ended early). Both leave a CANCELLED row carrying
    // text, so a `note !== null` test would call all three "paused" and the field would start lying.
    expect(isCancelledByPause({ status: "CANCELLED", note: "ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)" })).toBe(false);
    expect(isCancelledByPause({ status: "CANCELLED", note: "ยกเลิกคอร์ส (จบคอร์สก่อนกำหนด)" })).toBe(false);
  });

  test("🚫 the STATUS is part of the answer — the note alone is not enough", () => {
    // No path writes this today (the pause sets both in one `.set`), and that is exactly why it is asserted:
    // the field claims "cancelled by a pause", so a live row must never satisfy it however its note reads.
    expect(isCancelledByPause({ status: "PENDING", note: COURSE_PAUSE_NOTE })).toBe(false);
    expect(isCancelledByPause({ status: "SICK_LEAVE", note: COURSE_PAUSE_NOTE })).toBe(false);
  });
});

describe("TASK-290 — one literal, and the sentence does not cross the wire", () => {
  test("🔑 the Thai appears EXACTLY ONCE in the source — both sides read the constant", () => {
    // 📌 The constant was here before and I deleted it with TASK-282 §5's withdrawn design — correctly, because
    // nothing read it then. Something reads it now, and two inline copies compared to each other would be this
    // task's own defect one layer down.
    const files = [
      "src/lib/course-plan.ts",
      "src/services/scheduler.service.ts",
      "src/types/contract.ts",
    ];
    const counts = files.map((f) => ({ f, n: (src(f).match(/พักคอร์สชั่วคราว/g) ?? []).length }));
    expect(counts).toEqual([
      { f: "src/lib/course-plan.ts", n: 1 },
      { f: "src/services/scheduler.service.ts", n: 0 },
      { f: "src/types/contract.ts", n: 0 },
    ]);
    // …and both users name it rather than spelling it.
    const svc = code(src("src/services/scheduler.service.ts"));
    expect(svc).toContain('.set({ status: "CANCELLED", note: COURSE_PAUSE_NOTE })');
    expect(svc).toContain("cancelledByPause: isCancelledByPause(b),");
  });

  test("🚫 the note itself is NOT on the DTO — so it cannot start crossing the wire by accident", () => {
    const row = code(src("src/services/scheduler.service.ts"));
    const mapper = row.slice(row.indexOf("const toSessionRow = (b: any): PlanSessionRow => ({"));
    const body = mapper.slice(0, mapper.indexOf("});"));
    expect(body).not.toContain("note: b.note");
    // ⚠️ `attendeeNote` stays — REQ-068's "who is bringing the child", a different question one keystroke away.
    expect(body).toContain("attendeeNote: b.attendeeNote ?? null,");
    // The contract type is the guard that makes a dropped field a compile error (TASK-184); it must not name
    // the note either.
    const c = code(src("src/types/contract.ts"));
    const iface = c.slice(c.indexOf("export interface PlanSessionRow {"));
    // …to the closing brace at COLUMN ZERO: `teacher` is an inline object type, so a plain `indexOf("}")`
    // stops three fields early and the assertion below would pass on a truncation.
    const fields = iface.slice(0, iface.indexOf("\n}"));
    expect(fields).toContain("cancelledByPause: boolean;");
    expect(fields).not.toContain("note: string | null;");
  });
});
