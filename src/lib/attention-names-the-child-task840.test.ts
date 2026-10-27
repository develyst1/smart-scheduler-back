// TASK-840 (REQ-132) — every Attention item of «ใกล้ใช้ครบ» (nearly_finished_courses) and «ใกล้หมดอายุ» (expiring_entitlements) LEADS with the child, through THE one name rule, and carries a `link` target for the front.
// 🚫 The LINE digest stays counts-only for these two checks (names stay behind the login); every other check is byte-identical and has no `link` key.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ATTENTION_CHECKS, buildDigestMessage } from "./attention";

const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const TODAY = "2026-08-01";
const A = { id: "s-a", name: "Alice", nickname: "น้องเอ" };
const B = { id: "s-b", name: "Bella", nickname: "น้องบี" };

const course = (over: any = {}) => ({ id: "c1", size: 10, usedSessions: 8, expiryDate: "2026-08-10", student: A, coStudent: null, ...over });
const voucher = (over: any = {}) => ({ id: "v1", totalHours: 10, usedHours: 2, expiryDate: "2026-08-10", student: A, ...over });
const ctxOf = (load: any) => ({ today: TODAY, tomorrow: "2026-08-02", yesterday: "2026-07-31", expiryCutoff: "2026-08-15", salesWindowStart: "2026-07-01", load } as any);
const check = (key: string) => ATTENTION_CHECKS.find((c) => c.key === key)!;
const run = (key: string, load: any) => check(key).run(ctxOf(load));

describe("🔴 nearly_finished_courses — the label leads with the child, the item links to its course", () => {
  test("a course with 2 left for «น้องเอ» ⇒ `น้องเอ · course 10 · เหลือ 2`, link { course, c1 }", async () => {
    const r = await run("nearly_finished_courses", { courses: async () => [course()] });
    expect(r.count).toBe(1);
    expect(r.items).toEqual([{ id: "c1", label: "น้องเอ · course 10 · เหลือ 2", link: { kind: "course", id: "c1" } }]);
  });
  test("a DUO course names BOTH children (the one rule: both, in the course's order)", async () => {
    const r = await run("nearly_finished_courses", { courses: async () => [course({ coStudent: B })] });
    expect(r.items[0]!.label).toContain("น้องเอ");
    expect(r.items[0]!.label).toContain("น้องบี");
    expect(r.items[0]!.label).toMatch(/^น้องเอ & น้องบี · course 10 · เหลือ 2$/);
  });
  test("a course with no student keeps its label as before (no leading separator)", async () => {
    const r = await run("nearly_finished_courses", { courses: async () => [course({ student: null })] });
    expect(r.items[0]!.label).toBe("course 10 · เหลือ 2");
  });
  test("a nickname-less child reads by name", async () => {
    const r = await run("nearly_finished_courses", { courses: async () => [course({ student: { id: "s-c", name: "Carol", nickname: null } })] });
    expect(r.items[0]!.label).toBe("Carol · course 10 · เหลือ 2");
  });
});

describe("🔴 expiring_entitlements — a course AND a voucher both lead with the child; the link kind follows the item", () => {
  test("an expiring course ⇒ `น้องเอ · course 10 · 2026-08-10`, link course · an expiring voucher ⇒ `น้องบี · voucher 10h · 2026-08-10`, link voucher", async () => {
    const r = await run("expiring_entitlements", { courses: async () => [course({ usedSessions: 2 })], vouchers: async () => [voucher({ student: B })] });
    expect(r.count).toBe(2);
    expect(r.items).toEqual([
      { id: "c1", label: "น้องเอ · course 10 · 2026-08-10", link: { kind: "course", id: "c1" } },
      { id: "v1", label: "น้องบี · voucher 10h · 2026-08-10", link: { kind: "voucher", id: "v1" } },
    ]);
  });
  test("a DUO course and a studentless voucher: both children on the course; the voucher keeps its old label", async () => {
    const r = await run("expiring_entitlements", { courses: async () => [course({ usedSessions: 2, coStudent: B })], vouchers: async () => [voucher({ student: null })] });
    expect(r.items[0]!.label).toMatch(/^น้องเอ & น้องบี · course 10 · /);
    expect(r.items[1]).toEqual({ id: "v1", label: "voucher 10h · 2026-08-10", link: { kind: "voucher", id: "v1" } });
  });
});

