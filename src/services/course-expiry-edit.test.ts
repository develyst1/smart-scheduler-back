// SPEC-076 / TASK-264 (REQ-082 AC-1…AC-5 + ข) — edit a course's expiry, record it, and make the resume's
// `EXPIRY_REQUIRED` conditional.
//
// 🔴 Two of these ACs are ABSENCES, and absences are what this file is mostly for. AC-3 (*"this changes one
// date and nothing else"*) and AC-5 (*"no money moves"*) cannot be demonstrated by calling the function and
// looking at the result — a plan regenerated as a side effect and a plan left alone produce the same 200. They
// are asserted against the SOURCE, by name, with the reason attached, which is the shape TASK-260 used.
//
// ⚠️ The other half is (ข): the gate and the warning must be the SAME computation. Two implementations of
// *"required only when the warning fires"* is a gate that demands a date on a resume where nothing is wrong —
// which is the defect this removes — or lets one through where something is.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { EXPIRY_SETTLED_STATUSES, expiryImpact } from "../lib/course-expiry-impact";
import { SCHEDULING_WITNESSES } from "../lib/migration-witness";

const SVC = readSrc(await Bun.file("src/services/scheduler.service.ts").text());
const SQL = readSrc(await Bun.file("drizzle/0034_course_expiry_changes.sql").text());
const JOURNAL = readSrc(await Bun.file("drizzle/meta/_journal.json").text());
const SCHEMA = readSrc(await Bun.file("src/db/schema.ts").text());
const ROUTES = readSrc(await Bun.file("src/routes/api.ts").text());
const VALIDATION = readSrc(await Bun.file("src/validation.ts").text());

/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
/** SQL comments too — `PAUSED` in a `--` line is prose, not a statement (TASK-260's trap). */
const sqlCode = (s: string) => s.replace(/^\s*--.*$/gm, "");

/** The body of `updateCourseExpiry`, isolated so an assertion about it cannot be satisfied by another function. */
const EDIT = (() => {
  const c = code(SVC);
  const at = c.indexOf("export async function updateCourseExpiry(");
  return c.slice(at, c.indexOf("export async function getCourseExpiryHistory", at));
})();

describe("TASK-264 — the migration, counted and witnessed", () => {
  test("0034 is registered, and the counts agree", () => {
    // The board's rule: "no migration" is a CLAIM, not a state — so the numbers are asserted, not asserted about.
    const tags = JOURNAL.match(/"tag": "\d{4}_/g) ?? [];
    expect(tags.length).toBe(35);
    expect(JOURNAL).toContain('"tag": "0034_course_expiry_changes"');
    expect(JOURNAL).toContain('"idx": 34');
  });

  test("🔑 its witness is the LAST object it creates, and existence is valid HERE", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0034_course_expiry_changes")!;
    expect(w).toBeDefined();
    // Rule 1 — the index, not the table: witnessing the table would call a run that died between the two
    // statements "applied", and the index would then never be created.
    expect(w.probe).toEqual({ kind: "index", index: "course_expiry_changes_course_idx" });
    expect(w.why).toContain("0033");
    // Rule 2 — a false "applied" must be impossible. Unlike 0033 (whose index existed before AND after, so only
    // its predicate could witness it), this index is invented by this migration over a table invented by it.
    expect(sqlCode(SQL)).toContain('CREATE INDEX IF NOT EXISTS "course_expiry_changes_course_idx"');
    expect(sqlCode(SQL)).toContain('CREATE TABLE IF NOT EXISTS "course_expiry_changes"');
  });

  test("🚫 the record has no free-text reason column — in the SQL and in the schema", () => {
    // Nobody asked for one, and a reason field on an audit row is a prompt someone has to fill in and will not.
    expect(sqlCode(SQL)).not.toMatch(/"reason"/);
    const table = code(SCHEMA).slice(
      code(SCHEMA).indexOf("export const courseExpiryChanges"),
      code(SCHEMA).indexOf("export const coursePackagesRelations"),
    );
    expect(table).not.toContain("reason");
    // AC-2's four facts, all present.
    for (const col of ["course_id", "from_date", "to_date", "actor", "changed_at"]) {
      expect(sqlCode(SQL)).toContain(`"${col}"`);
    }
  });

  test("the table's comment names TASK-244 as the likely second tenant, and refuses to be a system", () => {
    // Naming the second tenant is not designing for it — it is what stops the third demand inventing a third
    // answer. Asserted on the comment because the comment is the deliverable here.
    expect(SQL).toContain("TASK-244");
    expect(SCHEMA).toContain("TASK-244 is the likely second");
  });
});

