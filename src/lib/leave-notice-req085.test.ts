// TASK-305 (REQ-085 §2 / §7.4 / §9.1) — the message that did not exist.
//
// 🔴 The owner raised it TWICE: *"ของแจ้งเตือนครูเด็กลายังไม่ขึ้น"*, and earlier *"ทำไมของครูไม่มีบอกเหมือนกันกับผปค"*.
// **A parent declares leave, the parent is told, and the coach is not** — so a coach can arrive for a session
// the student cancelled, and the admin who covers every coach learns nothing either.
//
// 🔻 And the reason it read as *not built*: a teacher notification DID exist, **gated on `notify_on_leave`,
// which defaults to `admin_only`** ⇒ it never ran on a default install.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
/** The `sendLeaveNotice` body alone — bounded by its own closing brace at column zero. */
const builderBody = (svc: string) => {
  const start = svc.indexOf("async function sendLeaveNotice(");
  return svc.slice(start, svc.indexOf("\n}", start) + 2);
};

const ctx = {
  studentName: "น้องดีซี",
  subject: "Private Freeskate",
  date: "2026-09-08", // a Tuesday
  startTime: "10:00",
  endTime: "11:00",
  coach: "ครูหนึ่ง",
};
const payload = {
  kind: "leave_notice",
  bookingType: "COURSE_PACKAGE",
  size: 6,
  studentName: "น้องดีซี",
  attendeeNote: "เตรียมเฉพาะ Freeskate ให้น้อง",
};
const render = (o: Record<string, unknown> = {}, audience: "parent" | "teacher" = "teacher") =>
  formatOutboxMessage({ ...payload, ...o }, ctx as any, "TH", audience);

describe("🔑 TASK-305 — the message, pinned BYTE-FOR-BYTE — 🔻 REWRITTEN to `§16d` by TASK-318", () => {
  // 🔻 **Two of this block's three assertions asserted things the customer has since overturned**, and they are
  // REWRITTEN here rather than deleted: an assertion that changes because the requirement changed is correct;
  // one deleted because it failed is how this class ships. 📌 The full `§16d` pin lives in
  // `leave-notice-req085-16d.test.ts`; what stays here is TASK-305's own subject — that the message EXISTS,
  // reaches both recipients, and never the parent.
  test("the shape, now the customer's own", () => {
    expect(render()).toBe(
      "LEAVE NOTICE / แจ้งลา ‼️\n" +
        "Student : น้องดีซี\n" +
        "Program : Private Freeskate 6 HR\n" +
        "Date : 08-09-2026\n" +
        "Time : 10:00-11:00\n" +
        "Coach : ครูหนึ่ง\n" +
        "Remark : เตรียมเฉพาะ Freeskate ให้น้อง",
    );
  });

  test("🔻 the header is BILINGUAL — `§16e` reverses the `§9` ruling this test used to assert", () => {
    // ⚠️ It read *"`LEAVE NOTICE` is ENGLISH in both languages — the §9 ruling supersedes §7.4's Thai `แจ้งลา`"*.
    // The owner gave that ruling before the customer had asked for anything; they asked, and he reversed it.
    // 🔑 **The property this line always protected — the header does not vary by reader language — is UNCHANGED**
    // and is what is asserted below. Only which single string it is changed.
    expect(formatOutboxMessage(payload as any, ctx as any, "EN", "teacher")).toBe(render());
    expect(render()).toContain("แจ้งลา");
  });

  test("🔻 `Date` renders the ACTUAL DATE — it asserted an ENGLISH WEEKDAY, which was the defect", () => {
    // 🔴 The weekday was correct-looking and wrong: two sessions of one weekly course produced two identical
    // messages. `§16d`: *"ครูจะไม่รู้ว่าแจ้งลา พฤ ไหน"*. ⚠️ `§7.1`'s course-wide `Date` is still the weekday —
    // that message describes a RECURRING SLOT — so this is a per-message rule, not a global one.
    expect(render()).toContain("Date : 08-09-2026");
    expect(render()).not.toContain("Date : Tuesday");
    expect(
      formatOutboxMessage({ ...payload, kind: "leave_notice" } as any, { ...ctx, date: "2026-09-06" } as any, "TH", "teacher"),
    ).toContain("Date : 06-09-2026");
  });
});

