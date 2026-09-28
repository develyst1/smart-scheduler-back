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
function run(row: Record<string, unknown>, replan: { appended?: string[]; rows?: any[]; coaches?: Record<string, string[]> } = {}) { // 🔻 TASK-548 — what the re-plan RETURNS
  const w = {
    bookings: [{ id: M1, status: "EXTENDED", date: "2026-10-30", startTime: "10:00:00", teacherId: "t1", studentId: "s1", coStudentId: null, courseId: "c1", voucherId: null, bookingType: "COURSE_PACKAGE",
      note: null, plannedAtCreation: false, leaveCharged: null, checkinSource: null, checkinChannel: null, checkinActor: null, campWeekDayId: null, confirmedAt: null, ...row }],
    courses: [{ id: "c1", size: 4, usedSessions: 1, leaveUsed: 1 }],
    inserts: [] as Array<{ table: string; v: any }>,
    replanAsked: [] as any[], // 🔻 TASK-552 — the opts each re-plan received
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
  // 🔻 TASK-551 — per row when a test says so (the same-slot decider compares coach SETS); else the two coaches, as before
  spies.push(spyOn(ownScope, "teachersOfBooking").mockImplementation((async (_e: any, id: string) => (replan.coaches?.[id] ?? ["t1", "t2"]).map((c) => ({ id: c, lineUserId: `U-coach-${c}` }))) as any));
  spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async (_e: any, ids: Array<string | null>) => { w.asked.push(ids); return ["U-mom", "U-dad"]; }) as any));
  spies.push(spyOn(sched, "reconcileCoursePlan").mockImplementation((async (_tx: any, _id: string, opts?: any) => { w.replanAsked.push(opts ?? null); return { appended: replan.appended ?? [], cancelled: [] }; }) as any));
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
    const replan = c.indexOf("replanned = await reconcileCoursePlan(tx, current.courseId, { reowedFor: reowedForOf(current) });");
    const notice = c.indexOf("await sendClassCancelledToFamilies(tx, { ...current, seats: seatsBefore }, enumReason ?? null, replanned?.appended ?? []);");
    expect(replan).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(replan);
    expect((c.match(/await sendClassCancelledToFamilies\(/g) ?? []).length).toBe(1); // moved, not duplicated
    // …and the dates are read from the rows the re-plan returned — by id — never from "the newest EXTENDED" or a setting
    const F = S.slice(S.indexOf("export async function classCancelledFamilyAccounts("), S.indexOf("async function familyAccountsOfRow("));
    expect(F).toContain("inA(b.id, [...appended])");
  });
});

