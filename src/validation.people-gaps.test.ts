// TASK-050 — the two small people-endpoint gaps, at the contract layer where they were missing.
// Both fields already existed in the schema; only the request schemas refused to carry them.
import { describe, expect, test } from "bun:test";
import { createParent, createParentStudent, updateParent } from "./validation";

describe("parent `note` is reachable again (TASK-050 gap 1)", () => {
  test("accepted on create", () => {
    const r = createParent.safeParse({ phone: "0812345678", name: "คุณแม่เอ", note: "แพ้นม" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.note).toBe("แพ้นม");
  });

  test("accepted on edit, and can be cleared with null", () => {
    expect(updateParent.safeParse({ note: "ย้ายบ้านแล้ว" }).success).toBe(true);
    expect(updateParent.safeParse({ note: null }).success).toBe(true);
  });

  test("omitting it still works — nothing else about the parent endpoints changed", () => {
    const r = createParent.safeParse({ phone: "0812345678" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.note).toBeUndefined();
  });
});

describe("student demographics in ONE call (TASK-050 gap 2)", () => {
  test("🔑 create accepts gender / birthDate / nationality — no follow-up PATCH needed", () => {
    const r = createParentStudent.safeParse({
      name: "น้องเอ",
      nickname: "เอ",
      gender: "female",
      birthDate: "2018-05-02",
      nationality: "TH",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.gender).toBe("female");
      expect(r.data.birthDate).toBe("2018-05-02");
      expect(r.data.nationality).toBe("TH");
    }
  });

  test("omitting them still works exactly as today (LINE self-registration path)", () => {
    const r = createParentStudent.safeParse({ name: "น้องบี" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.gender).toBeUndefined();
  });

  test("a malformed birthDate is still rejected (the DATE rule is unchanged)", () => {
    expect(createParentStudent.safeParse({ name: "น้องซี", birthDate: "02/05/2018" }).success).toBe(false);
  });

  test("name is still required", () => {
    expect(createParentStudent.safeParse({ gender: "male" }).success).toBe(false);
  });
});
