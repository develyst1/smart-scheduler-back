// SPEC-070 / TASK-228 (REQ-078 AC-16 revised) — an อื่นๆ booking on the teacher's LINE.
//
// 🔴 Asserted on the **composed message text**, not on payload fields. The DoD says so for a reason a previous
// task paid for: a test that checks "the field is set" passes happily on *"ประชุมทีม · นักเรียน: "* — an empty
// label, which reads to a teacher as information that went missing. The string is the thing a human receives,
// so the string is what is asserted.
//
// 🚫 Nothing here sends anything. Compose-and-assert only; real delivery is Tanya's, inside the owner's window.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { formatOutboxMessage } from "../lib/line-message";
import { renderSchedule } from "../lib/line-schedule";
import { groupReminders, type ReminderSession } from "../lib/daily-reminder";

const SVC = readSrc(await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text());
const JOBS = readSrc(await Bun.file(new URL("./jobs.service.ts", import.meta.url)).text());
const OUTBOX = readSrc(await Bun.file(new URL("./outbox.service.ts", import.meta.url)).text());

const confirmed = { kind: "booking_confirmed", bookingId: "b1", attendeeNote: null };

describe("🔴 AC-16 — the admin's title names it, and no empty label is printed", () => {
  test("a STUDENTLESS อื่นๆ confirmation shows the title and NO student / program label", () => {
    const msg = formatOutboxMessage(confirmed, {
      title: "ประชุมทีม",
      date: "2026-09-10",
      startTime: "10:00",
      endTime: "11:00",
    });
    expect(msg).toContain("ประชุมทีม");
    // The two labels must be absent entirely — not present with nothing after them.
    expect(msg).not.toContain("นักเรียน");
    expect(msg).not.toMatch(/:\s*$/m); // no line ends in a bare colon
    expect(msg).not.toMatch(/:\s*\n/); // …nor in a colon followed by a newline
  });

  test("🔴 the message never says “อื่นๆ” or “Other” — being asked to type a real name is the whole point", () => {
    for (const lang of ["TH", "EN"] as const) {
      const msg = formatOutboxMessage(confirmed, { title: "ปิดปรับปรุงลาน", date: "2026-09-10", startTime: "10:00" }, lang);
      expect(msg).not.toContain("อื่นๆ");
      expect(msg).not.toMatch(/\bOther\b/);
      expect(msg).toContain("ปิดปรับปรุงลาน");
    }
  });

  test("the title stands on its OWN line, with no label — it is not a student", () => {
    const msg = formatOutboxMessage(confirmed, { title: "ประชุมทีม", date: "2026-09-10", startTime: "10:00" });
    expect(msg.split("\n").some((l) => l.trim() === "ประชุมทีม")).toBe(true);
  });

  test("an อื่นๆ booking WITH a student shows both — the title names it, the student is a real fact", () => {
    const msg = formatOutboxMessage(confirmed, {
      title: "ประชุมกับผู้ปกครอง",
      studentName: "เด็กชายเอ",
      date: "2026-09-10",
      startTime: "10:00",
    });
    expect(msg).toContain("ประชุมกับผู้ปกครอง");
    expect(msg).toContain("เด็กชายเอ");
  });
});

describe("🔴 the four existing types' messages are byte-identical", () => {
  const ctx = {
    studentName: "น้องเอ",
    subject: "Surfskate",
    date: "2026-09-10",
    startTime: "10:00",
    endTime: "11:00",
  };

  test("a lesson confirmation with no title renders exactly as before", () => {
    // `title` is absent for every lesson type, so the new line renders to "" and the output is unchanged.
    const msg = formatOutboxMessage(confirmed, ctx);
    expect(msg).toContain("น้องเอ");
    expect(msg).toContain("Surfskate");
    expect(msg).not.toContain("undefined");
    // The title line contributes nothing: the body starts at the student label.
    const lines = msg.split("\n");
    expect(lines[1]).toContain("น้องเอ");
  });

  test("the title is the ONLY thing added to the confirm template", () => {
    // A diff check in test form: everything else in the template is untouched.
    const before = formatOutboxMessage(confirmed, ctx);
    const withTitle = formatOutboxMessage(confirmed, { ...ctx, title: "ประชุม" });
    expect(withTitle.replace("ประชุม\n", "")).toBe(before);
  });

  test("a lesson row still renders program · status on the indented line", () => {
    const out = renderSchedule(
      [{ date: "2026-09-10", startTime: "10:00:00", studentName: "น้องเอ", subjectName: "Surfskate", status: "CONFIRMED" }],
      "TH",
      "today",
    );
    expect(out).toContain("Surfskate · ");
  });
});

describe("🔴 the daily schedule line — title-named, and no blank program segment", () => {
  test("an อื่นๆ row shows the title and NO leading ' · '", () => {
    const out = renderSchedule(
      [{ date: "2026-09-10", startTime: "10:00:00", studentName: "ประชุมทีม", subjectName: null, status: "CONFIRMED" }],
      "TH",
      "today",
    );
    expect(out).toContain("ประชุมทีม");
    // The status still shows; what must not appear is a separator with nothing before it.
    expect(out).not.toMatch(/^\s+· /m);
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
  });

  test("mixed day: the lesson keeps its program, the อื่นๆ row does not grow one", () => {
    const out = renderSchedule(
      [
        { date: "2026-09-10", startTime: "09:00:00", studentName: "น้องเอ", subjectName: "Surfskate", status: "CONFIRMED" },
        { date: "2026-09-10", startTime: "10:00:00", studentName: "ประชุมทีม", subjectName: null, status: "CONFIRMED" },
      ],
      "TH",
      "today",
    );
    expect(out).toContain("Surfskate · ");
    expect(out).not.toMatch(/^\s+· /m);
  });
});

