import { describe, expect, test } from "bun:test";
import { resetSetting } from "./settings.service";

// A minimal stub of the Drizzle exec — records the delete so we don't touch a real DB (brownfield).
function stubExec() {
  const calls: { deleted: boolean; where: unknown } = { deleted: false, where: undefined };
  const exec = {
    delete: () => {
      calls.deleted = true;
      return { where: (cond: unknown) => ((calls.where = cond), Promise.resolve()) };
    },
  };
  return { exec, calls };
}

describe("resetSetting — true reset-to-default (TASK-122)", () => {
  test("deletes the override row and returns the coded default with isOverridden:false", async () => {
    const { exec, calls } = stubExec();
    const r = await resetSetting("checkin_early_minutes", exec);
    expect(calls.deleted).toBe(true); // it removes the row, not PUT-the-default
    expect(calls.where).toBeDefined(); // scoped by key
    expect(r).toEqual({
      key: "checkin_early_minutes",
      label: expect.any(String),
      unit: "minutes",
      value: 30, // the coded default
      default: 30,
      isOverridden: false, // the whole point — the FE can now show "default", honestly
    });
  });

  test("teacher_change_notice_days resets to its coded default (3)", async () => {
    const { exec } = stubExec();
    const r = await resetSetting("teacher_change_notice_days", exec);
    expect(r).toMatchObject({ value: 3, default: 3, isOverridden: false });
  });
});
