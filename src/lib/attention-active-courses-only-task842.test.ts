// TASK-842 (REQ-132) — the two Attention course checks count ACTIVE courses only (courseStatus), not ended / paused ones. Vouchers are unaffected; the LINE digest count follows.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ATTENTION_CHECKS, buildDigestMessage } from "./attention";

const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const TODAY = "2026-08-01";
const A = { id: "s-a", name: "Alice", nickname: "น้องเอ" };

// 1 left, expiring in 3 days — both lists would take it, were it active
const course = (over: any = {}) => ({ id: "c1", size: 10, usedSessions: 9, expiryDate: "2026-08-04", student: A, coStudent: null, endedAt: null, droppedAt: null, ...over });
const voucher = (over: any = {}) => ({ id: "v1", totalHours: 10, usedHours: 9, expiryDate: "2026-08-04", student: A, ...over });
const ctxOf = (load: any) => ({ today: TODAY, tomorrow: "2026-08-02", yesterday: "2026-07-31", expiryCutoff: "2026-08-15", salesWindowStart: "2026-07-01", load } as any);
const run = (key: string, load: any) => ATTENTION_CHECKS.find((c) => c.key === key)!.run(ctxOf(load));
const ids = (r: any) => r.items.map((i: any) => i.id);

const ENDED = course({ id: "c-end", endedAt: new Date("2026-07-20") });
const PAUSED = course({ id: "c-pause", droppedAt: new Date("2026-07-25") });
const BOTH = course({ id: "c-both", endedAt: new Date("2026-07-30"), droppedAt: new Date("2026-07-25") });
const ACTIVE = course({ id: "c-ok" });

describe("🔴 an ended / paused course is in NEITHER list; an ACTIVE one is in both", () => {
  test("nearly finished: only the active course (with 840's name + link)", async () => {
    const r = await run("nearly_finished_courses", { courses: async () => [ENDED, PAUSED, BOTH, ACTIVE] });
    expect(r.count).toBe(1);
    expect(r.items).toEqual([{ id: "c-ok", label: "น้องเอ · course 10 · เหลือ 1", link: { kind: "course", id: "c-ok" } }]);
  });
  test("expiring: only the active course (with 840's name + link)", async () => {
    const r = await run("expiring_entitlements", { courses: async () => [ENDED, PAUSED, BOTH, ACTIVE], vouchers: async () => [] });
    expect(r.count).toBe(1);
    expect(r.items).toEqual([{ id: "c-ok", label: "น้องเอ · course 10 · 2026-08-04", link: { kind: "course", id: "c-ok" } }]);
  });
  test("a paused course is out even when its window lapses mid-pause is irrelevant: paused with 1 left, 3 days to expiry ⇒ out of both", async () => {
    for (const key of ["nearly_finished_courses", "expiring_entitlements"]) {
      const r = await run(key, { courses: async () => [PAUSED], vouchers: async () => [] });
      expect(r.count).toBe(0);
    }
  });
});

describe("the digest count drops by exactly the ended / paused ones; a voucher is unaffected", () => {
  test("with 4 courses (2 active-eligible would-be) the counts are active only, and the digest says so", async () => {
    const load = { courses: async () => [ENDED, PAUSED, ACTIVE, course({ id: "c-ok2" })], vouchers: async () => [voucher()] };
    const nearly = await run("nearly_finished_courses", load);
    const expiring = await run("expiring_entitlements", load);
    expect(nearly.count).toBe(2);
    expect(expiring.count).toBe(3); // 2 active courses + 1 voucher
    const text = buildDigestMessage([{ key: "nearly_finished_courses", ...nearly }, { key: "expiring_entitlements", ...expiring }] as any, "TH");
    expect(text).toContain("2");
    expect(text).not.toContain("น้องเอ");
  });
  test("an expiring voucher is listed as before (vouchers are not course-status'd)", async () => {
    const r = await run("expiring_entitlements", { courses: async () => [ENDED, PAUSED], vouchers: async () => [voucher()] });
    expect(r.items).toEqual([{ id: "v1", label: "น้องเอ · voucher 10h · 2026-08-04", link: { kind: "voucher", id: "v1" } }]);
  });
});

describe("a row without the two fields reads as not ended / not paused (older callers)", () => {
  test("endedAt / droppedAt undefined ⇒ counted", async () => {
    const { endedAt, droppedAt, ...bare } = ACTIVE;
    const r = await run("nearly_finished_courses", { courses: async () => [bare] });
    expect(r.count).toBe(1);
  });
});

describe("🔑 by source — THE one status rule, `courseEligible` untouched", () => {
  const S = code(readFileSync(resolve(root, "src/lib/attention.ts"), "utf8").replace(/\r\n/g, "\n"));
  test("both predicates ask `isActiveCourse`, which is `courseStatus(...) === \"ACTIVE\"`; no second status rule", () => {
    expect(S).toContain('=== "ACTIVE"');
    expect(S).toContain("): boolean => isActiveCourse(c, today) && courseEligible(c, today) && courseRemainingSessions(c) <= NEARLY_FINISHED_SESSIONS;");
    expect(S).toContain("): boolean => isActiveCourse(c, today) && courseEligible(c, today) && isExpiringSoon(c.expiryDate, today, cutoff);");
    expect(S).not.toContain("c.endedAt == null");
  });
  test("`courseEligible` itself is not changed (its other callers keep their meaning)", () => {
    const E = code(readFileSync(resolve(root, "src/lib/eligibility.ts"), "utf8"));
    expect(E).not.toContain("endedAt");
    expect(E).not.toContain("droppedAt");
  });
});
