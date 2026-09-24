// TASK-371 (`REQ-091 §9`, Deploy A, T1) — a rental is a ROW on a session (`booking_rentals`, migration `0035`):
// record (unpaid, NO money) · paid (the ONE place money moves — `recordRental`, `hours 1`, `refId = bookingId`)
// · remove (unpaid only). DTO `rental: { code, remark, paid } | null` replaces the dead `hasRental`. The rules
// are pure (`lib/rental-row.ts`) and pinned with values; the routes run through the ROOT app with the service
// spied; the money path, the migration and the witness are pinned at the source.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CALENDAR_HIDDEN_STATUSES } from "../db/schema";
import { RENTAL_CODES, isRentalCode, rentalPriceList } from "./sale-items";
import { REMARK_REQUIRED_CODES, rentalBookingLive, rentalRemarkRequired, toRentalDTO } from "./rental-row";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { readSrc } from "./read-src";
import * as v from "../validation";
import { uuidFor } from "./test-uuid";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.SKIP_AUTH = "true";

const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
};

describe("🔑 the rules — pure, with values", () => {
  test("the remark rule is SET + RIDE (the customer's 'Full Set or inline'); helmet, pads, helmet+pads need none", () => {
    expect([...REMARK_REQUIRED_CODES].sort()).toEqual(["rental-ride", "rental-set"]);
    expect(rentalRemarkRequired("rental-set", "")).toBe(true);
    expect(rentalRemarkRequired("rental-set", "   ")).toBe(true);
    expect(rentalRemarkRequired("rental-set", null)).toBe(true);
    expect(rentalRemarkRequired("rental-set", "ชุด M เบอร์ 38")).toBe(false);
    expect(rentalRemarkRequired("rental-ride", undefined)).toBe(true);
    for (const c of ["rental-helmet", "rental-pads", "rental-helmet-pads"]) expect(rentalRemarkRequired(c, null)).toBe(false);
  });

  test("BOOKING_NOT_LIVE = exactly the grid's hidden statuses (CANCELLED, PAUSED); ATTENDED still accepts a rental", () => {
    for (const s of CALENDAR_HIDDEN_STATUSES) expect(rentalBookingLive(s)).toBe(false);
    for (const s of ["PENDING", "CONFIRMED", "EXTENDED", "ATTENDED", "NO_SHOW", "SICK_LEAVE", "PENDING_RESCHEDULE"]) expect(rentalBookingLive(s)).toBe(true);
  });

  test("the DTO shape: null without a row; { code, remark, paid } with one; paid = paid_at set, nothing else", () => {
    expect(toRentalDTO(null)).toBeNull();
    expect(toRentalDTO(undefined)).toBeNull();
    expect(toRentalDTO({ code: "rental-set", remark: "ชุด M", paidAt: null })).toEqual({ code: "rental-set", remark: "ชุด M", paid: false });
    expect(toRentalDTO({ code: "rental-helmet", remark: null, paidAt: new Date() })).toEqual({ code: "rental-helmet", remark: null, paid: true });
    expect(toRentalDTO({ code: "rental-ride", remark: null, paidAt: "2026-09-17T10:00:00Z" })).toMatchObject({ paid: true });
  });

  test("the 5th tier: `rental-helmet-pads` = 100/hr, a known code, in the price list the FE reads", () => {
    expect([...RENTAL_CODES]).toContain("rental-helmet-pads");
    expect(isRentalCode("rental-helmet-pads")).toBe(true);
    expect(rentalPriceList().find((p) => p.code === "rental-helmet-pads")?.priceMinor).toBe(10000);
    expect(rentalPriceList().map((p) => [p.code, p.priceMinor / 100])).toEqual([["rental-set", 200], ["rental-ride", 150], ["rental-helmet", 50], ["rental-pads", 50], ["rental-helmet-pads", 100]]);
  });

  test("the validator: a known code, an optional trimmed remark ≤ 200; an unknown code is a 400 — the remark RULE is not here", () => {
    expect(v.recordBookingRental.safeParse({ code: "rental-helmet-pads" }).success).toBe(true);
    expect(v.recordBookingRental.safeParse({ code: "rental-set" }).success).toBe(true); // shape only — the rule is the service's
    expect(v.recordBookingRental.safeParse({ code: "rental-unknown" }).success).toBe(false);
    expect(v.recordBookingRental.safeParse({ code: "rental-set", remark: "  ชุด M  " }).data?.remark).toBe("ชุด M");
    expect(v.recordBookingRental.safeParse({ code: "rental-set", remark: "x".repeat(201) }).success).toBe(false);
  });
});

