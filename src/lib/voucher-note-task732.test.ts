// 🔻 TASK-732 (Khwan's Q5 "Remark เอามาจากตอนสร้างค่ะ"; decided under the owner's delegation) — a voucher SALE carries a Remark: `vouchers.note` (migration 0068),
// accepted by `createVoucher`, printed by 730's family confirm only when non-empty. No database: by value + by source.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as v from "../validation";
import { formatOutboxMessage } from "./line-message";
import { notifyVoucherSold } from "./voucher-sold-notice";
import { SCHEDULING_WITNESSES } from "./migration-witness";

const root = resolve(import.meta.dir, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const STUDENT = { id: "11111111-1111-4111-8111-111111111111" } as any; // an EXISTING child (no inline-student phone rule in the way)

describe("🔴 TASK-732 — the validator: the attendee-note rule (trim, max 200), optional", () => {
  const body = (extra: any) => ({ student: STUDENT, totalHours: 5, ...extra });
  test("a note is trimmed; absent is fine; exactly 200 passes; 201 is refused BEFORE any sale", () => {
    expect((v.createVoucher.parse(body({ note: "  bring a helmet  " })) as any).note).toBe("bring a helmet");
    expect((v.createVoucher.parse(body({})) as any).note).toBeUndefined();
    expect((v.createVoucher.parse(body({ note: "x".repeat(200) })) as any).note.length).toBe(200);
    expect(v.createVoucher.safeParse(body({ note: "x".repeat(201) })).success).toBe(false);
  });
  test("a whitespace-only note parses to the empty string (the service turns it into null)", () => {
    expect((v.createVoucher.parse(body({ note: "   " })) as any).note).toBe("");
  });
});

describe("🔴 TASK-732 — the sale writes the note (blank ⇒ null); an import is unchanged (by source)", () => {
  const S = read("src/services/scheduler.service.ts");
  const region = (from: string, to: string) => S.slice(S.indexOf(from), S.indexOf(to, S.indexOf(from) + from.length));
  const create = region("export async function createVoucher(", "// ───────────────────────── Overbooking a leave slot");
  test("`createVoucher` normalises ONCE (blank ⇒ null), stores `note: saleNote`, and hands the same value to the family confirm", () => {
    expect(create).toContain('const saleNote: string | null = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;');
    expect(create).toContain("note: saleNote, // 🔻 TASK-732");
    expect(create).toContain("await notifyVoucherSold({ ...result.voucher, note: saleNote });");
  });
  test("`importVoucher` (historical data) neither reads nor writes a note", () => {
    const imp = region("export async function importVoucher(", "\n}\n");
    expect(imp).not.toContain("saleNote");
    expect(imp).not.toMatch(/\bnote\b\s*:/);
  });
});

describe("🔴 TASK-732 — the family confirm prints Remark only when the sale had one", () => {
  const voucher = { id: "v-1", totalHours: 5, student: { id: "s-1", name: "Student A", nickname: null } };
  const world = () => {
    const inserted: any[] = [];
    const exec: any = {
      query: { students: { findMany: async () => [{ id: "s-1", parentId: "p-1" }] }, parents: { findMany: async () => [{ id: "p-1", lineUserId: "U-parent" }] } },
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({ values: async (x: any) => { inserted.push(x); } }),
    };
    return { exec, inserted };
  };
  test("a note ⇒ it rides the payload and prints as the last line; no note / blank ⇒ NO key and NO Remark line (the payload is byte-identical to 730's)", async () => {
    const withNote = world();
    await notifyVoucherSold({ ...voucher, note: "bring a helmet" }, withNote.exec);
    expect(withNote.inserted[0].payload).toEqual({ kind: "voucher_sold_parent", studentName: "Student A", hours: 5, months: 3, note: "bring a helmet" });
    expect(formatOutboxMessage(withNote.inserted[0].payload, {}, "EN", "parent")).toBe("📅CONFIRMED SCHEDULE:\nStudent : Student A\nProgram : VOUCHER 5 HR\n*Expiry date : 3 Months\nRemark : bring a helmet");
    for (const note of [undefined, null, ""]) {
      const w = world();
      await notifyVoucherSold({ ...voucher, note }, w.exec);
      expect("note" in w.inserted[0].payload).toBe(false);
      expect(formatOutboxMessage(w.inserted[0].payload, {}, "TH", "parent")).not.toContain("Remark");
    }
  });
});

describe("🔴 TASK-732 — migration 0068: ONE nullable column, IF NOT EXISTS, the column is the witness (offline)", () => {
  test("the SQL, the journal entry, the witness and the schema agree", () => {
    const sql = read("drizzle/0068_vouchers_note.sql");
    const body = sql.replace(/^--.*$/gm, "");
    expect(body.trim()).toBe('ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "note" text;');
    expect(body).not.toMatch(/\b(UPDATE|INSERT|DELETE|NOT NULL|DEFAULT)\b/i); // no data written, no backfill, nullable
    const J = JSON.parse(read("drizzle/meta/_journal.json"));
    expect(J.entries.find((e: any) => e.idx === 68)).toMatchObject({ idx: 68, tag: "0068_vouchers_note", breakpoints: true, when: 1783000000064 });
    expect(J.entries.find((e: any) => e.idx === 68).when).toBeGreaterThan(J.entries.find((e: any) => e.idx === 67).when);
    expect(SCHEDULING_WITNESSES.find((w: any) => w.tag === "0068_vouchers_note")).toMatchObject({ probe: { kind: "column", table: "vouchers", column: "note" }, rerunnable: true });
    const schema = read("src/db/schema.ts");
    const from = schema.indexOf('export const vouchers = pgTable("vouchers"');
    expect(schema.slice(from, schema.indexOf(String.fromCharCode(10) + "});", from))).toContain('note: text("note"),'); // inside the vouchers table only
  });
});
