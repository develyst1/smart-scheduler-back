// TASK-537 — a family is told when their MAKE-UP class is cancelled BY AN ADMIN, and NOT when a leave UNDO cancels it.
// 🔑 How the two are told apart: STRUCTURALLY, not by a condition. The admin's cancel (and a coach's own leave, and the OTHER-series
// cancel-all) reach the ONE family cancel sender; the leave Undo cancels the make-up in `undo.service` and calls only the COACH sender.
// Pinned: the admin direction by value through the REAL `updateBookingStatus` (the TASK-497 harness shape) · the Undo direction by the
// real `undoBooking` (booking-undo-req108.test.ts, its "never the family" assertion over an EXTENDED make-up) AND by source here ·
// the words (📖 DRAFT, by FORM) · the household rule with cancelled seats excluded · the CONFIRMED notice unchanged.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as sched from "./scheduler.service";
import * as familyLink from "../lib/family-link";
import * as ownScope from "../lib/own-scope";
import * as salePost from "../lib/sale-post";
import { formatOutboxMessage } from "../lib/line-message";
import { t } from "../lib/line-i18n";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/\r\n/g, "\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const src = (f: string) => code(readFileSync(resolve(root, f), "utf8"));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
const M1 = "m1m1m1m1-m1m1-41m1-81m1-m1m1m1m1m1m1";
const STAFF = { channel: "staff" as const, actor: "admin-dong" };

/** One booking row + a course; UPDATEs judged by their REAL rendered WHERE; every insert recorded (the outbox rows are the evidence). */
function run(row: Record<string, unknown>, replan: { appended?: string[]; rows?: any[] } = {}) { // 🔻 TASK-548 — what the re-plan RETURNS
  const w = {
    bookings: [{ id: M1, status: "EXTENDED", date: "2026-10-30", startTime: "10:00:00", teacherId: "t1", studentId: "s1", coStudentId: null, courseId: "c1", voucherId: null, bookingType: "COURSE_PACKAGE",
      note: null, plannedAtCreation: false, leaveCharged: null, checkinSource: null, checkinChannel: null, checkinActor: null, campWeekDayId: null, confirmedAt: null, ...row }],
    courses: [{ id: "c1", size: 4, usedSessions: 1, leaveUsed: 1 }],
    inserts: [] as Array<{ table: string; v: any }>,
    asked: [] as Array<Array<string | null>>,
  };
  const withRels = (r: any) => r && ({ ...r, course: w.courses.find((c) => c.id === r.courseId) ?? null, voucher: null });
  const tx: any = {
    query: { bookings: { findFirst: async () => withRels(w.bookings[0]), findMany: async () => replan.rows ?? [] } },
    update: (t: any) => ({ set: (set: Record<string, unknown>) => ({ where: (cond: any) => {
      const { sql, params } = dialect.sqlToQuery(cond);
      const conds = [...sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)].map((m) => ({ col: camel(m[2]!), val: params[Number(m[3]) - 1] }));
      const rows = getTableName(t) === "bookings" ? w.bookings : getTableName(t) === "course_packages" ? w.courses : [];
      const hits = rows.filter((r: any) => conds.every((c) => r[c.col] === c.val));
      for (const r of hits) for (const [k, v] of Object.entries(set)) if (!(v && typeof v === "object" && "queryChunks" in (v as object))) (r as any)[k] = v;
      const out = hits.map((r: any) => ({ id: r.id }));
      return Object.assign(Promise.resolve(out), { returning: async () => out });
    } }) }),
    insert: (t: any) => ({ values: async (v: any) => { w.inserts.push({ table: getTableName(t), v }); } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }), innerJoin: async () => [] }) }), // no coach rows needed here
  };
  spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(tx)) as any));
  spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async () => [{ id: "t1", lineUserId: "U-coach-t1" }, { id: "t2", lineUserId: "U-coach-t2" }]) as any));
  spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async (_e: any, ids: Array<string | null>) => { w.asked.push(ids); return ["U-mom", "U-dad"]; }) as any));
  spies.push(spyOn(sched, "reconcileCoursePlan").mockImplementation((async () => ({ appended: replan.appended ?? [], cancelled: [] })) as any));
  spies.push(spyOn(sched, "reconcileBookingHolds").mockImplementation((async () => {}) as any));
  spies.push(spyOn(sched, "loadBookingDTO").mockImplementation((async (_e: any, id: string) => ({ id })) as any));
  spies.push(spyOn(salePost, "reverseBookingSale").mockImplementation((async () => ({ posted: false })) as any));
  const coachRows = () => w.inserts.filter((i) => i.v?.recipientType === "teacher").map((i) => ({ to: i.v.recipientLineUserId, kind: i.v.payload?.kind }));
  const parentRows = () => w.inserts.filter((i) => i.v?.recipientType === "parent").map((i) => ({ to: i.v.recipientLineUserId, kind: i.v.payload?.kind }));
  return { w, parentRows, coachRows };
}

