// TASK-690 (REQ-112, owner ruling 2026-10-06, LOCKED) — a new SESSION cancel reason, `SCHOOL_ISSUE` ("ปัญหาจากทางเรา" / "A problem on
// our side"): the ONLY thing that carries trigger T3 (*a class the school cancels for its own reason earns the course one more week*).
//
// 🔴 The closed list lives in THREE places — the code set, the validator, and the database CHECK — and a code missing from ANY one is
//    a 500 on live (migration 0045 already happened once for TEACHER_LEAVE). So the first describe pins that all THREE AGREE, in order.
// 🔴 And it is a SESSION reason ONLY: `END_REASONS` is also the closed set for ENDING a course (CHECK 0023) and a voucher (CHECK 0051),
//    and "a problem on our side" is about one missed class, not a reason to end a purchase. The second describe pins the boundary,
//    BY VALUE through the real validators and by source on the two services that must keep refusing it.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as v from "../validation";
import { END_REASONS, SCHOOL_ISSUE, SESSION_CANCEL_REASONS, isEndReason, isSessionCancelReason } from "./course-plan";
import { cancelReasonText } from "./line-message";
import { t } from "./line-i18n";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const sql = (f: string) => readFileSync(resolve(root, "drizzle", f), "utf8").replace(/\r\n/g, "\n");
const FILE = "0065_cancel_reason_school_issue.sql";
const checkList = (text: string, col: string) => text.match(new RegExp(`"${col}" IN \\(([^)]*)\\)`))![1]!.split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
const U = "11111111-1111-4111-8111-111111111111";

describe("🔴 THE THREE COPIES AGREE — the code set · the validator · the database CHECK (a code missing from ANY one is a 500 on live)", () => {
  test("the code set: END_REASONS is UNCHANGED, and the session set is END_REASONS + SCHOOL_ISSUE — derived by spread, never re-typed", () => {
    expect([...END_REASONS]).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR", "TEACHER_LEAVE"]); // 🔴 the course-end/voucher-end set did NOT move
    expect(SCHOOL_ISSUE).toBe("SCHOOL_ISSUE");
    expect([...SESSION_CANCEL_REASONS]).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR", "TEACHER_LEAVE", "SCHOOL_ISSUE"]);
    expect(code("src/lib/course-plan.ts")).toContain("export const SESSION_CANCEL_REASONS = [...END_REASONS, SCHOOL_ISSUE] as const;");
  });
  test("the validator: the status route and the series cancel-all both accept it — a SESSION cancel", () => {
    expect(v.updateStatus.safeParse({ action: "cancel", reasonCode: "SCHOOL_ISSUE" }).success).toBe(true);
    expect(v.otherSeriesCancelAll.safeParse({ reasonCode: "SCHOOL_ISSUE" }).success).toBe(true);
    // …and is still a CLOSED set: an unknown code is refused at the door, not stored
    expect(v.updateStatus.safeParse({ action: "cancel", reasonCode: "OUR_FAULT" }).success).toBe(false);
    expect(v.otherSeriesCancelAll.safeParse({ reasonCode: "OUR_FAULT" }).success).toBe(false);
    // the validator reads the ONE set — no literal list of codes in validation.ts
    expect(code("src/validation.ts")).toContain("reasonCode: z.enum(SESSION_CANCEL_REASONS).optional(),");
    expect(code("src/validation.ts")).not.toContain('"SCHOOL_ISSUE"');
  });
  test("🔴 the database CHECK, from the migration's own text: it lists EXACTLY the session set, in order", () => {
    const text = sql(FILE);
    expect(checkList(text, "cancel_reason")).toEqual([...SESSION_CANCEL_REASONS]);
    // the same shape as 0045, on purpose: DROP · ADD … NOT VALID · VALIDATE (the hot table's scan runs under SHARE UPDATE EXCLUSIVE)
    const stmts = text.split("\n").filter((l) => !l.startsWith("--") && l.trim()).join("\n").split(";").map((x) => x.trim()).filter(Boolean);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toBe('ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_cancel_reason_chk"');
    expect(stmts[1]).toContain("NOT VALID");
    expect(stmts[2]).toBe('ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_cancel_reason_chk"');
    expect(text).toContain("SHARE UPDATE EXCLUSIVE");
  });
  test("🔴 …and it is the LAST migration to touch that constraint, so it is the one the database really holds", () => {
    const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
    const touching = files.filter((f) => sql(f).includes("bookings_cancel_reason_chk"));
    expect(touching.at(-1)).toBe(FILE);
  });
  test("numbering: counted at the moment of writing and stated IN the file — 66 files, 66 journal tags, this is the 66th", () => {
    const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    expect(files).toHaveLength(66);
    expect(journal.entries).toHaveLength(66);
    expect(files[65]).toBe(FILE);
    expect(journal.entries[65]).toMatchObject({ idx: 65, tag: "0065_cancel_reason_school_issue", breakpoints: true });
    // the journal's `when` continues the synthetic incrementing value — strictly above every earlier entry
    expect(journal.entries[65].when).toBeGreaterThan(Math.max(...journal.entries.slice(0, 65).map((e: any) => e.when)));
    expect(sql(FILE)).toContain("`db:verify` expects 66");
    expect(sql(FILE)).toContain("so this is `0065` — the 66th file");
  });
  test("the WITNESS is the constraint's DEFINITION (its name exists before and after, so existence proves nothing) — the 0045 shape", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0065_cancel_reason_school_issue");
    expect(w).toMatchObject({ probe: { kind: "constraint-def", constraint: "bookings_cancel_reason_chk", contains: "SCHOOL_ISSUE" }, rerunnable: true });
    // 0045's witness is deliberately NOT re-pointed: the new definition still contains TEACHER_LEAVE, and re-running 0045 would REGRESS it
    expect(SCHEDULING_WITNESSES.find((x) => x.tag === "0045_cancel_reason_teacher_leave")).toMatchObject({ probe: { kind: "constraint-def", contains: "TEACHER_LEAVE" } });
  });
});

