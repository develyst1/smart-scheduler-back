// 🔻 TASK-888 (REQ-120 R1.5) - the pay-slip confirm reminder, to the agreed contract (BB lists, SB sends). DB-less: fake deps. No LINE call is made by any test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { formatOutboxMessage } from "../lib/line-message";
import { isLastDayOfMonth, lastDayOfMonth, reminderKey, reminderPayload, renderPayConfirmReminder } from "../lib/pay-confirm-reminder";
import { internalJobs } from "../routes/internal";
import { runPayConfirmNow, runPayConfirmReminder, sendSalaryRemind, type RemindDeps, type Unconfirmed } from "./pay-confirm-reminder.service";

const A = "aaaaaaaa-1111-4111-8111-111111111111"; // has a LINE id
const B = "bbbbbbbb-2222-4222-8222-222222222222"; // no LINE id
const C = "cccccccc-3333-4333-8333-333333333333"; // has a LINE id
const SYS = "dddddddd-4444-4444-8444-444444444444"; // system / archived / unknown: absent from the read
const PERIOD = "99999999-9999-4999-8999-999999999999";

function fake(o: { token?: boolean; allowed?: boolean; date?: string; time?: string; instant?: string; list?: Unconfirmed | "throw" } = {}) {
  const calls = { oaAllowed: 0, readLineIds: 0, fetchUnconfirmed: [] as string[], enqueue: [] as { teacherId: string; key: string; payload: any }[] };
  const keys = new Set<string>();
  const deps: RemindDeps = {
    lineConfigured: () => o.token ?? true,
    oaAllowed: async () => {
      calls.oaAllowed++;
      return o.allowed ?? true;
    },
    now: () => ({ date: o.date ?? "2026-10-31", time: o.time ?? "09:00", instant: new Date(o.instant ?? "2026-10-31T02:00:00Z") }),
    readLineIds: async (ids) => {
      calls.readLineIds++;
      const all = new Map<string, string | null>([[A, "Uaaa"], [B, null], [C, "Uccc"]]);
      return new Map(ids.filter((i) => all.has(i)).map((i) => [i, all.get(i)!]));
    },
    enqueue: async (e) => {
      if (keys.has(e.key)) return "duplicate";
      keys.add(e.key);
      calls.enqueue.push({ teacherId: e.teacherId, key: e.key, payload: e.payload });
      return "queued";
    },
    fetchUnconfirmed: async (d) => {
      calls.fetchUnconfirmed.push(d);
      if (o.list === "throw") throw new Error("down");
      return o.list ?? { periodId: PERIOD, lockAt: "2026-10-31T05:00:00Z", teacherIds: [A, B, C] };
    },
  };
  return { deps, calls };
}

describe("pure rules", () => {
  test("last day of month: month ends, leap February, December", () => {
    expect(isLastDayOfMonth("2026-10-31")).toBe(true);
    expect(isLastDayOfMonth("2026-10-30")).toBe(false);
    expect(isLastDayOfMonth("2026-02-28")).toBe(true);
    expect(isLastDayOfMonth("2028-02-28")).toBe(false);
    expect(isLastDayOfMonth("2028-02-29")).toBe(true);
    expect(isLastDayOfMonth("2026-12-31")).toBe(true);
    expect(lastDayOfMonth("2026-11-08")).toBe("2026-11-30");
    expect(() => lastDayOfMonth("2026-13-01")).toThrow();
  });
  test("keys: scheduled = per period+person+reason; now = per 5-minute Bangkok bucket", () => {
    expect(reminderKey("P", A, "0900", "2026-10-31", "09:00")).toBe(`payconfirm:P:${A}:0900`);
    expect(reminderKey("P", A, "1100", "2026-10-31", "11:00")).toBe(`payconfirm:P:${A}:1100`);
    expect(reminderKey("P", A, "now", "2026-10-31", "10:03")).toBe(reminderKey("P", A, "now", "2026-10-31", "10:04"));
    expect(reminderKey("P", A, "now", "2026-10-31", "10:05")).not.toBe(reminderKey("P", A, "now", "2026-10-31", "10:04"));
  });
  test("the text: the deadline date + 12:00 + hours left per reason; TH and EN; NEVER a pay figure", () => {
    for (const reason of ["0900", "1100", "now"] as const) {
      for (const lang of ["TH", "EN"] as const) {
        const t = renderPayConfirmReminder(reminderPayload(reason, "2026-10-31"), lang);
        expect(t).toContain("12:00");
        expect(t).toContain("31/10/2026");
        expect(t).not.toMatch(/฿|baht|บาท|\d{1,3}(,\d{3})+|\d+\.\d{2}/i);
      }
    }
    expect(renderPayConfirmReminder(reminderPayload("0900", "2026-10-31"), "TH")).toContain("ยืนยันสลิปเงินเดือนก่อน 12:00 ของ 31/10/2026");
    expect(renderPayConfirmReminder(reminderPayload("0900", "2026-10-31"), "TH")).toContain("3 ชั่วโมง");
    expect(renderPayConfirmReminder(reminderPayload("1100", "2026-10-31"), "EN")).toContain("1 hour left");
  });
  test("the outbox renderer knows the kind (the worker prints it, not a fallback)", () => {
    expect(formatOutboxMessage(reminderPayload("1100", "2026-10-31") as any, {}, "TH", "teacher")).toContain("ยืนยันสลิป");
    expect(formatOutboxMessage(reminderPayload("1100", "2026-10-31") as any, {}, "EN", "teacher")).toContain("confirm your pay slip");
  });
});

