import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { boPayment, boRevenueCategory, boRevenueLine } from "../db/bo-revenue";
import {
  DEFAULT_BRANCH,
  DEFAULT_METHOD,
  postConfirmRevenue,
  postCourseRevenue,
  postRentalRevenue,
  postVoucherRevenue,
  writeRevenueLine,
  type ConfirmDeps,
} from "./revenue-line";
import type { RevenueLineInput } from "./booking-sale-amount";
import { PRICE_GROUPS, listPriceMinor, revenueItemRef, voucherItemRef } from "./sale-items";

// TASK-864 — the writer and the four entry points, DB-free: a recording fake stands in for the drizzle executor. It
// proves WHAT is written (key, type, amounts, conflict target) and that a failure never escapes. It cannot prove the
// SQL itself or that the database dedupes — that is the sid run in the DoD.

type Rec = Record<string, any[]>;
/** `results` is the queue every awaited query chain resolves from, in order. An `Error` in it is thrown. */
function fakeExec(results: unknown[], queryData: Record<string, unknown> = {}, paymentRowOne: unknown = []) {
  const chains: Rec[] = [];
  let transactions = 0;
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
          // TASK-875: the writer's read of payment row 1 is answered from `paymentRowOne` (an Error is thrown), NOT from the queue,
          // so the existing queues stay exactly as TASK-864 wrote them.
          if (prop === "then")
            return (res: any, rej: any) =>
              Promise.resolve()
                .then(() => {
                  if (rec.from?.[0] === boPayment) {
                    if (paymentRowOne instanceof Error) throw paymentRowOne;
                    return paymentRowOne;
                  }
                  return next();
                })
                .then(res, rej);
          return (...a: any[]) => {
            rec[prop] = a;
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const query = new Proxy(
    {},
    {
      get: (_t, table: string) => ({
        findFirst: async () => {
          const v = queryData[table];
          if (v instanceof Error) throw v;
          return v ?? undefined;
        },
      }),
    },
  );
  const exec: any = {
    select: (...a: any[]) => chain("select", a),
    insert: (...a: any[]) => chain("insert", a),
    query,
    transaction: async (fn: (sp: any) => Promise<unknown>) => {
      transactions++;
      return fn(exec);
    },
  };
  return { exec, chains, transactionCount: () => transactions, inserts: (t: unknown) => chains.filter((c) => c.insert?.[0] === t) };
}

let errors: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = [];
  spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
});
afterEach(() => spy.mockRestore());

const LINE: RevenueLineInput = {
  idempotencyKey: "rl:booking:b-1",
  type: "TRIAL",
  categoryName: "1st Trial (Inline Skate)",
  productName: "Inline Skate Trial — Nong A",
  amountMinor: 139000,
  source: "BOOKING",
  refType: "BOOKING",
  refId: "b-1",
};

