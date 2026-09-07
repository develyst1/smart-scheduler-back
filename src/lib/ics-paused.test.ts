// TASK-272 — a paused session stayed on a teacher's subscribed phone calendar, **as `CONFIRMED`**.
//
// ## Why this was the worst of the three
// `calendar.service.ts` filters NO status, on purpose, and says so: *"CANCELLED bookings are included on
// purpose — they're serialized with `STATUS:CANCELLED` so subscribers remove them; dropping them would leave a
// cancelled class sitting on the teacher's phone."* That is right, and it means **`STATUS:CANCELLED` is this
// feed's only removal channel.** `PAUSED` was never taught it, so `veventStatus`'s trailing `return "CONFIRMED"`
// published a paused class as a confirmed one.
//
// 🔴 **DEF-1's mirror image.** That defect made pause look like a DELETE; this one made it look like nothing
// happened — and unlike a tray, the wrong answer was already in a coach's pocket and stayed there until
// something re-published.
//
// ⚠️ A removal that cannot be undone would be worse than the defect, so the round trip is asserted, not the
// pause half alone.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCalendar, icsUid } from "./ics";
import { bookingStatus } from "../db/schema";
import { readSrc } from "./read-src";

const NOW = new Date("2026-07-31T03:00:00.000Z");
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => readSrc(s).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

type Row = Parameters<typeof buildCalendar>[0][number];
const booking = (o: Partial<Row> = {}): Row => ({
  id: "b1",
  date: "2026-07-31",
  startTime: "09:00:00",
  endTime: "10:00:00",
  studentName: "น้องเอ",
  subjectName: "Surfskate",
  status: "CONFIRMED",
  updatedAt: new Date("2026-07-30T12:00:00.000Z"),
  ...o,
});
const ics = (rows: Row[], lang?: "TH" | "EN") => buildCalendar(rows, { now: NOW, lang });
/** The `STATUS:` line of the single event in a feed. */
const statusLine = (rows: Row[]) =>
  ics(rows)
    .split("\r\n")
    .find((l) => l.startsWith("STATUS:"))!;

describe("TASK-272 — a paused session is REMOVED from the phone, not published as confirmed", () => {
  test("🔴 PAUSED → STATUS:CANCELLED — the feed's only removal channel", () => {
    expect(statusLine([booking({ status: "PAUSED" })])).toBe("STATUS:CANCELLED");
  });

  test("🚫 …and NOT `TENTATIVE` — a paused class is not uncertain, it is not happening", () => {
    // The distinction matters on a phone: `TENTATIVE` leaves the block on the calendar looking provisional,
    // which is the answer for `PENDING`, not for a class that has been taken off the schedule.
    expect(statusLine([booking({ status: "PAUSED" })])).not.toBe("STATUS:TENTATIVE");
    expect(statusLine([booking({ status: "PENDING" })])).toBe("STATUS:TENTATIVE");
  });

  test("🔑 every OTHER status produces exactly what it produced before — 'no-op' is a claim", () => {
    // The map was written out in full, which is a chance to change something by accident. This pins the eight
    // against the old chain of ifs, reproduced here as the expectation.
    const before = (s: string) => (s === "CANCELLED" ? "CANCELLED" : s === "PENDING" ? "TENTATIVE" : "CONFIRMED");
    for (const status of bookingStatus.enumValues) {
      if (status === "PAUSED") continue; // the one deliberate change
      expect({ status, line: statusLine([booking({ status })]) }).toEqual({
        status,
        line: `STATUS:${before(status)}`,
      });
    }
  });

  test("⚠️ SICK_LEAVE stays CONFIRMED — the two surfaces must not disagree about one session", () => {
    // `CALENDAR_HIDDEN_STATUSES` deliberately keeps a leave on the grid. A feed that removed it would make the
    // calendar and the phone say different things about the same class.
    expect(statusLine([booking({ status: "SICK_LEAVE" })])).toBe("STATUS:CONFIRMED");
  });
});