describe("THE SENDER (POST /internal/salary-remind)", () => {
  test("sent / skipped: a coach with no LINE id, and a system / archived / unknown id, are NO_LINE_ID - never an error", async () => {
    const { deps, calls } = fake();
    const r = await sendSalaryRemind({ teacherIds: [A, B, C, SYS], reason: "0900", periodId: PERIOD }, deps);
    expect(r).toEqual({ sent: [A, C], skipped: [{ teacherId: B, reason: "NO_LINE_ID" }, { teacherId: SYS, reason: "NO_LINE_ID" }] });
    expect(calls.enqueue[0]!.payload).toEqual({ kind: "pay_confirm_reminder", reason: "0900", confirmDate: "2026-10-31" });
  });
  test("🔒 no LINE token => every id NO_TOKEN, and nothing is read, asked or queued", async () => {
    const { deps, calls } = fake({ token: false });
    const r = await sendSalaryRemind({ teacherIds: [A, B], reason: "now" }, deps);
    expect(r).toEqual({ sent: [], skipped: [{ teacherId: A, reason: "NO_TOKEN" }, { teacherId: B, reason: "NO_TOKEN" }] });
    expect(calls.oaAllowed + calls.readLineIds + calls.enqueue.length).toBe(0);
  });
  test("🔒 the OA is not on LINE_OA_WRITE_ALLOW => every id OA_NOT_ALLOWED, nothing read or queued", async () => {
    const { deps, calls } = fake({ allowed: false });
    const r = await sendSalaryRemind({ teacherIds: [A, C], reason: "1100" }, deps);
    expect(r.sent).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["OA_NOT_ALLOWED", "OA_NOT_ALLOWED"]);
    expect(calls.readLineIds + calls.enqueue.length).toBe(0);
  });
  test("idempotent per (period, teacher, reason): a repeat is ALREADY_SENT, not a second message; another reason is a separate send", async () => {
    const { deps, calls } = fake();
    await sendSalaryRemind({ teacherIds: [A, C], reason: "0900", periodId: PERIOD }, deps);
    const again = await sendSalaryRemind({ teacherIds: [A, C], reason: "0900", periodId: PERIOD }, deps);
    expect(again).toEqual({ sent: [], skipped: [{ teacherId: A, reason: "ALREADY_SENT" }, { teacherId: C, reason: "ALREADY_SENT" }] });
    expect((await sendSalaryRemind({ teacherIds: [A, C], reason: "1100", periodId: PERIOD }, deps)).sent).toEqual([A, C]);
    expect(calls.enqueue.length).toBe(4);
  });
  test("remind now: any day; a double-click inside the same 5 minutes is one send; the date in the text is that month's last day", async () => {
    const { deps, calls } = fake({ date: "2026-10-20", time: "10:03", instant: "2026-10-20T03:03:00Z" });
    expect((await sendSalaryRemind({ teacherIds: [A], reason: "now", periodId: PERIOD }, deps)).sent).toEqual([A]);
    expect((await sendSalaryRemind({ teacherIds: [A], reason: "now", periodId: PERIOD }, deps)).skipped).toEqual([{ teacherId: A, reason: "ALREADY_SENT" }]);
    expect(calls.enqueue[0]!.payload.confirmDate).toBe("2026-10-31");
  });
  test("a duplicate id in the request is one person", async () => {
    const { deps, calls } = fake();
    await sendSalaryRemind({ teacherIds: [A, A, A], reason: "0900" }, deps);
    expect(calls.enqueue.length).toBe(1);
  });
});

