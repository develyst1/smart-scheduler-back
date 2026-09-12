// TASK-346 (`REQ-079 §17g`) — the guard: KEEP THE CHECK, DROP THE SEND.
//
// 🔴 The owner's commit `baa6015` commented out ONE line to remove ONE behaviour (the unsolicited `welcome`)
// and lost TWO: that line was also the GUARD keeping an unlinked user out of the customer postback switch.
// ⇒ an unregistered parent tapping `เช็คอิน` fell through to `doCheckin` and was told *"you have no classes"*.
//
// 🔑 ***A line that does two jobs cannot be commented out to remove one of them*** — and the person who did it
// could not have known, because nothing said so. **This file says so, twice, one assertion per job.**
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { t } from "../lib/line-i18n";
import { CMD_REGISTER } from "../lib/line-commands";

const SVC = readSrc(await Bun.file(new URL("./line-webhook.service.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const CODE = code(SVC);
const fn = (decl: string) => {
  const at = CODE.indexOf(decl);
  const rest = CODE.slice(at);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const POSTBACK = fn("async function handlePostback");
const DISPATCH = fn("export async function handleLineWebhookEvents");
const GUARD = 'if (linked !== "customer") return send(replyToken, [textReply(tb("welcome"), lang)]);';

describe("🔴 TASK-346 — JOB ONE: the guard GATES. An unlinked tap never reaches the customer switch.", () => {
  test("🔑 the guard is PRESENT, LIVE (not a comment), and sits BETWEEN the teacher branch and the switch", () => {
    // ⚠️ `code()` strips comments, so `baa6015`'s commented-out line does NOT satisfy this — which is exactly
    // the assertion that was missing when he made the edit.
    expect(POSTBACK).toContain(GUARD);
    expect(POSTBACK.indexOf(GUARD)).toBeGreaterThan(POSTBACK.indexOf('if (linked === "teacher")'));
    expect(POSTBACK.indexOf(GUARD)).toBeLessThan(POSTBACK.indexOf("switch (action)"));
    // …and the suspended-household check (TASK-048) is still BELOW it: an unlinked user is refused before
    // anyone asks whether their household is suspended.
    expect(POSTBACK.indexOf(GUARD)).toBeLessThan(POSTBACK.indexOf("isSuspendedLineParent(lineUserId)"));
  });

  test("🔴 …so `doCheckin` / `doChildren` are reachable ONLY past the guard — the landing he verified is closed", () => {
    // 🔑 Asserted as a REGION: every customer action lives after the guard, none before it. This is what makes
    // *"told you have no classes instead of please register"* impossible rather than merely untested.
    const before = POSTBACK.slice(0, POSTBACK.indexOf(GUARD));
    for (const landing of ["doCheckin(", "doCheckinBooking(", "doChildren(", "doLeave", "doMyCourse"]) {
      expect({ landing, beforeGuard: before.includes(landing) }).toEqual({ landing, beforeGuard: false });
    }
    // ✅ …and a positive over the SAME region (TASK-342's rule): the region is the right one, not an empty one.
    expect(before).toContain('if (linked === "teacher")');
    expect(before).toContain("await detectLinkedRole(lineUserId)");
  });
});

describe("✅ TASK-346 — JOB TWO: the guard REPLIES, and the reply is SOLICITED", () => {
  test("🔑 it answers with `§17c` screen 1's text — the `welcome` body — in REPLY to the tap", () => {
    // 🔑 `§17g`: *"screen 1's TEXT is unchanged — it remains the correct reply when a parent DOES need the
    // hint."* A tap the bot cannot serve is that case. **The ruling was *never UNSOLICITED*, not *never*.**
    expect(GUARD).toContain('tb("welcome")');
    expect(t("welcome", "TH")).toContain("สมัคร");
    expect(t("welcome", "TH")).toContain("register"); // bilingual in the STRING, so `tb` sends it once
  });

  test("🚫 …and NOTHING is sent on `follow` — the `§17g` half, asserted as an absence", () => {
    // ⚠️ THE OWNER'S CHANGE STAYS. `handleFollow` is not dispatched; the customer's own OA greeting is the only
    // voice a new parent hears. 📌 `code()` strips his commented-out dispatch, so this is an assertion about
    // what RUNS, not about what the file still contains.
    expect(DISPATCH).not.toContain("handleFollow(");
    expect(DISPATCH).not.toContain('"follow"');
    expect(DISPATCH).toContain('if (ev.type === "message") await handleMessage(ev);');
    expect(DISPATCH).toContain('else if (ev.type === "postback") await handlePostback(ev);');
  });

  test("⚪ `handleFollow` is DEAD BY RULING and KEPT BY DECISION — with the reason beside it", () => {
    // 🔑 Not deleted: the ruling is the CUSTOMER's and may move again. Kept so that the line that comes back is
    // the line that left, not a reconstruction. The note is asserted so the deadness cannot go unexplained.
    expect(CODE).toContain("async function handleFollow(");
    expect(SVC).toContain("DEAD BY RULING, KEPT BY DECISION");
    expect(SVC).toContain("Do NOT re-dispatch it without a task");
  });

  test("✅ the `สมัคร` / `register` KEYWORD still starts registration — the half `§17g` explicitly kept", () => {
    const HANDLE = fn("async function handleMessage");
    // The keyword is checked FIRST in `handleMessage`, from any state — before the session, before the role.
    expect(HANDLE).toContain("if (inList(CMD_REGISTER, lower))");
    expect(HANDLE.indexOf("inList(CMD_REGISTER, lower)")).toBeLessThan(HANDLE.indexOf("await getSession(lineUserId)"));
    expect(CMD_REGISTER).toContain("สมัคร");
    expect(CMD_REGISTER).toContain("register");
  });
});

describe("📌 TASK-346 — the record is IN THE CODE, because a diff against the owner's commit must show a task", () => {
  test("the comment at the guard names `baa6015`, both jobs, and what this task restored", () => {
    const at = SVC.indexOf(GUARD);
    const above = SVC.slice(at - 1400, at);
    expect(above).toContain("baa6015");
    expect(above).toContain("did TWO jobs");
    expect(above).toContain("RESTORED. Both jobs.");
    expect(above).toContain("A line that does two jobs cannot be commented out to remove one of them");
  });
});
