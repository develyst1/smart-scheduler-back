import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BRANCH, createBooking, createCoursePackage, createVoucher, moveBooking, updateCourse } from "../validation";
import { toBookingDTO, toCourseWithStudent, toPublicCheckinBooking, toVoucherDTO } from "../db/mappers";
import { BRANCHES, branchOf, courseLine, isBranch, parkFeeLine, trialOrSingleLine, voucherLine } from "./booking-sale-amount";
import { postConfirmRevenue, postCourseRevenue, postVoucherRevenue, writeRevenueLine } from "./revenue-line";
import { boRevenueLine } from "../db/bo-revenue";
import { PRICE_GROUPS } from "./sale-items";

// TASK-889 (F1, SPEC-099 §9) — the branch (BRAVO | OTHER). DB-free: the validators, the DTOs, and the revenue line's branch per source.
// The write rules inside scheduler.service (course sessions, move, whole-course change) are the held hunks; their pure helper lives here
// once schema.ts is released. What is proved now: the contract the hunks will rely on.

describe("BRANCHES / branchOf — one definition", () => {
  test("exactly BRAVO and OTHER, in that order", () => expect([...BRANCHES]).toEqual(["BRAVO", "OTHER"]));
  test("isBranch: the two values only (case-sensitive)", () => {
    expect([isBranch("BRAVO"), isBranch("OTHER")]).toEqual([true, true]);
    for (const v of ["bravo", "Other", "", " BRAVO", null, undefined, 1, {}, "BRAVO,OTHER"]) expect(isBranch(v)).toBe(false);
  });
  test("branchOf: a stored value passes through; anything else reads as BRAVO (the column default), never a guess", () => {
    expect(branchOf("OTHER")).toBe("OTHER");
    expect(branchOf("BRAVO")).toBe("BRAVO");
    for (const v of [undefined, null, "", "x", "other", 0]) expect(branchOf(v)).toBe("BRAVO");
  });
});

describe("the shared BRANCH validator", () => {
  test.each(["BRAVO", "OTHER"])("accepts %s", (v) => expect(BRANCH.safeParse(v).success).toBe(true));
  test.each(["bravo", "other", "Bravo", "", "MAIN", "BRAVO ", null, 1, true])("refuses %p", (v) => expect(BRANCH.safeParse(v).success).toBe(false));
  test("refuses an array holding a valid value", () => expect(BRANCH.safeParse(["BRAVO"]).success).toBe(false));
});

const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const bookingBase = { student: { id: ID(1) }, teacherId: ID(2), subjectId: ID(3), date: "2026-08-05", startTime: "09:00", bookingType: "SINGLE_SESSION" as const };
const courseBase = { student: { name: "น้องเอ", phone: "0812345678" }, teacherId: ID(2), subjectId: ID(3), size: 4 as const, startDate: "2026-09-01", startTime: "09:00" };
const voucherBase = { student: { id: ID(1) }, totalHours: 10 as const };

describe("the five bodies accept an optional branch", () => {
  const cases: [string, (b?: unknown) => { success: boolean }][] = [
    ["createBooking", (b) => createBooking.safeParse({ ...bookingBase, ...(b === undefined ? {} : { branch: b }) })],
    ["createCoursePackage", (b) => createCoursePackage.safeParse({ ...courseBase, ...(b === undefined ? {} : { branch: b }) })],
    ["createVoucher", (b) => createVoucher.safeParse({ ...voucherBase, ...(b === undefined ? {} : { branch: b }) })],
    ["moveBooking", (b) => moveBooking.safeParse({ note: "x", ...(b === undefined ? {} : { branch: b }) })],
    ["updateCourse", (b) => updateCourse.safeParse({ adminUnlocked: true, ...(b === undefined ? {} : { branch: b }) })],
  ];
  for (const [name, parse] of cases) {
    describe(name, () => {
      test("absent is fine (a create ⇒ BRAVO, an edit ⇒ unchanged: decided by the service)", () => expect(parse().success).toBe(true));
      test.each(["BRAVO", "OTHER"])("accepts %s", (v) => expect(parse(v).success).toBe(true));
      test.each(["bravo", "MAIN", "", null, 5])("refuses %p", (v) => expect(parse(v).success).toBe(false));
    });
  }
  test("the parsed value is carried through (not stripped)", () => {
    expect(createCoursePackage.parse({ ...courseBase, branch: "OTHER" }).branch).toBe("OTHER");
    expect(createVoucher.parse({ ...voucherBase, branch: "OTHER" }).branch).toBe("OTHER");
    expect(createBooking.parse({ ...bookingBase, branch: "OTHER" }).branch).toBe("OTHER");
    expect(moveBooking.parse({ branch: "OTHER" }).branch).toBe("OTHER");
    expect(updateCourse.parse({ branch: "OTHER" }).branch).toBe("OTHER");
  });
  test("a body without branch parses to a body without branch (the service, not the schema, supplies BRAVO)", () => {
    expect("branch" in createCoursePackage.parse(courseBase)).toBe(false);
    expect("branch" in createVoucher.parse(voucherBase)).toBe(false);
  });
  test("moveBooking: a branch ALONE is a valid edit (the 'at least one field' rule counts it); an empty body is still refused", () => {
    expect(moveBooking.safeParse({ branch: "OTHER" }).success).toBe(true);
    expect(moveBooking.safeParse({}).success).toBe(false);
    expect(moveBooking.safeParse({ branch: undefined }).success).toBe(false);
  });
});

