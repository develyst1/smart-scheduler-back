// TASK-542 — `plannedAtCreation` on the ADMIN booking DTO, raw, so the leave dialog can tell a leave declared at course creation (it
// appends the make-up and charges NO quota — the owner's decision B) from an ordinary one. Pinned: by value both ways · nothing else
// in the DTO moved (the full key set) · the PUBLIC check-in answer never carries it (the allow-list, TASK-499) · a scoped teacher
// sees it on their own rows (stated).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toBookingDTO, toPublicCheckinBooking } from "../db/mappers";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const ROW = { id: "b1", date: "2026-10-02", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "SICK_LEAVE", teacher: { id: "t1", nickname: "Ek", name: "Ekachai" }, student: { id: "s1", name: "มะขิด", nickname: "ขิด" } };

describe("🔑 `plannedAtCreation` — raw, by value both ways", () => {
  test("a leave declared at course creation ⇒ true; an ordinary leave ⇒ false; a row that never had it ⇒ false (never undefined)", () => {
    expect(toBookingDTO({ ...ROW, plannedAtCreation: true }).plannedAtCreation).toBe(true);
    expect(toBookingDTO({ ...ROW, plannedAtCreation: false }).plannedAtCreation).toBe(false);
    expect(toBookingDTO({ ...ROW }).plannedAtCreation).toBe(false);
  });
  test("🚫 nothing else moved: the admin DTO's key set is the previous 33 + `plannedAtCreation` (the same under every provenance view)", () => {
    const BASE = ["attendeeNote", "badges", "bookingType", "campKidCount", "campWeekDayId", "campWeekId", "cancelReason", "coStudent", "course", "courseLast", "date", "discount", "displayName", "endTime", "group", "groupId", "groupName", "id", "incomingBookingId", "note", "other", "otherSeriesKey", "pendingSlot", "plannedAtCreation", "rate", "rental", "rescheduleTo", "startTime", "status", "student", "subject", "teacher", "teachers", "title"];
    expect(Object.keys(toBookingDTO({ ...ROW, plannedAtCreation: true })).sort()).toEqual(BASE);
    const PROV = [...BASE, "checkinActor", "checkinChannel", "checkinSource"].sort();
    expect(Object.keys(toBookingDTO({ ...ROW }, { provenance: "raw" })).sort()).toEqual(PROV);
    expect(Object.keys(toBookingDTO({ ...ROW }, { provenance: "masked" })).sort()).toEqual(PROV);
  });
});

describe("🔒 the PUBLIC answers are unaffected — confirmed, not assumed", () => {
  test("the public check-in booking is the six-field allow-list, whatever the admin DTO carries", () => {
    const pub = toPublicCheckinBooking(toBookingDTO({ ...ROW, plannedAtCreation: true }))!;
    expect(Object.keys(pub).sort()).toEqual(["date", "endTime", "startTime", "student", "subject", "teacher"]);
    expect(JSON.stringify(pub)).not.toContain("plannedAtCreation");
  });
  test("by source: every PUBLIC check-in answer goes out through the allow-list (the token page, the shop front, LINE) — never the admin DTO", () => {
    const C = code(readFileSync(resolve(root, "src/services/checkin.service.ts"), "utf8"));
    expect(C).toContain("return { already: true, booking: toPublicCheckinBooking(booking),");
    expect(C).toContain("return { already: false, booking: toPublicCheckinBooking(result.booking),");
    expect(C).not.toMatch(/return \{[^}]*booking: (booking|result\.booking)[,}]/); // no raw admin booking handed back
  });
});

describe("📌 the scoped teacher — the answer, stated", () => {
  test("a scoped teacher reads the SAME DTO for their own rows (calendar / list / by-id — scope filters ROWS, masks only provenance) ⇒ they see `plannedAtCreation` on their own leaves", () => {
    // Harmless by design: the row's SICK_LEAVE status is already theirs to see, and `course` (toCourseSummary) already carries the
    // course's leave counts; this says only WHICH of those leaves was declared at creation. The one per-view mask is provenance.
    const masked = toBookingDTO({ ...ROW, plannedAtCreation: true }, { provenance: "masked" });
    expect([masked.plannedAtCreation, masked.checkinActor]).toEqual([true, null]);
  });
});
