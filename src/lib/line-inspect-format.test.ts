// Pure-format test for the TASK-045 inspect command. The script itself only calls read-only LINE GETs at
// runtime; `formatMenu` is the part that decides whether the operator can SEE hypothesis (A), so it's tested.
import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { formatMenu } = await import("../../scripts/line-inspect-menus");

describe("line:inspect-menus formatMenu (TASK-045)", () => {
  test("prints each area's bounds + action data (the direct test of hypothesis A)", () => {
    const out = formatMenu("parentTH", "richmenu-1", {
      name: "smart-scheduler-parent-th",
      size: { width: 2500, height: 1686 },
      chatBarText: "เมนู",
      selected: true,
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "postback", data: "action=checkin" } },
        { bounds: { x: 833, y: 0, width: 833, height: 843 }, action: { type: "postback", data: "action=leave" } },
      ],
    });
    expect(out).toContain("parentTH [richmenu-1]");
    expect(out).toContain("2500x1686");
    expect(out).toContain("areas: 2");
    expect(out).toContain("action.type=postback data=action=checkin");
    expect(out).toContain("(833,0 833x843)");
    expect(out).not.toContain("NO AREAS");
  });

  test("an areas-less menu is called out loudly — that IS the dead-tap cause", () => {
    const out = formatMenu("parentTH", "richmenu-2", { name: "x", size: { width: 2500, height: 1686 }, areas: [] });
    expect(out).toContain("areas: 0");
    expect(out).toContain("NO AREAS");
    expect(out).toContain("hypothesis A");
  });

  test("a missing menu id is reported, not crashed on", () => {
    expect(formatMenu("teacherEN", "richmenu-gone", null)).toContain("NOT FOUND on LINE");
  });
});
