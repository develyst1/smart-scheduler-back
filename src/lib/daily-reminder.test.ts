import { describe, expect, test } from "bun:test";
import {
  dueReminders,
  groupReminders,
  reminderKey,
  reminderReach,
  type ReminderSession,
} from "./daily-reminder";

// SPEC-066 / TASK-208 (REQ-072 3B). The rule this feature lives or dies by is ONE MESSAGE PER PERSON: a
// Saturday is ~60 sessions, and a per-booking push would send one teacher eight notifications before 08:20.
const s = (o: Partial<ReminderSession> & { id: string }): ReminderSession => ({
  date: "2026-09-05",
  startTime: "09:00:00",
  status: "CONFIRMED",
  teacherId: "t1",
  teacherLineUserId: "Uteacher",
  studentId: "st1",
  studentName: "น้องเอ",
  parentId: "p1",
  parentLineUserId: "Uparent",
  subjectName: "Surfskate",
  ...o,
});

describe("🔴 one message per PERSON, never per booking (TASK-208)", () => {
  test("a teacher with eight classes gets ONE group listing all eight", () => {
    const day = Array.from({ length: 8 }, (_, i) =>
      s({ id: `b${i}`, startTime: `${String(9 + i).padStart(2, "0")}:00:00` }),
    );
    const teacher = groupReminders(day).filter((g) => g.recipientType === "teacher");
    expect(teacher).toHaveLength(1);
    expect(teacher[0]!.rows).toHaveLength(8);
  });

  test("🔑 a parent with two children gets ONE message listing both — keyed on the PARENT, not the student", () => {
    const day = [
      s({ id: "a", studentId: "st1", studentName: "น้องเอ" }),
      s({ id: "b", studentId: "st2", studentName: "น้องบี", startTime: "11:00:00" }),
    ];
    const parents = groupReminders(day).filter((g) => g.recipientType === "parent");
    expect(parents).toHaveLength(1);
    expect(parents[0]!.rows.map((r) => r.studentName)).toEqual(["น้องเอ", "น้องบี"]);
  });

  test("two teachers on the same day are two groups — the grouping is per person, not per day", () => {
    const day = [s({ id: "a" }), s({ id: "b", teacherId: "t2", teacherLineUserId: "U2" })];
    expect(groupReminders(day).filter((g) => g.recipientType === "teacher")).toHaveLength(2);
  });

  test("rows are ordered by time — the message reads as a day, not as a query result", () => {
    const day = [
      s({ id: "late", startTime: "16:00:00" }),
      s({ id: "early", startTime: "09:00:00" }),
      s({ id: "mid", startTime: "13:00:00" }),
    ];
    const [teacher] = groupReminders(day);
    expect(teacher!.rows.map((r) => r.startTime)).toEqual(["09:00:00", "13:00:00", "16:00:00"]);
  });
});

describe("what must NOT produce a reminder", () => {
  test("🔴 a cancelled or leave session never reminds anyone about a class that is not happening", () => {
    const day = [s({ id: "x", status: "CANCELLED" }), s({ id: "y", status: "SICK_LEAVE" })];
    expect(groupReminders(day)).toEqual([]);
  });

  test("a delivered session is not a reminder either — it already happened", () => {
    expect(groupReminders([s({ id: "z", status: "ATTENDED" })])).toEqual([]);
  });

  test("a walk-in student with no parent produces a teacher group and no parent group", () => {
    // FIRST_TRIAL students legitimately have `parent_id = null`; that must not drop the teacher's reminder.
    const groups = groupReminders([s({ id: "w", parentId: null, parentLineUserId: null })]);
    expect(groups.map((g) => g.recipientType)).toEqual(["teacher"]);
  });

  test("an empty day sends nothing at all", () => {
    expect(groupReminders([])).toEqual([]);
  });
});

