// TASK-594 — Tanya's TEST-076 re-test on sid, the three that are mine.
//   §1 the chat does NOT link at the phone step (the code path, named) — what she read is the phone step's SENTENCE;
//   §2 the chat's address questions rendered ONE language between two bilingual screens;
//   §4 "7 คน" on a week with one child — @Fern attributed it to the payload, and the payload pooled every week on the date.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REGISTRATION_COPY, t } from "./line-i18n";
import * as sched from "../services/scheduler.service";
import * as camp from "../services/camp.service";
import { db } from "../db";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from) + from.length));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
const W = code(read("src/services/line-webhook.service.ts"));

describe("🔴 §1 — does the chat link at the PHONE step? NO. The code path, named", () => {
  const VERIFY = region(W, "async function verifyAndLink(", "\n}\n");
  const AFTER = region(W, 'if (session.step === "AWAIT_CODE" && session.pendingRole) {', "\n  }\n");
  const CONFIRM = region(W, 'if (session.step === "AWAIT_STUDENT_CONFIRM") {', "\n  }\n");
  test("a NEW phone at the phone step: `linkFamilyByPhone` ⇒ `new`, carried as `pendingPhone` — and that branch links NO menus and writes NO family", () => {
    expect(VERIFY).toContain('if (r.outcome === "new") return { ok: true, pendingPhone: r.phone,');
    const pending = AFTER.slice(AFTER.indexOf("if (res.pendingPhone) {"), AFTER.indexOf('if (role !== "admin") await settleLinkedRole(lineUserId, role);'));
    expect(pending).toContain('await setDraft(lineUserId, "AWAIT_STUDENT_NAME", { newPhone: res.pendingPhone });');
    expect(pending).not.toMatch(/settleLinkedRole|linkParentLine|bindFamilyLine|findOrCreateParentByPhone/);
    // the writer's own half is pinned by value in TASK-590 (`linkFamilyByPhone` on a new phone writes nothing at all).
  });
  test("🔑 the chat's ONLY family write is at CONFIRM, through the one-transaction writer — it does not go around it", () => {
    expect(CONFIRM).toContain("await registerFamilyWithFirstChild(lineUserId, newPhone, {");
    expect((W.match(/registerFamilyWithFirstChild\(/g) ?? []).length).toBe(1); // exactly ONE call site in the whole chat
    // 🚫 nothing in the chat creates a parent or binds a LINE account anywhere else
    expect(W).not.toMatch(/findOrCreateParentByPhone\(|bindFamilyLine\(|linkParentLine\(/);
  });
  test("✅ what she READ is FIXED (TASK-601): the phone step no longer claims a completion, and the two sentences now DIFFER", () => {
    // 📌 Today's fact, pinned so the attribution cannot be lost. Both sentences claim the registration is done:
    //    · a NEW phone  ⇒ `verify_parent_ok_new`      — NOTHING is saved yet (the family is created with the first child)
    //    · an EXISTING phone ⇒ `verify_parent_ok_existing` — the account IS linked at once (the designed behaviour)
    // ⚠️ FLAGGED to @Sober / the owner (COPY §19 DRAFT): a tester holding our own spec read the first as a contradiction.
    // 🔻 TASK-601 (COPY §19, owner-approved) — this assertion RECORDED the defect as today's fact; it now records the fix. The
    // shape and value pins live in `registration-sentence-task601.test.ts`.
    expect(t("verify_parent_ok_new", "EN")).not.toContain("Registration completed");
    expect(t("verify_parent_ok_existing", "EN")).toContain("Registration completed ✅"); // the customer's sentence, where it is true
    expect(VERIFY.indexOf('"verify_parent_ok_existing"')).toBeGreaterThan(-1);
    // …and the sentence is the customer's own §17c screen 4, which is why it is a DRAFT and not an edit
    expect(Object.keys(REGISTRATION_COPY)).toContain("verify_parent_ok_new");
  });
});

describe("🔴 §2 — the chat's address questions render in BOTH languages, like the screens they replace", () => {
  const SCREENS = ["add_student_prompt", "add_student_name_prompt", "add_birthdate_prompt", "add_addr_province_prompt", "add_addr_district_prompt", "add_addr_subdistrict_prompt", "add_addr_on_file", "add_summary_head", "add_summary_confirm", "add_l_name", "add_l_birthdate", "add_l_province", "add_l_none", "added_done", "add_another_hint", "verify_parent_ok_new"];
  test("by value: every §17c SCREEN the wizard renders is byte-identical in TH and EN (the customer wrote both languages into one string)", () => {
    const differ = SCREENS.filter((k) => t(k, "TH") !== t(k, "EN"));
    expect(differ).toEqual([]);
    // 🔑 …and "identical in both languages" is NOT enough on its own — a Thai-ONLY string is identical too, which is exactly the
    // defect Tanya read. So every screen must CARRY both halves: Thai script and Latin script, in the one string.
    const missingHalf = SCREENS.filter((k) => !/[ก-๙]/.test(t(k, "EN")) || !/[A-Za-z]/.test(t(k, "EN")));
    expect(missingHalf).toEqual([]);
  });
  test("🔑 DERIVED — every key the wizard renders is either a bilingual §17c screen or one of the NAMED per-language refusals; nothing else", () => {
    // The rule, stated once: a §17c SCREEN is bilingual because the customer wrote it for a reader whose language we do not yet
    // know; everything else answers INSIDE a session whose language IS known (TASK-307: 39 `t(…, lang)` against 13 `both()`).
    const flow = ["async function handleAddStudentStep(", "async function showStudentSummary(", "async function askMoreDetail("].map((s) => region(W, s, "\n}\n")).join("\n");
    const keys = [...new Set([...flow.matchAll(/\bt\("(\w+)"/g)].map((m) => m[1]!))].sort();
    const screens = new Set(Object.keys(REGISTRATION_COPY));
    const perLanguage = keys.filter((k) => !screens.has(k)).sort();
    expect(perLanguage).toEqual([
      "add_addr_province_bad", // 🔻 TASK-594 — a REFUSAL, the same shape as `add_birthdate_bad` beside it
      "add_birthdate_bad",
      "add_cancelled",
      "add_dup_detail",
      "add_generic_err",
      "add_name_reserved",
      "add_no_parent",
      "added_atmax_note",
      "menu_body",
    ]);
    // 🚫 and no wizard SCREEN slipped out of the bilingual table
    expect(keys.filter((k) => screens.has(k)).length).toBeGreaterThan(9);
  });
});

describe("🔴 §4 — `campKidCount` is THIS week's children on that date, not every week's pooled (Tanya's “7 คน” on a one-child week)", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", W1 = "11111111-1111-4111-8111-111111111111", W2 = "22222222-2222-4222-8222-222222222222";
  const DATE = "2026-10-05";
  const campRow = (id: string, weekId: string, dayId: string, startTime: string) => ({
    id, date: DATE, startTime, endTime: "11:00:00", status: "CONFIRMED", bookingType: "OTHER", otherKind: "CAMP", otherTitle: "Camp",
    teacherId: A, teacher: { id: A, name: "Ek", nickname: "Ek" }, student: null, coStudent: null, subject: null, course: null, badges: [],
    additionalTeachers: [], rental: null, seats: [], group: null, groupId: null, courseId: null,
    campWeekDayId: dayId, campWeekDay: { id: dayId, campWeekId: weekId }, teacherRateMinor: null, pendingSlot: false,
  });
  /** The two weeks BOTH run on `DATE`: week 1 has ONE child that day, week 2 has SIX. Pooled ⇒ 7 on both. */
  const arm = () => {
    spies.push(spyOn(db.query.teachers, "findMany").mockImplementation((async () => [{ id: A, name: "Ek", nickname: "Ek", active: true, type: "FULL_TIME", workDays: [0, 1, 2, 3, 4, 5, 6], teacherSubjects: [], archived: false }]) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.boItem, "findMany").mockImplementation((async () => []) as any)); // the freelance ceilings the calendar attaches — never the DB here
    spies.push(spyOn(db.query.appSettings, "findMany").mockImplementation((async () => []) as any)); // the settings read — never the DB here
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => [campRow("b1", W1, "wd1", "10:00:00"), campRow("b2", W2, "wd2", "11:00:00")]) as any));
    spies.push(spyOn(sched, "lastLessonDatesForCourses").mockImplementation((async () => new Map()) as any));
    spies.push(spyOn(camp, "weeksForCalendar").mockImplementation((async () => [
      { id: W1, name: "Camp A", startDate: DATE, endDate: DATE, status: "OPEN", teacherIds: [A], dayCounts: { [DATE]: 1 } },
      { id: W2, name: "Camp B", startDate: DATE, endDate: DATE, status: "OPEN", teacherIds: [A], dayCounts: { [DATE]: 6 } },
    ]) as any));
  };
  const VIEWER = { teacherId: null, isSuperAdmin: true, grants: new Set<string>() } as any;
  const countAt = (cal: any, time: string) => cal.days[0].columns[0].slots.find((s: any) => s.time === time)?.booking?.campKidCount;
  test("🔑 by value, where the two candidate meanings DISAGREE: week 1's block reads 1 and week 2's reads 6 — never 7 on either", async () => {
    arm();
    const cal: any = await sched.getCalendar({ date: DATE, view: "day" }, VIEWER);
    expect([countAt(cal, "10:00"), countAt(cal, "11:00")]).toEqual([1, 6]);
    // …and the banner still carries each week's OWN per-date count (the consumer that was always right)
    expect(cal.campWeeks.map((w: any) => [w.id, w.dayCounts[DATE]])).toEqual([[W1, 1], [W2, 6]]);
  });
  test("one week alone on the date is unchanged (the fix is the pooling, not the count)", async () => {
    arm();
    spies.push(spyOn(camp, "weeksForCalendar").mockImplementation((async () => [{ id: W1, name: "Camp A", startDate: DATE, endDate: DATE, status: "OPEN", teacherIds: [A], dayCounts: { [DATE]: 4 } }]) as any));
    const cal: any = await sched.getCalendar({ date: DATE, view: "day" }, VIEWER);
    expect(countAt(cal, "10:00")).toBe(4);
    expect(countAt(cal, "11:00")).toBe(0); // week 2 has no counts in range ⇒ 0, never another week's number
  });
  test("a NON-camp booking still gets `null` — a reader that did not ask gets no guess", async () => {
    arm();
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async () => [{ ...campRow("b1", W1, "wd1", "10:00:00"), campWeekDayId: null, campWeekDay: null, bookingType: "PRIVATE", otherKind: null }]) as any));
    const cal: any = await sched.getCalendar({ date: DATE, view: "day" }, VIEWER);
    expect(countAt(cal, "10:00")).toBeNull();
  });
});
