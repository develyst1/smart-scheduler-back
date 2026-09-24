// TASK-437 (`REQ-095 §13.4a`, SPEC-089 A) — a subject has a TYPE: migration `0050` (`subjects.kind` NOT NULL DEFAULT 'PRIVATE' +
// the CHECK as witness; 55 = 55; the CHECK ⇔ `SUBJECT_KINDS` by value), the two readers carry `kind` (`teacher.subjects[]`,
// `GET /sellable-packages`), the ONE rule at both course creates BEFORE the tx (a DUO course needs a DUO subject; a Private
// course refuses a DUO one — no write on refusal), `add-subject --kind` (validated, default PRIVATE), and `ensure-subjects`'
// pure planner (missing ⇒ create; PRIVATE ⇒ update in place; correct ⇒ unchanged; a foreign name untouched). Walk-in
// single/trial on a DUO subject stays sellable (TASK-399, the owner's design); no pricing / RBAC change.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DUO_SUBJECT, DUO_SUBJECT_SEEDS, NOT_A_DUO_SUBJECT, SUBJECT_KINDS, assertSubjectKindForCourse, isSubjectKind, planEnsureSubjects } from "./subject-kinds";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { VOUCHER_EXCLUDED_GROUPS } from "./sale-items";
import { planSubjectAdd } from "./subject-add-plan";
import * as sched from "../services/scheduler.service";
import * as parentSvc from "../services/parent.service";
import { toTeacherDTO } from "../db/mappers";
import { db } from "../db";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const SCHED = code(src("src/services/scheduler.service.ts"));
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", SUBJ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

describe("🔴 the migration — 0050, counted, the column with its default on a small table, the CHECK NOT VALID → VALIDATE = the witness; the CHECK ⇔ the set", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
  const sql = readFileSync(resolve(root, "drizzle/0050_subject_kind.sql"), "utf8").replace(/\r\n/g, "\n");
  test("55 = 55: `0050_subject_kind` is the 51st file, idx 50 (TASK-439 added 0051 after it); 'expects 51'; the four statements", () => {
    expect(files.length).toBe(55);
    expect(journal.entries.length).toBe(55);
    expect(files[50]).toBe("0050_subject_kind.sql");
    expect(journal.entries[50]).toMatchObject({ idx: 50, tag: "0050_subject_kind" });
    expect(sql).toContain("`db:verify` expects 51");
    const stmts = sql.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(stmts).toEqual([
      `ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'PRIVATE';`,
      `ALTER TABLE "subjects" DROP CONSTRAINT IF EXISTS "subjects_kind_chk";`,
      `ALTER TABLE "subjects" ADD CONSTRAINT "subjects_kind_chk" CHECK ("kind" IN ('PRIVATE', 'DUO')) NOT VALID;`,
      `ALTER TABLE "subjects" VALIDATE CONSTRAINT "subjects_kind_chk";`,
    ]);
    expect(sql.replace(/\n-- +/g, " ")).toContain("SHARE UPDATE EXCLUSIVE"); // the header's lock sentence (wrapped)
  });
  test("🔴 the CHECK ⇔ `SUBJECT_KINDS` — the migration's IN-list parsed and compared to the code's set (a third kind fails here until a migration carries it)", () => {
    const m = sql.match(/CHECK \("kind" IN \(([^)]*)\)\)/)!;
    const dbSet = m[1]!.split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
    expect(dbSet).toEqual([...SUBJECT_KINDS]);
    expect([...SUBJECT_KINDS]).toEqual(["PRIVATE", "DUO"]);
    expect(isSubjectKind("DUO")).toBe(true);
    expect(isSubjectKind("GROUP")).toBe(false);
  });
  test("the witness is the LAST entry, a constraint-def probe on both literals; the schema column", () => {
    const last = SCHEDULING_WITNESSES.find((w) => w.tag === "0050_subject_kind")!; // 🔻 TASK-439: 0051 is the last now
    expect(last).toMatchObject({ tag: "0050_subject_kind", probe: { kind: "constraint-def", constraint: "subjects_kind_chk", contains: "DUO" }, rerunnable: true });
    expect(code(src("src/db/schema.ts"))).toContain('kind: text("kind").notNull().default("PRIVATE"),');
  });
});