describe("writeRevenueLine", () => {
  test("existing category: one line insert with the fixed branch / method, the key, and ON CONFLICT on the key", async () => {
    const f = fakeExec([[{ id: "cat-1" }], [{ id: "line-1" }]]);
    expect(await writeRevenueLine(f.exec, LINE)).toEqual({ ok: true });
    expect(f.inserts(boRevenueCategory).length).toBe(0);
    const [ins] = f.inserts(boRevenueLine);
    const v = ins.values[0];
    expect(v).toMatchObject({
      categoryId: "cat-1",
      type: "TRIAL",
      productName: "Inline Skate Trial — Nong A",
      amountMinor: 139000,
      branch: DEFAULT_BRANCH,
      method: DEFAULT_METHOD,
      source: "BOOKING",
      refType: "BOOKING",
      refId: "b-1",
      idempotencyKey: "rl:booking:b-1",
      actor: null,
    });
    expect([DEFAULT_BRANCH, DEFAULT_METHOD]).toEqual(["BRAVO", "TRANSFER"]);
    expect(v.occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/); // the Bangkok date of the write
    expect(ins.onConflictDoNothing[0]).toEqual({ target: boRevenueLine.idempotencyKey });
  });

  test("an explicit occurredOn is kept", async () => {
    const f = fakeExec([[{ id: "cat-1" }], [{ id: "l" }]]);
    await writeRevenueLine(f.exec, { ...LINE, occurredOn: "2026-11-08" });
    expect(f.inserts(boRevenueLine)[0].values[0].occurredOn).toBe("2026-11-08");
  });

  test("a missing category is CREATED (next sort_order, ON CONFLICT DO NOTHING), re-read, then the line is written", async () => {
    const f = fakeExec([[], [{ next: 26 }], undefined, [{ id: "cat-new" }], [{ id: "line-1" }]]);
    expect(await writeRevenueLine(f.exec, LINE)).toEqual({ ok: true });
    const [cat] = f.inserts(boRevenueCategory);
    expect(cat.values[0]).toEqual({ type: "TRIAL", name: "1st Trial (Inline Skate)", sortOrder: 26 });
    expect(cat.onConflictDoNothing).toBeDefined();
    expect(f.inserts(boRevenueLine)[0].values[0].categoryId).toBe("cat-new");
  });

  test("the key already exists ⇒ a success, marked duplicate (a second click writes no second row)", async () => {
    const f = fakeExec([[{ id: "cat-1" }], []]);
    expect(await writeRevenueLine(f.exec, LINE)).toEqual({ ok: true, skipped: "duplicate" });
    expect(errors).toEqual([]);
  });

  test("a failed insert is caught and logged with the key — it never throws", async () => {
    const f = fakeExec([[{ id: "cat-1" }], new Error("boom")]);
    const res = await writeRevenueLine(f.exec, LINE);
    expect(res).toEqual({ ok: false, skipped: "error" });
    expect(errors.join("\n")).toContain("rl:booking:b-1");
    expect(errors.join("\n")).toContain("NOT WRITTEN");
  });

  test("a category that is still missing after its insert is an error, not a silent null id", async () => {
    const f = fakeExec([[], [{ next: 0 }], undefined, []]);
    expect((await writeRevenueLine(f.exec, LINE)).skipped).toBe("error");
    expect(errors.join("\n")).toContain("missing after its insert");
  });

  test.each([0, -5, 1.5])("amount %p is refused before any query, loudly", async (amountMinor) => {
    const f = fakeExec([]);
    expect(await writeRevenueLine(f.exec, { ...LINE, amountMinor })).toEqual({ ok: false, skipped: "bad-amount" });
    expect(f.transactionCount()).toBe(0);
    expect(errors.join("\n")).toContain("rl:booking:b-1");
  });

  test("it runs in a savepoint (exec.transaction), so a failure cannot abort the caller's transaction", async () => {
    const f = fakeExec([[{ id: "c" }], [{ id: "l" }]]);
    await writeRevenueLine(f.exec, LINE);
    expect(f.transactionCount()).toBe(1);
  });
});

// ───────── TASK-875 — a COURSE / VOUCHER line takes row 1's method (TRANSFER when absent); nothing else does ─────────
describe("writeRevenueLine — the method follows payment row 1 (SPEC-099 §8.4)", () => {
  const COURSE_LINE: RevenueLineInput = { ...LINE, idempotencyKey: "rl:course:c-1", type: "COURSE", source: "BOOKING", refType: "COURSE", refId: "c-1" };
  const VOUCHER_LINE: RevenueLineInput = { ...COURSE_LINE, idempotencyKey: "rl:voucher:v-1", type: "VOUCHER", refType: "VOUCHER", refId: "v-1" };
  const run = async (line: RevenueLineInput, pay: unknown) => {
    const f = fakeExec([[{ id: "cat" }], [{ id: "l" }]], {}, pay);
    const res = await writeRevenueLine(f.exec, line);
    return { f, res, method: f.inserts(boRevenueLine)[0]?.values[0].method };
  };

  test.each(["CASH", "CARD", "TRANSFER"])("COURSE: row 1 says %s → the line is %s", async (m) => {
    expect((await run(COURSE_LINE, [{ method: m }])).method).toBe(m);
  });
  test("VOUCHER follows row 1 too", async () => {
    expect((await run(VOUCHER_LINE, [{ method: "CARD" }])).method).toBe("CARD");
  });
  test("no row 1 yet → TRANSFER", async () => {
    expect((await run(COURSE_LINE, [])).method).toBe("TRANSFER");
  });
  test("a method outside the three is never copied", async () => {
    expect((await run(COURSE_LINE, [{ method: "BITCOIN" }])).method).toBe("TRANSFER");
  });
  test("the read asks for n = 1 of THIS sale only, in its own nested savepoint", async () => {
    const { f } = await run(COURSE_LINE, [{ method: "CASH" }]);
    expect(f.transactionCount()).toBe(2); // the line's savepoint + the nested read
    const read = f.chains.find((c) => c.from?.[0] === boPayment)!;
    expect(read.limit).toEqual([1]);
    const q = new PgDialect().sqlToQuery(read.where![0]);
    expect(q.sql).toContain('"ref_type" = $1');
    expect(q.sql).toContain('"n" = $3');
    expect(q.params).toEqual(["COURSE", "c-1", 1]);
  });
  test("a failing read (the table is not there yet) is logged and the line is STILL written as TRANSFER", async () => {
    const { res, method } = await run(COURSE_LINE, new Error('relation "bo.payment" does not exist'));
    expect(res).toEqual({ ok: true });
    expect(method).toBe("TRANSFER");
    expect(errors.join("\n")).toContain("rl:course:c-1");
    expect(errors.join("\n")).toContain("TRANSFER");
  });
  test.each([
    ["a BOOKING (trial / single) line", { ...LINE }],
    ["a RENTAL line", { ...LINE, idempotencyKey: "rl:rental:x", refType: "RENTAL" as const, refId: "r-1", source: "RENT" as const }],
  ])("%s never reads payment row 1 (one savepoint, TRANSFER)", async (_n, line) => {
    const { f, method } = await run(line as RevenueLineInput, [{ method: "CASH" }]);
    expect(method).toBe("TRANSFER");
    expect(f.chains.some((c) => c.from?.[0] === boPayment)).toBe(false);
    expect(f.transactionCount()).toBe(1);
  });
});