describe("the 09:00 / 11:00 job (asks BB, then the sender in-process)", () => {
  test("on the last day it fetches BB's list for TODAY and sends with reason = the slot", async () => {
    const { deps, calls } = fake();
    const r = await runPayConfirmReminder("0900", undefined, deps);
    expect(calls.fetchUnconfirmed).toEqual(["2026-10-31"]);
    expect(r).toEqual({ ran: true, periodId: PERIOD, targets: 3, sent: [A, C], skipped: [{ teacherId: B, reason: "NO_LINE_ID" }] });
    expect(calls.enqueue.map((e) => e.payload.reason)).toEqual(["0900", "0900"]);
  });
  test("a re-tick sends nothing new; 11:00 is its own send", async () => {
    const { deps } = fake();
    await runPayConfirmReminder("0900", undefined, deps);
    const again = await runPayConfirmReminder("0900", undefined, deps);
    expect(again).toMatchObject({ ran: true, sent: [] });
    expect((again as any).skipped.map((s: any) => s.reason).sort()).toEqual(["ALREADY_SENT", "ALREADY_SENT", "NO_LINE_ID"]);
    expect(await runPayConfirmReminder("1100", undefined, deps)).toMatchObject({ ran: true, sent: [A, C] });
  });
  test("🔒 no token: it does not even call BB", async () => {
    const { deps, calls } = fake({ token: false });
    expect(await runPayConfirmReminder("0900", undefined, deps)).toEqual({ ran: false, reason: "no-channel-token" });
    expect(calls.fetchUnconfirmed.length + calls.enqueue.length).toBe(0);
  });
  test("not the last day => nothing, no call to BB", async () => {
    const { deps, calls } = fake({ date: "2026-10-30" });
    expect(await runPayConfirmReminder("1100", undefined, deps)).toEqual({ ran: false, reason: "not-confirm-day" });
    expect(calls.fetchUnconfirmed.length).toBe(0);
  });
  test("no period / at or after lock time / BB down => nothing is sent, and BB-down is reported, not thrown", async () => {
    expect(await runPayConfirmReminder("0900", undefined, fake({ list: { periodId: null } }).deps)).toEqual({ ran: false, reason: "no-period" });
    const late = fake({ instant: "2026-10-31T05:00:00Z" });
    expect(await runPayConfirmReminder("1100", undefined, late.deps)).toEqual({ ran: false, reason: "after-lock-time" });
    expect(late.calls.enqueue.length).toBe(0);
    const down = fake({ list: "throw" });
    expect(await runPayConfirmReminder("0900", undefined, down.deps)).toEqual({ ran: false, reason: "backoffice-unavailable" });
    expect(down.calls.enqueue.length).toBe(0);
  });
});

