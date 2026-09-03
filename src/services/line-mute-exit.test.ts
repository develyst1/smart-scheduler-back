// SPEC-071 / TASK-246 (REQ-079 §14 AC-23…AC-26 + DEF-8) — a mute silences the bot's INITIATIVE, never the
// parent's way OUT or back IN.
//
// 🔴 DEF-8, owner-found on `sid` the same morning TASK-245 shipped: a muted chat's **button** worked, the bot
// asked *"พิมพ์ชื่อนักเรียน… หรือพิมพ์ ยกเลิก เพื่อออก"*, the parent typed `มิลล่า` — **silence.** So the bot
// asked a question it would not answer, and **swallowed the escape it was advertising in the same sentence.**
// That is the `เมนู` contradiction from TASK-245 returning through the state machine instead of the command
// list: what the bot promises and what the bot does disagree.
//
// §14, the other half: LINE on PC has no rich menu at all, so a muted PC parent has nothing to tap and sits in
// a silence nobody explained.
//
// ⚠️ The behavioural replay (a real muted row, a real tap, a real name) needs session ROWS — Tanya's. What is
// pinned here is everything provable without a database: the vocabulary, the ORDERING, and the one un-mute.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { CMD_MENU, CMD_REOPEN, isCancelWord, isReopenWord, isReservedWord } from "../lib/line-commands";
import { decideMessageRoute, isMuted, muteUntilFrom } from "../lib/line-routing";
import { t } from "../lib/line-i18n";