describe("🔴 the two readers carry `kind`; no third subject reader exists; the rule by value; the refusals at both creates BEFORE the tx", () => {
  test("`teacher.subjects[]` (the ONE picker mapper) and `GET /sellable-packages` carry `kind` (PRIVATE when a row has none)", async () => {
    const dto: any = toTeacherDTO({ id: T1, name: "Bank", nickname: "Bank", type: "FULL_TIME", workDays: [1], teacherSubjects: [{ subject: { id: "s1", name: "Balance Bike", active: true, kind: "DUO" } }, { subject: { id: "s2", name: "Bike", active: true } }] });
    expect(dto.subjects).toEqual([{ id: "s1", name: "Balance Bike", kind: "DUO" }, { id: "s2", name: "Bike", kind: "PRIVATE" }]);
    const chain = (result: any) => { const q: any = { from: () => q, where: () => q, then: (res: any, rej: any) => Promise.resolve(result).then(res, rej) }; return q; };
    spies.push(spyOn(db, "select").mockImplementation((() => chain([{ id: "s1", name: "Duo SURFSKATE", priceGroup: "balance-duo", active: true, kind: "DUO" }, { id: "s2", name: "Skate", priceGroup: "bike-skate", active: true, kind: "PRIVATE" }])) as any));
    const pk: any = await sched.getSellablePackages();
    const duo4 = pk.packages.find((p: any) => p.priceGroup === "balance-duo" && p.size === 4);
    expect(duo4.subjects).toEqual([{ id: "s1", name: "Duo SURFSKATE", kind: "DUO" }]);
    expect(pk.packages.find((p: any) => p.priceGroup === "bike-skate" && p.size === 4).subjects).toEqual([{ id: "s2", name: "Skate", kind: "PRIVATE" }]);
    // no third reader: the `{ id, name }` subject shape is built in exactly these two places
    expect((code(src("src/db/mappers.ts")).match(/name: ts\.subject\.name,\n\s+kind: ts\.subject\.kind \?\? "PRIVATE",/g) ?? []).length).toBe(1);
    expect((SCHED.match(/\.map\(\(s\) => \(\{ id: s\.id, name: s\.name, kind: s\.kind \?\? "PRIVATE" \}\)\)/g) ?? []).length).toBe(1);
  });
  test("`assertSubjectKindForCourse` by value: DUO ⇔ DUO passes; DUO on PRIVATE ⇒ NOT_A_DUO_SUBJECT; Private on DUO ⇒ DUO_SUBJECT; a row without a kind reads PRIVATE", () => {
    expect(() => assertSubjectKindForCourse({ kind: "DUO" }, true)).not.toThrow();
    expect(() => assertSubjectKindForCourse({ kind: "PRIVATE" }, false)).not.toThrow();
    expect(() => assertSubjectKindForCourse({}, false)).not.toThrow();
    expect(() => assertSubjectKindForCourse({ kind: "PRIVATE" }, true)).toThrow(/คอร์ส DUO ต้องใช้โปรแกรม DUO/);
    expect(() => assertSubjectKindForCourse(null, true)).toThrow();
    expect(() => assertSubjectKindForCourse({ kind: "DUO" }, false)).toThrow(/โปรแกรม DUO ขายได้เฉพาะคอร์ส DUO/);
    expect(NOT_A_DUO_SUBJECT().status).toBe(400);
    expect(DUO_SUBJECT().code).toBe("DUO_SUBJECT");
  });
  test("`createCoursePackage` by value: a DUO create on a PRIVATE subject ⇒ 400 NOT_A_DUO_SUBJECT before the tx; a Private create on a DUO subject ⇒ 400 DUO_SUBJECT; no row written", async () => {
    const body = { student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 4, startDate: "2026-10-05", startTime: "10:00" };
    let subject: any = { id: SUBJ, priceGroup: "bike-skate", kind: "PRIVATE" };
    spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => subject) as any));
    spies.push(spyOn(parentSvc, "assertStudentActive").mockImplementation((async () => {}) as any));
    const tx = spyOn(db, "transaction").mockImplementation((async () => { throw new Error("must not open"); }) as any);
    spies.push(tx);
    await expect(sched.createCoursePackage({ ...body, duo: { coStudentId: B } })).rejects.toMatchObject({ status: 400, code: "NOT_A_DUO_SUBJECT" });
    subject = { id: SUBJ, priceGroup: "balance-duo", kind: "DUO" };
    await expect(sched.createCoursePackage(body)).rejects.toMatchObject({ status: 400, code: "DUO_SUBJECT" });
    expect(tx).not.toHaveBeenCalled();
  });
  test("`importCoursePackage` by value: a DUO subject ⇒ 400 DUO_SUBJECT before the tx (an import is a Private course)", async () => {
    spies.push(spyOn(db.query.subjects, "findFirst").mockImplementation((async () => ({ id: SUBJ, priceGroup: "balance-duo", kind: "DUO" })) as any));
    const tx = spyOn(db, "transaction").mockImplementation((async () => { throw new Error("must not open"); }) as any);
    spies.push(tx);
    await expect(sched.importCoursePackage({ student: { id: A }, teacherId: T1, subjectId: SUBJ, size: 10, usedSessions: 2, startDate: "2026-10-05", startTime: "10:00", expiryDate: "2026-12-31" })).rejects.toMatchObject({ code: "DUO_SUBJECT" });
    expect(tx).not.toHaveBeenCalled();
  });
  test("by source: the rule sits before each create's tx, through the ONE function; the walk-in paths and the voucher exclusion untouched", () => {
    const C = region(SCHED, "export async function createCoursePackage(", "\n}\n");
    expect(C).toContain("assertSubjectKindForCourse(await db.query.subjects.findFirst({ where: (s, { eq: e }) => e(s.id, input.subjectId) }), !!input.duo);");
    expect(C.indexOf("assertSubjectKindForCourse(")).toBeLessThan(C.indexOf("db.transaction("));
    const I = region(SCHED, "export async function importCoursePackage(", "\n}\n");
    expect(I).toContain("assertSubjectKindForCourse(await db.query.subjects.findFirst({ where: (s, { eq: e }) => e(s.id, input.subjectId) }), false);");
    expect(I.indexOf("assertSubjectKindForCourse(")).toBeLessThan(I.indexOf("db.transaction("));
    expect((SCHED.match(/assertSubjectKindForCourse\(/g) ?? []).length).toBe(2);
    expect(region(SCHED, "export async function createBooking(", "\n}\n")).not.toContain("assertSubjectKindForCourse"); // a walk-in DUO hour is sellable by design (TASK-399)
    expect(VOUCHER_EXCLUDED_GROUPS.has("balance-duo")).toBe(true);
    expect(region(SCHED, "export async function resolvePriceGroup(", "\n}\n")).not.toContain("kind"); // pricing untouched
  });
});