describe("🔴 the reach is COUNTED before anything is sent", () => {
  test("an unlinked person still forms a group — so they can be counted and SKIPPED, not silently dropped", () => {
    // On `uat` most parents were imported and have never linked LINE. A feature that quietly reaches nobody
    // is the `sale:ensure-items` lesson: it looked like it worked for a week.
    const groups = groupReminders([s({ id: "a", parentLineUserId: null })]);
    const parent = groups.find((g) => g.recipientType === "parent")!;
    expect(parent.lineUserId).toBeNull();
    expect(reminderReach(groups).unlinkedParents).toBe(1);
  });

  test("the reach separates linked from unlinked, per side", () => {
    const day = [
      s({ id: "a", teacherId: "t1", parentId: "p1" }),
      s({ id: "b", teacherId: "t2", teacherLineUserId: null, parentId: "p2", parentLineUserId: null }),
    ];
    expect(reminderReach(groupReminders(day))).toEqual({
      teachers: 2,
      parents: 2,
      unlinkedTeachers: 1,
      unlinkedParents: 1,
      sessions: 2,
    });
  });
});

// ═══ TASK-218 — a manual pre-08:15 trigger must not eat the day ═══
//
// The old guard asked "did this JOB already run today?" (`job_runs.summary.attempted`). An ops trigger at 07:00
// answered yes, so the real 08:15 run skipped and **nobody was reminded**. The DoD is written per-person, so the
// deciding rule is pure and lives here: given who was already keyed, who is still due?
describe("🔴 TASK-218 — idempotency is per RECIPIENT per day, not per job", () => {
  const DAY = "2026-09-05";
  const key = (t: "teacher" | "parent", id: string) => reminderKey(t, id, DAY);

  test("the key is person + business date — 'one per day' is a calendar statement", () => {
    expect(key("teacher", "t1")).toBe("reminder:teacher:t1:2026-09-05");
    expect(key("parent", "t1")).not.toBe(key("teacher", "t1")); // a person is never both by accident
    expect(reminderKey("teacher", "t1", "2026-09-06")).not.toBe(key("teacher", "t1")); // tomorrow is a new send
  });

  test("🔑 07:00 trigger then the 08:15 run: everyone due gets exactly one — none twice, none missed", () => {
    const day = [
      s({ id: "a", teacherId: "t1", parentId: "p1" }),
      s({ id: "b", teacherId: "t2", parentId: "p2", startTime: "13:00:00" }),
    ];
    const groups = groupReminders(day);
    expect(groups).toHaveLength(4); // t1, t2, p1, p2

    // 07:00 — an ops trigger reaches whoever it reaches. Say it got the two teachers.
    const at0700 = dueReminders(groups, DAY, new Set());
    expect(at0700).toHaveLength(4);
    const keyedAfter0700 = new Set([key("teacher", "t1"), key("teacher", "t2")]);

    // 08:15 — the scheduled run. It must NOT be suppressed, and must send only to the two parents.
    const at0815 = dueReminders(groups, DAY, keyedAfter0700);
    expect(at0815.map((g) => `${g.recipientType}:${g.personId}`)).toEqual(["parent:p1", "parent:p2"]);

    // Union across both runs = every person exactly once.
    const all = [...at0700.slice(0, 2), ...at0815].map((g) => `${g.recipientType}:${g.personId}`);
    expect(new Set(all).size).toBe(all.length);
  });

  test("two runs with no gap still send each person once (double-run safe)", () => {
    const groups = groupReminders([s({ id: "a" })]);
    const keyed = new Set(groups.map((g) => reminderKey(g.recipientType, g.personId, DAY)));
    expect(dueReminders(groups, DAY, keyed)).toEqual([]);
  });

  test("🔴 yesterday's keys never suppress today — the date is part of the key", () => {
    const groups = groupReminders([s({ id: "a" })]);
    const yesterday = new Set(groups.map((g) => reminderKey(g.recipientType, g.personId, "2026-09-04")));
    expect(dueReminders(groups, DAY, yesterday)).toHaveLength(groups.length);
  });

  test("an UNLINKED person stays due — they were not reminded, they were unreachable", () => {
    // `enqueueLine` deliberately stores no key on a SKIPPED row, so a parent who links LINE between the 07:00
    // trigger and 08:15 is still reached. Suppressing on "we tried" would silently never send to them.
    const groups = groupReminders([s({ id: "a", parentLineUserId: null })]);
    const parent = groups.find((g) => g.recipientType === "parent")!;
    expect(parent.lineUserId).toBeNull();
    expect(dueReminders(groups, DAY, new Set()).map((g) => g.personId)).toContain(parent.personId);
  });
});
