// TASK-489 (owner ruling 3, REQ-108) — DUO: one suspended household must not turn away the OTHER family's child.
// Sober's (ii): the session check-in refuses only when EVERY household on the row is suspended. A DUO row has ONE token shared
// by both families, so the token page cannot know who is asking; the doors that CAN know (LINE, the shop front) refuse a
// suspended requester before the act. Pinned by value on all three doors, through the REAL `checkinByToken`; the DB reads are
// faked by id (the fakes run the real `where`).
// ⚠️ Named, not coded (Sober): after this, a suspended family's child EARNS the on-time CRM points when the other family checks
// the shared row in — nothing withholds points on suspension anywhere; that is the owner's rule to make, across every award site.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes"; // TASK-504 — the dispatcher's own un-mute write + family read, faked at the boundary
import * as sched from "./scheduler.service";
import * as parentSvc from "./parent.service";
import * as checkinSvc from "./checkin.service";
import * as duo from "../lib/duo-course";
import * as lineAdmin from "../lib/line-admin";
import * as lineClient from "../lib/line-client";
import { tb } from "../lib/line-i18n";
import { handleLineWebhookEvents } from "./line-webhook.service";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

const TODAY = "2026-09-25";
const TOKEN = "token-123456";
const SUSPENDED = new Date("2026-09-01T00:00:00Z");
const U = "Uduo489requester";
const idOf = (q: any) => { try { return q.where({ id: "id" }, { eq: (_c: unknown, v: string) => v }); } catch { return undefined; } };
/** s1 = family p1 (A), s2 = family p2 (B), s9 = a walk-in. `suspended` = the families that are. `asker` = the LINE account's family. */
const households = (suspended: string[], asker = "p1") => {
  const kids: Record<string, any> = {
    s1: { id: "s1", parentId: "p1", name: "Feen Full", nickname: "Feen" },
    s2: { id: "s2", parentId: "p2", name: "Pun Full", nickname: "Pun" },
    s9: { id: "s9", parentId: null, name: "Walk In", nickname: null },
  };
  const parent = (id: string) => ({ id, lineUserId: id === asker ? U : null, lineLang: "EN", status: "active", suspendedAt: suspended.includes(id) ? SUSPENDED : null });
  spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async (q: any) => kids[idOf(q)]) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async (q: any) => { const id = idOf(q); return parent(id === "p1" || id === "p2" ? id : asker); }) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  return kids;
};
/** The session row behind the token, and the act's two writes recorded (attend; CRM points per child). */
const row = (extra: Record<string, unknown> = {}) => {
  const attended: string[] = [], points: string[] = [];
  const r = { id: "b1", date: TODAY, startTime: "16:00:00", endTime: "17:00:00", status: "CONFIRMED", checkinToken: TOKEN, checkinTokenExpiresAt: new Date(`${TODAY}T17:00:59+07:00`), studentId: "s1", coStudentId: "s2", voucherId: null, ...extra };
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => r) as any));
  spies.push(spyOn(sched, "updateBookingStatus").mockImplementation((async (id: string) => { attended.push(id); return { booking: { id } }; }) as any));
  spies.push(spyOn(lineAdmin, "awardCrmPoints").mockImplementation((async (sid: string) => { points.push(sid); }) as any));
  setSystemTime(new Date(`${TODAY}T16:10:00+07:00`));
  return { r, attended, points };
};
const post = (path: string, body: unknown, ip = "10.9.0.1") =>
  rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }));
/** 🔴 "no data about either family in any refusal": the body is the one sentence — no id, no name, no booking. */
const refusedWithNothing = async (res: Response) => {
  expect(res.status).toBe(400);
  const body = (await res.json()) as any;
  expect(body.error.message).toBe(tb("suspended_notice"));
  expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
  expect(JSON.stringify(body)).not.toMatch(/b1|s1|s2|p1|p2|Feen|Pun|booking|remaining/);
};