describe("🔴 AC-16 — EVERY assigned teacher, on the schedule and in the confirmation", () => {
  const s = (o: Partial<ReminderSession> & { id: string }): ReminderSession => ({
    date: "2026-09-10",
    startTime: "10:00:00",
    status: "CONFIRMED",
    teacherId: "t1",
    teacherLineUserId: "Ut1",
    studentId: null,
    studentName: "ประชุมทีม",
    parentId: null,
    parentLineUserId: null,
    subjectName: null,
    ...o,
  });

  test("3 teachers ⇒ 3 schedule groups, one each — not one group naming them all", () => {
    const groups = groupReminders([
      s({
        id: "b1",
        additionalTeachers: [
          { id: "t2", lineUserId: "Ut2" },
          { id: "t3", lineUserId: null },
        ],
      }),
    ]);
    const teachers = groups.filter((g) => g.recipientType === "teacher");
    expect(teachers.map((g) => g.personId).sort()).toEqual(["t1", "t2", "t3"]);
    // Each gets the session on their OWN list, once.
    for (const g of teachers) expect(g.rows).toHaveLength(1);
    // An unlinked extra still forms a group, so it is counted and written as SKIPPED rather than dropped.
    expect(teachers.find((g) => g.personId === "t3")!.lineUserId).toBeNull();
  });

  test("each of them reads the TITLE, not a student name or a placeholder", () => {
    const groups = groupReminders([s({ id: "b1", additionalTeachers: [{ id: "t2", lineUserId: "Ut2" }] })]);
    for (const g of groups.filter((x) => x.recipientType === "teacher")) {
      expect(g.rows[0]!.studentName).toBe("ประชุมทีม");
      expect(renderSchedule(g.rows, "TH", "today")).toContain("ประชุมทีม");
    }
  });

  test("the four lesson types are unchanged: no extras ⇒ exactly one teacher group", () => {
    const groups = groupReminders([
      s({ id: "b1", studentName: "น้องเอ", subjectName: "Surfskate", studentId: "st1", parentId: "p1" }),
    ]);
    expect(groups.filter((g) => g.recipientType === "teacher")).toHaveLength(1);
  });

  test("a teacher on TWO อื่นๆ bookings gets one group with both rows, not two groups", () => {
    const groups = groupReminders([
      s({ id: "b1", additionalTeachers: [{ id: "t2", lineUserId: "Ut2" }] }),
      s({ id: "b2", startTime: "13:00:00", teacherId: "t2", teacherLineUserId: "Ut2" }),
    ]);
    const t2 = groups.filter((g) => g.recipientType === "teacher" && g.personId === "t2");
    expect(t2).toHaveLength(1);
    expect(t2[0]!.rows).toHaveLength(2);
  });
});

describe("the confirm path — one message per teacher, from the one id accessor (source)", () => {
  const confirmBlock = SVC.slice(SVC.indexOf('if (action === "confirm")'), SVC.indexOf("await issueCheckinToken"));

  test("🔴 it LOOPS over the assigned teachers rather than sending to `teacher_id` alone", () => {
    expect(confirmBlock).toContain("await assignedTeacherIds(tx, id, current.teacherId)");
    expect(confirmBlock).toContain("for (const t of teachers)");
    expect(confirmBlock).toContain('recipientType: "teacher"');
  });

  test("one message PER teacher — the payload is built once and reused, never a body naming them all", () => {
    // A shared body would change what the other four types read too.
    expect(confirmBlock).toContain("const confirmPayload = {");
    expect(confirmBlock).not.toMatch(/teachers\.map\([^)]*nickname/);
  });

  test("🚫 it does not read the join table here — that is the accessor's job", () => {
    expect(confirmBlock).not.toContain("bookingTeachers");
  });

  test("the returned `notification` still describes the booking's OWN teacher", () => {
    // The FE renders it as "ส่ง LINE แล้ว / ยังไม่ผูก LINE"; it must keep meaning what it always meant.
    expect(confirmBlock).toContain("if (t.id === current.teacherId) notification = res;");
  });

  test("🔴 AC-17 is WITHDRAWN — no branch exists for a teacher-less booking", () => {
    // A branch for a state the schema forbids is dead code the next reader takes for a supported case — and an
    // impossible case handed to QA gets marked "pass".
    expect(confirmBlock).not.toMatch(/if \(!.*teacherId\)/);
    expect(confirmBlock).not.toContain("no teacher");
  });
});

describe("the reminder job feeds the same rule (source)", () => {
  test("the schedule name is `otherTitle` first — the DTO's `displayName` rule, not a second one", () => {
    expect(JOBS).toContain('studentName: r.otherTitle ?? r.student?.nickname ?? r.student?.name ?? "-"');
  });

  test("no program becomes `null`, not the `-` placeholder", () => {
    expect(JOBS).toContain("subjectName: r.subject?.name ?? null");
  });

  test("the additional teachers are loaded in the query, not per booking", () => {
    // A Saturday is ~60 sessions; a per-row lookup is the shape this job was written to avoid.
    expect(JOBS).toContain("additionalTeachers: { with: { teacher: true } }");
  });

  test("the outbox worker carries the title into the message context", () => {
    expect(OUTBOX).toContain("title: b.otherTitle ?? undefined");
  });
});
