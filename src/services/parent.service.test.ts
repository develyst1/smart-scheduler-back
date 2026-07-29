// TASK-033 (REQ-011): the student search must not return the whole roster on a non-numeric query. The bug
// was that the parent-phone `ilike` used `normalizePhone(q)`, which is "" for a text query → `%%` matches
// every student with a phone. Fix: include the phone clause only when the query has digits. These tests
// assert the pure condition-builder so no DB is needed (the phone clause is present iff the query has digits).
import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { studentSearchConditions } = await import("./parent.service");

describe("studentSearchConditions — phone clause only when the query has digits (TASK-033)", () => {
  test("text query with no digits → name + nickname only (no phantom phone match)", () => {
    // The REQ-011 bug: previously this produced a 3rd `ilike(phone, '%%')` clause → matched everyone.
    expect(studentSearchConditions("โอ๊ด")).toHaveLength(2);
  });

  test("digit query → name + nickname + parent phone", () => {
    expect(studentSearchConditions("081")).toHaveLength(3);
  });

  test("mixed query containing digits → phone clause included", () => {
    expect(studentSearchConditions("โอ๊ด 081")).toHaveLength(3);
  });

  test("punctuation / spaces with no digits → phone clause omitted", () => {
    expect(studentSearchConditions("  -  ")).toHaveLength(2);
  });
});
