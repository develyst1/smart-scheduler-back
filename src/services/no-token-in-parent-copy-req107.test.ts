// TASK-479 — a parent never reads "token" / "โทเคน". The check-in link's two refusals are in the parent's terms, the LINE reply
// follows the chat's language, and 🔑 THE RULE is pinned: no human-text string in a parent-facing file mentions a token.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes"; // TASK-504 — the dispatcher's own un-mute write + family read, faked at the boundary
import { ApiException } from "../lib/http";
import { t, tb } from "../lib/line-i18n";
import * as checkinSvc from "./checkin.service";
import * as lineClient from "../lib/line-client";
import { handleLineWebhookEvents } from "./line-webhook.service";
import { campScanOutcome } from "../lib/camp";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const root = resolve(import.meta.dir, "..", "..");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });
const TODAY = "2026-09-25";
const post = (path: string, token: string) => rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));

describe("✅ the words, by value", () => {
  test("too late · bad link — both languages; the bad-link line is the check-in PAGE's own wording (one voice)", () => {
    expect([t("checkin_too_late", "TH"), t("checkin_too_late", "EN")]).toEqual(["เลยเวลาเช็คอินแล้ว", "Check-in time has passed."]);
    expect([t("checkin_bad_link", "TH"), t("checkin_bad_link", "EN")]).toEqual(["ลิงก์เช็คอินไม่ถูกต้อง", "This check-in link is not valid."]);
    const FRONT = "../smart-scheduler-front/src/lib/i18n/dictionaries.ts";
    try { expect(readFileSync(resolve(root, FRONT), "utf8")).toContain("ลิงก์เช็คอินไม่ถูกต้อง"); } catch (e: any) { if (e?.code !== "ENOENT") throw e; } // the page's words, when the sibling repo is on this box
  });
});

describe("✅ the two link pages — the parent's words, the same statuses (WHEN is TASK-474's and unchanged)", () => {
  test("`/checkin`, the link expired ⇒ 400 CHECKIN_TOO_LATE, bilingual (the web page has no chat language)", async () => {
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => ({ id: "b1", date: TODAY, startTime: "16:00:00", endTime: "17:00:00", status: "CONFIRMED", checkinToken: "token-123456", checkinTokenExpiresAt: new Date(`${TODAY}T17:00:59+07:00`), studentId: "s9", coStudentId: null, voucherId: null })) as any));
    spies.push(spyOn(db.query.students, "findFirst").mockImplementation((async () => ({ id: "s9", parentId: null })) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
    setSystemTime(new Date(`${TODAY}T17:30:00+07:00`));
    const r = await post("/checkin", "token-123456");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: { code: "CHECKIN_TOO_LATE", message: "เลยเวลาเช็คอินแล้ว\nCheck-in time has passed." } });
  });
  test("an unknown link ⇒ 404 with the page's words — on BOTH pages", async () => {
    spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.campDays, "findFirst").mockImplementation((async () => undefined) as any));
    for (const path of ["/checkin", "/checkin/camp"]) {
      const r = await post(path, "nope-123456");
      expect({ path, status: r.status, body: await r.json() }).toEqual({ path, status: 404, body: { error: { code: "NOT_FOUND", message: tb("checkin_bad_link") } } });
    }
  });
  test("camp's expired day keeps its 410 code (internal) with the parent's words", () => {
    let err: any;
    try { campScanOutcome({ status: "PLANNED", date: TODAY, checkinTokenExpiresAt: new Date(`${TODAY}T00:00:00+07:00`) }, TODAY, new Date(`${TODAY}T10:00:00+07:00`)); } catch (e) { err = e; }
    expect({ status: err.status, code: err.code, message: err.message }).toEqual({ status: 410, code: "CAMP_TOKEN_EXPIRED", message: tb("checkin_too_late") });
  });
});

