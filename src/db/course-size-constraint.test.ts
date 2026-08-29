// SPEC-068 / TASK-217 — the DB must not hold the price card.
//
// 🔴 The failure this closes: `course_size_chk CHECK (size in (4,6,10))` had been on `course_packages` since
// `0000`. TASK-213 taught the APP that an off-card size is importable with an explicit quota — and the INSERT
// then hit that constraint, so Postgres threw and the API returned the generic 500 that TASK-213 existed to
// eliminate. The same error, one layer down, where no unit test was looking: my tests exercised the pure rule,
// the schema round trip (TASK-215), and never the constraint the row lands against.
//
// I cannot INSERT from here — the outcome (a 201 with a row) is Tanya's on `sid`. What these pin is the pair
// that must agree: the migration and the Drizzle schema, and the fact that no app-layer size gate remains on
// the import path.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";

const SCHEMA = readSrc(await Bun.file(new URL("./schema.ts", import.meta.url)).text());
const SQL = readSrc(await Bun.file(new URL("../../drizzle/0027_course_size_sanity.sql", import.meta.url)).text());
const SERVICE = readSrc(await Bun.file(new URL("../services/scheduler.service.ts", import.meta.url)).text());

describe("the card list is gone from the database", () => {
  test("🔴 the old `size in (4, 6, 10)` CHECK is dropped, not merely renamed around", () => {
    expect(SQL).toContain('DROP CONSTRAINT IF EXISTS "course_size_chk"');
    expect(SCHEMA).not.toContain("in (4, 6, 10)");
  });

  test("what remains is a SANITY bound, matching the zod bound on the same field", () => {
    expect(SQL).toContain('"size" >= 1 AND "size" <= 100');
    expect(SCHEMA).toContain("course_size_sanity_chk");
  });

  test("🔑 the migration and the Drizzle schema agree — they are the pair that silently diverged", () => {
    // `schema.ts` is what a future `db:generate` would compare against; leaving it on the old CHECK would make
    // the next generated migration try to put the card list back.
    const inSql = SQL.includes("course_size_sanity_chk");
    const inSchema = SCHEMA.includes("course_size_sanity_chk");
    expect([inSql, inSchema]).toEqual([true, true]);
  });

  test("🔴 the new constraint has a NEW NAME, so the migration is witnessable at all", () => {
    // Replacing `course_size_chk` in place would make "does it exist?" true before AND after — an un-migrated
    // box would look identical to a migrated one, which is exactly how `0022` and the day-end job hid.
    expect(SQL).toContain('ADD CONSTRAINT "course_size_sanity_chk"');
  });
});

describe("the app is the size authority — and only where it should be", () => {
  test("the SALE path still refuses an off-card size", () => {
    // Relaxing the DB must not quietly make off-card courses *sellable*: the card decides what can be sold.
    const sale = SERVICE.slice(SERVICE.indexOf("export async function createCoursePackage"));
    expect(sale.slice(0, sale.indexOf("\n}\n"))).toContain("isCourseSize");
  });

  test("🔑 the IMPORT path has no card-list gate left — `decideImportSize` is the whole rule", () => {
    const imp = SERVICE.slice(SERVICE.indexOf("export async function importCoursePackage"));
    const body = imp.slice(0, imp.indexOf("\n}\n"));
    expect(body).toContain("decideImportSize");
    expect(body).not.toContain("isCourseSize");
  });
});
