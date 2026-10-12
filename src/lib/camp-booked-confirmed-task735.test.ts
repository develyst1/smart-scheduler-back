// 🔻 TASK-735 (D2, Khwan's row 46; 📋 DRAFT — Q3: the `Program` wording) — the FAMILY's camp «CONFIRMED SCHEDULE»: sent when days are booked, again when they change, again on a cancel (Khwan Q6 "ส่งใหม่ค่ะ").
// Her layout, ONE text for both languages:  Student / Program / Date (first - last) / Time (the FIXED hours of the half, a COLON) / Remark (only when there is one).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { notifyCampBooked } from "./camp-booked-notice";

const dialect = new PgDialect();

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

type Day = { date: string; half: string; campWeekId: string };
const D = (date: string, half = "FULL", campWeekId = "w1"): Day => ({ date, half, campWeekId });

/**
 * A STATEFUL fake executor: the package + its student, the PLANNED days (mutable: `w.days` is what a test books and cancels), the household's accounts, and a real OUTBOX that
 * (1) refuses a repeated idempotency key exactly as the unique index does (a 23505 the `enqueueLine` swallows), and (2) answers the notifier's "last camp message to this recipient" read.
 */
function world(o: { days?: Day[]; note?: string | null; accounts?: string[]; failInsert?: boolean; noStudent?: boolean } = {}) {
  const outbox: any[] = []; // every row that LANDED, in order, with an id
  const keys = new Set<string>();
  const accounts = o.accounts ?? ["U-parent"];
  const w = { days: o.days ?? [D("2026-10-12"), D("2026-10-13")], outbox };
  let n = 0;
  const lastOf = (recipient: string) => [...outbox].reverse().find((r) => r.recipientLineUserId === recipient && String(r.idempotencyKey ?? "").startsWith("camp"));
  const exec: any = {
    query: {
      campPackages: { findFirst: async () => (o.noStudent ? { id: "pk-1", studentId: "s-1", kind: "FULL", plan: "FULL_WEEK", note: o.note ?? null, student: null } : { id: "pk-1", studentId: "s-1", kind: "FULL", plan: "FULL_WEEK", note: o.note ?? null, student: { id: "s-1", name: "Student A Full", nickname: "Student A" } }) },
      campDays: { findMany: async () => w.days },
      students: { findMany: async () => [{ id: "s-1", parentId: accounts.length ? "p-1" : null }] },
      parents: { findMany: async () => (accounts.length ? [{ id: "p-1", lineUserId: accounts[0] }] : []) },
    },
    // `select().from(table).where(...)`: the household's extra links (awaited directly) AND the notifier's `…where().orderBy().limit(1)` read of the last camp message
    select: () => ({
      from: (table: any) => {
        const isOutbox = getTableName(table) === "notification_outbox";
        return {
          where: (cond: any) => {
            if (!isOutbox) return Promise.resolve(accounts.slice(1).map((u) => ({ parentId: "p-1", lineUserId: u })));
            const recipient = dialect.sqlToQuery(cond).params[0] as string; // `recipient_line_user_id = $1 AND idempotency_key LIKE $2`
            const p = Promise.resolve([]) as any;
            p.orderBy = () => ({ limit: async () => { const r = lastOf(recipient); return r ? [{ id: r.id, payload: r.payload }] : []; } });
            return p;
          },
        };
      },
    }),
    insert: () => ({
      values: async (v: any) => {
        if (o.failInsert) throw new Error("outbox down");
        if (v.idempotencyKey && keys.has(v.idempotencyKey)) throw Object.assign(new Error("duplicate key"), { code: "23505" });
        if (v.idempotencyKey) keys.add(v.idempotencyKey);
        outbox.push({ ...v, id: `o${++n}` });
      },
    }),
  };
  return { exec, inserted: outbox, w, outbox };
}

const notify = (wd: ReturnType<typeof world>, input: Parameters<typeof notifyCampBooked>[0], _accounts?: string[]) => notifyCampBooked(input, wd.exec);

