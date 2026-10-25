// TASK-837 (REQ-126 "ตัดจบคอร์ส") — ending a course early: `ENDED_EARLY` is the 4th code of a COURSE's end reason, a COURSE-ONLY sibling set. The behaviour of `endCourse` is unchanged; what is new is the set, the CHECK (0072) and the coach's LINE words.
// Approved words (the owner, 2026-10-25): the reason → TH `ตัดจบคอร์ส` / EN "Course ended early". The voucher end does NOT accept it. `TEACHER_LEAVE` is not a reason to end a course (it gets a 400, never a Postgres 23514 ⇒ 500).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import { COURSE_END_REASONS, END_REASONS, ENDED_EARLY, SESSION_CANCEL_REASONS, isCourseEndReason, isEndReason } from "./course-plan";
import { cancelReasonText, formatOutboxMessage } from "./line-message";
import { t } from "./line-i18n";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import * as svc from "../services/scheduler.service";

const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const checkList = (sqlText: string): string[] => {
  const m = sqlText.replace(/^--.*$/gm, "").match(/"end_reason" IN \(([^)]*)\)/);
  return m ? [...m[1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]!) : [];
};

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

describe("🔴 the course-only set = exactly what the course-end CHECK accepts after 0072", () => {
  test("COURSE_END_REASONS = the three old ones + ENDED_EARLY, in that order; `TEACHER_LEAVE` is NOT in it; `END_REASONS` (the voucher's too) does NOT gain it", () => {
    expect([...COURSE_END_REASONS]).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR", "ENDED_EARLY"]);
    expect(ENDED_EARLY).toBe("ENDED_EARLY");
    expect(isCourseEndReason("ENDED_EARLY")).toBe(true);
    expect(isCourseEndReason("TEACHER_LEAVE")).toBe(false);
    expect(isCourseEndReason("SCHOOL_ISSUE")).toBe(false);
    expect(isCourseEndReason("")).toBe(false);
    expect(isCourseEndReason(undefined)).toBe(false);
    expect([...END_REASONS]).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR", "TEACHER_LEAVE"]); // unchanged
    expect(isEndReason("ENDED_EARLY")).toBe(false); // 🔴 the shared predicate (the voucher's) refuses it
    expect([...SESSION_CANCEL_REASONS]).not.toContain("ENDED_EARLY"); // and a SESSION cancel never takes it
  });
  test("migration 0072 = DROP IF EXISTS + ADD … NOT VALID + VALIDATE, the list ⇔ COURSE_END_REASONS in order; no data; 0023 still lists its three; the voucher's CHECK (0051) is untouched", () => {
    const f = "drizzle/0072_course_end_reason_ended_early.sql";
    const sql = read(f).replace(/^--.*$/gm, "");
    expect(sql).toContain('ALTER TABLE "course_packages" DROP CONSTRAINT IF EXISTS "course_packages_end_reason_chk";');
    expect(sql).toContain('ALTER TABLE "course_packages" VALIDATE CONSTRAINT "course_packages_end_reason_chk";');
    expect(sql).toContain("NOT VALID;");
    expect(sql.indexOf("DROP CONSTRAINT")).toBeLessThan(sql.indexOf("ADD CONSTRAINT"));
    expect(sql.indexOf("ADD CONSTRAINT")).toBeLessThan(sql.indexOf("VALIDATE CONSTRAINT")); // the CHECK's definition is the witness; VALIDATE is the last object
    expect(checkList(read(f))).toEqual([...COURSE_END_REASONS]);
    expect(sql).not.toMatch(/INSERT|UPDATE |DELETE FROM/i);
    expect(checkList(read("drizzle/0023_course_ended.sql"))).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR"]);
    expect(checkList(read("drizzle/0051_voucher_end.sql"))).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR", "TEACHER_LEAVE"]);
    const touching = readdirSync(resolve(root, "drizzle")).filter((x) => x.endsWith(".sql") && /vouchers_end_reason_chk/.test(read("drizzle/" + x).replace(/^--.*$/gm, "")));
    expect(touching).toEqual(["0051_voucher_end.sql"]); // no new migration touches the voucher's CHECK
  });
  test("the journal registers it as idx 72, and the witness reads the CHECK's DEFINITION (`ENDED_EARLY`)", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json"));
    expect(journal.entries.find((e: any) => e.tag === "0072_course_end_reason_ended_early")).toMatchObject({ idx: 72, breakpoints: true });
    expect(SCHEDULING_WITNESSES.find((x) => x.tag === "0072_course_end_reason_ended_early")).toMatchObject({ probe: { kind: "constraint-def", constraint: "course_packages_end_reason_chk", contains: "ENDED_EARLY" }, rerunnable: true });
  });
});