// ───────────────────────── TASK-551 §2 — the same-slot silence (owner ruling), EXACT, ONE decider, both directions ─────────────────────────
describe("🔴 TASK-551 §2 — a cancelled make-up re-added in the SAME slot tells nobody; anything short of an exact match sends", () => {
  const SLOT = { endTime: "11:00:00" }; // the cancelled make-up M1: 2026-10-30 10:00-11:00, coaches t1 + t2 (the harness default)
  const again = (over: Record<string, unknown> = {}, coaches: string[] = ["t1", "t2"]) => ({
    appended: ["n1n1"],
    rows: [{ id: "n1n1", date: "2026-10-30", startTime: "10:00:00", endTime: "11:00:00", ...over }],
    coaches: { n1n1: coaches },
  });
  const cancel = async (replan: any) => {
    const h = run(SLOT, replan);
    const out: any = await sched.updateBookingStatus(M1, "cancel", "coach unavailable", false, undefined, STAFF);
    return { h, out };
  };
  test("🔑 SAME date + time + the SAME coach set ⇒ NOTHING to the family and NOTHING to the coaches (the admin's response reports no coach notice)", async () => {
    const { h, out } = await cancel(again());
    expect([h.parentRows(), h.coachRows()]).toEqual([[], []]);
    expect(out.notification ?? null).toBeNull();
  });
  test("🔑 same slot, a DIFFERENT coach ⇒ the family is silent, but the ORIGINAL coaches ARE told (they lost this class)", async () => {
    const { h } = await cancel(again({}, ["t9"]));
    expect(h.parentRows()).toEqual([]);
    expect(h.coachRows()).toEqual([{ to: "U-coach-t1", kind: "class_cancelled_teacher" }, { to: "U-coach-t2", kind: "class_cancelled_teacher" }]);
  });
  test("same slot, a co-teacher DROPPED (the re-plan copies only the primary) ⇒ the coaches are told", async () => {
    const { h } = await cancel(again({}, ["t1"]));
    expect(h.parentRows()).toEqual([]);
    expect(h.coachRows().length).toBe(2);
  });
  test("🔑 a DIFFERENT DATE ⇒ today's notices, byte for byte: the family with its new-class line, and the coaches", async () => {
    const { h } = await cancel(again({ date: "2026-11-06" }));
    const fam = h.w.inserts.filter((i) => i.v?.recipientType === "parent").map((i) => i.v.payload);
    expect(fam).toEqual([
      { kind: "makeup_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4, newClassDates: ["2026-11-06"] },
      { kind: "makeup_cancelled_parent", bookingId: M1, bookingType: "COURSE_PACKAGE", size: 4, newClassDates: ["2026-11-06"] },
    ]);
    expect(h.coachRows().length).toBe(2);
  });
  test("same date, a different TIME — even ONE minute (no tolerance) — ⇒ both audiences are told", async () => {
    for (const startTime of ["10:30:00", "10:01:00"]) {
      const { h } = await cancel(again({ startTime }));
      expect([h.parentRows().length, h.coachRows().length]).toEqual([2, 2]);
      for (const sp of spies.splice(0)) sp.mockRestore();
    }
    const { h } = await cancel(again({ endTime: "11:30:00" })); // the END differs ⇒ not the same slot either
    expect([h.parentRows().length, h.coachRows().length]).toEqual([2, 2]);
  });
  test("🚫 a CONFIRMED class is never suppressed by this rule (it is about a cancelled MAKE-UP) — even with a same-slot append", async () => {
    const h = run({ ...SLOT, status: "CONFIRMED" }, again());
    await sched.updateBookingStatus(M1, "cancel", "x", false, undefined, STAFF);
    expect([h.parentRows().length, h.coachRows().length]).toEqual([2, 2]);
  });
  test("the pure decider by value: exact date · start · end (`10:00:00` = `10:00`, the same time spelt twice) · the coach SET (order and repeats irrelevant)", async () => {
    const { sameSlotReplacement } = await import("../lib/same-slot");
    const c = { date: "2026-10-30", startTime: "10:00:00", endTime: "11:00:00", coachIds: ["t1", "t2"] };
    expect(sameSlotReplacement(c, [{ ...c, startTime: "10:00", endTime: "11:00", coachIds: ["t2", "t1", "t2"] }])).toEqual({ family: true, coach: true });
    expect(sameSlotReplacement(c, [{ ...c, coachIds: ["t1"] }])).toEqual({ family: true, coach: false });
    expect(sameSlotReplacement(c, [{ ...c, date: "2026-10-31" }])).toEqual({ family: false, coach: false });
    expect(sameSlotReplacement(c, [])).toEqual({ family: false, coach: false });
  });
  test("by source: ONE decider feeds BOTH audiences — the coach and the family read the same `slot`, and only a make-up asks", () => {
    const S = code(readFileSync(resolve(root, "src/services/scheduler.service.ts"), "utf8"));
    const c = S.slice(S.indexOf('} else if (action === "cancel") {'), S.indexOf('} else if (action === "sick-leave"'));
    expect(c).toContain('const slot = current.status === "EXTENDED" ? await sameSlotOfReplan(tx, current, replanned?.appended ?? []) : NOT_SAME_SLOT;');
    expect(c).toContain("notification = slot.coach ? null : await sendClassCancelledToTeacher(tx, current, {");
    expect(c).toContain("if (!slot.family) await sendClassCancelledToFamilies(");
    expect((S.match(/sameSlotReplacement\(/g) ?? []).length).toBe(1); // one call site: the service helper
  });
});

// ───────────────────────── TASK-552 (B) — the admin's cancel hands the re-plan the cancelled make-up's OWN leave ─────────────────────────
describe("🔴 TASK-552 (B) — the re-plan is ASKED to re-owe to the cancelled make-up's own written link, and only that", () => {
  test("a make-up WITH a link ⇒ the re-plan is asked with exactly that leave", async () => {
    const h = run({ extendedFromId: "L-own" });
    await sched.updateBookingStatus(M1, "cancel", "x", false, undefined, STAFF);
    expect(h.w.replanAsked).toEqual([{ reowedFor: ["L-own"] }]);
  });
  test("⚠️ a make-up with NO link (the pause case) ⇒ the re-plan is asked with NOTHING — and it is said, not invented", async () => {
    const logs: string[] = [];
    spies.push(spyOn(console, "info").mockImplementation(((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }) as any));
    const h = run({ extendedFromId: null });
    await sched.updateBookingStatus(M1, "cancel", "x", false, undefined, STAFF);
    expect(h.w.replanAsked).toEqual([{ reowedFor: [] }]);
    expect(logs.join("\n")).toContain("carries no link — its re-owe inherits NO leave (TASK-553)");
  });
});