describe("🔴 TASK-735 — who is told, how often (by value, no database)", () => {
  test("a booking ⇒ ONE message per account, with the package's SALE NAME, the ONE name rule (nickname first) and the dates", async () => {
    const wd = world();
    await notify(wd, { packageId: "pk-1", weekId: "w1" }, ["U-parent"]);
    expect(wd.inserted.length).toBe(1);
    expect(wd.inserted[0]).toMatchObject({ recipientType: "parent", recipientLineUserId: "U-parent", status: "PENDING" });
    expect(wd.inserted[0].payload).toMatchObject({ kind: "camp_booked_parent", studentName: "Student A", program: "Camp — full day, full week", dates: ["2026-10-12", "2026-10-13"], half: "FULL" });
    expect(wd.inserted[0].idempotencyKey).toStartWith("camp:pk-1:U-parent:after:none:");
  });
  test("two accounts in the household ⇒ one each, each told ONCE", async () => {
    const wd = world({ accounts: ["U-mum", "U-dad"] });
    await notify(wd, { packageId: "pk-1" }, ["U-mum", "U-dad"]);
    expect(wd.inserted.map((r) => r.recipientLineUserId)).toEqual(["U-mum", "U-dad"]);
    await notify(wd, { packageId: "pk-1" }, ["U-mum", "U-dad"]); // the same state again
    expect(wd.inserted.length).toBe(2); // nobody is told twice
  });
  test("two halves in one week ⇒ one message per half, each with its own hours", async () => {
    const wd = world({ days: [D("2026-10-12", "AM"), D("2026-10-13", "PM")] });
    await notify(wd, { packageId: "pk-1" }, ["U-parent"]);
    expect(wd.inserted.map((r) => r.payload.half)).toEqual(["AM", "PM"]);
    expect(wd.inserted.map((r) => render(r.payload).split("\n").at(-1))).toEqual(["Time : 10:00-12:00", "Time : 13:00-15:00"]);
    await notify(wd, { packageId: "pk-1" }, ["U-parent"]); // the same two-message state, triggered again
    expect(wd.inserted.length).toBe(2);
  });
  test("the package's note rides the payload only when it has one", async () => {
    const withNote = world({ note: "bring a lunch box" });
    await notify(withNote, { packageId: "pk-1" }, ["U-parent"]);
    expect(withNote.inserted[0].payload.note).toBe("bring a lunch box");
    const bare = world();
    await notify(bare, { packageId: "pk-1" }, ["U-parent"]);
    expect("note" in bare.inserted[0].payload).toBe(false);
  });
  test("nothing planned and NO cancel given · no linked family · no student ⇒ NOTHING is sent", async () => {
    for (const w of [world({ days: [] }), world({ accounts: [] }), world({ noStudent: true })]) {
      await notify(w, { packageId: "pk-1" });
      expect(w.inserted).toEqual([]);
    }
    const noFamily = world({ days: [], accounts: [] });
    await notify(noFamily, { packageId: "pk-1", cancelled: { date: "2026-10-14", half: "AM" } }, ["U-parent"]);
    expect(noFamily.inserted).toEqual([]); // a cancel with nobody to tell sends nothing either
  });
  test("🔁 the LAST planned day cancelled (granted (b)): her layout under the APPROVED cancel title, for the day that went — in the chat's language", async () => {
    const wd = world({ days: [] });
    await notify(wd, { packageId: "pk-1", weekId: "w1", cancelled: { date: "2026-10-14", half: "PM" } }, ["U-parent"]);
    expect(wd.inserted.length).toBe(1);
    expect(wd.inserted[0].payload).toMatchObject({ kind: "camp_booked_parent", studentName: "Student A", program: "Camp — full day, full week", dates: ["2026-10-14"], half: "PM", cancelled: true });
    expect(render(wd.inserted[0].payload, "EN")).toBe("❌ CLASS CANCELLED:\nStudent : Student A\nProgram : Camp — full day, full week\nDate : 14-10-2026\nTime : 13:00-15:00");
    expect(render(wd.inserted[0].payload, "TH")).toBe("❌ ยกเลิกคาบเรียน:\nStudent : Student A\nProgram : Camp — full day, full week\nDate : 14-10-2026\nTime : 13:00-15:00");
  });
  test("a cancel while days REMAIN is the ordinary «what is left» CONFIRMED SCHEDULE (no cancel title)", async () => {
    const wd = world();
    await notify(wd, { packageId: "pk-1", weekId: "w1", cancelled: { date: "2026-10-14", half: "FULL" } }, ["U-parent"]);
    expect(wd.inserted.length).toBe(1);
    expect("cancelled" in wd.inserted[0].payload).toBe(false);
    expect(render(wd.inserted[0].payload, "EN").split("\n")[0]).toBe("📅CONFIRMED SCHEDULE:");
  });
  test("🔑 the booking never fails because the message did: a dead outbox resolves", async () => {
    await expect(notifyCampBooked({ packageId: "pk-1" }, world({ failInsert: true }).exec)).resolves.toBeUndefined();
  });
  test("by source: it reads only PLANNED days (a cancelled or attended day is not 'booked')", () => {
    const src = readFileSync(resolve(import.meta.dir, "camp-booked-notice.ts"), "utf8");
    expect((src.match(/eq\(x\.status, "PLANNED"\)/g) ?? []).length).toBe(2); // both branches: the week-scoped read and the whole-package read
  });
});

