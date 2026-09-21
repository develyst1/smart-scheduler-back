// TASK-368 (`REQ-089 §5.1`, item 4 as the owner shaped it) — `GET /calendar?includeCancelled=true` adds a
// separate cancelled TRAY: the response gains `cancelled: BookingDTO[]` (every CANCELLED row in range, date/time
// order); the GRID is exactly today's — the hidden list is the constant, the cell rule untouched, a cancelled row
// never enters the cell map. Absent/false ⇒ no `cancelled` key: today's response byte for byte.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CALENDAR_HIDDEN_STATUSES, SLOT_INACTIVE_STATUSES } from "../db/schema";
import { toBookingDTO } from "../db/mappers";
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

describe("🔑 the DTO — `cancelReason` rides for every reader, `null` on a live row", () => {
  const base = { id: "b", date: "2026-09-16", startTime: "10:00", endTime: "11:00", bookingType: "SINGLE_SESSION", teacher: { id: "t", name: "T", nickname: "T", type: "FULL_TIME" }, student: { id: "s", name: "S" } };
  test("a cancelled row carries status, the closed code and the human sentence; `courseLast` false by construction", () => {
    const c = toBookingDTO({ ...base, status: "CANCELLED", cancelReason: "ADMIN_ERROR", note: "จองผิดวัน" });
    expect(c).toMatchObject({ status: "CANCELLED", cancelReason: "ADMIN_ERROR", note: "จองผิดวัน", courseLast: false });
    expect(toBookingDTO({ ...base, status: "CONFIRMED" }).cancelReason).toBeNull();
  });
});

describe("🔴 the GRID is exactly today's — the constant list, the UC-004 cell rule, no cancelled row in the cell map (source)", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  // ⚠️ LAZY: a region computed at describe level THROWS before any test registers, and the whole block vanishes
  // as "0 fail" — mutation B of this task did exactly that. Inside a test, a moved anchor is a FAIL.
  const CAL = () => region(SVC, "export async function getCalendar(", "export async function getTeachers(");
  const GRID = () => region(CAL(), "const bookingRows =", "const cancelled =");
  test("the grid query hides the constant list; nothing subtracts from it; the two lists are untouched", () => {
    expect(GRID()).toContain("notInArray(b.status, [...CALENDAR_HIDDEN_STATUSES])");
    expect(CAL()).not.toMatch(/calendarHiddenStatuses|cellRank|hidden\b/);
    expect([...CALENDAR_HIDDEN_STATUSES]).toEqual(["CANCELLED", "PAUSED"]);
    expect([...SLOT_INACTIVE_STATUSES]).toContain("CANCELLED");
  });
  test("the cell rule is the UC-004 literal, and the cancelled read is AFTER the cell map is built — it can never enter it", () => {
    expect(GRID()).toContain('if (!cur || (cur.status === "SICK_LEAVE" && dto.status !== "SICK_LEAVE")) {');
    expect(CAL().indexOf("const cancelled =")).toBeGreaterThan(CAL().indexOf("idx.set(key, dto);"));
    expect(region(CAL(), "const cancelled =", "return {")).not.toContain("idx.");
  });
});

describe("🔑 the TRAY — on request only, every CANCELLED row in range, date/time order, absent otherwise (source)", () => {
  const SVC = code(src("src/services/scheduler.service.ts"));
  const CAL = () => region(SVC, "export async function getCalendar(", "export async function getTeachers(");
  const TRAY = () => region(CAL(), "const cancelled = input.includeCancelled", ": undefined;");
  test("a separate read, gated on the flag, status = CANCELLED, the same range, ordered by date then time", () => {
    expect(TRAY()).toContain('and(gte(b.date, range.start), lte(b.date, range.end), eq(b.status, "CANCELLED"), scope ? ownScopeWhere(scope) : undefined)'); // 🔻 TASK-406: + the own-scope term (null for an admin ⇒ `and` drops it)
    expect(TRAY()).toContain("orderBy: (b, { asc: a }) => [a(b.date), a(b.startTime)]");
    expect(TRAY()).toContain("with: withBookingRelations,");
    expect(TRAY()).not.toContain("pendingSlot"); // every cancelled row, no B.1 filter — the tray is a list, not a grid
  });
  test("the rows are full BookingDTOs (the rental rides as a relation since TASK-371); `courseLast` is never passed (false by construction)", () => {
    expect(TRAY()).toContain("rows.map((row) => toBookingDTO(row))");
    expect(TRAY()).not.toContain("courseLast");
  });
  test("🔴 the key is ABSENT when not asked for — today's response byte for byte; present (possibly []) when asked", () => {
    expect(CAL()).toContain("...(cancelled ? { cancelled } : {}),");
    expect(CAL()).toContain("const cancelled = input.includeCancelled\n    ? await");
    expect(CAL()).toContain(": undefined;");
  });
  test("the route passes the validated query through", () => {
    expect(code(src("src/routes/api.ts"))).toContain('.get("/calendar", zValidator("query", v.calendarQuery), async (c) =>\n    c.json(await svc.getCalendar(c.req.valid("query"), viewerOf(c))),'); // 🔻 TASK-406: + the scope; 🔻 TASK-426: the viewer (scope + the budget mask) from ONE object
  });
});
