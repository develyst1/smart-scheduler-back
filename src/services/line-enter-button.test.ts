// TASK-248 / DEF-9 (REQ-079) — `เข้าใช้ระบบ` asks for a phone number and something is listening.
//
// The owner, on a real phone: tap `เข้าใช้ระบบ` → *"กรุณาพิมพ์เบอร์โทรที่ลงทะเบียนไว้ค่ะ…"* → types
// `0900000092` → **silence** → types `สมัคร` → the flow works normally. The handler replied and returned: no
// step, no `pendingRole`, so the phone arrived at a chat with no conversation in progress and was treated as
// idle text.
//
// 🔴 **The reason it shipped is the reason this file exists.** `line-menus-flows.test.ts` asserted the copy
// three times — that the service mentions the key, that the Thai says `เบอร์โทร`, that it says `แอดมิน` — and
// never asked whether the answer went anywhere. **The button was dead and the tests were green.** (@Sober: *a
// source assertion must test what the code DOES — and where it cannot, it must not be mistaken for the test
// that does.*) So the assertions below are labelled: **BEHAVIOUR** ones run the real decision function;
// **WIRING** ones read the source and are honestly only that.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { decideMessageRoute, isSessionExpired, HANDOVER_AT, shouldHandOver } from "../lib/line-routing";
import { t } from "../lib/line-i18n";

const SVC = readSrc(await Bun.file(new URL("./line-webhook.service.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const CODE = code(SVC);
const POSTBACK = CODE.slice(CODE.indexOf("const { action, params } = parsePostback(data)"));
const ENTER = POSTBACK.slice(POSTBACK.indexOf('if (action === "enter")'), POSTBACK.indexOf('if (action === "lang")'));

describe("🔴 BEHAVIOUR — the state the button leaves behind is the state that answers the phone", () => {
  test("a chat at `AWAIT_CODE` routes the next message into the LINKING flow, not idle chat", () => {
    // This is the defect, reduced to the one function that decides it. Before TASK-248 the button left
    // `undefined` here — and `decideMessageRoute(undefined, …)` is exactly the silence the owner met.
    expect(decideMessageRoute("AWAIT_CODE", "customer")).toBe("linking");
    expect(decideMessageRoute("AWAIT_CODE", null)).toBe("linking");
  });

  test("🔑 …and with NO step it is silence — the bug, stated as the contrast", () => {
    // An unknown follower is exactly who taps this button, and `silence` is what their typed phone met.
    expect(decideMessageRoute(undefined, null)).toBe("silence");
    expect(decideMessageRoute(undefined, "customer")).toBe("linked"); // not the flow either
  });

  test("the flow still wins over already-linked routing (TASK-046), so a linked chat can use it too", () => {
    expect(decideMessageRoute("AWAIT_CODE", "customer")).toBe("linking");
    expect(decideMessageRoute("AWAIT_CODE", "teacher")).toBe("linking");
  });

  test("a wrong phone is on the two-strikes rule — the button's own promise of a person", () => {
    // The copy says "if you have never registered, contact an admin". A teacher (or anyone) failing here gets
    // exactly that, by the shipped AC-18 path rather than a bespoke one.
    expect(HANDOVER_AT).toBe(2);
    expect(shouldHandOver(1)).toBe(false);
    expect(shouldHandOver(2)).toBe(true);
    expect(t("handover_to_admin", "TH")).toContain("แอดมิน");
  });

  test("an abandoned tap does not own the chat forever — the TTL still applies", () => {
    // The one cost of setting a step from a button: someone taps, wanders off, and the row is live. TASK-231's
    // inactivity window closes it, and `สมัคร` restarts from any state regardless.
    expect(isSessionExpired(new Date(Date.now() - 31 * 60_000))).toBe(true);
    expect(isSessionExpired(new Date(Date.now() - 60_000))).toBe(false);
  });
});

describe("WIRING — the two ends of that chain, read from the source", () => {
  test("🔴 the button SETS the step before it replies", () => {
    expect(ENTER).toContain('await setStep(lineUserId, "AWAIT_CODE", "customer")');
    expect(ENTER.indexOf("setStep")).toBeLessThan(ENTER.indexOf("textReply"));
    expect(ENTER).toContain('t("enter_ask_phone", lang)');
  });

  test("🚫 it does NOT build a second phone flow", () => {
    // `AWAIT_CODE` + customer already is "type your phone and get linked". A parallel path would be a second
    // place for the same rules to drift — the argument that keeps `isSessionExpired` ignorant of the mute.
    expect(ENTER).not.toContain("verifyAndLink");
    expect(ENTER).not.toContain("findParentByPhone");
    expect(ENTER).not.toContain("normalizePhone");
    expect(CODE.match(/session\.step === "AWAIT_CODE"/g)).toHaveLength(1); // one branch answers the phone
  });

  test("the typed phone reaches `verifyAndLink`, and a failure strikes", () => {
    const branch = CODE.slice(CODE.indexOf('if (session.step === "AWAIT_CODE" && session.pendingRole)'));
    expect(branch.slice(0, 600)).toContain("const res = await verifyAndLink(lineUserId, role, text, lang)");
    expect(branch.slice(0, 600)).toContain("if (!res.ok) return strikeOrPrompt(");
  });

  test("⚠️ the step is set AFTER the un-mute, which since TASK-246 clears the flow", () => {
    // Reversed, the un-mute would erase the step the button just wrote — the ordering trap `สมัคร` already had.
    expect(POSTBACK.indexOf("await unmute(lineUserId)")).toBeLessThan(POSTBACK.indexOf('if (action === "enter")'));
  });

  test("🔑 it is still dispatched BEFORE any role check", () => {
    // The unknown menu must work for someone the system does not recognise — which is everyone who taps it.
    expect(POSTBACK.indexOf('action === "enter"')).toBeLessThan(POSTBACK.indexOf("detectLinkedRole"));
  });

  test("the retired code prompt is not resurrected", () => {
    // Flow 2 was deleted in §15; this button points at the phone, and at a person only for someone who has
    // never registered.
    expect(t("enter_ask_phone", "TH")).toContain("เบอร์โทร");
    expect(t("enter_ask_phone", "EN")).toContain("phone");
    expect(CODE).not.toContain("enter_ask_admin");
  });
});
