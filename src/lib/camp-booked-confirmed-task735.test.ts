// 🔻 TASK-735 (D2, Khwan's row 46; 📋 DRAFT — Q3: the `Program` wording) — the FAMILY's camp «CONFIRMED SCHEDULE»: sent when days are booked, again when they change, again on a cancel (Khwan Q6 "ส่งใหม่ค่ะ").
// Her layout, ONE text for both languages:  Student / Program / Date (first - last) / Time (the FIXED hours of the half, a COLON) / Remark (only when there is one).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { notifyCampBooked } from "./camp-booked-notice";

const render = (payload: any, lang: "TH" | "EN" = "EN") => formatOutboxMessage(payload, {}, lang, "parent");
const P = { kind: "camp_booked_parent", studentName: "Student A", program: "Camp — full day, full week", dates: ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"], half: "FULL" };

describe("🔴 TASK-735 — the message, by value (her row 46)", () => {
  test("ALL DAY, a full week: her layout, the first - last range, 10:00-15:00 (a COLON); one text for both languages", () => {
    const text = "📅CONFIRMED SCHEDULE:\nStudent : Student A\nProgram : Camp — full day, full week\nDate : 12-10-2026 - 16-10-2026\nTime : 10:00-15:00";
    expect(render(P, "EN")).toBe(text);
    expect(render(P, "TH")).toBe(text);
  });
  test("MORNING 10:00-12:00 · AFTERNOON 13:00-15:00 (the fixed hours of the half)", () => {
    expect(render({ ...P, half: "AM" }).split("\n").at(-1)).toBe("Time : 10:00-12:00");
    expect(render({ ...P, half: "PM" }).split("\n").at(-1)).toBe("Time : 13:00-15:00");
    expect(render(P)).not.toMatch(/\d{2}\.\d{2}/); // never her dot
  });
  test("a single day prints just that date; the dates are ordered whatever order they arrive in", () => {
    expect(render({ ...P, dates: ["2026-10-14"] })).toContain("\nDate : 14-10-2026\n");
    expect(render({ ...P, dates: ["2026-10-16", "2026-10-12", "2026-10-14"] })).toContain("\nDate : 12-10-2026 - 16-10-2026\n");
  });
  test("Remark = the package's note, only when it has one (omit-when-empty); no ISO date leaks", () => {
    expect(render({ ...P, note: "bring a lunch box" }).split("\n").at(-1)).toBe("Remark : bring a lunch box");
    for (const note of [undefined, null, "", "  "]) expect(render({ ...P, note })).not.toContain("Remark");
    expect(render(P)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

/** A fake executor: the package + its student, the PLANNED days, the household's accounts, the outbox. */
function world(o: { days?: Array<{ date: string; half: string; campWeekId: string }>; note?: string | null; accounts?: string[]; failInsert?: boolean; noStudent?: boolean } = {}) {
  const inserted: any[] = [];
  const accounts = o.accounts ?? ["U-parent"];
  const days = o.days ?? [{ date: "2026-10-12", half: "FULL", campWeekId: "w1" }, { date: "2026-10-13", half: "FULL", campWeekId: "w1" }];
  const exec: any = {
    query: {
      campPackages: { findFirst: async () => (o.noStudent ? { id: "pk-1", studentId: "s-1", kind: "FULL", plan: "FULL_WEEK", note: o.note ?? null, student: null } : { id: "pk-1", studentId: "s-1", kind: "FULL", plan: "FULL_WEEK", note: o.note ?? null, student: { id: "s-1", name: "Student A Full", nickname: "Student A" } }) },
      campDays: { findMany: async () => days },
      students: { findMany: async () => [{ id: "s-1", parentId: accounts.length ? "p-1" : null }] },
      parents: { findMany: async () => (accounts.length ? [{ id: "p-1", lineUserId: accounts[0] }] : []) },
    },
    select: () => ({ from: () => ({ where: async () => accounts.slice(1).map((u) => ({ parentId: "p-1", lineUserId: u })) }) }),
    insert: () => ({ values: async (v: any) => { if (o.failInsert) throw new Error("outbox down"); inserted.push(v); } }),
  };
  return { exec, inserted };
}

describe("🔴 TASK-735 — who is told, how often (by value, no database)", () => {
  test("a booking ⇒ ONE message per account, with the package's SALE NAME, the ONE name rule (nickname first) and the dates", async () => {
    const { exec, inserted } = world();
    await notifyCampBooked({ packageId: "pk-1", weekId: "w1" }, exec);
    expect(inserted.length).toBe(1);
    expect(inserted[0]).toMatchObject({ recipientType: "parent", recipientLineUserId: "U-parent", status: "PENDING" });
    expect(inserted[0].payload).toEqual({ kind: "camp_booked_parent", studentName: "Student A", program: "Camp — full day, full week", dates: ["2026-10-12", "2026-10-13"], half: "FULL" });
  });
  test("two accounts in the household ⇒ one each", async () => {
    const { exec, inserted } = world({ accounts: ["U-mum", "U-dad"] });
    await notifyCampBooked({ packageId: "pk-1" }, exec);
    expect(inserted.map((r) => r.recipientLineUserId)).toEqual(["U-mum", "U-dad"]);
  });
  test("the SAME booked days are never sent twice (same key); a CHANGED set (a day added or cancelled) is a new key ⇒ it is re-sent", async () => {
    const a = world(), b = world(), c = world({ days: [{ date: "2026-10-12", half: "FULL", campWeekId: "w1" }] });
    await notifyCampBooked({ packageId: "pk-1" }, a.exec);
    await notifyCampBooked({ packageId: "pk-1" }, b.exec);
    await notifyCampBooked({ packageId: "pk-1" }, c.exec);
    expect(a.inserted[0].idempotencyKey).toBe(b.inserted[0].idempotencyKey); // same state ⇒ the outbox drops the duplicate
    expect(c.inserted[0].idempotencyKey).not.toBe(a.inserted[0].idempotencyKey); // a cancelled day ⇒ the message is sent again, reflecting what is left
    expect(c.inserted[0].payload.dates).toEqual(["2026-10-12"]);
  });
  test("two halves in one week ⇒ one message per half, each with its own hours", async () => {
    const { exec, inserted } = world({ days: [{ date: "2026-10-12", half: "AM", campWeekId: "w1" }, { date: "2026-10-13", half: "PM", campWeekId: "w1" }] });
    await notifyCampBooked({ packageId: "pk-1" }, exec);
    expect(inserted.map((r) => r.payload.half)).toEqual(["AM", "PM"]);
    expect(inserted.map((r) => render(r.payload).split("\n").at(-1))).toEqual(["Time : 10:00-12:00", "Time : 13:00-15:00"]);
  });
  test("the package's note rides the payload only when it has one", async () => {
    const withNote = world({ note: "bring a lunch box" });
    await notifyCampBooked({ packageId: "pk-1" }, withNote.exec);
    expect(withNote.inserted[0].payload.note).toBe("bring a lunch box");
    const bare = world();
    await notifyCampBooked({ packageId: "pk-1" }, bare.exec);
    expect("note" in bare.inserted[0].payload).toBe(false);
  });
  test("nothing planned and NO cancel given · no linked family · no student ⇒ NOTHING is sent", async () => {
    for (const w of [world({ days: [] }), world({ accounts: [] }), world({ noStudent: true })]) {
      await notifyCampBooked({ packageId: "pk-1" }, w.exec);
      expect(w.inserted).toEqual([]);
    }
    const noFamily = world({ days: [], accounts: [] });
    await notifyCampBooked({ packageId: "pk-1", cancelled: { date: "2026-10-14", half: "AM" } }, noFamily.exec);
    expect(noFamily.inserted).toEqual([]); // a cancel with nobody to tell sends nothing either
  });
  test("🔁 the LAST planned day cancelled (granted (b)): her layout under the APPROVED cancel title, for the day that went — in the chat's language; and it is its own send-once key", async () => {
    const { exec, inserted } = world({ days: [] });
    await notifyCampBooked({ packageId: "pk-1", weekId: "w1", cancelled: { date: "2026-10-14", half: "PM" } }, exec);
    expect(inserted.length).toBe(1);
    expect(inserted[0].payload).toEqual({ kind: "camp_booked_parent", studentName: "Student A", program: "Camp — full day, full week", dates: ["2026-10-14"], half: "PM", cancelled: true });
    expect(inserted[0].idempotencyKey).toStartWith("camp-cancelled:pk-1:");
    expect(render(inserted[0].payload, "EN")).toBe("❌ CLASS CANCELLED:\nStudent : Student A\nProgram : Camp — full day, full week\nDate : 14-10-2026\nTime : 13:00-15:00");
    expect(render(inserted[0].payload, "TH")).toBe("❌ ยกเลิกคาบเรียน:\nStudent : Student A\nProgram : Camp — full day, full week\nDate : 14-10-2026\nTime : 13:00-15:00");
  });
  test("a cancel while days REMAIN is the ordinary «what is left» CONFIRMED SCHEDULE (no cancel title)", async () => {
    const { exec, inserted } = world();
    await notifyCampBooked({ packageId: "pk-1", weekId: "w1", cancelled: { date: "2026-10-14", half: "FULL" } }, exec);
    expect(inserted.length).toBe(1);
    expect("cancelled" in inserted[0].payload).toBe(false);
    expect(render(inserted[0].payload, "EN").split("\n")[0]).toBe("📅CONFIRMED SCHEDULE:");
  });
  test("🔑 the booking never fails because the message did: a dead outbox resolves", async () => {
    await expect(notifyCampBooked({ packageId: "pk-1" }, world({ failInsert: true }).exec)).resolves.toBeUndefined();
  });
  test("by source: it reads only PLANNED days (a cancelled or attended day is not 'booked')", () => {
    const src = readFileSync(resolve(import.meta.dir, "camp-booked-notice.ts"), "utf8");
    expect((src.match(/eq\(x\.status, "PLANNED"\)/g) ?? []).length).toBe(2); // both branches: the week-scoped read and the whole-package read
  });
});

describe("🔴 TASK-735 — the three emit sites in `camp.service.ts` (granted), by source", () => {
  const S = readFileSync(resolve(import.meta.dir, "../services/camp.service.ts"), "utf8").replace(/\r\n/g, "\n");
  const region = (from: string, to: string) => S.slice(S.indexOf(from), S.indexOf(to, S.indexOf(from) + from.length));
  test("BOOKED — `createPackage` tells the family AFTER the tx, only when days were planned", () => {
    const fn = region("export async function createPackage(", "// ───────────── days");
    expect(fn).toContain("if (input.firstWeek) await notifyCampBooked({ packageId: result.id, weekId: input.firstWeek.weekId });");
    expect(fn.indexOf("db.transaction(")).toBeLessThan(fn.indexOf("await notifyCampBooked("));
  });
  test("CHANGED — `redeemDays` tells the family AFTER its tx", () => {
    const fn = region("export async function redeemDays(", "/**\n * Mark a day");
    expect(fn).toContain("await notifyCampBooked({ packageId, weekId: input.weekId });");
    expect(fn.indexOf("db.transaction(")).toBeLessThan(fn.indexOf("await notifyCampBooked("));
  });
  test("CANCELLED — `markDay` tells the family only for a CANCEL, after its tx, with the cancelled day", () => {
    const fn = region("export async function markDay(", "// ───────────── the check-in QR");
    expect(fn).toContain('if (status === "CANCELLED") await notifyCampBooked({ packageId, weekId: marked.weekId, cancelled: { date: marked.date, half: marked.half } });');
    expect(fn.indexOf("db.transaction(")).toBeLessThan(fn.indexOf("await notifyCampBooked("));
  });
  test("exactly THREE call sites in the service (nothing else — an attend / absent / undo sends nothing)", () => {
    expect((S.match(/notifyCampBooked\(/g) ?? []).length).toBe(3);
  });
});