describe("the DTOs carry `branch`, additively", () => {
  const BOOKING = { id: "b-1", date: "2026-10-14", startTime: "10:00:00", endTime: "11:00:00", bookingType: "COURSE_PACKAGE", status: "CONFIRMED", teacher: { id: "t1", nickname: "Ek", name: "Ekachai" }, student: { id: "s1", name: "น้องเอ", nickname: "เอ" } };
  test("toBookingDTO: the stored branch, by value both ways; a row without it reads BRAVO", () => {
    expect(toBookingDTO({ ...BOOKING, branch: "OTHER" }).branch).toBe("OTHER");
    expect(toBookingDTO({ ...BOOKING, branch: "BRAVO" }).branch).toBe("BRAVO");
    expect(toBookingDTO({ ...BOOKING }).branch).toBe("BRAVO");
    expect(toBookingDTO({ ...BOOKING, branch: "garbage" }).branch).toBe("BRAVO");
  });
  test("toCourseWithStudent carries it", () => {
    const c = { id: "c-1", size: 4, usedSessions: 0, student: { id: "s", name: "น้อง", nickname: null }, bookings: [] };
    expect(toCourseWithStudent({ ...c, branch: "OTHER" }).branch).toBe("OTHER");
    expect(toCourseWithStudent({ ...c }).branch).toBe("BRAVO");
  });
  test("toVoucherDTO carries it", () => {
    const v = { id: "v-1", totalHours: 10, usedHours: 0, expiryDate: "2027-01-01", student: { id: "s", name: "น้อง", nickname: null } };
    expect(toVoucherDTO({ ...v, branch: "OTHER" }).branch).toBe("OTHER");
    expect(toVoucherDTO({ ...v }).branch).toBe("BRAVO");
  });
  test("🔑 the PUBLIC check-in answer (a parent's scan) never carries `branch`: it is a separate allow-list, built from the admin DTO", () => {
    const admin = toBookingDTO({ ...BOOKING, branch: "OTHER" });
    expect(admin.branch).toBe("OTHER");
    const pub: any = toPublicCheckinBooking(admin);
    expect(pub).toBeTruthy();
    expect("branch" in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain("OTHER");
  });
});

describe("the revenue line takes the branch of the row that produced it", () => {
  test("pure builders: course / voucher / trial / single / park fee each carry their source's branch; absent ⇒ BRAVO", () => {
    expect(courseLine({ id: "c", subjectName: "Inline Skate", duo: false, who: "A", branch: "OTHER" }, 100000)?.branch).toBe("OTHER");
    expect(courseLine({ id: "c", subjectName: "Inline Skate", duo: false, who: "A" }, 100000)?.branch).toBe("BRAVO");
    expect(voucherLine({ id: "v", hours: 10, who: "A", branch: "OTHER" }, 0)?.branch).toBe("OTHER");
    expect(voucherLine({ id: "v", hours: 10, who: "A" }, 0)?.branch).toBe("BRAVO");
    const facts = { id: "b", bookingType: "FIRST_TRIAL", subjectName: "Inline Skate", who: "A" };
    const group = "inline-skate"; // any price group the catalogue knows is found below
    for (const g of ["inline-skate", "skateboard", "scooter"]) {
      const l = trialOrSingleLine({ ...facts, branch: "OTHER" }, g);
      if (l) {
        expect(l.branch).toBe("OTHER");
        expect(trialOrSingleLine({ ...facts }, g)?.branch).toBe("BRAVO");
        break;
      }
    }
    expect(group).toBeDefined();
    expect(parkFeeLine({ id: "b", otherPriceMinor: 5000, otherPriceItemId: null, branch: "OTHER" }, null)?.branch).toBe("OTHER");
    expect(parkFeeLine({ id: "b", otherPriceMinor: 5000, otherPriceItemId: null }, null)?.branch).toBe("BRAVO");
  });
  test("an unknown stored value on the source reads BRAVO on the line", () => {
    expect(voucherLine({ id: "v", hours: 10, who: null, branch: "mystery" }, 0)?.branch).toBe("BRAVO");
  });
});

// ── writeRevenueLine and the entry points, on a recording fake (as revenue-line.test.ts) ──
type Rec = Record<string, any[]>;
function fakeExec(results: unknown[], queryData: Record<string, unknown> = {}) {
  const chains: Rec[] = [];
  const next = () => {
    const r = results.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  const chain = (op: string, args: any[]) => {
    const rec: Rec = { [op]: args };
    chains.push(rec);
    const proxy: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (res: any, rej: any) => Promise.resolve().then(() => (rec.from?.[0] && (rec.from[0] as any)?.[Symbol.for("drizzle:Name")] === "payment" ? [] : next())).then(res, rej);
          return (...a: any[]) => ((rec[prop] = a), proxy);
        },
      },
    );
    return proxy;
  };
  const query = new Proxy({}, { get: (_t, table: string) => ({ findFirst: async () => queryData[table] ?? undefined }) });
  const exec: any = {
    select: (...a: any[]) => chain("select", a),
    insert: (...a: any[]) => chain("insert", a),
    update: (...a: any[]) => chain("update", a),
    query,
    transaction: async (fn: (sp: any) => Promise<unknown>) => fn(exec),
  };
  return { exec, chains, lines: () => chains.filter((c) => c.insert?.[0] === boRevenueLine).map((c) => c.values[0]), updates: () => chains.filter((c) => c.update) };
}
let errors: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = [];
  spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
});
afterEach(() => spy.mockRestore());