describe("🔴 the LINE digest is counts-only for these two checks — unchanged, no names", () => {
  test("the digest text is BYTE-IDENTICAL whether the items lead with a child or not", async () => {
    const load = { courses: async () => [course({ usedSessions: 8 })], vouchers: async () => [voucher()] };
    const nearly = await run("nearly_finished_courses", load);
    const expiring = await run("expiring_entitlements", load);
    const withNames = [{ key: "nearly_finished_courses", ...nearly }, { key: "expiring_entitlements", ...expiring }];
    const oldShape = [
      { key: "nearly_finished_courses", count: 1, items: [{ id: "c1", label: "course 10 · เหลือ 2" }] },
      { key: "expiring_entitlements", count: 2, items: [{ id: "c1", label: "course 10 · 2026-08-10" }, { id: "v1", label: "voucher 10h · 2026-08-10" }] },
    ];
    for (const lang of ["TH", "EN"] as const) {
      expect(buildDigestMessage(withNames as any, lang)).toBe(buildDigestMessage(oldShape as any, lang));
      expect(buildDigestMessage(withNames as any, lang)).not.toContain("น้องเอ");
    }
    expect(buildDigestMessage(withNames as any, "TH")).toContain("• ");
  });
  test("the two checks do NOT name people in the digest (the flag is unset); a check that does is still listed", () => {
    expect(check("nearly_finished_courses").namesPeopleInDigest).toBeFalsy();
    expect(check("expiring_entitlements").namesPeopleInDigest).toBeFalsy();
    expect(check("unconfirmed_bookings").namesPeopleInDigest).toBe(true);
  });
});

describe("another check's items are unchanged and carry NO `link` key", () => {
  test("unconfirmed_bookings: the same label shape, no `link`", async () => {
    const r = await run("unconfirmed_bookings", { bookings: async () => [{ id: "b1", date: TODAY, startTime: "10:00:00", status: "PENDING", student: A, teacher: { nickname: "Bank" } }] });
    expect(r.items).toEqual([{ id: "b1", label: "2026-08-01 10:00 · น้องเอ · Bank" }]);
    expect(Object.keys(r.items[0]!)).not.toContain("link");
  });
  test("teachers_without_line: the same, no `link`", async () => {
    const r = await run("teachers_without_line", { teachers: async () => [{ id: "t1", nickname: "Mod", lineUserId: null, active: true, archived: false }] });
    expect(r.items).toEqual([{ id: "t1", label: "Mod" }]);
  });
});

describe("🔑 by source — one helper, the one name rule; `link` rides the two checks only", () => {
  const S = code(readFileSync(resolve(root, "src/lib/attention.ts"), "utf8").replace(/\r\n/g, "\n"));
  test("`childLead` is built on `studentNamesOf`; the two checks' labels start with it; exactly 3 `link` sites (two checks), none elsewhere", () => {
    expect(S).toContain("const names = studentNamesOf(row);");
    expect(S).toContain("label: `${childLead(c)}course ${c.size} · ${c.expiryDate}`");
    expect(S).toContain("label: `${childLead(v)}voucher ${v.totalHours}h · ${v.expiryDate}`");
    expect(S).toContain("label: `${childLead(c)}course ${c.size} · เหลือ ${courseRemainingSessions(c)}`");
    expect([...S.matchAll(/link: \{ kind: "/g)]).toHaveLength(3);
    expect(S).toContain('link: { kind: "voucher" as const, id: v.id }');
  });
});
