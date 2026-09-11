// SPEC-072 §3 / TASK-254 (REQ-077 Parent 3) — `COURSE DEDUCTION`, and its two triggers.
//
// 🔴 The defect this file exists to prevent is not a wrong number; it is a message that exists for one path and
// not the other. Quota is deducted when an admin marks attendance **and** at the day-end auto-attend, and since
// REQ-070 the day-end auto-attends every unmarked class — **so the job is the majority path.** A message wired
// only to the manual site would be missing for most sessions **and would pass every test anyone thought to
// write**, because the test would check the path its author was looking at. ⇒ both call sites are asserted, in
// their own source, on purpose.
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";
import { deductionPayload, remainingLabel } from "./course-deduction";
import { formatOutboxMessage } from "./line-message";
import { visibleFields } from "./line-message-fields";

const SCHED = readSrc(await Bun.file(new URL("../services/scheduler.service.ts", import.meta.url)).text());
const JOBS = readSrc(await Bun.file(new URL("../services/jobs.service.ts", import.meta.url)).text());
const HELPER = readSrc(await Bun.file(new URL("./course-deduction.ts", import.meta.url)).text());
const LINE = readSrc(await Bun.file(new URL("./line.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("🔴 ONE helper, called from BOTH deduction sites", () => {
  test("the manual attendance path calls it", () => {
    expect(code(SCHED)).toContain("notifyCourseDeduction(tx, {");
    // …inside the guard that does the deduction, not beside it: the message is tied to the write.
    const attend = code(SCHED).slice(code(SCHED).indexOf('} else if (action === "attend")'));
    const block = attend.slice(0, attend.indexOf('} else if (action === "cancel")'));
    expect(block).toContain('if (current.status !== "ATTENDED")');
    expect(block.match(/notifyCourseDeduction\(/g)).toHaveLength(2); // course + voucher
  });

  test("🔴 the DAY-END path calls it too — the one that would have been forgotten", () => {
    expect(code(JOBS).match(/notifyCourseDeduction\(tx, \{/g)).toHaveLength(2);
    // …and it is inside `runEndOfDayJob`'s auto-attend loop, where the quota is actually written.
    const job = code(JOBS).slice(code(JOBS).indexOf("export async function runEndOfDayJob"));
    expect(job.indexOf("usedSessions} + 1")).toBeLessThan(job.indexOf("notifyCourseDeduction"));
  });

  test("🚫 neither site builds its own message — there is one writer", () => {
    // ⚠️ Scoped to the DEDUCTION sites, not the whole file: since TASK-256 the same `jobs.service.ts` also holds
    // the daily-reminder job, which legitimately renders `remainingLabel` for a different message. The rule
    // being asserted is "the deduction does not compose its own text", and that is where it must be checked.
    const job = code(JOBS).slice(code(JOBS).indexOf("for (const b of due)"), code(JOBS).indexOf("return { autoAttended:"));
    const attend = code(SCHED).slice(code(SCHED).indexOf('} else if (action === "attend")'));
    const manual = attend.slice(0, attend.indexOf('} else if (action === "cancel")'));
    for (const block of [job, manual]) {
      expect(block).not.toContain('kind: "course_deduction"');
      expect(block).not.toContain("remainingLabel(");
    }
    expect(code(HELPER)).toContain('kind: "course_deduction"');
  });
});

describe("🔴 `Remaining` is the balance AFTER the write, taken FROM the write", () => {
  test("the day-end reads the row back with `.returning()`", () => {
    // That update is `used + 1` **in SQL**: the post-value exists only in the database until it is read back.
    const job = code(JOBS).slice(code(JOBS).indexOf("export async function runEndOfDayJob"));
    const courseWrite = job.slice(job.indexOf("usedSessions} + 1"), job.indexOf("coursesAutoAttended++"));
    expect(courseWrite).toContain(".returning()");
    expect(job).toContain("used: course.usedSessions");
    expect(job).toContain("used: voucher.usedHours");
  });

  test("🚫 …and never a second SELECT — a concurrent write between them would print a number true at neither", () => {
    const job = code(JOBS).slice(code(JOBS).indexOf("export async function runEndOfDayJob"));
    const loop = job.slice(job.indexOf("for (const b of due)"), job.indexOf("return { autoAttended:"));
    expect(loop).not.toContain("findFirst");
    expect(loop).not.toContain(".select(");
  });

  test("the manual site passes the post-value it already holds", () => {
    const attend = code(SCHED).slice(code(SCHED).indexOf('} else if (action === "attend")'));
    expect(attend.slice(0, 1400)).toContain("const used = current.course.usedSessions + 1");
    expect(attend.slice(0, 1400)).toContain("used,");
  });

  test("🔻 TASK-338 — the doc-block is checked AGAINST THE FUNCTION, so THIS one cannot go stale silently", () => {
    // ❓ @Sober asked whether anything cheap would have caught two comments that went stale within HOURS of
    // the change that staled them. ✅ **For one narrow class, yes — and it is here rather than claimed.**
    // 🔑 The doc-block quotes LITERALS the function produces, so the function can simply be ASKED.
    // ⚠️ **It generalises no further, and that limit is the honest half of the answer:** a comment about WHY,
    // about another file, or about intent has nothing to compare itself against.
    // 📌 Offered, not assumed — if it is not wanted, delete it; the comment fix stands without it.
    const doc = HELPER.slice(0, HELPER.indexOf("export function remainingLabel"));
    const block = doc.slice(doc.lastIndexOf("/**"));
    expect(block).toContain(`\`${remainingLabel("course", 2, 6)}\` for a course`);
    expect(block).toContain(`\`${remainingLabel("voucher", 4, 6)}\` for a voucher`);
    // 🚫 …and the word TASK-335 removed is not TAUGHT here. The note inside the function still records its
    // removal, which is HISTORY and must stay — the distinction is TENSE, not the presence of the word.
    // 🔻 CORRECTED BY THIS ASSERTION ITSELF: my first version demanded the word be absent from the WHOLE
    // block — and it FAILED, because the block now carries a 🔻 line RECORDING the removal. **That line must
    // stay: §3's rule is TENSE, and I had just written a history sentence and then asserted history away.**
    // ⇒ scoped to the line that TEACHES, which is the only line a reader copies from.
    const teaches = block.split("\n").find((l) => l.includes("for a voucher"))!;
    expect(teaches).not.toContain("ครั้ง");
    expect(block).toContain("TASK-335 removed the voucher"); // …and the history is still there
  });

  test("🔻 TASK-343 — the label is `n/N unit` for BOTH kinds: `2/6 HR` and `4/6 sessions`", () => {
    // 🔻 TASK-335 (`REQ-087 §1c`) — `ครั้ง` is GONE: it was THAI inside a value the SYSTEM generates, which
    // `REQ-085 §4` rules out. **REMOVED rather than translated** — `14/15` beside `Remaining :` already says
    // *14 of 15 left*, and choosing an English unit word would invent a string that is the customer's to
    // choose. 🔻 **TASK-335 left the COURSE form alone; TASK-343 changed BOTH** — see below.
    // 🔻 TASK-343 (`REQ-087 §6a`) — ONE SHAPE, `n/N unit`, for BOTH kinds. The course form said `2 HR`:
    // ⚠️ **a unit with no denominator, which does not say OF WHAT** — *3-of-4 and 3-of-10 read identically*.
    // 🚫 The UNIT is deliberately NOT unified (a voucher sells SESSIONS, a course sells HOURS); the SHAPE is.
    // 📖 `sessions` and the `n/N` shape are @Porter's words, RATIFIED BY THE OWNER — **not the customer's.**

    expect(remainingLabel("course", 2, 6)).toBe("2/6 HR");
    expect(remainingLabel("voucher", 4, 6)).toBe("4/6 sessions");
    // 🔑 The denominator needed NO plumbing: `remainingLabel` was already handed `total` and the course
    // branch ignored it. Asserted here so that fact is visible rather than re-derived.
    // The last session leaves zero, and zero is a number a parent must be told plainly.
    expect(remainingLabel("course", 0, 6)).toBe("0/6 HR");
    // Never negative: an over-attended course reads 0, not -1 — a negative on a money line reads as a fault.
    expect(remainingLabel("voucher", -1, 6)).toBe("0/6 sessions");
  });

  test("the payload computes remaining as total − used, from the post-value", () => {
    // 🔻 TASK-336 — a SECOND argument now: the session's own `attendeeNote`, read by `notifyCourseDeduction`
    // from the `bookingId` it already takes. **No CALLER supplies it**, which is why it is a parameter and
    // not a field on `DeductionInput` — an input field nobody sets reads as one somebody forgot.
    expect(deductionPayload({ bookingId: "b1", studentId: "s1", kind: "course", used: 4, total: 6, expiryDate: null }, null))
      .toMatchObject({ kind: "course_deduction", bookingType: "COURSE_PACKAGE", remaining: "2/6 HR", attendeeNote: null });
    expect(deductionPayload({ bookingId: "b1", studentId: "s1", kind: "voucher", used: 2, total: 6, expiryDate: "2026-12-31" }, "แพ้ถั่ว"))
      .toMatchObject({ bookingType: "VOUCHER", remaining: "4/6 sessions", expiryDate: "2026-12-31", attendeeNote: "แพ้ถั่ว" });
  });
});

describe("🔴 who gets it — the guard is 'a balance was deducted', not a type list", () => {
  test("only a booking with a course or a voucher can reach the helper at all", () => {
    // The condition is the SAME one the deduction itself uses (`if (b.courseId)` / `if (b.voucherId)`), so the
    // message cannot drift from the thing it announces. A type list beside it could.
    const job = code(JOBS).slice(code(JOBS).indexOf("for (const b of due)"));
    expect(job.indexOf("if (b.courseId)")).toBeLessThan(job.indexOf("notifyCourseDeduction"));
    expect(code(SCHED)).toContain("if (current.courseId && current.course)");
    expect(code(SCHED)).toContain("if (current.voucherId && current.voucher)");
    // 🚫 No `bookingType` list anywhere near the decision.
    expect(code(HELPER)).not.toContain("FIRST_TRIAL");
    expect(code(HELPER)).not.toContain("SINGLE_SESSION");
  });

  test("📌 1HR · 1st Trial · อื่นๆ deduct from nothing, so they announce nothing", () => {
    // @Porter's reason, kept: announcing a subtraction that did not happen is worse than silence. Those types
    // carry no `courseId`/`voucherId`, so both guards above are false and no row is written.
    for (const type of ["ONE_HOUR", "FIRST_TRIAL", "OTHER"] as const) {
      expect(visibleFields("course_deduction", type, "parent")).not.toContain("remaining");
      expect(visibleFields("course_deduction", type, "parent")).not.toContain("expiry");
    }
  });

  test("🚫 a studentless booking writes NO parent row — not even a SKIPPED one", () => {
    // SPEC-072 §5: a row addressed to nobody still lands in the outbox as SKIPPED and reads as *we tried to
    // reach a family*, when there was none. An อื่นๆ never deducts, so this should be unreachable — asserted
    // rather than relied on.
    expect(code(HELPER)).toContain("if (!input.studentId) return;");
    const helper = code(HELPER).slice(code(HELPER).indexOf("export async function notifyCourseDeduction"));
    expect(helper.indexOf("if (!input.studentId) return;")).toBeLessThan(helper.indexOf("enqueueLine("));
  });
});

describe("🔴 a day-end RE-RUN sends no second message", () => {
  test("the message is enqueued INSIDE the write that deducts — so a re-run that deducts nothing says nothing", () => {
    // The auto-attend selects `status = CONFIRMED` and the first run leaves everything ATTENDED, so a second
    // run's `due` list is empty and the loop — message included — never executes. The idempotency is the
    // deduction's own, not a second mechanism that could disagree with it.
    const job = code(JOBS).slice(code(JOBS).indexOf("export async function runEndOfDayJob"));
    expect(job).toContain('eq(bookings.status, "CONFIRMED")');
    const loop = job.slice(job.indexOf("for (const b of due)"), job.indexOf("return { autoAttended:"));
    expect(loop).toContain("notifyCourseDeduction");
  });

  test("⚠️ the outbox key was NOT used, and the source says why", () => {
    // `idempotencyKey` (TASK-218) is the obvious candidate and cannot be used here: its own signature says it
    // may only be used OUTSIDE a transaction — the duplicate is detected by swallowing a 23505, which leaves
    // the surrounding transaction aborted. Both deduction sites are inside one.
    expect(code(LINE)).toContain("idempotencyKey?: string;");
    expect(LINE).toContain("may only be used OUTSIDE a transaction");
    expect(code(HELPER)).not.toContain("idempotencyKey");
    expect(HELPER).toContain("cannot be used here");
  });

  test("the enqueue runs on the caller's transaction, so the message and the deduction commit together", () => {
    // Atomic with the write it announces: no message for a deduction that rolled back, and no deduction whose
    // message was lost between commit and enqueue.
    const helper = code(HELPER).slice(code(HELPER).indexOf("export async function notifyCourseDeduction"));
    expect(helper).toContain("exec,");
  });
});

describe("the rendered message — Parent 3, and the teacher does not get the family's expiry", () => {
  const ctx = {
    studentName: "น้องเอ",
    subject: "Private Freeskate",
    date: "2026-09-06",
    startTime: "10:00",
    endTime: "11:00",
    coach: "ครูหนึ่ง, ครูสอง",
  };
  const payload = { kind: "course_deduction", bookingType: "COURSE_PACKAGE", remaining: "2 HR", total: 6, expiryDate: "2026-12-31" };

  test("it answers 'เหลือเท่าไหร่' in the customer's own shape", () => {
    const out = formatOutboxMessage(payload, ctx, "TH", "parent");
    expect(out).toContain("💡COURSE DEDUCTION");
    expect(out).toContain("Student : น้องเอ");
    expect(out).toContain("Program : Private Freeskate 6 HR");
    // 🔻 TASK-344 (`REQ-087 §7`) — `DD-MM-YYYY` here too. 📌 *The customer's SHAPE is what this test names
    // and it is unchanged; the date's FORMAT is what moved.*
    expect(out).toContain("Date : 06-09-2026");
    expect(out).not.toContain("2026-09-06"); // 🚫 the ISO form reaches no reader
    expect(out).toContain("Time : 10:00-11:00");
    expect(out).toContain("Remaining : 2 HR");
    // 🔻 TASK-345 (`REQ-087 §7`) — `*Expiry date` / `Start` / the leave DATES are `DD-MM-YYYY` now. 📌 *The
    // claim each of these tests makes is untouched; only the format of the date inside it moved.*
    expect(out).toContain("*Expiry date : 31-12-2026");
  });

  test("`Coach` names every assigned teacher, joined — one field, not two lines", () => {
    // A second `Coach :` line would read as a second class.
    const out = formatOutboxMessage(payload, ctx, "TH", "parent");
    expect(out).toContain("Coach : ครูหนึ่ง, ครูสอง");
    expect(out.split("\n").filter((l) => l.startsWith("Coach")).length).toBe(1);
  });

  test("🔴 the teacher's copy IS the parent's, expiry included (owner: เอาหมด, 2026-09-07)", () => {
    // Was: *keeps the balance but loses the family's expiry.* TASK-269 §3 emptied `AUDIENCE_OMITS.teacher`,
    // and this template is affected the same way as the other two — the table is per-audience, not
    // per-template, which is why it is asserted here rather than assumed from the confirmed-schedule test.
    const teacher = formatOutboxMessage(payload, ctx, "TH", "teacher");
    const parent = formatOutboxMessage(payload, ctx, "TH", "parent");
    expect(teacher).toContain("Remaining : 2 HR");
    expect(teacher).toBe(parent);
  });

  test("a voucher renders its programme and its `n/N` — no Thai in a generated value (TASK-335)", () => {
    const v = { ...payload, bookingType: "VOUCHER", remaining: "4/6" };
    const out = formatOutboxMessage(v, ctx, "TH", "parent");
    expect(out).toContain("Program : Private Freeskate");
    expect(out).toContain("Remaining : 4/6");
  });
});