const LINE = { idempotencyKey: "rl:booking:b-1", type: "TRIAL" as const, categoryName: "1st Trial (Inline Skate)", productName: "x", amountMinor: 139000, source: "BOOKING" as const, refType: "BOOKING" as const, refId: "b-1" };

describe("writeRevenueLine — the branch column", () => {
  test("a line with no branch is BRAVO (unchanged behaviour); OTHER is written as OTHER", async () => {
    const a = fakeExec([[{ id: "cat" }], [{ id: "l" }]]);
    await writeRevenueLine(a.exec, LINE);
    expect(a.lines()[0].branch).toBe("BRAVO");
    const b = fakeExec([[{ id: "cat" }], [{ id: "l" }]]);
    await writeRevenueLine(b.exec, { ...LINE, branch: "OTHER" });
    expect(b.lines()[0].branch).toBe("OTHER");
  });
  test("a junk branch on the input still lands as BRAVO (the table's CHECK is never asked to refuse it)", async () => {
    const a = fakeExec([[{ id: "cat" }], [{ id: "l" }]]);
    await writeRevenueLine(a.exec, { ...LINE, branch: "junk" as never });
    expect(a.lines()[0].branch).toBe("BRAVO");
  });
  test("🔑 a line already written NEVER changes branch: the insert is ON CONFLICT DO NOTHING and there is no update", async () => {
    const f = fakeExec([[{ id: "cat" }], []]); // the key exists ⇒ the insert returns nothing
    expect(await writeRevenueLine(f.exec, { ...LINE, branch: "OTHER" })).toEqual({ ok: true, skipped: "duplicate" });
    expect(f.updates()).toHaveLength(0);
    expect(f.chains.find((c) => c.insert?.[0] === boRevenueLine)?.onConflictDoNothing[0]).toEqual({ target: boRevenueLine.idempotencyKey });
  });
});