const rental = await import("../services/rental.service");
const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const { ApiException } = await import("./http");

describe("🔑 the routes — through the ROOT app, the service spied", () => {
  const calls: any[] = [];
  const spies = [
    spyOn(rental, "recordBookingRental").mockImplementation((async (id: string, input: any, actor: string | null) => {
      calls.push(["record", id, input, actor]);
      if (id === uuidFor("dead")) throw new ApiException(409, "BOOKING_NOT_LIVE", "x");
      if (id === uuidFor("dup")) throw new ApiException(409, "RENTAL_EXISTS", "x");
      return { rental: { code: input.code, remark: input.remark ?? null, paid: false } };
    }) as any),
    spyOn(rental, "payBookingRental").mockImplementation((async (id: string, actor: string | null) => {
      calls.push(["paid", id, actor]);
      if (id === uuidFor("unposted")) throw new ApiException(502, "RENTAL_NOT_POSTED", "x");
      return { rental: { code: "rental-set", remark: "ชุด M", paid: true } };
    }) as any),
    spyOn(rental, "removeBookingRental").mockImplementation((async (id: string) => {
      calls.push(["remove", id]);
      if (id === uuidFor("paidrow")) throw new ApiException(409, "RENTAL_PAID", "x");
      return { removed: true as const };
    }) as any),
  ];
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  const req = (path: string, method: string, body?: unknown) =>
    app.fetch(new Request(`http://localhost/api${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));

  test("POST /bookings/:id/rental ⇒ 201 { rental: { …, paid: false } }; actor from the token", async () => {
    const res = await req(`/bookings/${uuidFor("b1")}/rental`, "POST", { code: "rental-set", remark: "ชุด M" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ rental: { code: "rental-set", remark: "ชุด M", paid: false } });
    expect(calls.at(-1)).toEqual(["record", uuidFor("b1"), { code: "rental-set", remark: "ชุด M" }, "dev"]);
  });

  test("an unknown code is refused at the edge (400 VALIDATION) — the service is never called", async () => {
    const before = calls.length;
    const res = await req(`/bookings/${uuidFor("b1")}/rental`, "POST", { code: "rental-boat" });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(before);
  });

  test("the service's refusals reach the client as the app's envelope: 409 BOOKING_NOT_LIVE · 409 RENTAL_EXISTS · 409 RENTAL_PAID · 502 RENTAL_NOT_POSTED", async () => {
    for (const [path, method, body, code] of [
      [`/bookings/${uuidFor("dead")}/rental`, "POST", { code: "rental-helmet" }, "BOOKING_NOT_LIVE"],
      [`/bookings/${uuidFor("dup")}/rental`, "POST", { code: "rental-helmet" }, "RENTAL_EXISTS"],
      [`/bookings/${uuidFor("paidrow")}/rental`, "DELETE", undefined, "RENTAL_PAID"],
      [`/bookings/${uuidFor("unposted")}/rental/paid`, "POST", undefined, "RENTAL_NOT_POSTED"],
    ] as const) {
      const res = await req(path, method, body);
      expect({ path, status: res.status, code: ((await res.json()) as any).error.code }).toEqual({ path, status: code === "RENTAL_NOT_POSTED" ? 502 : 409, code });
    }
  });

  test("POST …/rental/paid ⇒ 200 { rental: { …, paid: true } }; DELETE …/rental ⇒ 200 { removed: true }", async () => {
    const paid = await req(`/bookings/${uuidFor("b1")}/rental/paid`, "POST");
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ rental: { code: "rental-set", remark: "ชุด M", paid: true } });
    expect(calls.at(-1)).toEqual(["paid", uuidFor("b1"), "dev"]);
    const gone = await req(`/bookings/${uuidFor("b1")}/rental`, "DELETE");
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ removed: true });
  });
});

describe("🔴 the money — ONE place, the existing path, byte for byte (source)", () => {
  const SVC = code(src("src/services/rental.service.ts"));
  const REC = region(SVC, "export async function recordBookingRental(", "export async function payBookingRental(");
  const PAY = region(SVC, "export async function payBookingRental(", "export async function removeBookingRental(");
  const DEL = region(SVC, "export async function removeBookingRental(", "\n}\n");

  test("record writes the row and NOTHING to the ledger; the UNIQUE's 23505 becomes 409 RENTAL_EXISTS in the service", () => {
    expect(REC).toContain(".insert(bookingRentals)");
    expect(REC).not.toMatch(/recordRental|recordSale/);
    expect(REC).toContain('if (pgErrorCode(e) !== "23505") throw e;');
    expect(REC).toContain('throw conflict("RENTAL_EXISTS"');
    expect(REC).toContain('throw conflict("BOOKING_NOT_LIVE"');
    expect(REC).toContain('new ApiException(400, "RENTAL_REMARK_REQUIRED"');
    expect(REC).toContain("rentalRemarkRequired(input.code, input.remark)");
    expect(REC).toContain("rentalBookingLive(booking.status)");
  });

  test("🔑 paid posts through `recordRental` — hours 1, refId = bookingId, the actor — and sets paid_at ONLY after `recorded` or `duplicate`", () => {
    expect(PAY).toContain("const posted = await recordRental({ code: row.code, hours: 1, refId: bookingId, actor });");
    expect((PAY.match(/recordRental\(/g) ?? []).length).toBe(1);
    expect(PAY).not.toContain("recordSale(");
    expect(PAY).toContain('if (posted.status !== "recorded" && posted.status !== "duplicate") {');
    expect(PAY.indexOf("paidAt: new Date()")).toBeGreaterThan(PAY.indexOf("const posted = await recordRental("));
    // paid twice ⇒ return before the post (and the ledger key is the second guard, asserted below)
    expect(PAY).toContain("if (row.paidAt) return { rental: toRentalDTO(row) };");
    expect(PAY.indexOf("if (row.paidAt) return")).toBeLessThan(PAY.indexOf("const posted = await recordRental("));
  });

  test("the ledger's idempotency is the backstop: `recordRental` keys on `rental:<refId>:<code>`, so a second post is a `duplicate`", () => {
    const ITEMS = code(src("src/lib/sale-items.ts"));
    expect(ITEMS).toContain("export const rentalIdempotencyKey = (idBase: string, code: string): string => `rental:${idBase}:${code}`;");
    const OLD = region(SVC, "export async function recordRental(", "\n}\n");
    expect(OLD).toContain("const idempotencyKey = rentalIdempotencyKey(idBase, input.code);");
    expect(OLD).toContain('status: result.skipped === "duplicate" ? ("duplicate" as const) : ("recorded" as const),');
  });

  test("remove: unpaid only — a paid row is 409 RENTAL_PAID and nothing is deleted; no ledger reversal here", () => {
    expect(DEL).toContain('if (row.paidAt) throw conflict("RENTAL_PAID"');
    expect(DEL.indexOf('conflict("RENTAL_PAID"')).toBeLessThan(DEL.indexOf(".delete(bookingRentals)"));
    expect(DEL).not.toMatch(/recordSale|reverse/);
  });
});

describe("🔴 the DTO, the readers and the dead marker (source)", () => {
  test("`hasRental` and `bookingsWithRentals` are GONE from the product source and the contract", () => {
    for (const f of ["src/db/mappers.ts", "src/services/scheduler.service.ts", "src/services/checkin.service.ts", "src/types/contract.ts", "src/routes/api.ts"]) {
      expect({ f, hasRental: code(src(f)).includes("hasRental"), join: code(src(f)).includes("bookingsWithRentals") }).toEqual({ f, hasRental: false, join: false });
    }
    expect(code(src("src/db/mappers.ts"))).toContain("  rental: toRentalDTO(b.rental),");
    expect(src("src/types/contract.ts")).toContain("  rental: { code: string; remark: string | null; paid: boolean } | null;");
  });

  test("the row is a RELATION in both shared relation sets (calendar + check-in) — one batched query, no per-reader read", () => {
    for (const f of ["src/services/scheduler.service.ts", "src/services/checkin.service.ts"]) {
      const REL = region(code(src(f)), "const withBookingRelations = {", "} as const;");
      expect({ f, rental: REL.includes("rental: true,") }).toEqual({ f, rental: true });
    }
    const SCHEMA = code(src("src/db/schema.ts"));
    expect(SCHEMA).toContain("rental: one(bookingRentals, { fields: [bookings.id], references: [bookingRentals.bookingId] }),");
    expect(SCHEMA).toContain('uniqueIndex("booking_rentals_booking_uq").on(t.bookingId)');
    expect(SCHEMA).not.toMatch(/booking_rentals[\s\S]*price/i);
  });
});

describe("🔴 the migration — 0035, counted, witnessed, the lock named (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const JOURNAL = readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8");
  const SQL = readFileSync(resolve(root, "drizzle/0035_booking_rentals.sql"), "utf8").replace(/\r\n/g, "\n"); // the file may be CRLF on this box

  test("56 = 56 (0036 … 0055 added since): the 36th file is `0035_booking_rentals`, at idx 35", () => {
    expect(files.length).toBe(56);
    expect(files[35]).toBe("0035_booking_rentals.sql"); // 🔻 TASK-377: 0036_users is the 37th
    expect((JOURNAL.match(/"tag"/g) ?? []).length).toBe(56);
    const j = JSON.parse(JOURNAL) as { entries: Array<{ idx: number; tag: string }> };
    expect(j.entries[35]).toMatchObject({ idx: 35, tag: "0035_booking_rentals" });
  });

  test("the body: CREATE TABLE with the FK (cascade), then the UNIQUE INDEX as the LAST statement; both IF NOT EXISTS; no price column", () => {
    const body = SQL.replace(/^--.*$/gm, "");
    expect(body).toContain('CREATE TABLE IF NOT EXISTS "booking_rentals"');
    expect(body).toContain('"booking_id"  uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE');
    expect(SQL).toContain("--> statement-breakpoint"); // on the raw file — the comment strip above eats it
    expect(body.trim().endsWith('CREATE UNIQUE INDEX IF NOT EXISTS "booking_rentals_booking_uq"\n  ON "booking_rentals" ("booking_id");')).toBe(true);
    expect(body).not.toMatch(/price/i);
    for (const col of ['"code"', '"remark"', '"paid_at"', '"paid_actor"', '"created_at"', '"created_by"']) expect(body).toContain(col);
  });

  test("🔒 the header names the LOCK exactly — SHARE ROW EXCLUSIVE on bookings, writes wait, reads continue, not closed-shop — and the deploy order", () => {
    expect(SQL).toContain("SHARE ROW EXCLUSIVE on `bookings`");
    expect(SQL).toContain("reads continue, WRITES to `bookings` (INSERT/UPDATE/DELETE) wait");
    expect(SQL).toContain("NOT `0033`'s ACCESS EXCLUSIVE");
    expect(SQL).toContain("not closed-shop; a\n--     write-blocking blink on `bookings`");
    expect(SQL).toContain("`db:migrate` (this) → `bun run sale:ensure-items`");
    expect(SQL).toContain("drizzle/*.sql` = 35 (0000–0034) and journal tags = 35 before this, newest `0034`, so this is `0035`");
  });

  test("the witness is the unique index (the LAST object, invented by this migration), rerunnable", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0035_booking_rentals")!;
    expect(w).toBeTruthy();
    expect(w.probe).toEqual({ kind: "index", index: "booking_rentals_booking_uq" });
    expect(w.rerunnable).toBe(true);
    expect(SCHEDULING_WITNESSES.map((w) => w.tag)).toContain("0035_booking_rentals"); // 🔻 TASK-377: no longer the last
  });

  test("the 5th bo.item reaches an existing box through `sale:ensure-items` (additive) — the seed list carries it with the RENTAL marker", () => {
    const { RENTAL_ITEMS, SALE_ITEMS } = require("./sale-items");
    const item = SALE_ITEMS.find((i: any) => i.externalRef === "rental-helmet-pads");
    expect(item).toMatchObject({ unitPriceMinor: 10000, metadata: { revenueKind: "RENTAL" } });
    expect(RENTAL_ITEMS.length).toBe(5);
    const ENSURE = readFileSync(resolve(root, "scripts/ensure-sale-items.ts"), "utf8");
    expect(ENSURE).toContain("exists — left alone (price NOT overwritten)");
    expect(ENSURE).toContain("for (const item of SALE_ITEMS) {");
  });
});
