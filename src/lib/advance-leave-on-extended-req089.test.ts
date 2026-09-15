// TASK-361 (`REQ-089 item 1`) — advance leave on `Extended` rows: the LOCK goes, the CAP stays, ONE rule for
// which rows a planned course has, and the preview and the save ask that rule rather than agreeing by luck.
// Owner: *"ตารางที่ลาล่วงหน้า คลาสที่เป็น extended ไม่ต้องล็อกค่ะ สามารถลาได้เหมือนกัน"*.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { courseBornCeiling, makeupsToFlip, plannedRowCount, plannedRowExists } from "./course-plan";
import { courseExpiry, courseSessionDates } from "./recurring";
import { addDays } from "./time";
import { readSrc } from "./read-src";
import * as v from "../validation";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/scheduler.service.ts"));
const fn = (sig: string) => { const i = SVC.indexOf(sig); if (i < 0) throw new Error("no " + sig); return SVC.slice(i, SVC.indexOf("\n}\n", i) + 2); };
const T = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const body = (size: number, absentWeeks?: number[]) => ({ student: { id: T }, teacherId: T, subjectId: S, size, startDate: "2026-09-16", startTime: "10:00", ...(absentWeeks ? { absentWeeks } : {}) });

describe("🔑 THE RULE — row `w` exists iff the live rows before it number fewer than `size`", () => {
  test("no absences ⇒ exactly `size` rows", () => {
    for (const size of [4, 6, 10]) expect(plannedRowCount(size, new Set())).toBe(size);
  });

  test("🔴 the DoD case: size 4, week 2 absent, and the make-up at row 5 ticked ⇒ 6 rows, 4 live, 2 leaves, 2 make-ups", () => {
    const absent = new Set([2, 5]);
    expect(plannedRowCount(4, absent)).toBe(6);
    // rows 1..6: live · ABSENT · live · live · ABSENT(make-up) · live(make-up)
    const rows = Array.from({ length: 6 }, (_, i) => ({ w: i + 1, live: !absent.has(i + 1), makeup: i + 1 > 4 }));
    expect(rows.filter((r) => r.live).length).toBe(4);
    expect(rows.filter((r) => !r.live).length).toBe(2);
    expect(rows.filter((r) => r.makeup).length).toBe(2);
    expect(rows.find((r) => r.w === 5)).toEqual({ w: 5, live: false, makeup: true }); // both flags
  });

  test("a make-up of a make-up is the same case one row later", () => {
    // ⚠️ with no chain absence, rows 1–4 are all live and the plan STOPS at 4 — rows 5 and 6 never exist, so
    // declaring them changes nothing about the plan's length (and the validator refuses them as non-existent).
    expect(plannedRowCount(4, new Set([5, 6]))).toBe(4);
    expect(plannedRowExists(5, 4, new Set([5, 6]))).toBe(false);
    // …but with week 2 absent, row 5 exists (a make-up); tick it and row 6 exists; tick 6 and row 7 exists.
    expect(plannedRowCount(4, new Set([2, 5]))).toBe(6);
    expect(plannedRowCount(4, new Set([2, 5, 6]))).toBe(7);
    expect(plannedRowExists(7, 4, new Set([2, 5, 6]))).toBe(true);
    expect(plannedRowExists(8, 4, new Set([2, 5, 6]))).toBe(false);
  });

  test("🚫 a position beyond the drawn plan does not exist — the validator will refuse it", () => {
    expect(plannedRowExists(5, 4, new Set([2, 7]))).toBe(true); // row 5 exists (one chain absence)
    expect(plannedRowExists(7, 4, new Set([2, 7]))).toBe(false); // …but 7 does not: the plan is 5 rows long
    expect(plannedRowExists(0, 4, new Set())).toBe(false);
    expect(plannedRowExists(1.5, 4, new Set())).toBe(false);
  });
});