describe("the entry points read the SOURCE row's branch", () => {
  const course = { id: "c-1", coStudentId: null, subjectId: "s-1", student: { nickname: "Aa" }, coStudent: null };
  const movements = [{ key: "course-sale:c-1", valueMinor: 100000 }];

  test("postCourseRevenue: an OTHER course writes an OTHER line; a BRAVO course BRAVO; a row with no branch BRAVO", async () => {
    for (const [b, want] of [["OTHER", "OTHER"], ["BRAVO", "BRAVO"], [undefined, "BRAVO"]] as const) {
      const f = fakeExec([movements, [{ id: "cat" }], [{ id: "l" }]], { coursePackages: { ...course, branch: b }, subjects: { name: "Inline Skate" } });
      await postCourseRevenue(f.exec, "c-1");
      expect(f.lines()[0]).toMatchObject({ idempotencyKey: "rl:course:c-1", branch: want });
    }
  });
  test("postVoucherRevenue: the voucher's branch", async () => {
    const f = fakeExec([[{ id: "cat" }], [{ id: "l" }]], { vouchers: { id: "v-1", totalHours: 10, student: { nickname: "Aa" }, branch: "OTHER" } });
    await postVoucherRevenue(f.exec, "v-1", 0);
    expect(f.lines()[0]).toMatchObject({ idempotencyKey: "rl:voucher:v-1", branch: "OTHER" });
  });
  test("postConfirmRevenue: a trial / single takes the BOOKING's branch; a course session takes the COURSE's (not the session's)", async () => {
    const deps = { resolvePriceGroup: async () => null, groupKindOf: async () => null };
    const sessionOfOtherCourse = { id: "b-9", courseId: "c-1", bookingType: "COURSE_PACKAGE", branch: "BRAVO", student: { nickname: "Aa" }, coStudent: null, teacher: { isSystem: false } };
    const f = fakeExec([movements, [{ id: "cat" }], [{ id: "l" }]], { bookings: sessionOfOtherCourse, coursePackages: { ...course, branch: "OTHER" }, subjects: { name: "Inline Skate" } });
    await postConfirmRevenue(f.exec, "b-9", deps);
    expect(f.lines()[0]).toMatchObject({ idempotencyKey: "rl:course:c-1", branch: "OTHER" });
  });
  test("postConfirmRevenue: a trial and a single session take the BOOKING's branch", async () => {
    const deps = { resolvePriceGroup: async () => PRICE_GROUPS[0] as string, groupKindOf: async () => null };
    for (const bookingType of ["FIRST_TRIAL", "SINGLE_SESSION"]) {
      for (const [b, want] of [["OTHER", "OTHER"], ["BRAVO", "BRAVO"], [undefined, "BRAVO"]] as const) {
        const booking = { id: "b-5", courseId: null, subjectId: "s-1", groupId: null, bookingType, branch: b, subject: { name: "Inline Skate" }, student: { nickname: "Aa" }, coStudent: null, teacher: { isSystem: false } };
        const f = fakeExec([[{ id: "cat" }], [{ id: "l" }]], { bookings: booking });
        await postConfirmRevenue(f.exec, "b-5", deps);
        expect(f.lines()[0]).toMatchObject({ idempotencyKey: "rl:booking:b-5", branch: want });
      }
    }
  });
  test("postConfirmRevenue: a park fee takes the booking's branch", async () => {
    const deps = { resolvePriceGroup: async () => null, groupKindOf: async () => null };
    const booking = { id: "b-7", courseId: null, bookingType: "OTHER", branch: "OTHER", otherPriceMinor: 5000, otherPriceItemId: null, student: null, coStudent: null, teacher: { isSystem: true }, subject: null };
    const f = fakeExec([[{ id: "cat" }], [{ id: "l" }]], { bookings: booking });
    await postConfirmRevenue(f.exec, "b-7", deps);
    expect(f.lines()[0]).toMatchObject({ idempotencyKey: "rl:booking:b-7", type: "RENT", branch: "OTHER" });
  });
});

describe("source pins on the files this half of TASK-889 touched", () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
  test("revenue-line.ts has no fixed BRAVO left in the insert (DEFAULT_BRANCH stays exported for callers)", async () => {
    const src = await read("./revenue-line.ts");
    expect(src).toContain("branch: branchOf(line.branch)");
    expect(src).not.toMatch(/branch:\s*DEFAULT_BRANCH/);
  });
  test("every builder in booking-sale-amount sets `branch: branchOf(` — the four source-backed ones and (half 2) the rental one, from its ref's branch", async () => {
    const src = await read("./booking-sale-amount.ts");
    expect((src.match(/branch: branchOf\(/g) ?? []).length).toBe(5); // 🔻 TASK-889 half 2: +rentalLine
  });
  test("the validators are one shared `BRANCH` on the five bodies", async () => {
    const src = await read("../validation.ts");
    expect((src.match(/branch: BRANCH\.optional\(\)/g) ?? []).length).toBe(5);
    expect((src.match(/export const BRANCH = z\.enum\(BRANCHES\)/g) ?? []).length).toBe(1);
  });
});