describe("TASK-272 §3 — the round trip: pause then resume brings the class back", () => {
  // Same booking, three publishes. `icsUid` is stable per booking and `SEQUENCE` comes from `updatedAt`, so a
  // subscriber treats these as one event being updated — which is what makes the removal reversible.
  const confirmed = booking({ updatedAt: new Date("2026-07-30T12:00:00.000Z") });
  const paused = booking({ status: "PAUSED", updatedAt: new Date("2026-07-30T13:00:00.000Z") });
  const resumed = booking({ status: "CONFIRMED", updatedAt: new Date("2026-07-30T14:00:00.000Z") });

  const seq = (rows: Row[]) => Number(ics(rows).split("\r\n").find((l) => l.startsWith("SEQUENCE:"))!.slice(9));
  const uid = (rows: Row[]) => ics(rows).split("\r\n").find((l) => l.startsWith("UID:"))!;

  test("🔑 the SAME UID throughout — an update, never three different events", () => {
    expect(uid([confirmed])).toBe(`UID:${icsUid("b1")}`);
    expect(uid([paused])).toBe(uid([confirmed]));
    expect(uid([resumed])).toBe(uid([confirmed]));
  });

  test("🔴 pause REMOVES it, resume BRINGS IT BACK, and the sequence rises each time", () => {
    // A one-way removal would be a worse defect than the one being fixed: the coach would lose a class that
    // came back and never see it again.
    expect(statusLine([confirmed])).toBe("STATUS:CONFIRMED");
    expect(statusLine([paused])).toBe("STATUS:CANCELLED");
    expect(statusLine([resumed])).toBe("STATUS:CONFIRMED");
    // Strictly increasing — a subscriber ignores an update whose SEQUENCE has not advanced.
    expect(seq([paused])).toBeGreaterThan(seq([confirmed]));
    expect(seq([resumed])).toBeGreaterThan(seq([paused]));
  });
});

describe("TASK-272 §5 — the DESCRIPTION carries a LABEL, in the teacher's language", () => {
  const description = (rows: Row[], lang?: "TH" | "EN") =>
    ics(rows, lang)
      .split("\r\n")
      .find((l) => l.startsWith("DESCRIPTION:"))!;

  test("🔴 no raw enum reaches the coach's calendar", () => {
    // `Status: PAUSED` in front of a human is the same class of defect as `status_PAUSED` in a LINE reply,
    // reached by a different route — which is exactly why `t()` was the wrong net for finding it.
    expect(description([booking({ status: "PAUSED" })], "TH")).toBe("DESCRIPTION:Status: พัก");
    expect(description([booking({ status: "PAUSED" })], "EN")).toBe("DESCRIPTION:Status: Paused");
  });

  test("no status publishes as its raw enum name, in either language", () => {
    for (const status of bookingStatus.enumValues) {
      for (const lang of ["TH", "EN"] as const) {
        expect({ status, lang, d: description([booking({ status })], lang) }).not.toEqual({
          status,
          lang,
          d: `DESCRIPTION:Status: ${status}`,
        });
      }
    }
  });

  test("the language defaults to TH, exactly as every other reply does", () => {
    expect(description([booking({ status: "PAUSED" })])).toBe("DESCRIPTION:Status: พัก");
  });

  test("the route takes it from the TEACHER, not from a guess", () => {
    const c = code(readFileSync(resolve(root, "src/routes/calendar.ts"), "utf8"));
    expect(c).toContain('lang: found.teacher.lineLang === "EN" ? "EN" : "TH",');
  });
});

describe("TASK-272 §4 — the control is the compiler", () => {
  test("🔑 the mapping is a total Record over the DB-derived union, not a chain of ifs", () => {
    const c = code(readFileSync(resolve(root, "src/lib/ics.ts"), "utf8"));
    expect(c).toContain('const VEVENT_STATUS: Record<BookingStatus, "CONFIRMED" | "TENTATIVE" | "CANCELLED">');
    // 🚫 The fall-through that hid `PAUSED` for the life of this feature must not come back.
    expect(c).not.toContain('return "CONFIRMED";');
    expect(c).not.toContain("function veventStatus");
    // …and the input is typed, which is why the question now gets asked at all.
    expect(c).toContain("status: BookingStatus;");
  });

  test("🚫 the feed still includes every status — that is what makes the removal work", () => {
    // §6: dropping paused rows from the query instead would leave the stale CONFIRMED event on the phone
    // forever, because a feed cannot remove what it does not mention.
    const c = code(readFileSync(resolve(root, "src/services/calendar.service.ts"), "utf8"));
    expect(c).not.toContain("CALENDAR_HIDDEN_STATUSES");
    expect(c).not.toContain('ne(b.status,');
  });
});
