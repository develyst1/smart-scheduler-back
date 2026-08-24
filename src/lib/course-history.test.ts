import { describe, expect, test } from "bun:test";
import {
  bookingEventKind,
  buildCourseHistory,
  movementEventKind,
  type HistoryBookingInput,
  type HistoryMovementInput,
} from "./course-history";

const B = (over: Partial<HistoryBookingInput>): HistoryBookingInput => ({
  id: "b",
  status: "CONFIRMED",
  bookingType: "COURSE_PACKAGE",
  date: "2026-09-07",
  extendedFromId: null,
  note: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("bookingEventKind (SPEC-035 / TASK-119)", () => {
  test("status maps directly; EXTENDED = makeup, SINGLE_SESSION = extra", () => {
    expect(bookingEventKind({ status: "ATTENDED", bookingType: "COURSE_PACKAGE" })).toBe("attended");
    expect(bookingEventKind({ status: "NO_SHOW", bookingType: "COURSE_PACKAGE" })).toBe("no-show");
    expect(bookingEventKind({ status: "CANCELLED", bookingType: "COURSE_PACKAGE" })).toBe("cancelled");
    expect(bookingEventKind({ status: "SICK_LEAVE", bookingType: "COURSE_PACKAGE" })).toBe("sick-leave");
    expect(bookingEventKind({ status: "EXTENDED", bookingType: "COURSE_PACKAGE" })).toBe("makeup-appended");
    expect(bookingEventKind({ status: "CONFIRMED", bookingType: "COURSE_PACKAGE" })).toBe("scheduled");
    // a SINGLE_SESSION with this courseId is the paid extra, whatever its status
    expect(bookingEventKind({ status: "CONFIRMED", bookingType: "SINGLE_SESSION" })).toBe("extra-session-added");
  });
});

describe("movementEventKind — freelance ledger only (SPEC-035)", () => {
  test("BOOKING = draw, BOOKING_REVERSAL = refund; a SALE is not a deduction event", () => {
    expect(movementEventKind("BOOKING")).toBe("freelance-drawn");
    expect(movementEventKind("BOOKING_REVERSAL")).toBe("freelance-refunded");
    expect(movementEventKind("SALE")).toBeNull();
    expect(movementEventKind(null)).toBeNull();
  });
});

describe("buildCourseHistory — an attended/sick/makeup/cancel/extra course (TASK-119 DoD)", () => {
  const bookings: HistoryBookingInput[] = [
    B({ id: "s1", status: "ATTENDED", date: "2026-09-07", updatedAt: "2026-09-07T10:00:00.000Z" }),
    B({
      id: "s2",
      status: "SICK_LEAVE",
      date: "2026-09-14",
      note: "ป่วย",
      updatedAt: "2026-09-13T09:00:00.000Z",
    }),
    B({
      id: "mk",
      status: "EXTENDED",
      date: "2026-10-05",
      extendedFromId: "s2", // makeup of the 09-14 absence
      createdAt: "2026-09-13T09:00:05.000Z",
    }),
    B({
      id: "s3",
      status: "CANCELLED",
      date: "2026-09-21",
      note: "ยกเลิกโดยแอดมิน",
      updatedAt: "2026-09-20T08:00:00.000Z",
    }),
    B({
      id: "x1",
      status: "CONFIRMED",
      bookingType: "SINGLE_SESSION",
      date: "2026-09-10",
      createdAt: "2026-09-08T12:00:00.000Z",
    }),
  ];
  const movements: HistoryMovementInput[] = [
    { refId: "s1", refType: "BOOKING", qty: -1, valueMinor: 30000, createdAt: "2026-09-05T00:00:00.000Z" },
    { refId: "s2", refType: "BOOKING_REVERSAL", qty: 1, valueMinor: -30000, createdAt: "2026-09-13T09:00:01.000Z" },
    // a revenue SALE for the extra — must NOT appear as a deduction event
    { refId: "x1", refType: "SALE", qty: -1, valueMinor: 169000, createdAt: "2026-09-11T20:00:00.000Z" },
  ];

  const { summary, events } = buildCourseHistory({ size: 4, leaveUsed: 1 }, bookings, movements);

  test("summary counts only COURSE_PACKAGE delivered sessions", () => {
    // ATTENDED is the only delivered COURSE_PACKAGE row → usedSessions 1; the extra (SINGLE_SESSION) doesn't count.
    expect(summary).toEqual({
      size: 4,
      usedSessions: 1,
      leaveUsed: 1,
      remaining: 3,
      liveEndDate: "2026-10-05", // the EXTENDED makeup is the latest LIVE course row
    });
  });

  test("every event kind is present, the SALE is excluded, and it's ordered by `at`", () => {
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("attended");
    expect(kinds).toContain("sick-leave");
    expect(kinds).toContain("makeup-appended");
    expect(kinds).toContain("cancelled");
    expect(kinds).toContain("extra-session-added");
    expect(kinds).toContain("freelance-drawn");
    expect(kinds).toContain("freelance-refunded");
    expect(kinds).not.toContain("scheduled"); // none left scheduled here
    // 5 bookings + 2 freelance movements (the SALE dropped) = 7 events
    expect(events).toHaveLength(7);
    // ordered ascending by `at`
    const ats = events.map((e) => e.at);
    expect([...ats].sort()).toEqual(ats);
    // first event is the pre-course freelance draw (2026-09-05)
    expect(events[0]).toMatchObject({ kind: "freelance-drawn", valueMinor: 30000 });
  });

  test("makeup event links back to the absence date; reasons + actor:null carried", () => {
    const makeup = events.find((e) => e.kind === "makeup-appended")!;
    expect(makeup.makeupOfDate).toBe("2026-09-14");
    const sick = events.find((e) => e.kind === "sick-leave")!;
    expect(sick.reason).toBe("ป่วย");
    expect(events.every((e) => e.actor === null)).toBe(true); // limit #1 — who isn't tracked
  });
});

// REQ-070 / TASK-180: the day-end job no longer writes NO_SHOW, but `uat` and every future export still hold
// rows that have it. This pins that history keeps rendering — the enum value stays for exactly this reason,
// and deleting it "because nothing writes it any more" would blank out real sessions in a family's history.
describe("historical NO_SHOW still renders (REQ-070)", () => {
  test("a NO_SHOW row from before the change is still a recognised event, not a blank", () => {
    expect(bookingEventKind({ status: "NO_SHOW", bookingType: "COURSE_PACKAGE" })).toBe("no-show");
  });
});
