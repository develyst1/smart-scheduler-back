// TASK-496 — the entitlement counters (`used_sessions`, `used_hours`, `used_units`, `leave_used`) move ONLY by `sql` arithmetic, and
// every decrement is floored with `GREATEST(…, 0)`. 🔑 Pinned by a SCAN over every production `.set({ … })`, not a list of line
// numbers: the next path someone adds is caught by the rule, not by remembering to extend a list. The day-end job had the right
// shape all along (`sql … + 1`, the post-value from `.returning()`); every other writer now copies it.
// 📌 Also here: TASK-258's sale reversal runs AFTER its transaction commits (it writes through `db`, outside the transaction).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const COUNTERS = ["usedSessions", "usedHours", "usedUnits", "leaveUsed"] as const;
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

/** Every `.set(…)` argument in a file, by balanced parentheses. */
const setCalls = (s: string): string[] => {
  const out: string[] = [];
  for (let i = s.indexOf(".set("); i >= 0; i = s.indexOf(".set(", i + 5)) {
    let depth = 0, j = i + 4;
    for (; j < s.length; j++) { if (s[j] === "(") depth++; else if (s[j] === ")" && --depth === 0) break; }
    out.push(s.slice(i + 5, j));
  }
  return out;
};
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
});
type Write = { file: string; counter: string; value: string };
const writes: Write[] = [];
for (const f of [...walk(resolve(root, "src")), ...walk(resolve(root, "scripts"))]) {
  const s = code(readSrc(readFileSync(f, "utf8")));
  for (const arg of setCalls(s)) {
    for (const m of arg.matchAll(new RegExp(`\\b(${COUNTERS.join("|")}):\\s*((?:sql\`[^\`]*\`)|[^,}\\n]+)`, "g"))) {
      writes.push({ file: f.slice(root.length + 1).replace(/\\/g, "/"), counter: m[1]!, value: m[2]!.trim() });
    }
  }
}

describe("🔴 the SCAN — no production write of an entitlement counter reads-then-writes", () => {
  test("every counter write is `sql` arithmetic on the column itself", () => {
    for (const w of writes) expect({ w, sql: /^sql`\$\{\w+\.(usedSessions|usedHours|usedUnits|leaveUsed)\} [+-] |^sql`GREATEST\(\$\{\w+\.\w+\} [+-] /.test(w.value) }).toEqual({ w, sql: true });
  });
  test("every DECREMENT is floored — `GREATEST(x - n, 0)` — and a signed delta (camp) is floored too", () => {
    for (const w of writes.filter((x) => / - |\+ \$\{delta\}/.test(x.value))) expect({ w, floored: /^sql`GREATEST\(.*, 0\)`$/.test(w.value) }).toEqual({ w, floored: true });
  });
  test("🔑 not vacuous, and by VALUE: every site, its counter and its amount — the same moves as before, only safe", () => {
    const list = writes.map((w) => `${w.file} · ${w.counter} · ${w.value}`).sort();
    expect(list).toEqual([
      "src/services/camp.service.ts · usedUnits · sql`${campPackages.usedUnits} + ${d.units}`", // redeem (was already sql)
      "src/services/camp.service.ts · usedUnits · sql`GREATEST(${campPackages.usedUnits} + ${delta}, 0)`", // markDay (TASK-496: was usedAfter(read, delta))
      "src/services/jobs.service.ts · usedHours · sql`${vouchers.usedHours} + 1`", // the day-end (the shape copied)
      "src/services/jobs.service.ts · usedSessions · sql`${coursePackages.usedSessions} + 1`",
      "src/services/scheduler.service.ts · leaveUsed · sql`${coursePackages.leaveUsed} + 1`", // Door 1 (TASK-492)
      "src/services/scheduler.service.ts · leaveUsed · sql`${coursePackages.leaveUsed} + 1`", // Door 2 (TASK-492)
      "src/services/scheduler.service.ts · usedHours · sql`${vouchers.usedHours} + 1`", // attend (TASK-496: was read + 1)
      "src/services/scheduler.service.ts · usedHours · sql`GREATEST(${vouchers.usedHours} - 1, 0)`", // the cancel of a delivered session (was afterReturn)
      "src/services/scheduler.service.ts · usedSessions · sql`${coursePackages.usedSessions} + 1`", // attend (TASK-496: was read + 1)
      "src/services/scheduler.service.ts · usedSessions · sql`GREATEST(${coursePackages.usedSessions} - 1, 0)`", // the cancel of a delivered session
      "src/services/undo.service.ts · leaveUsed · sql`GREATEST(${coursePackages.leaveUsed} - 1, 0)`", // TASK-492
      // 🔻 TASK-497 — TASK-258's undo and TASK-492's check-in Undo share ONE writer now: their four sites became these two.
      "src/services/attendance-revert.service.ts · usedHours · sql`GREATEST(${vouchers.usedHours} - 1, 0)`",
      "src/services/attendance-revert.service.ts · usedSessions · sql`GREATEST(${coursePackages.usedSessions} - 1, 0)`",
    ].sort());
  });
  test("the attend site's message reads the post-value FROM THE WRITE (`.returning()`), as the day-end does — never a JS `+ 1`", () => {
    const S = code(readSrc(readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8")));
    const attend = S.slice(S.indexOf('} else if (action === "attend")'), S.indexOf('} else if (action === "cancel")'));
    expect(attend).toContain(".returning({ usedSessions: coursePackages.usedSessions });");
    expect(attend).toContain(".returning({ usedHours: vouchers.usedHours });");
    expect(attend).not.toMatch(/\.(usedSessions|usedHours) \+ 1/);
  });
  test("the two JS floor helpers the counters no longer call are GONE (a helper nothing calls, with tests, is green dead code)", () => {
    expect(readFileSync(resolve(root, "src/lib/checkin-correction.ts"), "utf8")).not.toContain("export const afterReturn");
    expect(readFileSync(resolve(root, "src/lib/camp.ts"), "utf8")).not.toContain("export const usedAfter");
  });
});

describe("🔴 TASK-258's sale reversal runs AFTER its transaction commits (TASK-492's shape)", () => {
  test("the branch only raises a flag; the call sits after `db.transaction(…)` returns", () => {
    const S = code(readSrc(readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8")));
    const fn = S.slice(S.indexOf("export async function updateBookingStatus("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const txEnd = body.lastIndexOf("  });\n");
    expect(body.indexOf("let reverseSaleAfterCommit = false;")).toBeLessThan(body.indexOf("const result = await db.transaction("));
    expect(body.slice(0, txEnd)).toContain("reverseSaleAfterCommit = true;");
    expect(body.slice(0, txEnd)).not.toContain("reverseBookingSale(");
    expect(body.slice(txEnd)).toContain("if (reverseSaleAfterCommit) await reverseBookingSale(id);");
    expect((body.match(/reverseBookingSale\(/g) ?? []).length).toBe(1);
  });
});