// ─────────────────────────────── the entry points: which trigger maps to which line ───────────────────────────────
const deps = (group: string | null = null): ConfirmDeps => ({
  resolvePriceGroup: async () => group,
  groupKindOf: async () => null,
});
/** A written line = the `revenue_line` insert's values. */
const written = (f: ReturnType<typeof fakeExec>) => f.inserts(boRevenueLine).map((c) => c.values[0]);
const baseBooking = {
  id: "b-1",
  courseId: null,
  subjectId: "s-1",
  groupId: null,
  subject: { name: "Inline Skate" },
  student: { nickname: "Nong A" },
  coStudent: null,
  teacher: { isSystem: false },
  discountKind: null,
  discountValue: null,
  discountReason: null,
  discountActor: null,
  otherPriceMinor: null,
  otherPriceItemId: null,
};

describe("postConfirmRevenue — applyConfirm's triggers", () => {
  test("FIRST_TRIAL → TRIAL, key rl:booking:<id>, the trial list price", async () => {
    const f = fakeExec([[{ id: "c" }], [{ id: "l" }]], { bookings: { ...baseBooking, bookingType: "FIRST_TRIAL" } });
    await postConfirmRevenue(f.exec, "b-1", deps());
    expect(written(f)).toHaveLength(1);
    expect(written(f)[0]).toMatchObject({ type: "TRIAL", idempotencyKey: "rl:booking:b-1", amountMinor: listPriceMinor("first-trial") });
  });

  test("SINGLE_SESSION → COURSE (1 HR) at the program's price", async () => {
    const group = PRICE_GROUPS[0] as string;
    const f = fakeExec([[{ id: "c" }], [{ id: "l" }]], { bookings: { ...baseBooking, bookingType: "SINGLE_SESSION" } });
    await postConfirmRevenue(f.exec, "b-1", deps(group));
    expect(written(f)[0]).toMatchObject({
      type: "COURSE",
      idempotencyKey: "rl:booking:b-1",
      amountMinor: listPriceMinor(revenueItemRef("SINGLE_SESSION", group)!),
    });
  });

  test("OTHER with the SYSTEM teacher → RENT · park fee at the typed amount", async () => {
    const f = fakeExec([[{ id: "c" }], [{ id: "l" }]], {
      bookings: { ...baseBooking, bookingType: "OTHER", teacher: { isSystem: true }, otherPriceMinor: 5000 },
    });
    await postConfirmRevenue(f.exec, "b-1", deps());
    expect(written(f)[0]).toMatchObject({ type: "RENT", productName: "Park fee", amountMinor: 5000, idempotencyKey: "rl:booking:b-1" });
  });

  test("a NORMAL OTHER booking (Birthday …, a real teacher) writes nothing", async () => {
    const f = fakeExec([], { bookings: { ...baseBooking, bookingType: "OTHER", otherPriceMinor: 5000 } });
    await postConfirmRevenue(f.exec, "b-1", deps());
    expect(f.chains).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  test("a VOUCHER booking (a session drawn from a voucher) writes nothing — the voucher's revenue is at its sale", async () => {
    const f = fakeExec([], { bookings: { ...baseBooking, bookingType: "VOUCHER" } });
    await postConfirmRevenue(f.exec, "b-1", deps());
    expect(f.chains).toHaveLength(0);
  });

  test("a session of a COURSE → the course's line (net of its sale + discount movements), key rl:course:<id>", async () => {
    const f = fakeExec(
      [
        [
          { key: "course-sale:c-1", valueMinor: 1420000 },
          { key: "discount:c-1", valueMinor: -142000 },
        ],
        [{ id: "cat" }],
        [{ id: "line" }],
      ],
      {
        bookings: { ...baseBooking, bookingType: "COURSE_PACKAGE", courseId: "c-1" },
        coursePackages: { id: "c-1", subjectId: "s-1", coStudentId: null, student: { nickname: "Nong A" }, coStudent: null },
        subjects: { name: "Surfskate" },
      },
    );
    await postConfirmRevenue(f.exec, "b-1", deps());
    expect(written(f)).toHaveLength(1);
    expect(written(f)[0]).toMatchObject({
      type: "COURSE",
      idempotencyKey: "rl:course:c-1",
      amountMinor: 1278000,
      productName: "Surfskate Private — Nong A",
      refType: "COURSE",
      refId: "c-1",
    });
  });

  test("a failure while reading is logged and NEVER thrown at the confirm", async () => {
    const f = fakeExec([], { bookings: new Error("db down") });
    await expect(postConfirmRevenue(f.exec, "b-1", deps())).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("confirm of booking b-1");
  });

  test("a booking that does not exist is a quiet no-op", async () => {
    const f = fakeExec([], {});
    await postConfirmRevenue(f.exec, "gone", deps());
    expect(f.chains).toHaveLength(0);
  });
});

describe("postCourseRevenue — confirmCourse", () => {
  const course = {
    coursePackages: { id: "c-1", subjectId: "s-1", coStudentId: "s-2", student: { nickname: "A" }, coStudent: { nickname: "B" } },
    subjects: { name: "Surfskate" },
  };
  test("a course with a co-student is Duo", async () => {
    const f = fakeExec([[{ key: "course-sale:c-1", valueMinor: 100000 }], [{ id: "cat" }], [{ id: "l" }]], course);
    await postCourseRevenue(f.exec, "c-1");
    expect(written(f)[0].productName).toContain("Surfskate Duo");
  });
  test("no posted sale movement ⇒ no line and a loud reason naming the keys", async () => {
    const f = fakeExec([[]], course);
    await postCourseRevenue(f.exec, "c-1");
    expect(written(f)).toHaveLength(0);
    expect(errors.join("\n")).toContain("course-sale:c-1");
  });
  test("a course confirmed twice writes under the SAME key both times (the table's unique key makes it one row)", async () => {
    const rows = [{ key: "course-sale:c-1", valueMinor: 100000 }];
    const f = fakeExec([rows, [{ id: "cat" }], [{ id: "l" }], rows, [{ id: "cat" }], []], course);
    await postCourseRevenue(f.exec, "c-1");
    await postCourseRevenue(f.exec, "c-1");
    const keys = written(f).map((v) => v.idempotencyKey);
    expect(keys).toEqual(["rl:course:c-1", "rl:course:c-1"]);
    expect(f.inserts(boRevenueLine).every((c) => c.onConflictDoNothing[0].target === boRevenueLine.idempotencyKey)).toBe(true);
    expect(errors).toEqual([]); // the second one is a quiet duplicate, not an alarm
  });
});

describe("postVoucherRevenue — createVoucher, after its commit", () => {
  test("VOUCHER · '<hours> Hr', rl:voucher:<id>, list price less the validated discount", async () => {
    const f = fakeExec([[{ id: "cat" }], [{ id: "l" }]], { vouchers: { id: "v-1", totalHours: 10, student: { nickname: "Nong A" } } });
    await postVoucherRevenue(f.exec, "v-1", 50000);
    expect(written(f)[0]).toMatchObject({
      type: "VOUCHER",
      idempotencyKey: "rl:voucher:v-1",
      productName: "Voucher 10 Hr — Nong A",
      amountMinor: listPriceMinor(voucherItemRef(10))! - 50000,
    });
  });
  test("a voucher that cannot be read back is logged, not thrown", async () => {
    const f = fakeExec([], { vouchers: undefined });
    await expect(postVoucherRevenue(f.exec, "v-9", 0)).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("rl:voucher:v-9");
  });
});

// 🔑 The call sites. The tests above prove each entry point; this proves the four sale paths actually CALL one — a
// helper nobody calls is a green suite and an empty ledger. Source pins, in this repo's style: slice the function's own
// body (up to the next top-level declaration) and look for the call inside it.
describe("wiring — each sale path reaches the ledger", () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
  const bodyOf = (src: string, header: string): string => {
    const start = src.indexOf(header);
    expect(start).toBeGreaterThan(-1);
    const rest = src.slice(start + header.length);
    const end = rest.search(/\n(export )?(async )?function |\nexport const /);
    return rest.slice(0, end === -1 ? undefined : end);
  };

  test("applyConfirm → postConfirmRevenue(tx, id, { resolvePriceGroup, groupKindOf }), right after the status write", async () => {
    const body = bodyOf(await read("../services/scheduler.service.ts"), "async function applyConfirm(");
    expect(body).toContain("await postConfirmRevenue(tx, id, { resolvePriceGroup, groupKindOf });");
    expect(body.indexOf('status: "CONFIRMED"')).toBeLessThan(body.indexOf("postConfirmRevenue"));
  });
  test("confirmCourse → postCourseRevenue, only when a session was confirmed", async () => {
    const body = bodyOf(await read("../services/scheduler.service.ts"), "export async function confirmCourse(");
    expect(body).toContain("if (confirmed > 0) await postCourseRevenue(tx, id);");
  });
  test("createVoucher → postVoucherRevenue(db, id, the validated discount), after the commit and beside recordSale", async () => {
    const body = bodyOf(await read("../services/scheduler.service.ts"), "export async function createVoucher(");
    expect(body).toContain("void postVoucherRevenue(db, result.voucher.id, discount?.discountMinor ?? 0);");
    expect(body.indexOf("db.transaction")).toBeLessThan(body.indexOf("postVoucherRevenue"));
    expect(body.indexOf("recordSale(")).toBeLessThan(body.indexOf("postVoucherRevenue"));
  });
  test("recordRental → postRentalRevenue, after the sale posted and its failure was thrown (covers the press, the upfront course rental and the standalone one)", async () => {
    const body = bodyOf(await read("../services/rental.service.ts"), "export async function recordRental(");
    expect(body).toContain("await postRentalRevenue(db, {");
    expect(body).toContain("movementKey: idempotencyKey,");
    expect(body.indexOf("RENTAL_NOT_POSTED")).toBeLessThan(body.indexOf("postRentalRevenue"));
    expect(body.indexOf("recordSale(")).toBeLessThan(body.indexOf("postRentalRevenue"));
  });
  test("payBookingRental does NOT call it itself — one writer per post, nothing double-writes", async () => {
    const body = bodyOf(await read("../services/rental.service.ts"), "export async function payBookingRental(");
    expect(body).toContain("recordRental(");
    expect(body).not.toContain("postRentalRevenue");
  });
  test("the day-end job is untouched: it does not know the ledger exists", async () => {
    expect(await read("../services/jobs.service.ts")).not.toContain("revenue-line");
  });
  test("SB never migrates the ledger tables: drizzle.config.ts does not name bo-revenue", async () => {
    expect(await read("../../drizzle.config.ts")).not.toContain("bo-revenue");
  });
});

describe("postRentalRevenue — every recordRental post", () => {
  test("the paid press: RENT · EQUIPMENT, rl: + the movement key, source RENT", async () => {
    const f = fakeExec([[{ id: "cat" }], [{ id: "l" }]]);
    await postRentalRevenue(f.exec, { movementKey: "rental:b-9:rental-set", refId: "b-9", code: "rental-set", hours: 1 });
    expect(written(f)[0]).toMatchObject({
      type: "RENT",
      idempotencyKey: "rl:rental:b-9:rental-set",
      source: "RENT",
      refType: "RENTAL",
      refId: "b-9",
      amountMinor: listPriceMinor("rental-set"),
    });
  });
  test("a course's upfront rental and a discounted standalone one net what their post netted", async () => {
    const rate = listPriceMinor("rental-set")!;
    const up = fakeExec([[{ id: "cat" }], [{ id: "l" }]]);
    await postRentalRevenue(up.exec, { movementKey: "rental:c-1:rental-set", refId: "c-1", code: "rental-set", hours: 10 });
    expect(written(up)[0].amountMinor).toBe(rate * 10);
    const solo = fakeExec([[{ id: "cat" }], [{ id: "l" }]]);
    await postRentalRevenue(solo.exec, { movementKey: "rental:k:rental-set", refId: "k", code: "rental-set", hours: 2, discountMinor: 5000 });
    expect(written(solo)[0].amountMinor).toBe(rate * 2 - 5000);
  });
  test("a failure is logged, never thrown (the rental is already posted)", async () => {
    const f = fakeExec([[{ id: "cat" }], new Error("boom")]);
    await expect(postRentalRevenue(f.exec, { movementKey: "rental:b-9:rental-set", refId: "b-9", code: "rental-set", hours: 1 })).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("rl:rental:b-9:rental-set");
  });
});
