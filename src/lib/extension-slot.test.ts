// TASK-148 rework — the shared make-up placement. The preview and the save must agree, so the stepping rule is
// tested once, here, with a synthetic occupancy predicate.
import { describe, expect, test } from "bun:test";
import { firstFreeWeeklySlot } from "./extension-slot";

describe("firstFreeWeeklySlot", () => {
  test("the next week when it is free", async () => {
    expect(await firstFreeWeeklySlot("2026-09-01", () => false)).toBe("2026-09-08");
  });

  test("skips a taken week and lands a week later", async () => {
    const taken = new Set(["2026-09-08"]);
    expect(await firstFreeWeeklySlot("2026-09-01", (d) => taken.has(d))).toBe("2026-09-15");
  });

  test("two make-ups placed in sequence never share a slot (the preview's case)", async () => {
    const claimed = new Set<string>();
    const place = async (from: string) => {
      const d = await firstFreeWeeklySlot(from, (x) => claimed.has(x));
      claimed.add(d);
      return d;
    };
    const first = await place("2026-09-01");
    const second = await place(first);
    expect(first).toBe("2026-09-08");
    expect(second).toBe("2026-09-15"); // not 09-08 twice — the wrong end date the rework fixes
  });

  test("an async predicate (the DB query the save uses) is awaited", async () => {
    const busy = new Set(["2026-09-08", "2026-09-15"]);
    expect(await firstFreeWeeklySlot("2026-09-01", async (d) => busy.has(d))).toBe("2026-09-22");
  });

  test("nothing free within the scan window → the last candidate, for the ceiling guard to refuse", async () => {
    const d = await firstFreeWeeklySlot("2026-09-01", () => true, 3);
    expect(d).toBe("2026-09-29"); // +7 ×4 — never a silently 'valid' date
  });
});
