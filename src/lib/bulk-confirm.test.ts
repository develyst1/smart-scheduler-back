import { describe, expect, test } from "bun:test";
import { preCheckBulkConfirm } from "./bulk-confirm";

describe("preCheckBulkConfirm — bulk-confirm id classification (TASK-036)", () => {
  test("missing booking → skipped (not found)", () => {
    const expected = { proceed: false, outcome: "skipped", reason: "ไม่พบคาบเรียน" } as const;
    expect(preCheckBulkConfirm(null)).toEqual(expected);
    expect(preCheckBulkConfirm(undefined)).toEqual(expected);
  });

  test("PENDING → proceed to the real single-confirm", () => {
    expect(preCheckBulkConfirm({ status: "PENDING" })).toEqual({ proceed: true });
  });

  test("already CONFIRMED / ATTENDED → already_confirmed (retry-safe, no new LINE)", () => {
    expect(preCheckBulkConfirm({ status: "CONFIRMED" })).toEqual({
      proceed: false,
      outcome: "already_confirmed",
    });
    expect(preCheckBulkConfirm({ status: "ATTENDED" })).toEqual({
      proceed: false,
      outcome: "already_confirmed",
    });
  });

  test("any other non-PENDING → skipped (bulk never un-cancels)", () => {
    for (const status of ["CANCELLED", "NO_SHOW", "SICK_LEAVE", "EXTENDED"]) {
      expect(preCheckBulkConfirm({ status })).toEqual({
        proceed: false,
        outcome: "skipped",
        reason: "ไม่ใช่คาบที่รอยืนยัน",
      });
    }
  });
});
