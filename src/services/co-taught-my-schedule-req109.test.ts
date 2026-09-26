// TASK-487 — a co-taught class (T1 primary, T2 ADDITIONAL) appears for BOTH coaches through EVERY door that reads "my classes":
// the `ตารางของฉัน` reply (today AND week), the phone-calendar feed, and the Monday digest — the same row from all three. A third
// coach's class never does. The reply and the feed read through THE predicate (`ownScopeWhere`); the fake DB below answers what
// that predicate means (primary OR additional), and only when the reader actually passed it — no predicate ⇒ every row, which is
// exactly the widening a mutation must be caught for.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes";
import * as ownScope from "../lib/own-scope";
import { handleLineWebhookEvents } from "./line-webhook.service";
import { findBookingsForCalendarToken } from "./calendar.service";
import { groupWeekRows } from "../lib/weekly-digest";
import * as lineClient from "../lib/line-client";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const T1 = "t1-primary", T2 = "t2-additional", T3 = "t3-elsewhere";
const LINE: Record<string, string> = { [T1]: "U-t1", [T2]: "U-t2", [T3]: "U-t3" };
const CO_TAUGHT = { id: "b-co", date: "2026-09-25", startTime: "10:00:00", endTime: "11:00:00", status: "CONFIRMED", teacherId: T1, teacher: { lineUserId: LINE[T1] }, additionalTeachers: [{ teacherId: T2, teacher: { lineUserId: LINE[T2] } }], student: { name: "ส้ม", nickname: "ส้ม" }, coStudent: null, otherTitle: null, subject: { name: "Private FREESKATE" }, attendeeNote: null, seats: [] };
const ELSEWHERE = { ...CO_TAUGHT, id: "b-t3", startTime: "12:00:00", endTime: "13:00:00", teacherId: T3, teacher: { lineUserId: LINE[T3] }, additionalTeachers: [], student: { name: "Anya", nickname: "Anya" } };
const ALL = [CO_TAUGHT, ELSEWHERE];

/** The DB: `ownScopeWhere(me)` is recorded as a marker; `findMany` honours it (primary OR additional), and returns EVERYTHING without it. */
const world = (me: string) => {
  spies.push(spyOn(ownScope, "ownScopeWhere").mockImplementation(((id: string) => ({ scopeFor: id })) as any));
  const ops = { and: (...a: any[]) => a.flat(), gte: () => null, lte: () => null, notInArray: () => null, eq: (c: string, v: unknown) => ({ [c]: v }), asc: () => null };
  const cols = new Proxy({}, { get: (_t, k) => String(k) });
  spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async (q: any) => {
    const conds = [q.where(cols, ops)].flat(3).filter((c: any) => c && typeof c === "object");
    const scope = conds.find((c: any) => "scopeFor" in c)?.scopeFor;
    const primaryOnly = conds.find((c: any) => "teacherId" in c)?.teacherId;
    if (scope) return ALL.filter((b) => b.teacherId === scope || b.additionalTeachers.some((a) => a.teacherId === scope)); // THE predicate
    if (primaryOnly) return ALL.filter((b) => b.teacherId === primaryOnly); // the old hand-written filter
    return ALL; // no filter at all
  }) as any));
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => ({ id: me, lineUserId: LINE[me], nickname: me, lineLang: "EN", calendarToken: `tok-${me}` })) as any));
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => undefined) as any));
  // 🔴 TASK-504 — why this file used to need a real database: every tap runs `unmute(lineUserId)` first (a conditional UPDATE of the
  // chat's session row, only while muted) and `familyOfLineUser` reads `family_line_links`. These chats have NO session and NO family
  // link, so the honest fakes are EMPTY tables (shared: `test-support/line-dispatch-fakes`); the real functions still run.
  unmuteWrites = fakeDispatchBoundary(spies).unmutes;
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  const replies: any[] = [];
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
  setSystemTime(new Date("2026-09-25T09:00:00+07:00")); // Friday
  return replies;
};
/** What the dispatcher wrote (the un-mute's rendered WHERE), per test. */
let unmuteWrites: Array<{ sql: string; params: unknown[] }> = [];
const tap = (me: string, data: string) => ({ type: "postback", replyToken: "rt", source: { userId: LINE[me] }, postback: { data } }) as any;
const CO_LINES = "@ 10:00 / ส้ม\n　FREESKATE / Confirmed";

describe("🔴 the ADDITIONAL teacher sees the co-taught class — from every door", () => {
  test("`ตารางของฉัน` TODAY", async () => {
    const replies = world(T2);
    await handleLineWebhookEvents([tap(T2, "action=schedule")]);
    expect(replies[0].text).toBe(`⏱️TODAY'S SCHEDULE:\n\n▸ FRI / 25/09\n${CO_LINES}`);
    // TASK-504 — what this door also does, undeclared until now: ONE un-mute of THIS chat, only while it is muted
    expect(unmuteWrites.map((w) => [w.sql, w.params[0]])).toEqual([
      ['("line_link_sessions"."line_user_id" = $1 and "line_link_sessions"."muted_until" > $2)', LINE[T2]],
    ]);
  });
  test("`ตารางของฉัน` THIS WEEK", async () => {
    const replies = world(T2);
    await handleLineWebhookEvents([tap(T2, "action=schedule&range=week")]);
    expect(replies[0].text).toBe(`⏱️ THIS WEEK'S SCHEDULE\n\n▸ FRI / 25/09\n${CO_LINES}`);
  });
  test("the phone-calendar feed (the second reader that had the reply's answer)", async () => {
    world(T2);
    const feed = await findBookingsForCalendarToken(`tok-${T2}`);
    expect(feed!.rows.map((r: any) => r.id)).toEqual(["b-co"]);
  });
  test("the Monday digest — the SAME row, for BOTH coaches", () => {
    const groups = groupWeekRows(ALL);
    for (const t of [T1, T2]) expect({ t, ids: groups.find((g) => g.teacherId === t)!.rows.map((r) => `${r.date} ${r.startTime} ${r.name}`) }).toEqual({ t, ids: ["2026-09-25 10:00 ส้ม"] });
  });
});

describe("✅ nobody loses a row, and nobody gains another coach's class", () => {
  test("the PRIMARY teacher's view is unchanged: the same class, the same lines", async () => {
    const replies = world(T1);
    await handleLineWebhookEvents([tap(T1, "action=schedule")]);
    expect(replies[0].text).toBe(`⏱️TODAY'S SCHEDULE:\n\n▸ FRI / 25/09\n${CO_LINES}`);
  });
  test("🔴 a third coach's class never appears for T2 — on the reply or the feed", async () => {
    const replies = world(T2);
    await handleLineWebhookEvents([tap(T2, "action=schedule")]);
    expect(replies[0].text).not.toContain("Anya");
    expect((await findBookingsForCalendarToken(`tok-${T2}`))!.rows.map((r: any) => r.id)).not.toContain("b-t3");
  });
  test("📌 a co-taught row carries nothing that implies sole ownership: the teacher format names no teacher at all", async () => {
    const replies = world(T2);
    await handleLineWebhookEvents([tap(T2, "action=schedule")]);
    expect(replies[0].text).not.toMatch(/Teacher|ครู|t1-primary/);
  });
});
