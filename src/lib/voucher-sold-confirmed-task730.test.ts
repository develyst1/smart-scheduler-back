// 🔻 TASK-730 (D1, Khwan's row 45; 📋 DRAFT — Q5 pending: the expiry format and the Remark source) — the FAMILY is told, once, that a VOUCHER was sold.
// Her layout, ONE text for both languages:  📅CONFIRMED SCHEDULE: / Student : / Program : / *Expiry date : / Remark :   (Remark only when it has a value).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { notifyVoucherSold } from "./voucher-sold-notice";

const VOUCHER = { id: "v-1", totalHours: 5, student: { id: "s-1", name: "Student A Full", nickname: "Student A" } };

/** A fake executor: students → parent, parents → primary account, no invited links, the outbox collects inserts. */
function world(o: { parentId?: string | null; accounts?: Array<string | null>; failInsert?: boolean } = {}) {
  const inserted: any[] = [];
  const parentId = "parentId" in o ? o.parentId : "p-1";
  const accounts = o.accounts ?? ["U-parent"];
  const exec: any = {
    query: {
      students: { findMany: async () => [{ id: "s-1", parentId }] },
      parents: { findMany: async () => (parentId ? [{ id: parentId, lineUserId: accounts[0] ?? null }] : []) },
    },
    select: () => ({ from: () => ({ where: async () => accounts.slice(1).filter(Boolean).map((u) => ({ parentId, lineUserId: u })) }) }),
    insert: () => ({ values: async (v: any) => { if (o.failInsert) throw new Error("outbox down"); inserted.push(v); } }),
  };
  return { exec, inserted };
}
const render = (payload: any, lang: "TH" | "EN") => formatOutboxMessage(payload, {}, lang, "parent");

describe("🔴 TASK-730 — the message, by value (her row 45)", () => {
  const payload = { kind: "voucher_sold_parent", studentName: "Student A", hours: 5, months: 3 };
  test("her layout with the expiry in MONTHS (Khwan's Q5 answer: `3 Months`), identical in TH and EN; no Remark line when there is none", () => {
    const text = "📅CONFIRMED SCHEDULE:\nStudent : Student A\nProgram : VOUCHER 5 HR\n*Expiry date : 3 Months";
    expect(render(payload, "TH")).toBe(text);
    expect(render(payload, "EN")).toBe(text);
  });
  test("Remark is appended only when it has a value (omit-when-empty); a blank one never prints a bare label", () => {
    expect(render({ ...payload, note: "bring a helmet" }, "EN").split("\n").at(-1)).toBe("Remark : bring a helmet");
    for (const blank of ["", "   ", null, undefined]) expect(render({ ...payload, note: blank }, "EN")).not.toContain("Remark");
  });
  test("the program line and the months follow the package: 5 h → 3 Months, 10 h → 6, 15 h → 9 (the table that decides the real expiry); never a date", async () => {
    for (const [hours, months] of [[5, 3], [10, 6], [15, 9]] as const) {
      const { exec, inserted } = world();
      await notifyVoucherSold({ ...VOUCHER, totalHours: hours }, exec);
      const text = render(inserted[0].payload, "EN");
      expect(text).toContain(`Program : VOUCHER ${hours} HR`);
      expect(text.split("\n").at(-1)).toBe(`*Expiry date : ${months} Months`);
      expect(text).not.toMatch(/\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2}/);
    }
  });
});

describe("🔴 TASK-730 — the sale tells the family ONCE (by value, no database)", () => {
  test("a linked family ⇒ exactly ONE outbox row per account, to that account, with the sale's facts and the ONE name rule (nickname first)", async () => {
    const { exec, inserted } = world();
    await notifyVoucherSold(VOUCHER, exec);
    expect(inserted.length).toBe(1);
    expect(inserted[0]).toMatchObject({ recipientType: "parent", recipientLineUserId: "U-parent", status: "PENDING", idempotencyKey: "voucher-sold:v-1:U-parent" });
    expect(inserted[0].payload).toEqual({ kind: "voucher_sold_parent", studentName: "Student A", hours: 5, months: 3 }); // no date on the row: the real expiry is provisional until the first booking
    expect(render(inserted[0].payload, "TH")).toBe("📅CONFIRMED SCHEDULE:\nStudent : Student A\nProgram : VOUCHER 5 HR\n*Expiry date : 3 Months");
  });
  test("two accounts in the family ⇒ one row each (and two different send-once keys)", async () => {
    const { exec, inserted } = world({ accounts: ["U-mum", "U-dad"] });
    await notifyVoucherSold(VOUCHER, exec);
    expect(inserted.map((r) => r.recipientLineUserId)).toEqual(["U-mum", "U-dad"]);
    expect(new Set(inserted.map((r) => r.idempotencyKey)).size).toBe(2);
  });
  test("no linked family (no parent / no account) ⇒ NOTHING is sent", async () => {
    for (const w of [world({ parentId: null }), world({ accounts: [] })]) {
      await notifyVoucherSold(VOUCHER, w.exec);
      expect(w.inserted).toEqual([]);
    }
  });
  test("🔑 the sale never fails because the message did: a dead outbox resolves, it does not throw", async () => {
    const { exec } = world({ failInsert: true });
    await expect(notifyVoucherSold(VOUCHER, exec)).resolves.toBeUndefined();
  });
});

describe("🔴 TASK-730 — only a SALE sends (by source)", () => {
  const S = readFileSync(resolve(import.meta.dir, "../services/scheduler.service.ts"), "utf8").replace(/\r\n/g, "\n");
  const region = (from: string, to: string) => S.slice(S.indexOf(from), S.indexOf(to, S.indexOf(from) + from.length));
  test("`createVoucher` calls the notifier exactly once, after the transaction; `importVoucher` never does; nobody else does", () => {
    expect((S.match(/notifyVoucherSold\(/g) ?? []).length).toBe(1);
    const create = region("export async function createVoucher(", "// ───────────────────────── Overbooking a leave slot");
    expect(create).toContain("await notifyVoucherSold(result.voucher);");
    expect(create.indexOf("db.transaction(")).toBeLessThan(create.indexOf("await notifyVoucherSold("));
    expect(create.indexOf("await notifyVoucherSold(")).toBeLessThan(create.indexOf("void recordSale("));
    expect(region("export async function importVoucher(", "\n}\n")).not.toContain("notifyVoucherSold");
  });
});