describe("🔴 the LINE chat — the line Tanya saw, now in the CHAT's language", () => {
  const U = "Uaeeb9c20ca9";
  const chat = (lang: "TH" | "EN") => {
    const replies: any[] = [];
    spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => undefined) as any));
  fakeDispatchBoundary(spies); // TASK-504
    spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => ({ id: "p1", lineUserId: U, lineLang: lang, status: "active", suspendedAt: null })) as any));
    spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
    spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => ({ parentId: "p1", lineUserId: U, lineLang: lang })) as any));
    spies.push(spyOn(checkinSvc, "findTodayBookingsForParent").mockImplementation((async () => [{ id: "b1", date: TODAY, startTime: "16:00:00", endTime: "17:00:00", student: { name: "Feen" }, teacher: { nickname: "KK" }, subject: { name: "BALLET" } }]) as any));
    spies.push(spyOn(checkinSvc, "getCheckinQr").mockImplementation((async () => ({ token: "tok" })) as any));
    spies.push(spyOn(checkinSvc, "checkinByToken").mockImplementation((async () => { throw new ApiException(400, checkinSvc.CHECKIN_TOO_LATE, tb("checkin_too_late")); }) as any));
    spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
    return replies;
  };
  for (const [lang, want] of [["TH", "เลยเวลาเช็คอินแล้ว"], ["EN", "Check-in time has passed."]] as const) {
    test(`${lang} chat ⇒ "${want}" alone — no token, no other language`, async () => {
      const replies = chat(lang);
      await handleLineWebhookEvents([{ type: "postback", replyToken: "rt", source: { userId: U }, postback: { data: "action=checkin&bookingId=b1" } } as any]);
      expect(replies.map((r) => r.text)).toEqual([want]);
    });
  }
});

// ─────────── 🔑 THE RULE ───────────
/** The files whose strings a PARENT can read: the bot's words, its replies, and the public pages' services and routes. */
export const PARENT_FACING = [
  "src/lib/line-i18n.ts", "src/lib/line-reply.ts", "src/lib/liff-link.ts", "src/lib/checkin.ts", "src/lib/checkin-token.ts", "src/lib/camp.ts",
  "src/services/line-webhook.service.ts", "src/services/checkin.service.ts", "src/services/camp.service.ts",
  "src/services/shopfront-checkin.service.ts", "src/services/line-register.service.ts", "src/routes/checkin.ts", "src/routes/register.ts",
];
/** Human-text literals (Thai, or two words with a space) outside comments and log lines — identifiers, URLs and codes are not copy. */
const humanStrings = (source: string): string[] => {
  const s = source.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l) && !/console\.(log|warn|error|info)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
  const lits = [...s.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  return lits.filter((x) => /[฀-๿]/.test(x) || /[A-Za-z]{2,} [A-Za-z]{2,}/.test(x));
};
const mentionsToken = (x: string) => /token|โทเคน/i.test(x);

describe("🔑 THE RULE — no parent-facing string mentions a token", () => {
  test("every human-text string in the parent-facing files is token-free", () => {
    const hits: string[] = [];
    for (const f of PARENT_FACING) for (const x of humanStrings(readFileSync(resolve(root, f), "utf8"))) if (mentionsToken(x)) hits.push(`${f}: ${x.slice(0, 80)}`);
    expect(hits).toEqual([]);
  });
  test("the scan is not vacuous: it reads real copy, and it CATCHES a planted line (Thai and English)", () => {
    expect(humanStrings(readFileSync(resolve(root, "src/lib/line-i18n.ts"), "utf8")).length).toBeGreaterThan(200);
    expect(humanStrings(`throw notFound("โทเคนเช็คอินไม่ถูกต้อง");`).filter(mentionsToken)).toEqual(["โทเคนเช็คอินไม่ถูกต้อง"]);
    expect(humanStrings(`x = { EN: "Your token has expired" };`).filter(mentionsToken)).toEqual(["Your token has expired"]);
    // …and it does not trip on what is not copy: identifiers, URLs, a log line, a comment
    expect(humanStrings(`const u = \`/checkin?token=\${tok}\`; // the token\nconsole.warn("token gone"); checkinToken: x`).filter(mentionsToken)).toEqual([]);
  });
  test("📌 the one 'โทเคน' left in src is the STAFF login (middleware/auth.ts) — and no public route passes through it", () => {
    const IDX = readFileSync(resolve(root, "src/index.ts"), "utf8");
    expect(IDX.indexOf('app.route("/api", publicCheckin);')).toBeLessThan(IDX.indexOf('app.use("/api/*", authMiddleware);'));
    expect(PARENT_FACING).not.toContain("src/middleware/auth.ts");
  });
});
