// SPEC-063 / TASK-178 (REQ-068) — the two rules of the attendee note that cannot be checked by reading the
// happy path: that the edit touches ONE column of ONE booking (AC-3), and that it notifies NOBODY (AC-8).
//
// These are source-level assertions on purpose. "We didn't call notify" is exactly the kind of claim that is
// true the day it is written and quietly stops being true when someone later routes note edits through the
// move path "for consistency" — and a LINE push to a teacher because a typo was fixed is not something the
// test suite would otherwise notice.
import { describe, expect, test } from "bun:test";
import { setAttendeeNote as noteSchema } from "../validation";

const SRC = await Bun.file(new URL("./scheduler.service.ts", import.meta.url)).text();
const fn = SRC.slice(SRC.indexOf("export async function setAttendeeNote"));
const body = fn.slice(0, fn.indexOf("\n}") + 2);

describe("setAttendeeNote — AC-3 / AC-8 (TASK-178)", () => {
  test("🔴 AC-8: nothing in it can notify — no outbox, no LINE, no push", () => {
    for (const forbidden of ["enqueue", "notify", "Outbox", "outbox", "pushTo", "sendLine"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  test("🔴 AC-3: it writes `attendeeNote` and nothing else", () => {
    expect(body).toContain("set({ attendeeNote })");
    expect(body).not.toContain("note:"); // never the status-reason column
    expect(body).not.toContain("status:"); // a note is not a status change
  });

  test("🔴 AC-3: it targets ONE booking by id — never a course, never a set", () => {
    expect(body).toContain("where(eq(bookings.id, id))");
    expect(body).not.toContain("courseId");
    expect(body).not.toContain("inArray");
  });

  test("a missing booking is refused, not silently ignored", () => {
    expect(body).toContain("notFound");
  });
});

describe("the note's shape (zod)", () => {
  test("200 chars is the ceiling, and it is enforced with a Thai message", () => {
    expect(noteSchema.safeParse({ attendeeNote: "ก".repeat(200) }).success).toBe(true);
    const tooLong = noteSchema.safeParse({ attendeeNote: "ก".repeat(201) });
    expect(tooLong.success).toBe(false);
    expect(JSON.stringify(tooLong)).toContain("200");
  });

  test("🔑 null CLEARS the note — that is an edit, not a missing field", () => {
    expect(noteSchema.safeParse({ attendeeNote: null }).success).toBe(true);
    expect(noteSchema.safeParse({}).success).toBe(false); // omitting it is not the same as clearing it
  });

  test("whitespace is trimmed, so a note of spaces cannot masquerade as content", () => {
    const parsed = noteSchema.parse({ attendeeNote: "  พาน้องมาด้วย  " });
    expect(parsed.attendeeNote).toBe("พาน้องมาด้วย");
  });
});