describe("🔑 TASK-305 §3 — BOTH recipients, and the one who deliberately does NOT get it", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  // 🔻 TASK-306 moved the construction into `sendLeaveNotice`, the ONE builder both doors call — so this slice
  // follows it. The property is unchanged and is now stronger: there is nothing left to keep in step.
  const branch = builderBody(SVC);

  test("🔑 the ADMIN chat AND the teacher's chat — one payload, two sends", () => {
    // ⚠️ A teacher-only test proves half the requirement. Both sends are asserted, and they carry the SAME
    // object — so the coach and the admin can never read different versions of one leave.
    expect(branch).toContain("await notifyAdmins(payload, tx, booking.id);");
    expect(branch).toContain('recipientType: "teacher",');
    expect(branch).toContain("payload,");
  });

  test("🚫 the PARENT is NOT a recipient — asserted as an absence", () => {
    // They are the one who declared it, and the product already confirms the leave to them. This is the
    // assertion that keeps it a notification rather than a broadcast.
    expect(branch).not.toContain('recipientType: "parent"');
    expect(branch).not.toContain("familyLineUserIds");
    expect(branch).not.toContain("parentLineUserId");
  });

  test("🔴 `Coach` is on the message — the reason the field exists is the ADMIN's copy", () => {
    // The teacher reads this in their own chat and already knows the class is theirs; the admin reads every
    // coach's, and without this line three leaves from three teachers arrive looking identical.
    expect(render({}, "teacher")).toContain("Coach : ครูหนึ่ง");
    expect(render({}, "parent")).toContain("Coach : ครูหนึ่ง"); // the admin's copy renders as the fuller audience
  });

  test("🔻 the default-off gate is gone — that is why it read as *not built*", () => {
    // `notify_on_leave` defaulted to `admin_only`, so the teacher branch never ran. The owner's ruling is
    // unconditional, so the setting no longer gates this send.
    expect(branch).not.toContain("notify_on_leave");
    expect(branch).not.toContain("admin_and_teacher");
  });
});

describe("⚠️ TASK-305 §4 — `*ถ้ามี`, and this message has NO `(-)` rule at all", () => {
  test("🔑 `Remark` is ABSENT — the whole line — when there is no note", () => {
    const out = render({ attendeeNote: null });
    expect(out).not.toContain("Remark");
    // 🔻 TASK-318 — the header and the date follow `§16d` now; **the property this test is for is the ABSENT
    // `Remark` line**, and it is unchanged.
    expect(out).toBe(
      "LEAVE NOTICE / แจ้งลา ‼️\nStudent : น้องดีซี\nProgram : Private Freeskate 6 HR\nDate : 08-09-2026\n" +
        "Time : 10:00-11:00\nCoach : ครูหนึ่ง",
    );
  });

  test("🚫 `(-)` NEVER appears — the fourth message running, and the one §9.1 warned about", () => {
    for (const note of [null, "", "   "]) {
      for (const a of ["teacher", "parent"] as const) {
        expect(render({ attendeeNote: note }, a)).not.toContain("(-)");
      }
    }
  });

  test("📌 …and the Remark's value here is specific: a coach learns there is nothing to prepare", () => {
    // A Remark is usually about PREPARATION, so it earns its place on a message about a class NOT happening.
    expect(render()).toContain("Remark : เตรียมเฉพาะ Freeskate ให้น้อง");
  });
});

