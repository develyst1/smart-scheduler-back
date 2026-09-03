// SPEC-071 / TASK-231 (REQ-079 §16) — silence by default, mute, and the two-strikes handover.
//
// 🔴 This is a REGRESSION task: it TAKES SOMETHING AWAY from a running system real teachers use. The deployed
// bot answers stray text in an idle chat (`เมนู`, `yo`) while a human is about to reply, and AC-16 stops that.
//
// ⚠️ So the assertions that matter most here are the ones about what must KEEP answering. "Too loud" is a
// nuisance; **"silenced the wrong branch and nobody notices for a week"** is a parent unable to report sick
// leave, and it would look like an unrelated outage.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import {
  HANDOVER_AT,
  MUTE_MINUTES,
  decideMessageRoute,
  isMuted,
  isSessionExpired,
  muteUntilFrom,
  SESSION_IDLE_MINUTES,
  shouldHandOver,
} from "../lib/line-routing";
import { t } from "../lib/line-i18n";
import { CMD_REGISTER } from "../lib/line-commands";

const SVC = readSrc(await Bun.file(new URL("./line-webhook.service.ts", import.meta.url)).text());
const body = (decl: string) => {
  const rest = SVC.slice(SVC.indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const PARENT_CMD = body("async function handleParentCommand");
const HANDLE = body("async function handleMessage");
const STRIKE = body("async function strikeOrPrompt");

describe("🔴 AC-16 — an idle chat gets NO reply", () => {
  test("an unlinked chat with no session is SILENCE, not `welcome`", () => {
    expect(decideMessageRoute(undefined, null)).toBe("silence");
  });

  test("all five silenced fallbacks are `return`s, and each is marked at the site", () => {
    // Enumerated deliberately: the task asks which paths changed, and a reader six months from now needs to
    // find them without reconstructing this reasoning. The fifth was found while checking the other four —
    // a session row whose `step` is none we use still answered `welcome` to anything.
    expect(SVC.match(/SILENCED FALLBACK #/g)).toHaveLength(5);
    // #1 parent catch-all — was `return doMenu(replyToken, lang)`, the loudest of the five.
    expect(PARENT_CMD).not.toMatch(/\n  return doMenu\(replyToken, lang\);\n\}/);
    expect(PARENT_CMD).toContain("SILENCED FALLBACK #1");
    // #4 the unlinked welcome — the one §16's screenshot is actually about.
    expect(HANDLE).toContain('if (route === "silence") return;');
    expect(HANDLE).not.toContain('return reply(replyToken, t("welcome", lang))');
  });

  test("🚫 the FOLLOW greeting is NOT silenced — that is someone knocking, not stray text", () => {
    // Adding the OA is the one moment the bot is certainly not talking over a human, and it is how a new
    // parent learns that `สมัคร` is the way in. Silencing it would leave them an empty chat.
    const follow = body("async function handleFollow");
    expect(follow).toContain('t("welcome", lang)');
  });
});

describe("🔴 what must KEEP answering — the branch this could silence by mistake", () => {
  test("every recognised PARENT command still replies — `ลา` and `เช็คอิน` above all", () => {
    // A parent reporting sick leave by typing `ลา` is a shipped, load-bearing flow (REQ-046/049). Silencing it
    // would be the exact failure this task warns about, on the two things a family uses most.
    for (const kept of ["doLeave(", "doCheckin(", "doQr(", "doChildren(", "doMenu(replyToken, lang)"]) {
      expect(PARENT_CMD).toContain(kept);
    }
    // …including the numbered forms, which are how the pickers are answered.
    expect(PARENT_CMD).toContain("doLeaveBooking(");
    expect(PARENT_CMD).toContain("doCheckinBooking(");
  });

  test("the teacher keyword fallbacks (REQ-015 / REQ-017) still reply", () => {
    expect(HANDLE).toContain("doTeacherSchedule(");
    expect(HANDLE).toContain("doTeacherCalendar(");
    expect(HANDLE).toContain('t("teacher_linked_menu", lang)');
  });

  test("`สมัคร` still works from ANY state — it is the only way in", () => {
    expect(HANDLE).toContain("inList(CMD_REGISTER, lower)"); // TASK-245 — the same words, now from ONE list
    // …and it is checked BEFORE the session/route is even read, so silence cannot swallow it.
    expect(HANDLE.indexOf("CMD_REGISTER")).toBeLessThan(HANDLE.indexOf("decideMessageRoute"));
    expect([...CMD_REGISTER]).toContain("สมัคร");
  });

  test("the in-flow steps still own their message (AC-19)", () => {
    expect(decideMessageRoute("CHOOSE_ROLE", null)).toBe("linking");
    expect(decideMessageRoute("AWAIT_CODE", "customer")).toBe("linking");
    expect(decideMessageRoute("AWAIT_STUDENT_NAME", null)).toBe("add-student");
  });
});

describe("🔴 AC-17 — mute silences ONE chat, not the bot", () => {
  test("a future `muted_until` beats every other rule, including an in-progress flow", () => {
    const future = new Date(Date.now() + 60_000);
    expect(decideMessageRoute("AWAIT_CODE", "customer", { mutedUntil: future })).toBe("muted");
    expect(decideMessageRoute("AWAIT_STUDENT_NAME", null, { mutedUntil: future })).toBe("muted");
  });

  test("🔑 the bot still works normally in every OTHER chat — mute is per-session state", () => {
    // The real requirement, and the one a single-conversation test would miss entirely: muting chat A must not
    // change chat B. It cannot, because the flag lives on the session ROW, and this asserts that shape.
    const future = new Date(Date.now() + 60_000);
    expect(decideMessageRoute("AWAIT_CODE", "customer", { mutedUntil: future })).toBe("muted");
    expect(decideMessageRoute("AWAIT_CODE", "customer", { mutedUntil: null })).toBe("linking");
    expect(decideMessageRoute(undefined, "customer", {})).toBe("linked");
  });

  test("a PAST mute is over — the bot comes back on its own", () => {
    expect(isMuted(new Date(Date.now() - 1000))).toBe(false);
    expect(isMuted(null)).toBe(false);
    expect(isMuted(undefined)).toBe(false);
    expect(decideMessageRoute(undefined, "customer", { mutedUntil: new Date(Date.now() - 1) })).toBe("linked");
  });

  test("it accepts the string a DB row actually returns, not just a Date", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isMuted(future)).toBe(true);
    // …and garbage never silences the bot forever.
    expect(isMuted("not-a-date")).toBe(false);
  });

  test("a muted chat's session is NOT cleared — a person is mid-conversation with them", () => {
    expect(HANDLE).toContain('if (route === "muted") return;');
    const mutedBranch = HANDLE.slice(HANDLE.indexOf('route === "muted"'), HANDLE.indexOf("add-student"));
    expect(mutedBranch).not.toContain("clearSession");
  });
});

describe("🔴 AC-18 — two strikes, then a human", () => {
  test("the boundary is exactly two: one is still trying, two hands over", () => {
    expect(HANDOVER_AT).toBe(2);
    expect(shouldHandOver(1)).toBe(false);
    expect(shouldHandOver(2)).toBe(true);
    // Never a third: a parent must not be trapped in a loop with a machine while a person is in the chat.
    expect(shouldHandOver(3)).toBe(true);
  });

  test("the handover apologises and names a human — in both languages", () => {
    expect(t("handover_to_admin", "TH")).toContain("แอดมิน");
    expect(t("handover_to_admin", "EN")).toContain("admin");
  });

  test("handing over MUTES, so the bot does not talk over the person it just called", () => {
    expect(STRIKE).toContain("mutedUntil: muteUntilFrom()");
    expect(MUTE_MINUTES).toBe(60);
    const until = muteUntilFrom(new Date("2026-09-02T10:00:00Z"));
    expect(until.toISOString()).toBe("2026-09-02T11:00:00.000Z");
  });

  test("⚠️ it RESETS on success — a counter that only increments locks a chat in June for a typo in March", () => {
    expect(SVC).toContain("async function resetStrikes");
    expect(SVC.match(/await resetStrikes\(lineUserId\)/g)!.length).toBeGreaterThanOrEqual(2);
    // …and the handover itself resets, so a returning parent starts clean rather than one strike from silence.
    expect(STRIKE).toContain("unexpectedCount: 0, mutedUntil:");
  });

  test("it is wired to the branches that can FAIL recognisably, and says which", () => {
    // CHOOSE_ROLE (unparseable role) · AWAIT_CODE (verification failed — the exact branch §16's screenshot
    // came from) · and, since TASK-232, AWAIT_2FA (wrong code). Free-text steps like a student's name have no
    // "unrecognised" to detect, so they are deliberately not wired.
    //
    // 🔑 That the 2FA step reuses THIS rule is the point: a wrong code is an unrecognised in-flow reply like
    // any other, so it did not get a bespoke lockout. One handover rule, not two that drift.
    // TASK-233 added the fourth: an unrecognised answer at the summary/confirm step. Same reasoning again —
    // it is an unrecognised in-flow reply, so it gets the one handover rule rather than a bespoke retry loop.
    //
    // 🔴 TASK-245 added the fifth and sixth, and corrected the sentence above: **a REJECTION is an unexpected
    // reply too.** "Free-text steps have no unrecognised to detect" was true of a name the bot accepts — it was
    // never true of a birthdate the bot refuses, and that gap is where the owner got stuck. The name step joins
    // them because it can now reject: a reserved word.
    expect(SVC.match(/strikeOrPrompt\(/g)!.length).toBe(7); // the declaration + six call sites
    expect(SVC).toContain("t(\"role_prompt\", lang), lang)");
    expect(SVC).toContain("res.message, lang)");
    expect(SVC).toContain('t("twofa_bad", lang), lang)');
    expect(SVC).toContain('t("add_summary_confirm", lang), lang)');
    expect(SVC).toContain('t("add_name_reserved", lang, { word: name })');
    expect(SVC).toContain('t("add_birthdate_bad", lang)');
  });

  test("🔴 the counter it uses is `unexpected_count`, and the CODE lockout is not resurrected", () => {
    expect(STRIKE).toContain("unexpectedCount");
    for (const dead of ["code_attempts", "codeAttempts", "code_locked_until", "codeLockedUntil"]) {
      expect(SVC).not.toContain(dead);
    }
  });
});

// ═══ 🔴 TASK-231 REOPENED — the session TTL, which is what §16 ACTUALLY reported ═══
//
// The screenshot was never the idle-chat fallbacks. Both strings come from `AWAIT_CODE`, and sessions never
// expired — so an abandoned `สมัคร` left that chat treating **every message it ever sent** as a code attempt,
// permanently. Silencing the fallbacks does not touch it; this does.
describe("🔴 a stale session stops owning the chat", () => {
  const minutes = (n: number) => new Date(Date.now() - n * 60_000);

  test("the window is 30 minutes of INACTIVITY", () => {
    expect(SESSION_IDLE_MINUTES).toBe(30);
    expect(isSessionExpired(minutes(29))).toBe(false);
    expect(isSessionExpired(minutes(31))).toBe(true);
  });

  test("🔑 a moving conversation is never dropped — this is inactivity, not age", () => {
    // The failure this ordering prevents: a parent typing slowly, or retrying a code, losing their flow
    // mid-registration. `updated_at` moves with them, so the window restarts on every message they send.
    const started = new Date("2026-09-02T10:00:00Z");
    const now = new Date("2026-09-02T12:00:00Z"); // two hours after the flow BEGAN
    const lastMessage = new Date("2026-09-02T11:50:00Z"); // …but ten minutes since they last spoke
    expect(isSessionExpired(started, now)).toBe(true);
    expect(isSessionExpired(lastMessage, now)).toBe(false);
  });

  test("⚠️ the trap: every inbound message a session HANDLES refreshes the row", () => {
    // Only `setStep` used to write it, so a parent retrying inside one step would not have touched it at all —
    // and a 30-minute window would then have run against someone who *is* actively replying.
    expect(SVC).toContain("async function touchSession");
    expect(HANDLE).toContain('if (route === "add-student" || route === "linking") await touchSession(lineUserId)');
    // …and it happens BEFORE any branch below can return.
    expect(HANDLE.indexOf("touchSession")).toBeLessThan(HANDLE.indexOf('route === "add-student"') + 200);
  });

  test("🚫 a `linked` or `silence` route does NOT refresh — it is not a session conversation", () => {
    // Otherwise stray text would keep a dead row alive forever, which is the bug wearing a different hat.
    const touchLine = HANDLE.slice(HANDLE.indexOf("await touchSession"), HANDLE.indexOf("await touchSession") + 120);
    expect(touchLine).not.toContain("linked");
    expect(touchLine).not.toContain("silence");
  });

  test("the TTL is applied at the SOURCE, so every reader gets the same answer", () => {
    // Not in the router: the router is one caller. The same one-definition principle as `SLOT_INACTIVE_STATUSES`.
    const getSession = body("async function getSession");
    expect(getSession).toContain("isSessionExpired(row.updatedAt) ? undefined : row");
  });

  test("nothing is DELETED — an expired row stays for the record, it just stops being authoritative", () => {
    const getSession = body("async function getSession");
    expect(getSession).not.toContain("delete");
  });

  test("an undated or unparseable row is treated as EXPIRED, not as fresh", () => {
    // A row we cannot date is a row we cannot trust to be someone's live conversation, and guessing "fresh" is
    // the failure that lasts forever.
    expect(isSessionExpired(null)).toBe(true);
    expect(isSessionExpired(undefined)).toBe(true);
    expect(isSessionExpired("not-a-date")).toBe(true);
  });

  test("it accepts the string a DB row actually returns", () => {
    expect(isSessionExpired(new Date(Date.now() - 60_000).toISOString())).toBe(false);
  });

  test("🔑 and the way back in is unchanged: `สมัคร` restarts from any state", () => {
    // The cost of expiring is one word retyped — which is why 30 minutes is safe rather than destructive.
    expect(HANDLE).toContain("inList(CMD_REGISTER, lower)"); // TASK-245 — the same words, now from ONE list
  });
});

describe("AC-21 — the outbound paths are untouched", () => {
  test("this task changed no push: the schedule, confirms and the 08:15 job are elsewhere", () => {
    // Every change is in the INBOUND webhook handler and the pure router. `runDailyReminderJob`,
    // `confirmBooking` and `confirmCourse` live in other files and are not imported here for sending.
    expect(SVC).not.toContain("runDailyReminderJob");
    expect(SVC).not.toContain("enqueueLine");
  });
});
