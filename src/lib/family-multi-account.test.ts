// SPEC-074 / TASK-259 — a family's SECOND LINE account must receive messages and be able to use the bot.
//
// 🔴 The defect this closes is silent in both directions. Outbound, the second parent was never sent to and no
// row said so; inbound, they were not recognised as a parent at all, so `เช็คอิน` fell through to silence. The
// cause was one column — `parents.line_user_id`, overwritten by each new link — used as a routing fact by four
// readers and as an identity by eight more.
//
// ⚠️ **The trap this file exists to pin is §3's:** `reminderKey` identifies a PERSON, and while one parent meant
// one phone the two were the same thing. Writing a row per account under a per-person key would make the second
// row a duplicate, the second parent would get nothing **exactly as before**, and every test of the accessor
// would still pass. The key rule is asserted first, and against the historical literal.
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";
import {
  deviceReminderKey,
  dueSends,
  groupReminders,
  reminderKey,
  reminderSends,
  type ReminderGroup,
  type ReminderSession,
} from "./daily-reminder";

const FAMILY = readSrc(await Bun.file(new URL("./family-link.ts", import.meta.url)).text());
const PARENT = readSrc(await Bun.file(new URL("../services/parent.service.ts", import.meta.url)).text());
const CHECKIN = readSrc(await Bun.file(new URL("../services/checkin.service.ts", import.meta.url)).text());
const SCHED = readSrc(await Bun.file(new URL("../services/scheduler.service.ts", import.meta.url)).text());
const DEDUCT = readSrc(await Bun.file(new URL("./course-deduction.ts", import.meta.url)).text());
const JOBS = readSrc(await Bun.file(new URL("../services/jobs.service.ts", import.meta.url)).text());
const SCHEMA = readSrc(await Bun.file(new URL("../db/schema.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fn = (src: string, decl: string) => {
  const rest = code(src).slice(code(src).indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};

const DAY = "2026-09-06";
const MUM = "U-mum";
const DAD = "U-dad";

describe("🔴 §3 — the send-once key identifies a DEVICE, without colliding with what is already queued", () => {
  test("the PRIMARY account keeps the historical, un-suffixed key", () => {
    // A row queued this morning under the old format still suppresses the primary's duplicate, so nobody is
    // messaged twice on the day this deploys. Same shape as TASK-258's generation 0.
    expect(deviceReminderKey("parent", "p1", DAY, MUM, MUM)).toBe(reminderKey("parent", "p1", DAY));
    expect(deviceReminderKey("parent", "p1", DAY, MUM, MUM)).toBe("reminder:parent:p1:2026-09-06");
  });

  test("🔑 an ADDITIONAL account carries its own id — a key that has never existed before", () => {
    expect(deviceReminderKey("parent", "p1", DAY, DAD, MUM)).toBe("reminder:parent:p1:2026-09-06:U-dad");
    // …so it cannot collide with the primary's row, which is the whole point.
    expect(deviceReminderKey("parent", "p1", DAY, DAD, MUM)).not.toBe(deviceReminderKey("parent", "p1", DAY, MUM, MUM));
  });

  test("a teacher's key is byte-identical to what it always was — they have one account", () => {
    expect(deviceReminderKey("teacher", "t1", DAY, "U-t1", "U-t1")).toBe("reminder:teacher:t1:2026-09-06");
  });

  test("an unlinked person still keys on the person — a SKIPPED row is one fact, not none", () => {
    expect(deviceReminderKey("parent", "p1", DAY, null, null)).toBe(reminderKey("parent", "p1", DAY));
  });
});

describe("🔴 outbound — a two-account family gets TWO rows, and neither is swallowed", () => {
  const group = (lineUserIds: string[]): ReminderGroup => ({
    recipientType: "parent",
    personId: "p1",
    lineUserId: lineUserIds[0] ?? null,
    lineUserIds,
    rows: [{ date: DAY, startTime: "10:00" }],
  });

  test("two accounts ⇒ two sends, with two DIFFERENT keys", () => {
    const sends = reminderSends([group([MUM, DAD])], DAY);
    expect(sends).toHaveLength(2);
    expect(sends.map((s) => s.lineUserId)).toEqual([MUM, DAD]);
    expect(new Set(sends.map((s) => s.key)).size).toBe(2);
  });

  test("🔑 …and neither is filtered out as already-sent", () => {
    // The defect in one assertion: with a per-person key, `alreadyKeyed` would contain the mother's key and
    // the father's send would vanish here — silently, with the accessor working perfectly.
    const sends = reminderSends([group([MUM, DAD])], DAY);
    expect(dueSends(sends, new Set())).toHaveLength(2);
    // The mother already reminded (an earlier run today) ⇒ ONLY the father is still due.
    const due = dueSends(sends, new Set([reminderKey("parent", "p1", DAY)]));
    expect(due).toHaveLength(1);
    expect(due[0]!.lineUserId).toBe(DAD);
  });

  test("⚠️ ONE account behaves exactly as today — the regression that matters most", () => {
    // This is every family we have; the multi-account path is the rare case.
    const sends = reminderSends([group([MUM])], DAY);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.key).toBe("reminder:parent:p1:2026-09-06");
    expect(dueSends(sends, new Set([reminderKey("parent", "p1", DAY)]))).toHaveLength(0); // still send-once
  });

  test("no account ⇒ exactly ONE skipped send, keyed on the person", () => {
    const sends = reminderSends([group([])], DAY);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.lineUserId).toBeNull();
    expect(sends[0]!.key).toBe(reminderKey("parent", "p1", DAY));
  });

  test("the grouping still collapses a day into one message per person", () => {
    const s = (o: Partial<ReminderSession>): ReminderSession => ({
      id: "b1",
      date: DAY,
      startTime: "10:00",
      status: "CONFIRMED",
      teacherId: "t1",
      teacherLineUserId: "U-t1",
      studentId: "st1",
      studentName: "น้องเอ",
      parentId: "p1",
      parentLineUserId: MUM,
      parentLineUserIds: [MUM, DAD],
      subjectName: "Surfskate",
      ...o,
    });
    const groups = groupReminders([s({}), s({ id: "b2", startTime: "11:00", studentName: "น้องบี" })]);
    const parent = groups.find((g) => g.recipientType === "parent")!;
    expect(parent.rows).toHaveLength(2); // one message, both classes
    expect(parent.lineUserIds).toEqual([MUM, DAD]); // …to both phones
    expect(reminderSends([parent], DAY)).toHaveLength(2);
  });
});

describe("🔴 the three outbound senders all ask the ONE accessor", () => {
  test("the deduction message writes one row per account, and one SKIPPED row when there are none", () => {
    const f = fn(DEDUCT, "export async function notifyCourseDeduction");
    expect(f).toContain("familyAccountsOfStudent(exec, input.studentId)");
    expect(f).toContain("for (const lineUserId of accounts)");
    expect(f).toContain("if (!accounts.length)");
    expect(code(DEDUCT)).toContain("return familyLineUserIds(student.parentId, exec)");
    // 🚫 The old column read is gone.
    expect(code(DEDUCT)).not.toContain("parent?.lineUserId");
  });

  test("both scheduler senders go through `enqueueParentCopies`", () => {
    expect(code(SCHED)).toContain("return familyLineUserIds(student.parentId, exec)");
    expect(code(SCHED).match(/enqueueParentCopies\(/g)).toHaveLength(3); // the definition + two call sites
    expect(code(SCHED)).not.toContain("parent?.lineUserId ?? null");
  });

  test("the reminder job resolves the whole day in ONE bulk call — the shape it was written to keep", () => {
    // Calling the single accessor per row would put back the per-row lookup this job exists to avoid.
    expect(code(JOBS)).toContain("familyLineUserIdsBulk(parentIds)");
    expect(code(JOBS)).toContain("familyAccounts.get(r.student.parentId)");
    const job = code(JOBS).slice(code(JOBS).indexOf("export async function runDailyReminderJob"));
    expect(job).not.toContain("await familyLineUserIds(");
  });

  test("🔑 bulk and single are ONE implementation — the answer cannot differ between senders", () => {
    expect(code(FAMILY)).toContain("familyLineUserIdsBulk([parentId], exec)");
    expect(code(FAMILY).match(/new Set\(ids\)/g)).toHaveLength(1); // one dedupe, one primary-first rule
  });
});

describe("🔴 inbound — the second account is recognised, and the hand-rolled copy is gone", () => {
  test("`findParentByLineUserId` resolves through `familyOfLineUser`", () => {
    const f = fn(PARENT, "export async function findParentByLineUserId");
    expect(f).toContain("await familyOfLineUser(lineUserId, exec)");
    // 🔑 Changed at the ONE resolver rather than at seven call sites, so no inbound path can be left behind.
    expect(f).not.toContain("e(x.lineUserId, lineUserId)");
  });

  test("🚫 the hand-rolled copy in `checkin.service.ts` is gone — asserted with its reason", () => {
    // It was the same two-step written out by hand, which is why a grep for the function name never counted it
    // — and why it would have been the one site left behind when every other inbound path moved.
    expect(code(CHECKIN)).toContain("await findParentByLineUserId(lineUserId)");
    expect(code(CHECKIN)).not.toContain("e(p.lineUserId, lineUserId)");
  });

  test("…and no OTHER hand-rolled lookup is left anywhere", () => {
    for (const src of [SCHED, DEDUCT, JOBS, CHECKIN]) {
      expect(code(src)).not.toMatch(/parents\.findFirst\([^)]*lineUserId, lineUserId/);
    }
  });
});

describe("🔴 upstream — the first account stays primary", () => {
  test("`linkParentLine` only writes the column when it is EMPTY", () => {
    const f = fn(PARENT, "export async function linkParentLine");
    expect(f).toContain("isNull(parents.lineUserId)");
    // …and it still refuses an account that belongs to a DIFFERENT family.
    expect(f).toContain("if (owner && owner.id !== parentId)");
  });

  test("the schema says what the column now is — display, not routing", () => {
    const col = SCHEMA.slice(SCHEMA.indexOf("export const parents"), SCHEMA.indexOf("export const students"));
    expect(col).toContain("PRIMARY account, for DISPLAY");
    expect(col).toContain("not a routing fact");
  });

  test("🚫 nothing was migrated — the fallback is what makes that safe", () => {
    // `familyOfLineUser` reads the links first and falls back to the column, so a family that has never had a
    // link row resolves exactly as it always did. No backfill, no migration.
    const f = fn(FAMILY, "export async function familyOfLineUser");
    expect(f).toContain("familyLineLinks.lineUserId, lineUserId");
    expect(f).toContain("e(p.lineUserId, lineUserId)");
  });
});