describe("🔴 the seed — `planEnsureSubjects` by value (an UPSERT by exact name); `add-subject --kind`; the script's dry-run shape", () => {
  test("missing ⇒ create; present as PRIVATE ⇒ update in place; present correct ⇒ unchanged; inactive ⇒ re-activated; a foreign name never touched", () => {
    expect([...DUO_SUBJECT_SEEDS].map((s) => s.name)).toEqual(["Duo INLINE SKATE", "Duo SURFSKATE"]);
    const plan = planEnsureSubjects([
      { name: "Duo INLINE SKATE", kind: "PRIVATE", priceGroup: "balance-duo", active: true }, // uat after 0050's default
      { name: "Skate", kind: "PRIVATE", priceGroup: "bike-skate", active: true },
    ]);
    expect(plan).toEqual([
      { name: "Duo INLINE SKATE", action: "update", changes: ["kind PRIVATE→DUO"] },
      { name: "Duo SURFSKATE", action: "create", changes: ["kind DUO", "price_group balance-duo", "active true"] },
    ]);
    expect(planEnsureSubjects([{ name: "Duo INLINE SKATE", kind: "DUO", priceGroup: "balance-duo", active: true }, { name: "Duo SURFSKATE", kind: "DUO", priceGroup: "balance-duo", active: false }])).toEqual([
      { name: "Duo INLINE SKATE", action: "unchanged", changes: [] },
      { name: "Duo SURFSKATE", action: "update", changes: ["active false→true"] },
    ]);
    expect(planEnsureSubjects([{ name: "Duo SURFSKATE", kind: "PRIVATE", priceGroup: null, active: true }])[1]).toEqual({ name: "Duo SURFSKATE", action: "update", changes: ["kind PRIVATE→DUO", "price_group null→balance-duo"] });
    expect(planEnsureSubjects([]).every((p) => p.action === "create")).toBe(true); // idempotent: a second run over the applied rows is all `unchanged`
  });
  test("the script by source: dry-run is the default and writes nothing; `--apply` in ONE tx updates by name (never inserts a duplicate); `subjects:ensure` registered", () => {
    const S = readFileSync(resolve(root, "scripts/ensure-subjects.ts"), "utf8");
    expect(S).toContain('const apply = process.argv.includes("--apply");');
    expect(S).toContain('if (!apply) { console.log("DRY RUN — nothing written. Re-run with --apply."); return; }');
    expect(S).toContain("await db.transaction(async (tx) => {");
    expect(S).toContain('else if (p.action === "update") await tx.update(subjects).set({ kind: w.kind, priceGroup: w.priceGroup, active: true }).where(eq(subjects.name, w.name));');
    expect(S).toContain('if (p.action === "create") await tx.insert(subjects).values({ name: w.name, kind: w.kind, priceGroup: w.priceGroup, active: true });');
    expect(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts["subjects:ensure"]).toBe("bun run scripts/ensure-subjects.ts");
  });
  test("`add-subject --kind`: default PRIVATE; DUO accepted; an unknown kind refused before any write; the insert carries it", () => {
    expect(planSubjectAdd({ name: "Bike", group: "bike-skate", existingNames: [] })).toMatchObject({ ok: true, kind: "PRIVATE", willCreate: true });
    expect(planSubjectAdd({ name: "Duo BMX", group: "balance-duo", kind: "DUO", existingNames: [] })).toMatchObject({ ok: true, kind: "DUO" });
    const bad = planSubjectAdd({ name: "X", group: "bike-skate", kind: "GROUP", existingNames: [] });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(" ")).toContain("--kind ไม่ถูกต้อง");
    const A = readFileSync(resolve(root, "scripts/add-subject.ts"), "utf8");
    expect(A).toContain('const kind = arg("kind");');
    expect(A).toContain('.values({ name: plan.name, priceGroup: plan.group, kind: plan.kind ?? "PRIVATE" })');
  });
});
