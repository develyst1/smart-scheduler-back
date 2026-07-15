import { describe, expect, test } from "bun:test";
import { findTypeConflict } from "./badge-rules";

describe("badge one-per-type rule", () => {
  test("no conflict when every value is a different type", () => {
    expect(
      findTypeConflict([
        { id: "v1", typeId: "branch" },
        { id: "v2", typeId: "promo" },
      ]),
    ).toBeNull();
  });

  test("empty list is fine", () => {
    expect(findTypeConflict([])).toBeNull();
  });

  test("returns the duplicated type id", () => {
    expect(
      findTypeConflict([
        { id: "v1", typeId: "branch" },
        { id: "v2", typeId: "branch" },
      ]),
    ).toBe("branch");
  });
});
