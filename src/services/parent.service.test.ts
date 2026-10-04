// TASK-033 (REQ-011): the student search must not return the whole roster on a non-numeric query. The bug
// was that the parent-phone `ilike` used `normalizePhone(q)`, which is "" for a text query → `%%` matches
// every student with a phone. Fix: include the phone clause only when the query has digits. These tests
// assert the pure condition-builder so no DB is needed (the phone clause is present iff the query has digits).
// 🔻 TASK-660 (F5) — "has digits" was the same bug one step on (`Ari3y` ⇒ `phone ILIKE '%3%'`, 228 rows on TEST-075):
// the phone clause now rides only when the query is PHONE-SHAPED (digits + phone separators, ≥ 3 digits).
import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { studentSearchConditions } = await import("./parent.service");
const { studentSearchQuery } = await import("./search.queries");

describe("studentSearchConditions — phone clause only when the query is phone-shaped (TASK-033 → TASK-660)", () => {
  test("text query with no digits → name + nickname only (no phantom phone match)", () => {
    // The REQ-011 bug: previously this produced a 3rd `ilike(phone, '%%')` clause → matched everyone.
    expect(studentSearchConditions("โอ๊ด")).toHaveLength(2);
  });

  test("digit query → name + nickname + parent phone", () => {
    expect(studentSearchConditions("081")).toHaveLength(3);
  });

  // 🔻 TASK-660 — this test USED to say "mixed query containing digits → phone clause included". That pinned TASK-033's
  // "any digit" rule, which was never a business decision about mixed searches. Porter's ruling (TASK-660 Q1): a name +
  // digits search is looking for a PERSON, so it matches names only. Searching by phone is still one plain number away.
  test("mixed query (name + digits) → name + nickname only, no phone clause (TASK-660 Q1)", () => {
    expect(studentSearchConditions("โอ๊ด 081")).toHaveLength(2);
  });

  test("punctuation / spaces with no digits → phone clause omitted", () => {
    expect(studentSearchConditions("  -  ")).toHaveLength(2);
  });

  // TASK-660 (F5) — the real student whose name flooded the list, and the lone digit.
  const cases: Array<[string, number]> = [
    ["Ari3y", 2],
    ["Ari3y(V)'MOM", 2],
    ["2", 2], // under the 3-digit floor — was 1347 rows
    ["081", 3],
    ["081-234-5678", 3],
    ["+66 81 234", 3],
    ["  -  ", 2],
  ];
  for (const [q, n] of cases) test(`F5: ${JSON.stringify(q)} → ${n} conditions`, () => expect(studentSearchConditions(q)).toHaveLength(n));
});

// 🔴 TASK-660 — Porter's condition: the two ORDINARY searches are pinned UNCHANGED through the generated SQL (no database),
// so a change to either PATTERN goes red, not only a change in how many conditions there are. A search that returns too
// little is the same complaint from the other side, and the harder one to notice.
describe("🔴 the ordinary searches are unchanged — pinned through `studentSearchQuery(...).toSQL()`", () => {
  const where = (q: string) => {
    const { sql, params } = studentSearchQuery(q).toSQL();
    return { where: sql.slice(sql.indexOf(" where ")), params };
  };
  test("a pure-digit search still finds PHONES: `081` ⇒ phone ilike `%081%`, beside name and nickname", () => {
    expect(where("081")).toEqual({
      where: ' where ("students"."name" ilike $1 or "students"."nickname" ilike $2 or "parents"."phone" ilike $3)',
      params: ["%081%", "%081%", "%081%"],
    });
  });
  test("a formatted phone still finds phones: the needle is the DIGITS (`%0812345678%`)", () => {
    expect(where("081-234-5678").params).toEqual(["%081-234-5678%", "%081-234-5678%", "%0812345678%"]);
  });
  test("a pure-name search still finds NAMES: `Aileen` ⇒ name + nickname `%Aileen%`, and NO phone condition", () => {
    expect(where("Aileen")).toEqual({
      where: ' where ("students"."name" ilike $1 or "students"."nickname" ilike $2)',
      params: ["%Aileen%", "%Aileen%"],
    });
  });
});
