// TASK-130 (REQ-042) — the pure part of `line:adopt-menus`. The script's only other move is a read + one
// upsert; the selection is what decides whether the DB ends up with the RIGHT four ids (and whether a gap is
// reported instead of a half map), so it's the part worth testing.
import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { selectMenuIds } = await import("../../scripts/line-adopt-menus");

const menu = (richMenuId: string, name: string) => ({ richMenuId, name });

describe("line:adopt-menus selectMenuIds (TASK-130)", () => {
  test("maps the four canonical names onto the MenuIds keys", () => {
    const { ids, missing } = selectMenuIds([
      menu("rm-p-th", "smart-scheduler-parent-th"),
      menu("rm-p-en", "smart-scheduler-parent-en"),
      menu("rm-t-th", "smart-scheduler-teacher-th"),
      menu("rm-t-en", "smart-scheduler-teacher-en"),
    ]);
    expect(ids).toEqual({ parentTH: "rm-p-th", parentEN: "rm-p-en", teacherTH: "rm-t-th", teacherEN: "rm-t-en" });
    expect(missing).toEqual([]);
  });

  test("duplicate names (this OA has 2 of each) → the LAST occurrence wins, deterministically", () => {
    const list = [
      menu("rm-p-th-1", "smart-scheduler-parent-th"),
      menu("rm-p-en-1", "smart-scheduler-parent-en"),
      menu("rm-t-th-1", "smart-scheduler-teacher-th"),
      menu("rm-t-en-1", "smart-scheduler-teacher-en"),
      menu("rm-p-th-2", "smart-scheduler-parent-th"),
      menu("rm-p-en-2", "smart-scheduler-parent-en"),
      menu("rm-t-th-2", "smart-scheduler-teacher-th"),
      menu("rm-t-en-2", "smart-scheduler-teacher-en"),
    ];
    const { ids, missing } = selectMenuIds(list);
    expect(ids).toEqual({
      parentTH: "rm-p-th-2",
      parentEN: "rm-p-en-2",
      teacherTH: "rm-t-th-2",
      teacherEN: "rm-t-en-2",
    });
    expect(missing).toEqual([]);
    expect(selectMenuIds(list).ids).toEqual(ids); // re-run picks the same ids → adopt is idempotent
  });

  test("a missing name is reported (the script then stores nothing)", () => {
    const { ids, missing } = selectMenuIds([
      menu("rm-p-th", "smart-scheduler-parent-th"),
      menu("rm-t-th", "smart-scheduler-teacher-th"),
    ]);
    expect(ids).toEqual({ parentTH: "rm-p-th", teacherTH: "rm-t-th" });
    expect(missing).toEqual(["smart-scheduler-parent-en", "smart-scheduler-teacher-en"]);
  });

  test("menus created outside our publish are ignored, and an empty OA reports all four", () => {
    const { ids, missing } = selectMenuIds([menu("rm-x", "made-in-oa-manager"), { richMenuId: "rm-y" }]);
    expect(ids).toEqual({});
    expect(missing).toHaveLength(4);
  });
});
