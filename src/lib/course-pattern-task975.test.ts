import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { expandPattern, type Slot } from "./course-pattern";

// TASK-975 (D-159-2) — `expandPattern` lays the pattern out FROM `fromDate` when it is BEFORE the course start; for any later `fromDate` the output is the base code's, byte for byte.

const SLOTS: Slot[] = [
  { weekday: 1, startTime: "10:00", teacherId: "t-a" },
  { weekday: 1, startTime: "11:00", teacherId: "t-b" },
  { weekday: 3, startTime: "13:00", teacherId: "t-c" },
  { weekday: 4, startTime: "10:00", teacherId: "t-d" },
];
const flat = (rows: ReturnType<typeof expandPattern>) => rows.map((r) => `${r.date} ${r.startTime} ${r.teacherId}`);

describe("expandPattern — fromDate before the start", () => {
  test("(a) start Mon 2027-02-01, fromDate 2026-11-23: first row 11-23 10:00, all before the start, in date order, each with its slot's coach", () => {
    const rows = expandPattern("2027-02-01", SLOTS, 10, new Set(), "2026-11-23");
    expect(flat(rows)).toEqual([
      "2026-11-23 10:00 t-a", "2026-11-23 11:00 t-b", "2026-11-25 13:00 t-c", "2026-11-26 10:00 t-d",
      "2026-11-30 10:00 t-a", "2026-11-30 11:00 t-b", "2026-12-02 13:00 t-c", "2026-12-03 10:00 t-d",
      "2026-12-07 10:00 t-a", "2026-12-07 11:00 t-b",
    ]);
    expect(rows.every((r) => r.date < "2027-02-01")).toBe(true);
    expect(rows.map((r) => r.date + r.startTime)).toEqual([...rows.map((r) => r.date + r.startTime)].sort());
    expect(rows[0].week).toBe(1); // counted from fromDate
  });
  test("(a2) a fromDate that is not the start weekday still gives the first `size` occurrences on or after it", () => {
    const rows = expandPattern("2027-02-01", SLOTS, 3, new Set(), "2026-11-24"); // a Tuesday
    expect(flat(rows)).toEqual(["2026-11-25 13:00 t-c", "2026-11-26 10:00 t-d", "2026-11-30 10:00 t-a"]);
  });
  test("(b) fromDate = startDate is the same as no fromDate", () => {
    expect(expandPattern("2027-02-01", SLOTS, 10, new Set(), "2027-02-01")).toEqual(expandPattern("2027-02-01", SLOTS, 10));
  });
  test("(c) a fromDate AFTER the start (the resume shape) is pinned to today's output", () => {
    const rows = expandPattern("2026-11-02", SLOTS, 5, new Set(), "2026-11-12"); // start Mon, from Thu of course week 2
    expect(rows.map((r) => `${r.date} ${r.startTime} ${r.teacherId} w${r.week}`)).toEqual([
      "2026-11-12 10:00 t-d w2", "2026-11-16 10:00 t-a w3", "2026-11-16 11:00 t-b w3", "2026-11-18 13:00 t-c w3", "2026-11-19 10:00 t-d w3",
    ]);
  });
  test("a one-week-before fromDate never emits a row before it", () => {
    for (const from of ["2027-01-25", "2027-01-31", "2026-12-31"]) {
      expect(expandPattern("2027-02-01", SLOTS, 6, new Set(), from).every((r) => r.date >= from)).toBe(true);
    }
  });
  test("by source: the anchor line is there once", () => {
    const src = readFileSync(new URL("./course-pattern.ts", import.meta.url), "utf8");
    expect((src.match(/const anchor = fromDate < startDate \? fromDate : startDate;/g) ?? []).length).toBe(1);
  });
});
