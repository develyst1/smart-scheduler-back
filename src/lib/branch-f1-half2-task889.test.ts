// 🔻 TASK-889 half 2 (REQ-120 F1, SPEC-099 §9) — the write side of the branch: schema columns, migration 0076, the booking-path hunks, the whole-course change, the rental's ref branch.
// DB-free: a spied `db` where a fake read is cheap, source pins (comments stripped) where the read is deep. Each pin must fail when its line is removed (mutation set: branch-f1-half2-task889.mutations.json).
import { afterEach, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const { db } = await import("../db");
const svc = await import("../services/scheduler.service");
const rental = await import("../services/rental.service");
const { readSrc } = await import("./read-src");

const file = async (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const region = (src: string, from: string, to: string) => {
  const i = src.indexOf(from);
  expect(i).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j < 0 ? undefined : j);
};
const MIG = (await file("../../drizzle/0076_branch_on_course_voucher_booking.sql")).replace(/\r\n/g, "\n");
const JOURNAL = await file("../../drizzle/meta/_journal.json");
const WITNESS = (await file("./migration-witness.ts")).replace(/\r\n/g, "\n");
const SCHEMA = await file("../db/schema.ts");
const SVC = code(readSrc(await file("../services/scheduler.service.ts")));
const RENT = code(await file("../services/rental.service.ts"));
const REV = code(await file("./revenue-line.ts"));

describe("🔴 TASK-889 — the migration: three columns, three CHECKs, additive, the bookings CHECK LAST = the witness", () => {
  test("the three columns are NOT NULL DEFAULT 'BRAVO', IF NOT EXISTS", () => {
    for (const t of ["course_packages", "vouchers", "bookings"])
      expect(MIG).toContain(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "branch" text DEFAULT 'BRAVO' NOT NULL;`);
  });
  test("the three CHECKs allow exactly BRAVO and OTHER (drop-if-exists then add, so a re-run is safe)", () => {
    for (const [t, c] of [["course_packages", "course_packages_branch_ck"], ["vouchers", "vouchers_branch_ck"], ["bookings", "bookings_branch_ck"]]) {
      expect(MIG).toContain(`ALTER TABLE "${t}" DROP CONSTRAINT IF EXISTS "${c}";`);
      expect(MIG).toContain(`ALTER TABLE "${t}" ADD CONSTRAINT "${c}" CHECK ("branch" IN ('BRAVO','OTHER'));`);
    }
  });
  test("additive only: nothing dropped but our own constraints, no data written", () => {
    const body = MIG.replace(/^--.*$/gm, "");
    expect(body).not.toMatch(/DROP (TABLE|COLUMN|INDEX)|DELETE|TRUNCATE|UPDATE |INSERT /);
    expect(body.match(/DROP CONSTRAINT/g)?.length).toBe(3);
  });
  test("the LAST statement is the bookings CHECK — the witness", () => {
    expect(MIG.trimEnd().split("\n").pop()).toContain("bookings_branch_ck");
    expect(WITNESS).toContain('tag: "0076_branch_on_course_voucher_booking",\n    probe: { kind: "constraint", constraint: "bookings_branch_ck" },');
  });
  test("journal: idx 76, tag 0076_…, and the file is the 77th", () => {
    const j = JSON.parse(JOURNAL) as { entries: Array<{ idx: number; tag: string; when: number }> };
    expect(j.entries.length).toBe(82); /* 🔻 TASK-969: +0081 */ /* 🔻 TASK-965: +0080 */ /* 🔻 TASK-961: +0079 */ /* 🔻 TASK-942: +0078 */ /* 🔻 TASK-959: +0077 */
    expect(j.entries[76]).toMatchObject({ idx: 76, tag: "0076_branch_on_course_voucher_booking" });
    expect(j.entries[76].when).toBeGreaterThan(j.entries[75].when);
  });
  test("the schema declares the column on all three tables, default BRAVO", () => {
    expect(SCHEMA.split('branch: text("branch").notNull().default("BRAVO")').length - 1).toBe(3);
  });
});

describe("the sale and the booking write the branch", () => {
  test("createCoursePackage: the course row takes the body's branch (absent ⇒ column default), and EVERY session is born with the course's branch", () => {
    const C = region(SVC, "export async function createCoursePackage(", "\n}\n");
    expect(C).toContain("...(input.branch ? { branch: input.branch } : {}),");
    expect(C).toContain('branch: input.branch ?? "BRAVO",');
    // the second one is inside the insertBooking call of the session loop
    expect(C.indexOf('branch: input.branch ?? "BRAVO",')).toBeGreaterThan(C.indexOf("await insertBooking("));
  });
  test("createVoucher: the voucher row takes the body's branch (absent ⇒ BRAVO)", () => {
    const V = region(SVC, "export async function createVoucher(", "\n}\n");
    expect(V).toContain("...(input.branch ? { branch: input.branch } : {}),");
  });
  test("createBooking hands the whole body to the ONE inserter, so a booking's own branch reaches the insert", () => {
    const B = region(SVC, "export async function createBooking(", "\n}\n");
    expect(B).toContain("const id = await insertBooking(tx, studentId, input);");
  });
  test("insertBooking: own branch, else the course's (a make-up / extra born later), else the default — and it is in the values", () => {
    const I = region(SVC, "export async function insertBooking(", "\n}\n");
    expect(I).toContain("const branch: string | undefined = input.branch ?? (input.courseId ? await courseBranchOf(exec, input.courseId) : undefined);");
    expect(I).toContain("...(branch ? { branch } : {}),");
    const H = region(SVC, "async function courseBranchOf(", "\n}\n");
    expect(H).toContain("columns: { branch: true }");
    expect(H).toContain("return c?.branch ?? undefined;");
  });
});

describe("moveBooking: a branch moves THAT booking only", () => {
  test("the type accepts it, and it lands in the patch only when given (absent ⇒ unchanged)", () => {
    const M = region(SVC, "export async function moveBooking(", "\n  try {");
    expect(M).toContain('branch?: "BRAVO" | "OTHER" }');
    expect(M).toContain("if (input.branch) patch.branch = input.branch;");
  });
  test("it is written by the same single-row update as every other move field — never a course-wide or group-wide update", () => {
    const M = region(SVC, "export async function moveBooking(", "\nexport async function ");
    expect(M).toContain("await tx.update(bookings).set(patch).where(eq(bookings.id, id));");
    expect(M).not.toContain("eq(bookings.courseId");
  });
});

describe("updateCourse: a whole-course branch change", () => {
  const ENDED = ["ATTENDED", "NO_SHOW", "CANCELLED"];
  afterEach(() => { for (const s of spies) s.mockRestore(); spies.length = 0; });
  const spies: Array<{ mockRestore: () => void }> = [];

  const run = async (input: any) => {
    const sets: Array<{ table: string; set: any; where: any }> = [];
    const order: string[] = [];
    const row = { id: "c-1", branch: "BRAVO", endedAt: null, student: null, coStudent: null };
    spies.push(spyOn(db.query.coursePackages, "findFirst").mockResolvedValue(row as any));
    const mk = (table: string) => ({ set: (s: any) => ({ where: async (w: any) => { sets.push({ table, set: s, where: w }); order.push(table); } }) });
    const tx: any = { update: (t: any) => mk(t === (undefined as any) ? "?" : String((t as any)[Symbol.for("drizzle:Name")] ?? "")) };
    spies.push(spyOn(db, "transaction").mockImplementation((async (cb: any) => cb(tx)) as any));
    spies.push(spyOn(db, "update").mockImplementation(((t: any) => mk(String(t[Symbol.for("drizzle:Name")] ?? ""))) as any));
    try { await svc.updateCourse("c-1", input); } catch (e: any) { return { sets, order, err: e }; }
    return { sets, order, err: null as any };
  };

  test("branch ⇒ the course row first, then its sessions — both inside ONE transaction", async () => {
    const r = await run({ branch: "OTHER" });
    expect(r.sets.map((s) => s.table)).toEqual(["course_packages", "bookings"]);
    expect(r.sets[0].set).toEqual({ branch: "OTHER" });
    expect(r.sets[1].set).toEqual({ branch: "OTHER" });
  });
  test("absent branch ⇒ no transaction, no booking write (unchanged)", async () => {
    const r = await run({ adminUnlocked: true });
    expect(r.sets.map((s) => s.table)).toEqual(["course_packages"]);
    expect(r.sets[0].set).toEqual({ adminUnlocked: true });
  });
  test("the sessions touched exclude exactly ATTENDED / NO_SHOW / CANCELLED (a class already held keeps where it happened), and only THIS course's", () => {
    const U = region(SVC, "export async function updateCourse(", "\n}\n");
    expect(U).toContain('notInArray(bookings.status, ["ATTENDED", "NO_SHOW", "CANCELLED"])');
    for (const s of ENDED) expect(U).toContain(`"${s}"`);
    expect(U).toContain("eq(bookings.courseId, id)");
    expect(U).toContain("await db.transaction(async (tx) => {");
  });
  test("the course write and the bookings write are in the same transaction callback", () => {
    const U = region(SVC, "export async function updateCourse(", "\n}\n");
    const tx = U.indexOf("await db.transaction(async (tx) => {");
    expect(U.indexOf("await tx.update(coursePackages).set({ branch })")).toBeGreaterThan(tx);
    expect(U.indexOf("await tx.update(bookings).set({ branch })")).toBeGreaterThan(tx);
  });
});

describe("the rental's revenue line takes the branch of its ref", () => {
  afterEach(() => { for (const s of spies) s.mockRestore(); spies.length = 0; });
  const spies: Array<{ mockRestore: () => void }> = [];
  const fake = (course: any, booking: any) => {
    spies.push(spyOn(db.query.coursePackages, "findFirst").mockResolvedValue(course));
    spies.push(spyOn(db.query.bookings, "findFirst").mockResolvedValue(booking));
  };
  test("a course ref ⇒ the course's branch (the booking is not even asked)", async () => {
    fake({ branch: "OTHER" }, { branch: "BRAVO" });
    expect(await rental.refBranchOf("c-1")).toBe("OTHER");
  });
  test("not a course ⇒ the booking's branch", async () => {
    fake(undefined, { branch: "OTHER" });
    expect(await rental.refBranchOf("b-1")).toBe("OTHER");
  });
  test("a standalone rental (no ref) ⇒ undefined ⇒ BRAVO, and nothing is read", async () => {
    fake({ branch: "OTHER" }, { branch: "OTHER" });
    expect(await rental.refBranchOf(undefined)).toBeUndefined();
    expect(db.query.coursePackages.findFirst).not.toHaveBeenCalled();
  });
  test("an unknown ref ⇒ undefined (BRAVO)", async () => {
    fake(undefined, undefined);
    expect(await rental.refBranchOf("nope")).toBeUndefined();
  });
  test("a read that throws never blocks the rental ⇒ undefined", async () => {
    spies.push(spyOn(db.query.coursePackages, "findFirst").mockRejectedValue(new Error("down")));
    expect(await rental.refBranchOf("c-1")).toBeUndefined();
  });
  test("recordRental passes that branch to the ledger line; revenue-line forwards it to rentalLine", () => {
    expect(RENT).toContain("branch: await refBranchOf(input.refId),");
    expect(RENT.indexOf("branch: await refBranchOf(input.refId),")).toBeGreaterThan(RENT.indexOf("await postRentalRevenue(db, {"));
    expect(REV).toContain("hours: r.hours, branch: r.branch }, r.discountMinor ?? 0)");
  });
});

describe("rentalLine carries the branch it is given", () => {
  test("OTHER in ⇒ OTHER on the line; absent ⇒ BRAVO (a standalone rental)", async () => {
    const { rentalLine } = await import("./booking-sale-amount");
    const base = { movementKey: "rental:c-1:rental-set", refId: "c-1", code: "rental-set", hours: 10 };
    expect(rentalLine({ ...base, branch: "OTHER" })!.branch).toBe("OTHER");
    expect(rentalLine(base)!.branch).toBe("BRAVO");
  });
});
