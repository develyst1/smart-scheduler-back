// TASK-389 (`REQ-094`) — a make-up (born EXTENDED, purple) is confirmed by the BULK confirm like a PENDING one, so
// the end-of-day auto-mark (CONFIRMED-only, correct) can attend it. The pre-check is pure and asserted by value; the
// bulk loop, the single confirm's lack of a status guard, and the job's select are pinned by source — the job's
// select BYTE-frozen, because "add EXTENDED to the job" is the wrong fix and must stay unshippable.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { preCheckBulkConfirm } from "./bulk-confirm";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a);
  return s.slice(a, b < 0 ? undefined : b);
};

describe("🔴 the bulk over {PENDING, EXTENDED, CONFIRMED, SICK_LEAVE} confirms exactly the first two", () => {
  test("by value: PENDING and EXTENDED proceed; CONFIRMED is already_confirmed; SICK_LEAVE is skipped with the sentence", () => {
    const fates = ["PENDING", "EXTENDED", "CONFIRMED", "SICK_LEAVE"].map((status) => [status, preCheckBulkConfirm({ status })] as const);
    expect(fates).toEqual([
      ["PENDING", { proceed: true }],
      ["EXTENDED", { proceed: true }],
      ["CONFIRMED", { proceed: false, outcome: "already_confirmed" }],
      ["SICK_LEAVE", { proceed: false, outcome: "skipped", reason: "ไม่ใช่คาบที่รอยืนยัน" }],
    ]);
    expect(fates.filter(([, f]) => f.proceed).map(([s]) => s)).toEqual(["PENDING", "EXTENDED"]);
  });
  test("the one line: `PENDING || EXTENDED` proceeds — nothing else moved (CANCELLED / PAUSED / NO_SHOW still skipped; a bulk never un-cancels)", () => {
    const S = code(src("src/lib/bulk-confirm.ts"));
    expect(S).toContain('if (booking.status === "PENDING" || booking.status === "EXTENDED") return { proceed: true };');
    for (const status of ["CANCELLED", "PAUSED", "NO_SHOW"]) expect(preCheckBulkConfirm({ status })).toMatchObject({ proceed: false, outcome: "skipped" });
    expect(preCheckBulkConfirm({ status: "ATTENDED" })).toEqual({ proceed: false, outcome: "already_confirmed" });
  });
});

describe("🔴 the path a proceeding id takes is the REAL single confirm — which has no status guard, so an EXTENDED row becomes CONFIRMED (source)", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  test("`bulkConfirm` loops: read the row → `preCheckBulkConfirm` → `updateBookingStatus(id, \"confirm\")` — the same path as a single confirm", () => {
    const B = region(SVC, "export async function bulkConfirm(", "\n}\n");
    expect(B).toContain("const pre = preCheckBulkConfirm(booking);");
    expect(B).toContain('await updateBookingStatus(id, "confirm");');
    expect(B.indexOf("preCheckBulkConfirm(booking)")).toBeLessThan(B.indexOf('updateBookingStatus(id, "confirm")'));
  });
  test("the single confirm's branch reads only `confirmedAt` (idempotency), never `status` — EXTENDED and PENDING are the same to it; the write sets CONFIRMED + confirmedAt", () => {
    const C = region(SVC, 'if (action === "confirm") {', 'if (action === "attend")');
    expect(C).toContain("if (current.confirmedAt) {");
    expect(C).toContain('.set({ status: "CONFIRMED", confirmedAt: new Date() })');
    expect(C.slice(0, C.indexOf(".set({"))).not.toMatch(/current\.status/);
  });
});

describe("🚫 the job's select is CONFIRMED-only and BYTE-frozen — the fix is upstream, never here", () => {
  const JOB = readSrc(readFileSync(resolve(root, "src/services/jobs.service.ts"), "utf8")).replace(/\r\n/g, "\n");
  test("the literal", () => {
    expect(JOB).toContain('      .where(and(eq(bookings.date, runDate), eq(bookings.status, "CONFIRMED"), ended));');
    expect(code(JOB)).not.toMatch(/inArray\(bookings\.status/);
    expect(code(JOB)).not.toContain('"EXTENDED"');
  });
  test("after a bulk confirm the row IS what the job selects: the bulk's write sets `status: \"CONFIRMED\"`, the job's filter is `status = CONFIRMED` — one literal on each side", () => {
    // The two sides meet on the same string; a rename on either would break this pin, which is the point.
    expect(code(src("src/services/scheduler.service.ts"))).toContain('.set({ status: "CONFIRMED", confirmedAt: new Date() })');
    expect(JOB).toContain('eq(bookings.status, "CONFIRMED")');
  });
  test("56 = 56 — REQ-094 added no migration (0038 … 0055 are other tasks')", () => {
    expect(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8").match(/"tag"/g)!.length).toBe(56);
  });
});