describe("🔴 TEST-099 F1 — Tanya's EXACT sequence: a RETURN to an earlier set of days is RE-SENT (compare with the LAST message, never with history)", () => {
  const dateLine = (r: any) => render(r.payload).split("\n").find((l: string) => l.startsWith("Date : "));
  test("booked 09–10 ⇒ msg 1 · added 11 ⇒ msg 2 (09–11) · cancelled 11 ⇒ msg 3 (09–10, RE-SENT) · cancelled 10 ⇒ msg 4 (09)", async () => {
    const wd = world({ days: [D("2026-10-09"), D("2026-10-10")] });
    const go = async (cancelled?: { date: string; half: string }) => notify(wd, { packageId: "pk-1", weekId: "w1", ...(cancelled ? { cancelled } : {}) }, ["U-parent"]);
    await go(); // 1. booked 09–10
    wd.w.days = [D("2026-10-09"), D("2026-10-10"), D("2026-10-11")];
    await go(); // 2. added 11
    wd.w.days = [D("2026-10-09"), D("2026-10-10")];
    await go({ date: "2026-10-11", half: "FULL" }); // 3. cancelled 11 — back to the state of message 1
    wd.w.days = [D("2026-10-09")];
    await go({ date: "2026-10-10", half: "FULL" }); // 4. cancelled 10
    expect(wd.inserted.map(dateLine)).toEqual(["Date : 09-10-2026 - 10-10-2026", "Date : 09-10-2026 - 11-10-2026", "Date : 09-10-2026 - 10-10-2026", "Date : 09-10-2026"]);
    expect(new Set(wd.inserted.map((r: any) => r.idempotencyKey)).size).toBe(4); // four distinct chained keys
  });
  test("the SAME change triggered twice (a retry, a double click) ⇒ ONE message", async () => {
    const wd = world({ days: [D("2026-10-09")] });
    await notify(wd, { packageId: "pk-1", weekId: "w1" }, ["U-parent"]);
    wd.w.days = [D("2026-10-09"), D("2026-10-10")];
    await notify(wd, { packageId: "pk-1", weekId: "w1" }, ["U-parent"]);
    await notify(wd, { packageId: "pk-1", weekId: "w1" }, ["U-parent"]); // identical predecessor + state
    expect(wd.inserted.length).toBe(2);
  });
  test("two recipients each follow their OWN chain: both told on a change, neither twice", async () => {
    const wd = world({ days: [D("2026-10-09")], accounts: ["U-mum", "U-dad"] });
    const accts = ["U-mum", "U-dad"];
    await notify(wd, { packageId: "pk-1", weekId: "w1" }, accts);
    wd.w.days = [D("2026-10-09"), D("2026-10-10")];
    await notify(wd, { packageId: "pk-1", weekId: "w1" }, accts);
    wd.w.days = [D("2026-10-09")];
    await notify(wd, { packageId: "pk-1", weekId: "w1", cancelled: { date: "2026-10-10", half: "FULL" } }, accts); // back to the first state
    const byWho = (u: string) => wd.inserted.filter((r: any) => r.recipientLineUserId === u).map(dateLine);
    expect(byWho("U-mum")).toEqual(["Date : 09-10-2026", "Date : 09-10-2026 - 10-10-2026", "Date : 09-10-2026"]);
    expect(byWho("U-dad")).toEqual(["Date : 09-10-2026", "Date : 09-10-2026 - 10-10-2026", "Date : 09-10-2026"]);
  });
  test("by source: the key is CHAINED on the last message (`after:{lastId}`) and the last message is read newest-first", () => {
    const src = readFileSync(resolve(import.meta.dir, "camp-booked-notice.ts"), "utf8");
    expect(src).toContain("`camp:${input.packageId}:${lineUserId}:after:${last?.id ?? \"none\"}:${batch}:${key}`");
    expect(src).toContain(".orderBy(desc(notificationOutbox.createdAt))");
    expect(src).toContain(".limit(1)");
    expect(src).toContain("=== batch) continue;");
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
