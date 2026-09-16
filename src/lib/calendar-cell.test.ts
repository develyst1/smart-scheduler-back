// TASK-368 (`REQ-089 §5`, item 4 re-scoped) — `GET /calendar?includeCancelled=true` shows the range's CANCELLED
// sessions, display only; `PAUSED` stays hidden; the default path is byte-for-byte today's. Three pure pieces
// pinned with values (the coercion, the subtracted list, the cell precedence), the DTO's new key, and the wiring.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CALENDAR_HIDDEN_STATUSES, SLOT_INACTIVE_STATUSES, calendarHiddenStatuses } from "../db/schema";
import { toBookingDTO } from "../db/mappers";
import { cellRank } from "./calendar-cell";
import { readSrc } from "./read-src";
import * as v from "../validation";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
};

describe("🔑 the flag — the `archived` pattern, NOT `z.coerce.boolean()`", () => {
  const parse = (q: Record<string, string>) => v.calendarQuery.safeParse({ date: "2026-09-16", ...q });
  test('"true" ⇒ on', () => expect(parse({ includeCancelled: "true" })).toMatchObject({ success: true, data: { includeCancelled: true } }));
  test('🔴 "false" ⇒ OFF — the string `z.coerce.boolean()` would have made true', () =>
    expect(parse({ includeCancelled: "false" })).toMatchObject({ success: true, data: { includeCancelled: false } }));
  test("absent ⇒ off (today's request is unchanged)", () => expect(parse({})).toMatchObject({ success: true, data: { includeCancelled: false } }));
  test('anything else ("1", "yes", "") ⇒ 400, not a guess', () => {
    for (const x of ["1", "yes", ""]) expect(parse({ includeCancelled: x }).success).toBe(false);
  });
  test("the source says so", () => {
    const Q = region(code(src("src/validation.ts")), "export const calendarQuery = z.object({", "});");
    expect(Q).toContain('z\n    .enum(["true", "false"])\n    .optional()\n    .transform((v) => v === "true")');
    expect(Q).not.toContain("coerce");
  });
});

describe("🔑 the list — subtract, don't branch", () => {
  test("off ⇒ the named list itself; on ⇒ the list minus CANCELLED; PAUSED hidden on both", () => {
    expect(calendarHiddenStatuses(false)).toEqual([...CALENDAR_HIDDEN_STATUSES]);
    expect(calendarHiddenStatuses(true)).toEqual(["PAUSED"]);
    expect(calendarHiddenStatuses(true)).not.toContain("CANCELLED");
    expect(calendarHiddenStatuses(true)).toContain("PAUSED");
  });
  test("🚫 the slot list, the index's list, is untouched — cancelling still frees the slot", () => {
    expect([...SLOT_INACTIVE_STATUSES]).toContain("CANCELLED");
    expect(code(src("src/db/schema.ts"))).toContain('export const SLOT_INACTIVE_STATUSES = ["CANCELLED", "PENDING_RESCHEDULE", "SICK_LEAVE", "PAUSED"] as const;');
  });
});

describe("🔑 the cell — LIVE > SICK_LEAVE > CANCELLED; a cancelled row never displaces, anything displaces it", () => {
  const wins = (cur: string, next: string) => cellRank(next) > cellRank(cur);
  test("the UC-004 rule is unchanged: a live row displaces a leave; a leave never displaces a live row", () => {
    expect(wins("SICK_LEAVE", "CONFIRMED")).toBe(true);
    expect(wins("CONFIRMED", "SICK_LEAVE")).toBe(false);
  });
  test("a cancelled row yields to a live row AND to a leave, in either read order", () => {
    expect(wins("CANCELLED", "CONFIRMED")).toBe(true);
    expect(wins("CONFIRMED", "CANCELLED")).toBe(false);
    expect(wins("CANCELLED", "SICK_LEAVE")).toBe(true);
    expect(wins("SICK_LEAVE", "CANCELLED")).toBe(false);
  });
  test("equal ranks keep the first read — two live rows, two leaves, two cancelled", () => {
    for (const s of ["CONFIRMED", "SICK_LEAVE", "CANCELLED"]) expect(wins(s, s)).toBe(false);
    expect(wins("CONFIRMED", "EXTENDED")).toBe(false); // both live
  });
  test("every status the grid can show that is not a leave or a cancel is LIVE for the cell", () => {
    for (const s of ["PENDING", "CONFIRMED", "ATTENDED", "NO_SHOW", "EXTENDED", "PENDING_RESCHEDULE"]) expect(cellRank(s)).toBe(2);
    expect(cellRank("SICK_LEAVE")).toBe(1);
    expect(cellRank("CANCELLED")).toBe(0);
  });
});

describe("🔑 the DTO — `cancelReason` rides for every reader, `null` on a live row", () => {
  const base = { id: "b", date: "2026-09-16", startTime: "10:00", endTime: "11:00", bookingType: "SINGLE_SESSION", teacher: { id: "t", name: "T", nickname: "T", type: "FULL_TIME" }, student: { id: "s", name: "S" } };
  test("a cancelled row carries status, the closed code and the human sentence; a live row carries null", () => {
    const c = toBookingDTO({ ...base, status: "CANCELLED", cancelReason: "MISTAKE", note: "จองผิดวัน" });
    expect(c).toMatchObject({ status: "CANCELLED", cancelReason: "MISTAKE", note: "จองผิดวัน", courseLast: false });
    expect(toBookingDTO({ ...base, status: "CONFIRMED" }).cancelReason).toBeNull();
  });
});

describe("🔴 the wiring — one list, one query, the default path untouched (source)", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  const CAL = region(SVC, "export async function getCalendar(", "export async function getTeachers(");
  test("`hidden` is computed once from the flag and is the ONE `notInArray`; no second query, no branch on the flag", () => {
    expect(CAL).toContain("const hidden = calendarHiddenStatuses(input.includeCancelled ?? false);");
    expect(CAL).toContain("notInArray(b.status, hidden)");
    expect((CAL.match(/notInArray\(b\.status/g) ?? []).length).toBe(1);
    expect((CAL.match(/db\.query\.bookings\.findMany/g) ?? []).length).toBe(1);
    expect(CAL).not.toContain("includeCancelled ? "); // no ternary on the flag — the subtraction lives in the helper
    expect(CAL).not.toContain('ne(b.status, "CANCELLED")');
  });
  test("the cell rule is `cellRank`, applied where the overlap was resolved before", () => {
    expect(CAL).toContain("if (!cur || cellRank(dto.status) > cellRank(cur.status)) {");
  });
  test("the route passes the validated query through; `SLOT_INACTIVE_STATUSES` is not referenced by the calendar read", () => {
    expect(code(src("src/routes/api.ts"))).toContain('.get("/calendar", zValidator("query", v.calendarQuery), async (c) =>\n    c.json(await svc.getCalendar(c.req.valid("query"))),');
    expect(CAL).not.toContain("SLOT_INACTIVE_STATUSES");
  });
});