describe("🔴 the validator — the LOCK is gone, the CAP stays", () => {
  test("🔑 an `Extended` row may be declared absent — `size+1` on a size-4 with week 2 absent is ACCEPTED", () => {
    expect(v.createCoursePackage.safeParse(body(4, [2, 5])).success).toBe(true);
    // 🔻 this used to be refused by `w <= size` — the lock the customer asked to remove.
    expect(v.createCoursePackage.safeParse(body(4, [2])).success).toBe(true);
    expect(v.createCoursePackage.safeParse(body(6, [1, 7, 8])).success).toBe(true); // two make-ups of a chain absence
  });

  test("🚫 a `w` beyond the drawn plan is still refused — it names a row nobody will see", () => {
    const r = v.createCoursePackage.safeParse(body(4, [5])); // no chain absence ⇒ the plan is 4 rows; 5 does not exist
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as any).error?.issues)).toContain("สัปดาห์ที่ลาต้องอยู่ในช่วงของคอร์ส");
    expect(v.createCoursePackage.safeParse(body(4, [2, 7])).success).toBe(false);
  });

  test("🔻 the CAP `< size` is GONE too — TASK-363: the owner ruled FULL UNLOCK the same day this file was written", () => {
    // 🔻 TASK-361 kept the cap on instruction ("the lock goes, not the cap"); `REQ-089 §4.2` then removed it. The
    // claim this file makes about the LOCK is unchanged; the cap's fate is TASK-363's and pinned there.
    const r = v.createCoursePackage.safeParse(body(4, [1, 2, 3, 4]));
    expect(r.success).toBe(true);
    const VAL = code(src("src/validation.ts"));
    expect(VAL).not.toContain("new Set(d.absentWeeks).size < d.size");
    // …and the lock is gone from the source, not just from the result.
    expect(VAL).not.toContain("d.absentWeeks.every((w) => w <= d.size)");
    expect(VAL).toContain("plannedRowExists(w, d.size, new Set(d.absentWeeks))");
  });
});

describe("🔑 the FLIP decision, with values — which make-ups the create turns into declared absences", () => {
  const row = (id: string, status = "CONFIRMED") => ({ id, status });
  test("🔴 the DoD case: size 4, week 2 absent, row 5 ticked ⇒ after the first reconcile, exactly row 5 is flipped", () => {
    // date order after the first reconcile: 4 chain rows (row 2 already SICK_LEAVE) + 1 appended make-up (row 5)
    const afterFirst = [row("r1"), row("r2", "SICK_LEAVE"), row("r3"), row("r4"), row("r5", "EXTENDED")];
    expect(makeupsToFlip(afterFirst, 4, new Set([2, 5])).map((r) => r.id)).toEqual(["r5"]);
    // …after the flip and the second reconcile: row 5 is SICK_LEAVE, row 6 appended — nothing left to flip.
    const afterSecond = [...afterFirst.slice(0, 4), row("r5", "SICK_LEAVE"), row("r6", "EXTENDED")];
    expect(makeupsToFlip(afterSecond, 4, new Set([2, 5]))).toEqual([]);
  });
  test("a chain week is never flipped here (it was BORN absent), and an unticked make-up is never touched", () => {
    const rows = [row("r1"), row("r2", "SICK_LEAVE"), row("r3"), row("r4"), row("r5", "EXTENDED")];
    expect(makeupsToFlip(rows, 4, new Set([2]))).toEqual([]);
    expect(makeupsToFlip(rows, 4, new Set([1, 2]))).toEqual([]); // position 1 is chain — not this pass's job
  });
  test("a make-up of a make-up: the second pass flips row 6 once it exists", () => {
    const rows = [row("r1"), row("r2", "SICK_LEAVE"), row("r3"), row("r4"), row("r5", "SICK_LEAVE"), row("r6", "EXTENDED")];
    expect(makeupsToFlip(rows, 4, new Set([2, 5, 6])).map((r) => r.id)).toEqual(["r6"]);
  });
});