const SVC = readSrc(await Bun.file(new URL("./line-webhook.service.ts", import.meta.url)).text());
const ROUTING = readSrc(await Bun.file(new URL("../lib/line-routing.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const CODE = code(SVC);
const fn = (decl: string) => {
  const rest = CODE.slice(CODE.indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const HANDLE = fn("async function handleMessage");
const POSTBACK = fn("async function handlePostback");
const MUTED_BRANCH = HANDLE.slice(HANDLE.indexOf('route === "muted"'), HANDLE.indexOf('route === "add-student"'));

describe("🔴 DEF-8 — a tap un-mutes FIRST, so a flow can only ever be entered unmuted", () => {
  test("the un-mute runs before any postback action is dispatched", () => {
    // This is what makes DEF-8 unreachable **by construction** rather than by a check: there is no state in
    // which a flow has been entered and the answer to its question is still muted.
    expect(POSTBACK).toContain("await unmute(lineUserId)");
    expect(POSTBACK.indexOf("await unmute(lineUserId)")).toBeLessThan(POSTBACK.indexOf('action === "admin"'));
    expect(POSTBACK.indexOf("await unmute(lineUserId)")).toBeLessThan(POSTBACK.indexOf("switch (action)"));
  });

  test("🚫 …and therefore NO second guard was added — one that can never fire is worse than none", () => {
    // @Porter's fallback ("a muted chat must not be able to enter a flow at all") is satisfied by the ordering
    // above. A guard beside it would be dead code the next reader has to disprove.
    expect(POSTBACK).not.toContain('route === "muted"');
    expect(POSTBACK).not.toContain("isMuted(");
  });

  test("🔑 the owner's third message is then answerable — the routing half, proven purely", () => {
    // Muted, his `มิลล่า` was route `muted` ⇒ dropped. Unmuted, the same step owns the message and replies.
    expect(decideMessageRoute("AWAIT_STUDENT_NAME", "customer", { mutedUntil: muteUntilFrom() })).toBe("muted");
    expect(decideMessageRoute("AWAIT_STUDENT_NAME", "customer", { mutedUntil: null })).toBe("add-student");
    // And the un-mute is a real clear, not a shortened mute.
    expect(isMuted(null)).toBe(false);
  });

  test("the `admin` tap still mutes — that tap is a REQUEST for silence", () => {
    // The un-mute at the top must not defeat the one button whose purpose is to bring the bot's silence about.
    const call = fn("async function doCallAdmin");
    expect(call).toContain("mutedUntil: muteUntilFrom()");
    expect(POSTBACK.indexOf("await unmute(lineUserId)")).toBeLessThan(POSTBACK.indexOf("doCallAdmin("));
  });
});

describe("🔴 `ยกเลิก` is honoured while muted — and the gate is not in front of it", () => {
  test("the ORDERING, asserted: the escape is checked before the silence returns", () => {
    // The bug in one line: a gate that swallows the escape the prompt in the same chat advertises. An ordering
    // nobody pinned is an ordering that drifts back.
    expect(MUTED_BRANCH).toContain("isCancelWord(lower)");
    expect(MUTED_BRANCH.indexOf("isCancelWord(lower)")).toBeLessThan(MUTED_BRANCH.lastIndexOf("return;"));
  });

  test("🔴 it clears the flow but LEAVES THE MUTE — two intents, two effects", () => {
    // 🔑 The mechanical trap behind that sentence: the mute lives on the session ROW, so `clearSession`'s
    // delete would un-mute as a side effect and drop the bot straight back on top of the admin who is typing.
    const exitDoor = MUTED_BRANCH.slice(
      MUTED_BRANCH.indexOf("isCancelWord(lower)"),
      MUTED_BRANCH.indexOf("isReopenWord(lower)"),
    );
    expect(exitDoor).toContain("clearFlowKeepMute(lineUserId)");
    expect(exitDoor).not.toContain("clearSession(");
    expect(exitDoor).not.toContain("unmute(lineUserId)"); // ← the whole point: getting out is not getting back in
    const clear = fn("async function clearFlowKeepMute");
    expect(clear).not.toContain("mutedUntil");
    expect(clear).not.toContain("delete(");
    // …and the draft is nulled explicitly, since the row that used to carry it away now survives. Both writers
    // spell "no flow in progress" with the SAME constant, so it cannot come to mean two sets of columns.
    expect(clear).toContain("...FLOW_CLEARED");
    expect(CODE).toContain(
      "const FLOW_CLEARED = { step: MUTED_STEP, pendingRole: null, draft: null, unexpectedCount: 0 } as const",
    );
  });

  test("it confirms in words — and does not claim a deletion that did not happen", () => {
    expect(MUTED_BRANCH).toContain('t(had ? "add_cancelled" : "cancel_nothing", lang)');
    expect(t("add_cancelled", "TH")).toContain("ลบทิ้ง");
    expect(t("cancel_nothing", "TH")).not.toContain("ลบทิ้ง");
    expect(t("cancel_nothing", "EN")).toContain("nothing in progress");
  });
});

describe("🔴 AC-23 / AC-26 — `เปิดเมนู` is the way back in, and it starts nothing", () => {
  test("it un-mutes and shows the command list", () => {
    const reopen = MUTED_BRANCH.slice(MUTED_BRANCH.indexOf("isReopenWord(lower)"));
    expect(reopen).toContain("await unmute(lineUserId)");
    expect(reopen).toContain("doMenu(replyToken, lang)");
  });

  test("🔑 AC-26 — it starts NO flow: no step, no draft, no picker", () => {
    // The reason this does not reopen Rule 2 (no keyword may start a flow out of an idle chat): it is the
    // opposite shape — a deliberate act, by someone who was just told the word, ENDING a state they are in.
    const reopen = MUTED_BRANCH.slice(MUTED_BRANCH.indexOf("isReopenWord(lower)"));
    expect(reopen).not.toContain("setStep(");
    expect(reopen).not.toContain("setDraft(");
  });

  test("`เปิดเมนู` and `เมนู` are DIFFERENT words, and only one of them re-opens", () => {
    expect(isReopenWord("เปิดเมนู")).toBe(true);
    expect(isReopenWord("  Reopen ")).toBe(true);
    // 🚫 @Porter's rule, kept: while muted, `เมนู` is deliberately ignored. If it re-opened, a parent idly
    // reaching for a familiar command would drop the bot into a live conversation with an admin. The un-mute
    // must be a thing you CHOOSE, not a thing you reach for.
    expect(isReopenWord("เมนู")).toBe(false);
    expect(isReopenWord("menu")).toBe(false);
    for (const w of CMD_REOPEN) expect([...CMD_MENU]).not.toContain(w);
  });

  test("it answers outside a mute too — a word the bot advertises means one thing everywhere", () => {
    // Told once in the mute message, it must not become an unknown word an hour later. Un-muting an unmuted
    // chat is a no-op, so this is the same act with no second behaviour (TASK-245's one-list rule).
    expect(CODE).toContain("if (inList(CMD_MENU, cmd) || inList(CMD_REOPEN, cmd)) return doMenu(replyToken, lang)");
  });

  test("…and it can never become a child's name", () => {
    expect(isReservedWord("เปิดเมนู")).toBe(true);
  });
});

describe("🔴 AC-25 — everything else stays SILENT. The owner proved this working; it must not regress", () => {
  test("plain `เมนู`, `เพิ่มนักเรียน` and free text are not exceptions", () => {
    for (const word of ["เมนู", "เพิ่มนักเรียน", "yo", "มิลล่า"]) {
      expect(isReopenWord(word)).toBe(false);
      expect(isCancelWord(word)).toBe(false);
    }
    // The branch has exactly two doors and then falls to a bare `return`; nothing else is answered in a mute.
    expect(MUTED_BRANCH.match(/return (reply|doMenu)/g)).toHaveLength(2);
    const tail = MUTED_BRANCH.slice(MUTED_BRANCH.indexOf("return doMenu"));
    expect(tail).toContain("return;");
    expect(tail.slice(tail.indexOf("return;"))).not.toContain("reply(");
  });

  test("a muted chat's session is still NOT cleared for stray text — a person is mid-conversation", () => {
    const afterDoors = MUTED_BRANCH.slice(MUTED_BRANCH.indexOf("isReopenWord(lower)"));
    expect(afterDoors).not.toContain("clearSession(");
    expect(afterDoors).not.toContain("clearFlowKeepMute(");
  });

  test("the mute still beats every other route, including an in-progress flow", () => {
    const future = muteUntilFrom();
    for (const step of ["AWAIT_CODE", "AWAIT_STUDENT_NAME", "CHOOSE_ROLE"]) {
      expect(decideMessageRoute(step, "customer", { mutedUntil: future })).toBe("muted");
    }
  });
});

describe("🔴 AC-24 — the word is TOLD, not discovered", () => {
  test("BOTH messages that mute a chat name it, in both languages", () => {
    // A way out nobody was told about is not a way out — and these two messages are the only screens a muted
    // parent is guaranteed to have read.
    for (const key of ["handover_to_admin", "admin_called"]) {
      expect(t(key, "TH")).toContain("เปิดเมนู");
      expect(t(key, "EN")).toContain("reopen");
    }
  });

  test("🔑 the word it advertises IS the word the router matches", () => {
    // The TASK-245 lesson applied to a message instead of a step: copy that names a word the code does not
    // accept is the same lie, one layer up.
    for (const key of ["handover_to_admin", "admin_called"]) {
      const th = t(key, "TH");
      expect(CMD_REOPEN.some((w) => th.includes(w))).toBe(true);
      expect(isReopenWord(th.slice(th.indexOf("เปิดเมนู"), th.indexOf("เปิดเมนู") + "เปิดเมนู".length))).toBe(true);
    }
  });
});

describe("🔄 coming back is a FRESH START — the un-mute clears the flow (Sober, from Q2)", () => {
  const UNMUTE = fn("async function unmute");

  test("🔴 it clears step, draft and strikes — at the un-mute, so all THREE doors are covered", () => {
    // The hole this closes was not `เปิดเมนู`-only: a **button** that renders a list also starts no flow, so the
    // forgotten step survived and intercepted the next message behind that door too. Fixing one door would have
    // been the half-fix shape this whole day has been about.
    expect(UNMUTE).toContain("...FLOW_CLEARED");
    expect(UNMUTE).toContain("mutedUntil: null");
  });

  test("🔑 …and it is scoped to a chat that is muted RIGHT NOW", () => {
    // "Coming back" presupposes having been away. An unmuted parent taps a rich-menu button mid-flow all the
    // time, and their half-finished registration is not ours to discard — so the predicate is the same test
    // `isMuted` applies, rather than "this row exists".
    expect(UNMUTE).toContain("gt(lineLinkSessions.mutedUntil, new Date())");
    expect(isMuted(new Date(Date.now() - 1000))).toBe(false); // an expired mute is not a mute
    expect(isMuted(muteUntilFrom())).toBe(true);
  });

  test("🔴 the `สมัคร` door un-mutes BEFORE it sets its step — reversed, it wipes what it just wrote", () => {
    // The ordering trap the flow-clear introduced: `unmute()` now clears `step`, so writing `CHOOSE_ROLE` first
    // and un-muting second would erase it and swallow the parent's "1" — the same silence, one door along.
    const register = HANDLE.slice(HANDLE.indexOf("inList(CMD_REGISTER, lower)"), HANDLE.indexOf("const session ="));
    expect(register.indexOf("await unmute(lineUserId)")).toBeLessThan(register.indexOf("await setStep("));
  });

  test("⚠️ it does NOT weaken 'the handover keeps the session' (TASK-231)", () => {
    // The handover still keeps the row so an admin can read the whole conversation; the clear happens only when
    // the parent chooses to return, after the human has had their turn.
    const strike = fn("async function strikeOrPrompt");
    expect(strike).not.toContain("clearSession");
    expect(strike).not.toContain("FLOW_CLEARED");
    expect(strike).toContain("mutedUntil: muteUntilFrom()");
  });

  test("🚫 the shorter-TTL option was NOT taken — one definition of 'is this session live'", () => {
    // Sober's call, and the reason: a TTL that depends on mute state is two definitions of one thing, which is
    // the drift this codebase keeps removing.
    expect(ROUTING).toContain("export const SESSION_IDLE_MINUTES = 30");
    const expired = ROUTING.slice(ROUTING.indexOf("export function isSessionExpired"));
    expect(expired).not.toContain("muted");
  });
});

describe("🔑 ONE un-mute — the parent must not learn two ways back depending on their device", () => {
  test("one definition, and every path goes through it", () => {
    expect(CODE.match(/async function unmute\(/g)).toHaveLength(1);
    // 🔴 The real assertion: no other writer clears the mute. Two implementations is how the typed word and the
    // button quietly diverge — and a PC parent, who has no button, would be the one who lost.
    expect(CODE.match(/mutedUntil: null/g)).toHaveLength(1);
  });

  test("its three call sites are the three deliberate ways a parent engages the bot", () => {
    // The tap (DEF-8) · `เปิดเมนู` (§14) · and `สมัคร`, which is checked above the mute gate — see Q1 in the
    // TASK file. All three are acts a parent chose; none of them is a word someone idly reaches for.
    expect(CODE.match(/await unmute\(lineUserId\)/g)).toHaveLength(3);
    const register = HANDLE.slice(0, HANDLE.indexOf("const session ="));
    expect(register).toContain("inList(CMD_REGISTER, lower)");
    expect(register).toContain("await unmute(lineUserId)");
  });
});