describe("🔴 SESSION cancel ONLY — it is NOT a reason to END A COURSE or a VOUCHER, and those CHECKs are UNTOUCHED", () => {
  test("the predicates: a session cancel accepts it; the course-end / voucher-end predicate REFUSES it", () => {
    expect(isSessionCancelReason("SCHOOL_ISSUE")).toBe(true);
    expect(isEndReason("SCHOOL_ISSUE")).toBe(false); // 🔴 `endCourse` and the voucher end ask THIS one
    for (const c of END_REASONS) { expect(isSessionCancelReason(c)).toBe(true); expect(isEndReason(c)).toBe(true); } // everything that already worked still does
  });
  test("by source: the course end and the voucher end still ask `isEndReason` — the code cannot reach their CHECKs", () => {
    const S = code("src/services/scheduler.service.ts");
    const ends = [...S.matchAll(/if \(!isEndReason\(input\.reason\)\)/g)];
    expect(ends).toHaveLength(2); // endCourse + endVoucher — and no third
    expect(S).not.toMatch(/isSessionCancelReason\(input\.reason\)/); // 🚫 never on an END
    // …and the session-cancel branch asks the SESSION predicate
    expect(S).toContain("if (!isSessionCancelReason(enumReason)) {");
  });
  test("🔴 the OTHER two CHECKs are byte-untouched: 0023 (course end) lists three, 0051 (voucher end) lists four — NEITHER names SCHOOL_ISSUE", () => {
    expect(checkList(sql("0023_course_ended.sql"), "end_reason")).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR"]);
    expect(checkList(sql("0051_voucher_end.sql"), "end_reason")).toEqual(["PROGRAM_CHANGED", "CUSTOMER_CANCELLED", "ADMIN_ERROR", "TEACHER_LEAVE"]);
    // ⚠️ Asked of the STATEMENTS, not the text: 0065's own header comment NAMES these two constraints (to say they are unchanged), and a
    // raw-text check reads that explanation as the thing it forbids. 🔑 An absence claim about SQL has to be asked of SQL.
    const stmtsOnly = (f: string) => sql(f).split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("--")).join(" ");
    const touching = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql") && stmtsOnly(f).includes("course_packages_end_reason_chk"));
    expect(touching).toEqual(["0023_course_ended.sql"]); // 0065 does not ALTER the course-end constraint
    expect(stmtsOnly(FILE)).not.toContain("course_packages_end_reason_chk");
    expect(stmtsOnly(FILE)).not.toContain("vouchers_end_reason_chk");
  });
  test("by value through the REAL service: ending a COURSE with it is refused at the door with the allowed list — 400, not a Postgres 23514", async () => {
    // the course-end door is `isEndReason`; a refusal here is a 400 INVALID_REASON naming the END set (which does NOT contain the new code)
    const svc = await import("../services/scheduler.service");
    await expect(svc.endCourse(U, { reason: "SCHOOL_ISSUE" as any, note: undefined }, "admin")).rejects.toMatchObject({ status: 400, code: "INVALID_REASON" });
  });
});

describe("📋 the label — the customer's own words in Thai, verbatim, DRAFT until @Sober says approved", () => {
  test("TH `ปัญหาจากทางเรา` · EN `A problem on our side`, in the dictionary AND through the cancel notice's own reader", () => {
    expect(t("ob_reason_SCHOOL_ISSUE", "TH")).toBe("ปัญหาจากทางเรา");
    expect(t("ob_reason_SCHOOL_ISSUE", "EN")).toBe("A problem on our side");
    expect(cancelReasonText("SCHOOL_ISSUE", "free text that must be ignored", "TH")).toBe("ปัญหาจากทางเรา"); // the CODE wins over the note
    expect(readSrc(readFileSync(resolve(root, "src/lib/line-i18n.ts"), "utf8"))).toContain("📋 DRAFT — both ride the round's one copy set via @Porter");
  });
  test("🔻 the OpenAPI document's `reasonCode` enum IS the session set — by VALUE (it was a stale fourth copy: three codes, missing TEACHER_LEAVE since TASK-406)", async () => {
    // Granted by @Sober after 690 (one line, `UpdateStatusRequest.reasonCode.enum` only). Derived by SPREAD from `SESSION_CANCEL_REASONS`, so it cannot drift again.
    const { openApiDocument } = await import("../openapi/document");
    const e = (openApiDocument as any).components.schemas.UpdateStatusRequest.properties.reasonCode.enum;
    expect(e).toEqual([...SESSION_CANCEL_REASONS]);
    expect(e).toHaveLength(5);
    expect(e).toContain("SCHOOL_ISSUE");
    expect(e).toContain("TEACHER_LEAVE");
    expect(readFileSync(resolve(root, "src/openapi/document.ts"), "utf8")).toContain("enum: [...SESSION_CANCEL_REASONS]");
  });
});