describe("🔑 ONE rule, THREE callers — the preview and the save agree because they ask the same function", () => {
  test("the PREVIEW appends until `plannedRowCount` rows exist, flagging a ticked make-up `absent: true, makeup: true`", () => {
    const preview = fn("export async function previewCoursePackage(");
    expect(preview).toContain("const rowsWanted = plannedRowCount(input.size, absent);");
    expect(preview).toContain("while (sessions.length < rowsWanted) {");
    expect(preview).toContain("sessions.push({ date, ...ref, absent: absent.has(sessions.length + 1), makeup: true });");
    // 🚫 the flat `absent.size` loop is gone.
    expect(preview).not.toContain("for (let k = 0; k < absent.size; k++)");
  });

  test("the CREATE flips the ticked make-ups and asks the ONE engine again — no second placement path", () => {
    const create = fn("export async function createCoursePackage(");
    expect(create).toContain("const wanted = plannedRowCount(input.size, absentWeeks);");
    expect(create).toContain("const toFlip = makeupsToFlip(ordered as any[], input.size, absentWeeks);");
    // 🔑 the loop's ONLY exit is the guarded one — a bare `break` before the flip would leave the make-ups live
    // with every line of the flip still in the file (that mutation PASSED a text pin; this is what caught it).
    const loop = create.slice(create.indexOf("for (let guard = 0; guard < wanted; guard++) {"), create.indexOf("const courseRow = await tx.query.coursePackages"));
    expect(loop).toContain("if (!toFlip.length) break;");
    expect((loop.match(/\bbreak;/g) ?? []).length).toBe(1);
    expect(loop.indexOf("if (!toFlip.length) break;")).toBeLessThan(loop.indexOf("for (const r of toFlip)"));
    expect(loop).toContain("await reconcileCoursePlan(tx, course.id);");
    expect(create).toContain('await tx.update(bookings).set({ status: "SICK_LEAVE", plannedAtCreation: true }).where(eq(bookings.id, r.id));');
    // the engine, again — and ONLY the engine: the create places no make-up itself.
    expect((create.match(/await reconcileCoursePlan\(tx, course\.id\);/g) ?? []).length).toBe(2);
    expect(create).not.toContain("findFreeExtensionDate(");
    // positions are read in the same order the preview draws them.
    expect(create).toContain("orderBy: (b: any, { asc }: any) => [asc(b.date), asc(b.startTime)],");
  });

  test("…and both the preview and the engine place a make-up from the LAST planned date — the same anchor", () => {
    const preview = fn("export async function previewCoursePackage(");
    const reconcile = fn("export async function reconcileCoursePlan(");
    expect(preview).toContain("let fromDate = sessions[sessions.length - 1]?.date ?? input.startDate;");
    expect(reconcile).toContain("const plannedRows = rows.filter((r: any) => !cancelledSet.has(r.id) && r.status !== \"CANCELLED\");");
    expect(reconcile).toContain("findFreeExtensionDate(tx, template.teacherId, template.startTime, fromDate)");
  });
});

describe("✅ the ceiling — unchanged in shape; an extended-row leave is one more absent week", () => {
  const START = "2026-09-23";
  const week = (n: number) => addDays(START, (n - 1) * 7);
  const last = (size: number) => courseSessionDates(START, size).at(-1)!;

  test("Kavya still holds: size 6, 3 absent weeks ⇒ week 11; 0 ⇒ week 8", () => {
    expect(courseBornCeiling(courseExpiry(START, 6), last(6), 3)).toBe(week(11));
    expect(courseBornCeiling(courseExpiry(START, 6), last(6), 0)).toBe(week(8));
  });

  test("🔑 the DoD case: size 4, week 2 + the make-up at row 5 ⇒ base + 2 weeks = week 7", () => {
    // `absentWeeks.size` counts positions, chain or make-up alike — the create passes exactly that.
    expect(courseBornCeiling(courseExpiry(START, 4), last(4), new Set([2, 5]).size)).toBe(week(7));
    // one extended leave alone would be +1: size 4, week 2 absent ⇒ week 6; tick its make-up ⇒ week 7.
    expect(courseBornCeiling(courseExpiry(START, 4), last(4), 1)).toBe(week(6));
    const create = fn("export async function createCoursePackage(");
    expect(create).toContain("absentWeeks.size,");
  });
});