describe("🚫 TASK-305 §6 — the three shipped formats are untouched", () => {
  test("§7.1, §7.3 and the parent's leave confirmation are unchanged", () => {
    // 🔑 Five messages now share a header vocabulary; each task has to prove it did not disturb the others.
    const session = formatOutboxMessage(
      { kind: "booking_confirmed", bookingType: "SINGLE_SESSION" } as any,
      { studentName: "Aiwa", subject: "Private Freeskate", date: "2026-09-08", startTime: "11:00", endTime: "12:00" } as any,
      "TH",
    );
    expect(session).toBe(
      // 🔻 TASK-343 (`REQ-087 §6b`) — `Date` is the real date now. This file asserts only that the leave work
      // did not disturb its neighbours, and that claim is unchanged.
      "📅CONFIRMED SCHEDULE:\nStudent : Aiwa\nProgram : Private Freeskate 1 HR\nDate : 08-09-2026\nTime : 11:00-12:00",
    );
    // …and the parent's own leave confirmation, which this task must not touch.
    const parentLeave = formatOutboxMessage(
      { kind: "sick_leave", studentName: "น้องซี", via: "line" } as any,
      { date: "2026-07-01", startTime: "10:00" } as any,
    );
    expect(parentLeave).toContain("แจ้งลา");
    expect(parentLeave).toContain("น้องซี");
  });
});

describe("🔴 TASK-306 §1 — the plan editor's door sends the SAME notice", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  const markAbsence = SVC.slice(
    SVC.indexOf('if (change.kind === "mark-absence")'),
    SVC.indexOf('if (change.kind === "insert")'),
  );

  test("🔑 `mark-absence` calls the ONE builder — not a second construction of the message", () => {
    // ⚠️ It cancels a FUTURE session exactly as the per-session action does; an admin using the plan editor is
    // doing the same thing by a different door, and the coach was told by one and not the other.
    // 🔑 Made unfalsifiable rather than asserted-by-comparison: both doors call `sendLeaveNotice`, so there is
    // no second version of the message to keep in step.
    expect(markAbsence).toContain("await sendLeaveNotice(tx, b, {");
    expect(SVC.match(/kind: "leave_notice"/g)).toHaveLength(1);
    expect(SVC.match(/async function sendLeaveNotice\(/g)).toHaveLength(1);
  });

  test("📌 ONE message per SESSION, not per edit — named, because it is a surprise if unstated", () => {
    // Each `mark-absence` change carries ONE `bookingId`, and the notice names a specific class (`Date`,
    // `Time`, `Coach`, `Remark`) — a single message for several sessions could not say WHICH. ⇒ three absences
    // in one edit send three notices.
    expect(markAbsence.match(/sendLeaveNotice/g)).toHaveLength(1); // inside the per-change branch
    expect(markAbsence).toContain("change.kind === \"mark-absence\"");
    // …and the send is INSIDE that branch, so a different change kind sends nothing. ⚠️ Bounded by the end of
    // the plan-change handler: a slice that ran to the end of the file found the builder's own DEFINITION and
    // would have passed on a broken build.
    const insertBranch = SVC.slice(
      SVC.indexOf('if (change.kind === "insert")'),
      SVC.indexOf("async function sendLeaveNotice("),
    );
    expect(insertBranch).not.toContain("sendLeaveNotice");
  });

  test("✅ a plan edit still succeeds when the coach has no LINE link", () => {
    // 🔑 `enqueueLine` writes a SKIPPED row rather than throwing, and the builder does not guard on the link —
    // so the notification cannot fail the edit. Asserted as the ABSENCE of a throw on that path.
    // ⚠️ Bounded by the function's OWN closing brace at column zero: the helper does not sit adjacent to
    // `updateBookingStatus`, and a slice that ran to it swept in unrelated code (it found a `throw` there).
    expect(builderBody(SVC)).not.toContain("throw");
    expect(builderBody(SVC)).toContain("recipientLineUserId: teacher?.lineUserId ?? null,");
  });

  test("🚫 the three paths §1 rules as FINE still send nothing", () => {
    // Creation-time declaration and attendance correction are deliberately silent — the leave predates the
    // class, or the class already happened. Asserted so a later sweep does not "helpfully" wire them.
    const creation = SVC.slice(SVC.indexOf("const absentWeeks = new Set<number>"), SVC.indexOf("if (absentWeeks.size) await reconcileCoursePlan"));
    expect(creation).not.toContain("sendLeaveNotice");
    const correction = SVC.slice(SVC.indexOf('} else if (action === "sick-leave" && current.status === "SICK_LEAVE")'));
    expect(correction.slice(0, correction.indexOf('} else if (action === "sick-leave")'))).not.toContain("sendLeaveNotice");
  });
});