describe("TASK-264 — AC-3: this changes one date and nothing else (an ABSENCE)", () => {
  test("🔴 the edit calls NO plan-reconciling function — named, with the reason", () => {
    // An expiry edit that quietly regenerates a plan is a WORSE defect than the missing feature: the admin
    // asked to move a boundary and would get a rebuilt calendar, which no warning can undo.
    for (const forbidden of [
      "reconcileCoursePlan",
      "applyPlanChange",
      "courseOwedTarget",
      "insertBooking",
      "courseSessionDates",
      "deriveLiveEndDate",
    ]) {
      expect({ forbidden, called: EDIT.includes(`${forbidden}(`) }).toEqual({ forbidden, called: false });
    }
  });

  test("🔴 it writes exactly one column of one table, plus the audit row", () => {
    // `bookings` are READ (to be counted for the warning) and never written — that is the whole of AC-3.
    expect(EDIT).toContain(".update(coursePackages).set({ expiryDate: input.expiryDate })");
    expect(EDIT).not.toContain(".update(bookings)");
    expect(EDIT).not.toContain(".delete(bookings)");
    expect(EDIT).not.toContain(".insert(bookings)");
    expect(EDIT.match(/\.insert\(/g)).toBeNull(); // the audit insert lives in `recordExpiryChange`
  });
});

describe("TASK-264 — AC-5: no money, no entitlement (an ABSENCE)", () => {
  test("🚫 no movement, no usedSessions, no usedHours", () => {
    // An expiry is a boundary, not a purchase. Extending a course does not sell sessions.
    for (const forbidden of ["boMovement", "usedSessions", "usedHours", "recordSale", "revKey", "discountKey"]) {
      expect({ forbidden, present: EDIT.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});

describe("TASK-264 — AC-1: ANY course, so no writability gate", () => {
  test("🔴 the edit does not call assertCourseWritable — deliberately", () => {
    // That gate keeps ENDED/DROPPED courses out of the paths that CREATE or MOVE sessions, and this path does
    // neither (AC-3). ⚠️ And guarding it would break the pair it ships with: REQ-084's resume warning says
    // "ขยับวันหมดอายุก่อน" about a course that is DROPPED at that very moment.
    expect(EDIT).not.toContain("assertCourseWritable");
    // Guarded elsewhere, so this is an absence in ONE function and not a gate that got deleted.
    expect(code(SVC)).toContain("await assertCourseWritable(db, id);");
  });

  test("the route classifies the new write, and takes its actor from the TOKEN", () => {
    expect(ROUTES).toContain('.patch("/courses/:id/expiry"');
    expect(ROUTES).toContain('svc.updateCourseExpiry(c.req.param("id"), c.req.valid("json"), c.get("user")?.sub ?? null)');
    // 🚫 Never from the body — TASK-160's rule, and an audit row whose author the caller picks records nothing.
    expect(code(VALIDATION).slice(code(VALIDATION).indexOf("export const updateCourseExpiry"))).not.toContain("actor");
  });
});

describe("TASK-264 — AC-4 / (ข): ONE computation, and it warns rather than refuses", () => {
  const sessions = [
    { id: "b1", date: "2026-09-01", status: "ATTENDED" },
    { id: "b2", date: "2026-10-05", status: "CONFIRMED" },
    { id: "b3", date: "2026-10-12", status: "PENDING" },
    { id: "b4", date: "2026-10-19", status: "CANCELLED" },
    { id: "b5", date: "2026-10-26", status: "PAUSED" },
  ];

  test("it names WHICH sessions fall outside — AC-4 asks for the list, not a count", () => {
    const impact = expiryImpact("2026-10-06", sessions);
    expect(impact.warn).toBe(true);
    expect(impact.outside.map((s) => s.id)).toEqual(["b3", "b5"]);
    expect(impact.outsideCount).toBe(2);
    // 🚫 A CANCELLED session is not a session anyone is waiting for — warning about it is noise that trains
    // people to dismiss the warning.
    expect(impact.outside.map((s) => s.id)).not.toContain("b4");
  });

  test("⚠️ a session ON the expiry date is INSIDE it", () => {
    // The expiry is the last day the course is good for — the same reading `courseStatus` uses
    // (`c.expiryDate < today`). A boundary that means one thing in the warning and another in the status is
    // worse than no warning at all.
    expect(expiryImpact("2026-10-12", sessions).outside.map((s) => s.id)).toEqual(["b5"]);
    expect(expiryImpact("2026-12-31", sessions).warn).toBe(false);
  });

  test("🔑 PAUSED is still owed, and the SETTLED list is written as the settled set on purpose", () => {
    // A status added tomorrow falls into "still owed" and gets warned about, rather than silently dropped from
    // the warning. Both defaults are wrong somewhere; this one is wrong LOUDLY.
    expect([...EXPIRY_SETTLED_STATUSES]).toEqual(["ATTENDED", "SICK_LEAVE", "NO_SHOW", "CANCELLED"]);
    expect([...EXPIRY_SETTLED_STATUSES]).not.toContain("PAUSED");
    const unknown = expiryImpact("2026-01-01", [{ id: "x", date: "2026-06-01", status: "SOME_NEW_STATUS" }]);
    expect(unknown.warn).toBe(true);
  });

  test("🔴 the edit WARNS and still SAVES — it does not refuse", () => {
    // The owner's rule: warn, do not act. The write is unconditional; only the response's warning varies.
    expect(EDIT).toContain("const impact = expiryImpact(");
    // No throw between computing the impact and writing it.
    const afterImpact = EDIT.slice(EDIT.indexOf("const impact = expiryImpact("));
    expect(afterImpact.slice(0, afterImpact.indexOf(".update(coursePackages)"))).not.toContain("throw");
    expect(EDIT).toContain("expiryWarning: impact");
  });

  test("🔴 (ข): the gate and the warning are the SAME function, and the gate is conditional", () => {
    const c = code(SVC);
    const resume = c.slice(c.indexOf("export async function resumeCourse("), c.indexOf("export async function cancelCourse("));
    // One computation, read twice.
    expect(resume).toContain("const impact = expiryImpact(effectiveExpiry, projected);");
    expect(resume.match(/expiryImpact\(/g)!.length).toBe(1);
    // Conditional: only when the warning fires AND the admin gave no date.
    expect(resume).toContain("if (!input.expiryDate && impact.warn) {");
    expect(resume).toContain('"EXPIRY_REQUIRED"');
    // 🚫 The old unconditional gate must not survive anywhere.
    expect(c).not.toContain('if (!input.expiryDate) throw new ApiException(400, "EXPIRY_REQUIRED"');
    // …and the resume warns and saves too, with the same shape the edit returns.
    expect(resume).toContain("expiryWarning: impact");
  });

  test("the resume schema made the field optional — the requirement moved, it did not disappear", () => {
    const v = code(VALIDATION);
    const schema = v.slice(v.indexOf("export const resumeCourse = z.object({"));
    expect(schema.slice(0, schema.indexOf("});"))).toContain("expiryDate: DATE.optional(),");
    // The edit's own field stays required — there is nothing to infer there.
    const edit = v.slice(v.indexOf("export const updateCourseExpiry = z.object({"));
    expect(edit.slice(0, edit.indexOf("});"))).toContain("expiryDate: DATE,");
  });
});

describe("TASK-264 — AC-2: the audit has no hole on day one (Q1)", () => {
  test("🔴 BOTH paths that move a course's expiry record it, through ONE writer", () => {
    const c = code(SVC);
    // Q1's sweep: `updateCourseExpiry` (new) and `resumeCourse` are the only two writers of a COURSE expiry.
    expect(c.match(/recordExpiryChange\(/g)!.length).toBe(3); // the declaration + the edit + the resume
    const resume = c.slice(c.indexOf("export async function resumeCourse("), c.indexOf("export async function cancelCourse("));
    expect(resume).toContain("await recordExpiryChange(tx, { courseId: id, from: course.expiryDate, to: effectiveExpiry, actor });");
  });

  test("🚫 a resume that changes nothing writes no audit row", () => {
    // An audit full of rows saying nothing happened is how people stop reading it. The guard is in the writer,
    // so neither caller has to remember it.
    const c = code(SVC);
    const writer = c.slice(c.indexOf("async function recordExpiryChange("), c.indexOf("export async function updateCourseExpiry("));
    expect(writer).toContain("if (row.from === row.to) return;");
  });

  test("the audit row is written in the SAME transaction as the change it records", () => {
    // An audit that can commit without its subject — or the reverse — is not a record of anything.
    const tx = EDIT.slice(EDIT.indexOf("await db.transaction("), EDIT.indexOf("const updated ="));
    expect(tx).toContain(".update(coursePackages)");
    expect(tx).toContain("recordExpiryChange(tx,");
  });

  test("`resumeCourse` passes the real actor — it used to discard it", () => {
    // It took `_actor` and never used it: the route has always supplied one, and the underscore was the sign
    // nothing read it. The audit is the first reader.
    const c = code(SVC);
    expect(c).toContain("export async function resumeCourse(id: string, input: { expiryDate?: string | null }, actor?: string | null)");
    expect(c).not.toContain("_actor?: string | null");
    expect(ROUTES).toContain('svc.resumeCourse(c.req.param("id"), c.req.valid("json"), c.get("user")?.sub ?? null)');
  });
});
