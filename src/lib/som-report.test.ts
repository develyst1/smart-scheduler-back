import { describe, expect, test } from "bun:test";
import {
  UNKNOWN_KEY,
  ageBand,
  ageFrom,
  breakdown,
  inMonth,
  monthOf,
  primarySport,
} from "./som-report";

const TODAY = "2026-08-01";

describe("breakdown — unknown is a first-class bucket (REQ-013 / TASK-062)", () => {
  test("counts by key and always reports {known, unknown, total}", () => {
    const b = breakdown(
      [{ g: "female" }, { g: "female" }, { g: "male" }, { g: null }],
      (r) => r.g,
    );
    expect(b.total).toBe(4);
    expect(b.known).toBe(3);
    expect(b.unknown).toBe(1);
    expect(b.buckets.find((x) => x.key === "female")!.count).toBe(2);
  });

  test("🔑 null / undefined / blank all fall into `unknown` — they never vanish", () => {
    const b = breakdown([{ v: null }, { v: undefined }, { v: "   " }, { v: "th" }], (r) => r.v);
    expect(b.unknown).toBe(3);
    expect(b.known).toBe(1);
    expect(b.buckets.find((x) => x.key === UNKNOWN_KEY)!.count).toBe(3);
  });

  test("the unknown bucket is present even when nothing is unknown (FE never infers it)", () => {
    const b = breakdown([{ v: "a" }], (r) => r.v);
    expect(b.buckets.some((x) => x.key === UNKNOWN_KEY)).toBe(true);
    expect(b.unknown).toBe(0);
  });

  test("an empty list is a valid, honest breakdown", () => {
    const b = breakdown([] as Array<{ v: string }>, (r) => r.v);
    expect(b).toMatchObject({ known: 0, unknown: 0, total: 0 });
  });

  test("known buckets sort by count desc (stable render)", () => {
    const b = breakdown([{ v: "a" }, { v: "b" }, { v: "b" }], (r) => r.v);
    expect(b.buckets[0]!.key).toBe("b");
  });
});

describe("ageFrom / ageBand — derived at read time, never stored", () => {
  test("age accounts for whether the birthday has passed this year", () => {
    expect(ageFrom("2016-08-01", TODAY)).toBe(10); // birthday today
    expect(ageFrom("2016-08-02", TODAY)).toBe(9); // tomorrow → still 9
    expect(ageFrom("2016-07-31", TODAY)).toBe(10);
  });

  test("🔑 no DOB → null → the unknown bucket (not age 0)", () => {
    expect(ageFrom(null, TODAY)).toBeNull();
    expect(ageBand(null, TODAY)).toBeNull();
    expect(ageBand(undefined, TODAY)).toBeNull();
  });

  test("band boundaries land in the right band", () => {
    expect(ageBand("2021-08-01", TODAY)).toBe("0-5"); // 5
    expect(ageBand("2020-08-01", TODAY)).toBe("6-9"); // 6
    expect(ageBand("2017-08-01", TODAY)).toBe("6-9"); // 9
    expect(ageBand("2016-08-01", TODAY)).toBe("10-12"); // 10
    expect(ageBand("2011-08-01", TODAY)).toBe("13-15"); // 15
    expect(ageBand("2009-08-01", TODAY)).toBe("16-17"); // 17
    expect(ageBand("2008-08-01", TODAY)).toBe("18+"); // 18
  });
});

describe("primarySport — one unit per student, so shares sum to 100%", () => {
  test("the subject with the most bookings wins", () => {
    const s = primarySport([
      { subjectId: "surf", subjectName: "Surfskate", date: "2026-07-01" },
      { subjectId: "surf", subjectName: "Surfskate", date: "2026-07-08" },
      { subjectId: "bike", subjectName: "Balance Bike", date: "2026-07-02" },
    ]);
    expect(s).toEqual({ id: "surf", name: "Surfskate" });
  });

  test("🔑 a tie is broken by the MOST RECENT booking", () => {
    const s = primarySport([
      { subjectId: "surf", subjectName: "Surfskate", date: "2026-07-01" },
      { subjectId: "bike", subjectName: "Balance Bike", date: "2026-07-20" },
    ]);
    expect(s!.id).toBe("bike");
  });

  test("the tie-break uses time when the dates match", () => {
    const s = primarySport([
      { subjectId: "surf", subjectName: "S", date: "2026-07-20", startTime: "09:00" },
      { subjectId: "bike", subjectName: "B", date: "2026-07-20", startTime: "15:00" },
    ]);
    expect(s!.id).toBe("bike");
  });

  test("🔑 a student with ZERO bookings → null (unknown bucket), not a crash", () => {
    expect(primarySport([])).toBeNull();
  });

  test("bookings with no subject are ignored rather than counted", () => {
    expect(primarySport([{ subjectId: null, date: "2026-07-01" }])).toBeNull();
  });
});

describe("monthOf / inMonth — Bangkok-relative, resolved server-side", () => {
  test("monthOf takes YYYY-MM", () => {
    expect(monthOf("2026-08-01")).toBe("2026-08");
  });

  test("🔑 the month-boundary trap: 01 Aug 02:00 Bangkok is 31 Jul UTC — it must count as August", () => {
    // Without the +07:00 shift this row would be filed under July for the first 7 hours of every month.
    expect(inMonth(new Date("2026-07-31T19:00:00Z"), "2026-08")).toBe(true);
    expect(inMonth(new Date("2026-07-31T16:00:00Z"), "2026-08")).toBe(false); // 23:00 Bangkok, still July
  });

  test("accepts ISO strings and rejects junk/null safely", () => {
    expect(inMonth("2026-08-15T00:00:00Z", "2026-08")).toBe(true);
    expect(inMonth(null, "2026-08")).toBe(false);
    expect(inMonth("not-a-date", "2026-08")).toBe(false);
  });
});