describe("🔑 an ADMIN cancels a make-up ⇒ the family IS told (the REAL status change)", () => {
  test("🔴 BOTH audiences on ONE admin cancel (Sober's ruling on finding 1): every coach of the make-up AND the family — neither without the other", async () => {
    const h = run({});
    await sched.updateBookingStatus(M1, "cancel", "coach unavailable", false, undefined, STAFF);
    expect(h.coachRows()).toEqual([{ to: "U-coach-t1", kind: "class_cancelled_teacher" }, { to: "U-coach-t2", kind: "class_cancelled_teacher" }]);
    expect(h.parentRows().map((r) => r.kind)).toEqual(["makeup_cancelled_parent", "makeup_cancelled_parent"]);
  });
  test("…and a PENDING make-up still tells NEITHER (never announced)", async () => {
    const h = run({ status: "PENDING" });
    await sched.updateBookingStatus(M1, "cancel", "x", false, undefined, STAFF);
    expect([h.coachRows(), h.parentRows()]).toEqual([[], []]);
  });
  test("EXTENDED → cancel: one `makeup_cancelled_parent` row per linked device of the child's household; nothing about why in the payload", async () => {
    const h = run({});
    await sched.updateBookingStatus(M1, "cancel", "coach unavailable", false, undefined, STAFF);
    expect(h.w.bookings[0]!.status).toBe("CANCELLED");
    expect(h.w.asked).toEqual([["s1", null]]); // the ONE household rule, the row's child
    expect(h.parentRows()).toEqual([{ to: "U-mom", kind: "makeup_cancelled_parent" }, { to: "U-dad", kind: "makeup_cancelled_parent" }]);
    const payloads = h.w.inserts.filter((i) => i.v?.recipientType === "parent").map((i) => i.v.payload);
    for (const p of payloads) expect(p).toEqual({ kind: "makeup_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4 });
  });
  test("🚫 and a CONFIRMED class cancelled the same way still gets the CONFIRMED notice — byte-identical payload (unchanged)", async () => {
    const h = run({ status: "CONFIRMED" });
    await sched.updateBookingStatus(M1, "cancel", "coach unavailable", false, undefined, STAFF);
    expect(h.parentRows().map((r) => r.kind)).toEqual(["class_cancelled_parent", "class_cancelled_parent"]);
    expect(h.w.inserts.find((i) => i.v?.recipientType === "parent")!.v.payload).toEqual({ kind: "class_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4, cancelReason: null });
  });
  test("…and a PENDING one still tells nobody (it was never announced)", async () => {
    const h = run({ status: "PENDING" });
    await sched.updateBookingStatus(M1, "cancel", "x", false, undefined, STAFF);
    expect(h.parentRows()).toEqual([]);
  });
});

describe("🚫 a leave UNDO cancels the make-up ⇒ the family is NOT told — structural, not a condition", () => {
  test("by source: the Undo cancels the make-up in `undo.service` and names only the COACH sender — no family sender, no parent kind, no parent recipient", () => {
    const U = src("src/services/undo.service.ts");
    expect(U).toContain("await sendClassCancelledToCoaches(tx, { ...(makeup as any)");
    expect(U).not.toMatch(/sendClassCancelledToFamilies|classCancelledFamilyAccounts|makeup_cancelled_parent|class_cancelled_parent|enqueueParentCopies|recipientType: "parent"/);
  });
  test("…and by behaviour: the real `undoBooking` over an EXTENDED make-up asserts no non-teacher row (booking-undo-req108.test.ts keeps that line)", () => {
    const T = readFileSync(resolve(root, "src/services/booking-undo-req108.test.ts"), "utf8");
    expect(T).toContain('expect(h.w.outbox.filter((m) => m.recipientType !== "teacher")).toEqual([]); // 🚫 never the family');
  });
});

describe("📋 the words — 📖 a DRAFT, pinned by FORM (the move notice's house pattern)", () => {
  const CTX = { studentName: "มะขิด", subject: "Freeskate", date: "2026-10-30", startTime: "10:00", endTime: "11:00", coach: "Ek" };
  const P = { kind: "makeup_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4 } as any;
  test("the title in the CHAT's language; the four English-labelled lines; no Coach, no Reason, no Note", () => {
    const th = formatOutboxMessage(P, CTX as any, "TH", "parent").split("\n");
    const en = formatOutboxMessage(P, CTX as any, "EN", "parent").split("\n");
    expect([th[0], en[0]]).toEqual([t("mc_title", "TH"), t("mc_title", "EN")]);
    expect(th.slice(1)).toEqual(["Student : มะขิด", "Program : Freeskate 4 HR", "Date : 30-10-2026", "Time : 10:00-11:00"]);
    expect(en.slice(1)).toEqual(th.slice(1)); // labels English in both
    expect([...th, ...en].join("\n")).not.toMatch(/Coach|Reason|เหตุผล|Note|ชดเชย|make-up|replac/i);
  });
  test("🔑 it promises NO replacement: the cancel notice's shape-chosen Note (\"a make-up has been added\") is not in it", () => {
    const out = formatOutboxMessage(P, CTX as any, "TH", "parent") + formatOutboxMessage(P, CTX as any, "EN", "parent");
    expect(out).not.toContain(t("cl_note_makeup", "TH"));
    expect(out).not.toContain(t("cl_note_makeup", "EN"));
  });
});

describe("the household rule — reused, cancelled seats excluded", () => {
  test("a GROUP make-up row: only LIVE seats' families are asked (a CANCELLED seat's family is not the class's family)", async () => {
    const asked: Array<Array<string | null>> = [];
    spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async (_e: any, ids: any) => { asked.push(ids); return ["U-live"]; }) as any));
    const inserted: any[] = [];
    const tx = { query: { bookings: { findMany: async () => [] } }, insert: () => ({ values: async (v: any) => { inserted.push(v); } }) };
    const seats = [{ id: "S1", studentId: "kid-live", status: "EXTENDED" }, { id: "S2", studentId: "kid-gone", status: "CANCELLED" }];
    expect(await sched.classCancelledFamilyAccounts(tx, { id: "G", status: "EXTENDED", bookingType: "GROUP", seats } as any, null)).toEqual(["U-live"]);
    expect(asked).toEqual([["kid-live"]]);
    expect(inserted.map((v) => v.payload.kind)).toEqual(["makeup_cancelled_parent"]);
  });
});

// ───────────────────────── TASK-548 — the line, ONLY from the re-plan's own append result (owner-approved rule; words a DRAFT) ─────────────────────────
describe("🔴 TASK-548 — a cancelled make-up names the new class ONLY when the re-plan actually appended one", () => {
  const CTX = { studentName: "มะขิด", subject: "Freeskate", date: "2026-10-30", startTime: "10:00", endTime: "11:00", coach: "Ek" };
  test("🔑 the re-plan APPENDED a class ⇒ its date rides the family payload, read off the row the re-plan returned; the line names it (TH / EN)", async () => {
    const h = run({}, { appended: ["n1n1"], rows: [{ date: "2026-11-13" }] });
    await sched.updateBookingStatus(M1, "cancel", "coach unavailable", false, undefined, STAFF);
    const fam = h.w.inserts.filter((i) => i.v?.recipientType === "parent").map((i) => i.v.payload);
    expect(fam.length).toBe(2);
    for (const p of fam) expect(p).toEqual({ kind: "makeup_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4, newClassDates: ["2026-11-13"] });
    const th = formatOutboxMessage(fam[0], CTX as any, "TH", "parent").split("\n");
    const en = formatOutboxMessage(fam[0], CTX as any, "EN", "parent").split("\n");
    expect(th.at(-1)).toMatch(/^Note : .*13-11-2026/); // the SHAPE (✅ FINAL words since TASK-550, by value in `approved-copy-task550.test.ts`): the appended line, the date present
    expect(en.at(-1)).toMatch(/^Note : .*13-11-2026/);
    expect([...th, ...en].join("\n")).not.toMatch(/ชดเชย|make-up|makeup|replac/i); // the "never make-up" rule still holds
    expect([th[0], en[0]]).toEqual([t("mc_title", "TH"), t("mc_title", "EN")]); // the title unchanged
  });
  test("🔑 NO append ⇒ NO line: the payload is TASK-537's, byte for byte (no field at all), and nothing is appended to the message", async () => {
    const h = run({}, { appended: [] });
    await sched.updateBookingStatus(M1, "cancel", "coach unavailable", false, undefined, STAFF);
    const p = h.w.inserts.find((i) => i.v?.recipientType === "parent")!.v.payload;
    expect(p).toEqual({ kind: "makeup_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4 });
    const th = formatOutboxMessage(p, CTX as any, "TH", "parent").split("\n");
    expect(th).toHaveLength(5); // title + Student / Program / Date / Time — nothing after
    expect(th.join("\n")).not.toContain("Note");
  });
  test("the COACH's notice is untouched by the append: no field, no line (the audience for this line is the family only)", async () => {
    const h = run({}, { appended: ["n1n1"], rows: [{ date: "2026-11-13" }] });
    await sched.updateBookingStatus(M1, "cancel", "coach unavailable", false, undefined, STAFF);
    const coach = h.w.inserts.filter((i) => i.v?.recipientType === "teacher").map((i) => i.v.payload);
    expect(coach.length).toBeGreaterThan(0);
    for (const p of coach) expect(p).not.toHaveProperty("newClassDates");
  });
  test("🔑 by source: the admin's family notice is built AFTER the re-plan (same transaction) and is handed the re-plan's OWN result", () => {
    const S = code(readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8"));
    const c = S.slice(S.indexOf('} else if (action === "cancel") {'), S.indexOf('} else if (action === "sick-leave"'));
    const replan = c.indexOf("replanned = await reconcileCoursePlan(tx, current.courseId);");
    const notice = c.indexOf("await sendClassCancelledToFamilies(tx, { ...current, seats: seatsBefore }, enumReason ?? null, replanned?.appended ?? []);");
    expect(replan).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(replan);
    expect((c.match(/await sendClassCancelledToFamilies\(/g) ?? []).length).toBe(1); // moved, not duplicated
    // …and the dates are read from the rows the re-plan returned — by id — never from "the newest EXTENDED" or a setting
    const F = S.slice(S.indexOf("export async function classCancelledFamilyAccounts("), S.indexOf("async function familyAccountsOfRow("));
    expect(F).toContain("inA(b.id, [...appended])");
  });
});