describe("remind now (POST /internal/salary-remind-now { periodId })", () => {
  test("any day: fetches BB's list for TODAY, sends reason=now only when it is the period asked for", async () => {
    const { deps, calls } = fake({ date: "2026-10-20", time: "10:03", instant: "2026-10-20T03:03:00Z" });
    const r = await runPayConfirmNow(PERIOD, deps);
    expect(calls.fetchUnconfirmed).toEqual(["2026-10-20"]);
    expect(r).toEqual({ ran: true, periodId: PERIOD, targets: 3, sent: [A, C], skipped: [{ teacherId: B, reason: "NO_LINE_ID" }] });
    expect(calls.enqueue.map((e) => e.payload.reason)).toEqual(["now", "now"]);
    expect(calls.enqueue[0]!.payload.confirmDate).toBe("2026-10-31");
  });
  test("a double-click inside 5 minutes is one send", async () => {
    const { deps } = fake({ date: "2026-10-20", time: "10:03", instant: "2026-10-20T03:03:00Z" });
    await runPayConfirmNow(PERIOD, deps);
    const again = await runPayConfirmNow(PERIOD, deps);
    expect(again).toMatchObject({ ran: true, sent: [] });
  });
  test("a different period than the list belongs to => period-mismatch, nothing sent", async () => {
    const { deps, calls } = fake();
    expect(await runPayConfirmNow("11111111-0000-4000-8000-000000000000", deps)).toEqual({ ran: false, reason: "period-mismatch" });
    expect(calls.enqueue.length).toBe(0);
  });
  test("🔒 no token: BB is not called; no period / after lock / BB down => nothing sent", async () => {
    const nt = fake({ token: false });
    expect(await runPayConfirmNow(PERIOD, nt.deps)).toEqual({ ran: false, reason: "no-channel-token" });
    expect(nt.calls.fetchUnconfirmed.length).toBe(0);
    expect(await runPayConfirmNow(PERIOD, fake({ list: { periodId: null } }).deps)).toEqual({ ran: false, reason: "no-period" });
    expect(await runPayConfirmNow(PERIOD, fake({ instant: "2026-10-31T05:00:00Z" }).deps)).toEqual({ ran: false, reason: "after-lock-time" });
    expect(await runPayConfirmNow(PERIOD, fake({ list: "throw" }).deps)).toEqual({ ran: false, reason: "backoffice-unavailable" });
  });
});

describe("the route and the REAL deps", () => {
  const KEYS = ["INTERNAL_JOB_SECRET", "LINE_CHANNEL_ACCESS_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;
  let fetched = 0;
  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    process.env.INTERNAL_JOB_SECRET = "s3cret-888";
    globalThis.fetch = (() => {
      fetched++;
      throw new Error("no network in this test");
    }) as any;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const app = new Hono().route("/internal", internalJobs);
  const post = (body: unknown, secret?: string) =>
    app.request("/internal/salary-remind", { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-internal-secret": secret } : {}) }, body: JSON.stringify(body) });

  test("the secret gate: none or wrong => 401; unset => 503 NOT_CONFIGURED", async () => {
    expect((await post({ teacherIds: [A], reason: "now" })).status).toBe(401);
    expect((await post({ teacherIds: [A], reason: "now" }, "wrong")).status).toBe(401);
    delete process.env.INTERNAL_JOB_SECRET;
    const r = await post({ teacherIds: [A], reason: "now" }, "s3cret-888");
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error.code).toBe("NOT_CONFIGURED");
    process.env.INTERNAL_JOB_SECRET = "s3cret-888";
  });
  test("a bad body is 400 (non-uuid id, unknown reason, too many ids)", async () => {
    expect((await post({ teacherIds: ["x"], reason: "now" }, "s3cret-888")).status).toBe(400);
    expect((await post({ teacherIds: [A], reason: "tomorrow" }, "s3cret-888")).status).toBe(400);
    expect((await post({ teacherIds: Array.from({ length: 501 }, () => A), reason: "now" }, "s3cret-888")).status).toBe(400);
  });
  test("remind-now route: 401 without the secret, 400 for a non-uuid periodId, and with the secret but no token the REAL deps do nothing (no network)", async () => {
    const hit = (body: unknown, secret?: string) => app.request("/internal/salary-remind-now", { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-internal-secret": secret } : {}) }, body: JSON.stringify(body) });
    expect((await hit({ periodId: PERIOD })).status).toBe(401);
    expect((await hit({ periodId: "nope" }, "s3cret-888")).status).toBe(400);
    expect(await runPayConfirmNow(PERIOD)).toEqual({ ran: false, reason: "no-channel-token" });
    expect(fetched).toBe(0);
  });
  test("🔒 with the secret but NO LINE token (real deps): everything is NO_TOKEN, and no database or network is touched", async () => {
    const r = await post({ teacherIds: [A, C], reason: "now" }, "s3cret-888");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sent: [], skipped: [{ teacherId: A, reason: "NO_TOKEN" }, { teacherId: C, reason: "NO_TOKEN" }] });
    expect(await runPayConfirmReminder("0900", "2026-10-31")).toEqual({ ran: false, reason: "no-channel-token" });
    expect(fetched).toBe(0);
  });
});