describe("🔴 the token page `/checkin` — it cannot know who is asking, so it asks: is EVERY household on this row suspended?", () => {
  test("DUO, only B (the co-student's family) suspended ⇒ A's class is checked in", async () => {
    households(["p2"]);
    const { attended } = row();
    expect((await post("/checkin", { token: TOKEN })).status).toBe(200);
    expect(attended).toEqual(["b1"]);
  });
  test("DUO, only B suspended with B as the PRIMARY child ⇒ checked in (which seat B sits in does not matter)", async () => {
    households(["p2"]);
    const { attended } = row({ studentId: "s2", coStudentId: "s1" });
    expect((await post("/checkin", { token: TOKEN })).status).toBe(200);
    expect(attended).toEqual(["b1"]);
  });
  test("⚠️ the named consequence: both children get the on-time points, B's included (code untouched — the owner's rule)", async () => {
    households(["p2"]);
    const { points } = row();
    await post("/checkin", { token: TOKEN });
    expect(points).toEqual(["s1", "s2"]);
  });
  test("DUO, BOTH households suspended ⇒ refused with today's words, nothing about either family, NO attend", async () => {
    households(["p1", "p2"]);
    const { attended } = row();
    await refusedWithNothing(await post("/checkin", { token: TOKEN }));
    expect(attended).toEqual([]);
  });
  test("DUO, both suspended and already ATTENDED ⇒ still refused FIRST — no booking, no remaining handed back", async () => {
    households(["p1", "p2"]);
    row({ status: "ATTENDED" });
    await refusedWithNothing(await post("/checkin", { token: TOKEN }));
  });
  test("DUO, a walk-in and a suspended family ⇒ checked in (a walk-in has no household to suspend)", async () => {
    households(["p2"]);
    const { attended } = row({ studentId: "s9", coStudentId: "s2" });
    expect((await post("/checkin", { token: TOKEN })).status).toBe(200);
    expect(attended).toEqual(["b1"]);
  });
  test("🔑 the non-DUO pin: a single child whose household is suspended ⇒ refused exactly as before", async () => {
    households(["p1"]);
    const { attended } = row({ coStudentId: null });
    await refusedWithNothing(await post("/checkin", { token: TOKEN }));
    expect(attended).toEqual([]);
  });
});

describe("🔴 the LINE door — the requester IS known; a suspended requester is refused at the bot boundary, before the act", () => {
  const chat = (b: Record<string, unknown>) => {
    const replies: any[] = [];
    spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => undefined) as any));
  fakeDispatchBoundary(spies); // TASK-504
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(checkinSvc, "findTodayBookingsForParent").mockImplementation((async () => [{ date: TODAY, teacher: { nickname: "KK" }, subject: { name: "BALLET" }, ...b }]) as any));
    spies.push(spyOn(checkinSvc, "getCheckinQr").mockImplementation((async () => ({ token: TOKEN })) as any));
    spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
    return replies;
  };
  const tap = () => handleLineWebhookEvents([{ type: "postback", replyToken: "rt", source: { userId: U }, postback: { data: "action=checkin&bookingId=b1" } } as any]);
  const linkedTo = (parentId: string) => spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => ({ parentId, lineUserId: U, lineLang: "EN" })) as any));

  test("A asks, only B suspended ⇒ A's class is checked in, and A is never told an account is suspended", async () => {
    const kids = households(["p2"], "p1"); linkedTo("p1");
    const { r, attended } = row();
    const replies = chat({ ...r, student: kids.s1, coStudent: kids.s2 });
    await tap();
    expect(attended).toEqual(["b1"]);
    expect(replies.map((m) => m.text).join("\n")).not.toContain(tb("suspended_notice"));
  });
  test("B asks, B suspended ⇒ refused with today's words, NO attend (the requester's own guard — the act never runs)", async () => {
    const kids = households(["p2"], "p2"); linkedTo("p2");
    const { r, attended } = row();
    const replies = chat({ ...r, student: kids.s1, coStudent: kids.s2 });
    await tap();
    expect(attended).toEqual([]);
    expect(replies.map((m) => m.text)).toEqual([tb("suspended_notice")]);
  });
  test("🔑 the non-DUO pin through LINE: a single child, the requester's household suspended ⇒ refused, NO attend", async () => {
    const kids = households(["p1"], "p1"); linkedTo("p1");
    const { r, attended } = row({ coStudentId: null });
    const replies = chat({ ...r, student: kids.s1, coStudent: null });
    await tap();
    expect(attended).toEqual([]);
    expect(replies.map((m) => m.text)).toEqual([tb("suspended_notice")]);
  });
});