describe("🔴 the doors — by value through the REAL service", () => {
  test("a COURSE end with ENDED_EARLY passes the door, is stored as `endReason: ENDED_EARLY`, and the course is ended (0 rows lost to a refusal)", async () => {
    const sets: any[] = [];
    const course = { id: U, size: 1, endedAt: null, endReason: null };
    const tx = {
      query: { coursePackages: { findFirst: async () => course }, bookings: { findMany: async () => [] } },
      update: () => ({ set: (v: any) => { sets.push(v); return { where: async () => undefined }; } }),
    };
    spies.push(spyOn(db, "transaction").mockImplementation((async (cb: any) => cb(tx)) as any));
    const r: any = await svc.endCourse(U, { reason: "ENDED_EARLY", note: "Khwan: ตัดจบ" }, "admin");
    expect(r).toMatchObject({ cancelled: true, removedSessions: 0 });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ endReason: "ENDED_EARLY", endNote: "Khwan: ตัดจบ", endedBy: "admin" });
    expect(sets[0].endedAt).toBeInstanceOf(Date);
  });
  test("the 3 old reasons are still accepted, unchanged", async () => {
    for (const reason of ["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR"]) {
      const sets: any[] = [];
      const tx = {
        query: { coursePackages: { findFirst: async () => ({ id: U, size: 1, endedAt: null }) }, bookings: { findMany: async () => [] } },
        update: () => ({ set: (v: any) => { sets.push(v); return { where: async () => undefined }; } }),
      };
      const sp = spyOn(db, "transaction").mockImplementation((async (cb: any) => cb(tx)) as any);
      await svc.endCourse(U, { reason }, "admin");
      sp.mockRestore();
      expect(sets[0]).toMatchObject({ endReason: reason });
    }
  });
  test("🔴 `TEACHER_LEAVE` (and any code the CHECK would refuse) ⇒ 400 INVALID_REASON naming the COURSE set — nothing written, never a Postgres 23514", async () => {
    let touched = 0;
    spies.push(spyOn(db, "transaction").mockImplementation((async () => { touched++; }) as any));
    for (const reason of ["TEACHER_LEAVE", "SCHOOL_ISSUE", "NOPE"]) {
      await expect(svc.endCourse(U, { reason } as any, "admin")).rejects.toMatchObject({ status: 400, code: "INVALID_REASON", details: { allowed: [...COURSE_END_REASONS] } });
    }
    expect(touched).toBe(0); // the door refuses BEFORE any transaction opens
  });
  test("🔴 a VOUCHER end with ENDED_EARLY ⇒ 400 INVALID_REASON (the voucher's CHECK would refuse it: a 500) — the word «course» is wrong on a voucher", async () => {
    let touched = 0;
    spies.push(spyOn(db, "transaction").mockImplementation((async () => { touched++; }) as any));
    await expect(svc.endVoucher(U, { reason: "ENDED_EARLY" }, "admin")).rejects.toMatchObject({ status: 400, code: "INVALID_REASON", details: { allowed: [...END_REASONS] } });
    expect(touched).toBe(0);
  });
});

describe("✅ the coach's LINE reason — the owner's words, verbatim (APPROVED 2026-10-25)", () => {
  test("the dictionary: TH `ตัดจบคอร์ส` · EN `Course ended early`", () => {
    expect(t("ob_reason_ENDED_EARLY", "TH")).toBe("ตัดจบคอร์ส");
    expect(t("ob_reason_ENDED_EARLY", "EN")).toBe("Course ended early");
  });
  test("the cancel notice's reader maps the CODE to the words (the code wins over the note) in both languages", () => {
    expect(cancelReasonText("ENDED_EARLY", "free text that must be ignored", "TH")).toBe("ตัดจบคอร์ส");
    expect(cancelReasonText("ENDED_EARLY", null, "EN")).toBe("Course ended early");
  });
  test("by value through the real coach message: a course ENDED with `ENDED_EARLY` shows «ตัดจบคอร์ส» / «Course ended early» as its reason", () => {
    const payload = { kind: "course_dropped_teacher", cause: "ended", cancelReason: "ENDED_EARLY", note: "free text that must be ignored", size: 1, dates: ["2026-10-30"], startTime: "10:00", endTime: "11:00" };
    const th = formatOutboxMessage(payload as any, { date: "", startTime: "", endTime: "" } as any, "TH", "teacher");
    const en = formatOutboxMessage(payload as any, { date: "", startTime: "", endTime: "" } as any, "EN", "teacher");
    expect(th).toContain("ตัดจบคอร์ส");
    expect(th).not.toContain("free text that must be ignored");
    expect(en).toContain("Course ended early");
    // …and a course ended for an OLD reason still reads its old label
    const old = formatOutboxMessage({ ...payload, cancelReason: "PROGRAM_CHANGED" } as any, { date: "", startTime: "", endTime: "" } as any, "EN", "teacher");
    expect(old).toContain("Program changed");
    expect(old).not.toContain("Course ended early");
  });
});

describe("🔑 by source — the course door asks the COURSE set, the voucher door the shared one", () => {
  const S = code(read("src/services/scheduler.service.ts"));
  test("`endCourse` asks `isCourseEndReason` and names `COURSE_END_REASONS`; `endVoucher` still asks `isEndReason` with `END_REASONS`; the stored reason is the input", () => {
    const course = S.slice(S.indexOf("export async function endCourse("), S.indexOf("export async function endCourse(") + 2200);
    expect(course).toContain("if (!isCourseEndReason(input.reason))");
    expect(course).toContain("{ allowed: COURSE_END_REASONS }");
    expect(course).not.toContain("isEndReason(");
    expect(course).toContain("endReason: input.reason,");
    const voucher = S.slice(S.indexOf("export async function endVoucher("), S.indexOf("export async function endVoucher(") + 900);
    expect(voucher).toContain("if (!isEndReason(input.reason))");
    expect(voucher).toContain("{ allowed: END_REASONS }");
    expect(voucher).not.toContain("isCourseEndReason");
  });
});