describe("🔴 the shop front — the lookup already asks about the PHONE's household; now the act underneath agrees with it", () => {
  const PHONES: Record<string, string> = { "0811111111": "p1", "0822222222": "p2" };
  const BID = "48948948-9489-4489-8489-489489489489"; // the route validates a uuid
  let ip = 0;
  const wall = (suspended: string[], coStudentId: string | null = "s2") => {
    const kids = households(suspended);
    const { r, attended } = row({ id: BID, coStudentId });
    const session = { ...r, campWeekDayId: null, student: kids.s1, coStudent: coStudentId ? kids[coStudentId] : null, teacher: { nickname: "KK" }, subject: { name: "BALLET" } };
    spies.push(spyOn(parentSvc, "findParentByPhone").mockImplementation((async (p: string) => { const id = PHONES[parentSvc.normalizePhone(p)]; return id ? { id, suspendedAt: suspended.includes(id) ? SUSPENDED : null } : null; }) as any));
    spies.push(spyOn(db.query.students, "findMany").mockImplementation((async (q: any) => {
      const pid = [q.where(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => ({ [c]: v }), isNull: (c: string) => ({ isNull: c }) })].flat(3).find((c: any) => c && "parentId" in c)?.parentId;
      return Object.values(kids).filter((k: any) => k.parentId === pid);
    }) as any));
    spies.push(spyOn(duo, "familyRowsWhere").mockImplementation(((ids: string[]) => ({ family: ids })) as any));
    spies.push(spyOn(db.query.bookings, "findMany").mockImplementation((async (q: any) => {
      const fam: string[] = [q.where(new Proxy({}, { get: (_t, k) => String(k) }), { and: (...a: any[]) => a.flat(), eq: (c: string, v: unknown) => ({ [c]: v }), isNull: (c: string) => ({ isNull: c }) })].flat(3).find((c: any) => c && "family" in c)?.family ?? [];
      return fam.includes(session.studentId) || fam.includes(session.coStudentId as string) ? [session] : [];
    }) as any));
    spies.push(spyOn(db.query.campDays, "findMany").mockImplementation((async () => []) as any));
    spies.push(spyOn(checkinSvc, "getCheckinQr").mockImplementation((async () => ({ token: TOKEN })) as any));
    return attended;
  };
  const act = (phone: string) => post("/checkin/shopfront", { phone, bookingId: BID }, `10.48.9.${++ip}`);

  test("A's phone, only B suspended ⇒ A is offered the DUO class AND the act checks it in (one door, one answer)", async () => {
    const attended = wall(["p2"]);
    const list = (await (await post("/checkin/shopfront/lookup", { phone: "0811111111" }, `10.48.8.${++ip}`)).json()) as any;
    expect(list.children.map((c: any) => c.items.map((i: any) => i.bookingId))).toEqual([[BID]]);
    expect((await act("0811111111")).status).toBe(200);
    expect(attended).toEqual([BID]);
  });
  test("B's phone, B suspended ⇒ the neutral empty list, the act is NOT_CHECKINABLE, NO attend", async () => {
    const attended = wall(["p2"]);
    expect(await (await post("/checkin/shopfront/lookup", { phone: "0822222222" }, `10.48.8.${++ip}`)).json()).toEqual({ children: [] });
    const res = await act("0822222222");
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("NOT_CHECKINABLE");
    expect(attended).toEqual([]);
  });
  test("🔑 the non-DUO pin at the wall: a single child, the phone's household suspended ⇒ NOT_CHECKINABLE, NO attend", async () => {
    const attended = wall(["p1"], null);
    const res = await act("0811111111");
    expect(res.status).toBe(409);
    expect(attended).toEqual([]);
  });
});
