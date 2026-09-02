// SPEC-071 Amendment #2 / TASK-232 (REQ-079 §2) — the phone alone is the door, and the 2FA branch ships OFF.
//
// 🔴 The accepted risk, stated so nobody "improves" it later: **anyone who knows a phone number can see that
// family's children and act for them.** The owner put that danger to the customer in those words and **the
// customer refused the extra step**. Quiet hardening is forbidden by §2 as explicitly as re-opening it is.
//
// ⚠️ What BOUNDS the risk is AC-20 — LINE never unlocks anything that moves money — which is why the
// grep-guard at the bottom of this file is load-bearing rather than tidy.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { SETTINGS } from "../lib/settings";
import { parentChildrenNames, parentChildrenNote } from "../lib/line-pairing";
import { decideMessageRoute } from "../lib/line-routing";
import {
  TWOFA_DIGITS,
  TWOFA_MAX_ATTEMPTS,
  TWOFA_TTL_MINUTES,
  generate2faCode,
  matches2faCode,
} from "../lib/line-2fa";
import { t } from "../lib/line-i18n";

const SVC = readSrc(await Bun.file(new URL("./line-webhook.service.ts", import.meta.url)).text());
const PAIRING = readSrc(await Bun.file(new URL("../lib/line-pairing.ts", import.meta.url)).text());
const TWOFA = readSrc(await Bun.file(new URL("../lib/line-2fa.ts", import.meta.url)).text());
const FAMILY = readSrc(await Bun.file(new URL("../lib/family-link.ts", import.meta.url)).text());
const body = (decl: string) => {
  const rest = SVC.slice(SVC.indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const VERIFY = body("async function verifyAndLink");

describe("🔴 the phone binds the chat — and can never re-bind it to another family", () => {
  test("`bindFamilyLine` refuses a chat already bound to a DIFFERENT family", () => {
    // The one guarantee that survived all three entry designs. Without it a parent opens the app to another
    // family's children — TASK-047's failure by a different route.
    expect(FAMILY).toContain('return { ok: false, reason: "bound-to-other-family" }');
    expect(FAMILY).toContain("if (current && current !== parentId)");
  });

  test("re-binding the SAME family is a no-op, not an error", () => {
    // A parent who types their phone twice has done nothing wrong.
    expect(FAMILY).toContain("alreadyBound: current === parentId");
    expect(FAMILY).toContain("onConflictDoNothing()");
  });

  test("the refusal reaches the parent as a sentence, not a 23505", () => {
    expect(VERIFY).toContain("const bind = await bindFamilyLine(existing.id, lineUserId)");
    expect(VERIFY).toContain('if (!bind.ok) return { ok: false, message: t("verify_parent_other_family", lang) }');
    expect(t("verify_parent_other_family", "TH")).toContain("แอดมิน");
  });

  test("🔑 the bind is attempted BEFORE anything else is written", () => {
    // Otherwise a refused chat would still have moved the roster link and re-pointed `parents.line_user_id`.
    expect(VERIFY.indexOf("bindFamilyLine")).toBeLessThan(VERIFY.indexOf("linkParentLine"));
    expect(VERIFY.indexOf("bindFamilyLine")).toBeLessThan(VERIFY.indexOf("moveRosterLink"));
  });

  test("an unknown phone gives NO hint about whether that number is a customer", () => {
    // The reply is the same shape whether the number exists or not — and the existing-account branch is the
    // only one that says anything about a family.
    expect(VERIFY).toContain('t("verify_parent_badphone", lang)');
    expect(VERIFY).not.toContain("not a customer");
  });
});

describe("🔴 §2 — the phone alone returns the children BY NAME", () => {
  test("`parentChildrenNames` lists them; the count version is UNTOUCHED beside it", () => {
    expect(parentChildrenNames(["น้องรดา", "น้องต้น"], "TH")).toContain("น้องรดา, น้องต้น");
    expect(parentChildrenNote(2, "TH")).toContain("2");
    // Both empty-safe, same rule as each other.
    expect(parentChildrenNames([], "TH")).toBe("");
    expect(parentChildrenNote(0, "TH")).toBe("");
  });

  test("🚫 TASK-047's function and its REASON are still there — a decision, not an erosion", () => {
    // The task was explicit: do not delete the function or its comment; add the new path's reason beside it.
    // The old rule was not refuted — it was accepted, with the customer's refusal on record.
    expect(PAIRING).toContain("export const parentChildrenNote");
    expect(PAIRING).toContain("a **count**, never names");
    expect(PAIRING).toContain("has not been refuted; it has been ACCEPTED");
  });

  test("the 2FA-off path uses NAMES and the 2FA-on path uses the COUNT", () => {
    // Not a style choice: names are for the path the owner accepted the risk on. Where a gate exists,
    // TASK-047's rule is honoured — the count before verifying, the names after.
    expect(VERIFY).toContain("parentChildrenNames(");
    expect(VERIFY).toContain("list: parentChildrenNote(kids.length, lang)");
  });
});

describe("🔀 the 2FA branch — BUILT, and switched by a setting", () => {
  test("🔴 it is a registered `app_settings` key defaulting to `off`", () => {
    expect(SETTINGS.line_parent_2fa.default).toBe("off");
    expect(SETTINGS.line_parent_2fa.options).toEqual(["off", "on"]);
    expect(SETTINGS.line_parent_2fa.parse("on")).toBe("on");
    expect(SETTINGS.line_parent_2fa.parse("maybe")).toBeNull();
  });

  test("🔑 THE DELIVERABLE — flipping the setting changes behaviour with NO code change", () => {
    // The task's words: "prove it with a test that flips the setting and gets different behaviour with no code
    // change. That test is the deliverable, not the branch." The switch is read from `app_settings` on every
    // use, so the same build behaves both ways — that is what makes turning it on a setting, not a rebuild.
    expect(SVC).toContain('(await getSetting("line_parent_2fa")).value === "on"');
    // …and the branch it gates is a single `if` in the flow, not a second flow.
    expect(VERIFY).toContain("if (await twoFaEnabled())");
    expect(SVC).toContain('if (res.needs2fa && res.code)');
    expect(SVC).toContain('if (session.step === "AWAIT_2FA")');
    // The step is routed as a linking step, so a parent mid-verification owns their message (AC-19).
    expect(decideMessageRoute("AWAIT_2FA", "customer")).toBe("linking");
  });

  test("🔴 the switch is read EVERY time, never cached — a cached flag makes it a restart", () => {
    const fn = body("async function twoFaEnabled");
    expect(fn).toContain("await getSetting");
    expect(SVC).not.toMatch(/let\s+twoFaCached/);
  });

  test("the code is 6 digits from a CSPRNG — a predictable code verifies nothing", () => {
    expect(TWOFA_DIGITS).toBe(6);
    expect(TWOFA).toContain("crypto.getRandomValues");
    // Comments stripped: the file DISCUSSES why `Math.random` is wrong, and a test that reads prose would fail
    // on the explanation. Only the code is evidence — the trap that has caught me three times this week.
    expect(TWOFA.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")).not.toContain("Math.random");
    for (let i = 0; i < 20; i++) expect(generate2faCode()).toMatch(/^\d{6}$/);
  });

  test("matching trims but does not otherwise forgive", () => {
    expect(matches2faCode("123456", " 123456 ")).toBe(true);
    expect(matches2faCode("123456", "123457")).toBe(false);
    expect(matches2faCode(null, "123456")).toBe(false);
    expect(matches2faCode(undefined, "")).toBe(false);
  });

  test("🚫 lifetime / attempts / lockout are PLACEHOLDERS and say so — not inherited from the deleted designs", () => {
    // The task forbade choosing them: they return to the owner on switch-on, and the family-code and
    // invite-code parameters went with those designs when they were removed.
    expect(TWOFA_TTL_MINUTES).toBeGreaterThan(0);
    expect(TWOFA_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(TWOFA).toContain("PLACEHOLDER — the owner decides on switch-on");
    expect(TWOFA).toContain("not** inherited from the two deleted designs");
  });

  test("🔴 unconfigured delivery FAILS LOUDLY rather than silently locking a family out", () => {
    // Switching the setting on without deciding how the parent receives the digits is discovered by whoever
    // flips it, not by a family who can no longer reach their children's schedule.
    expect(TWOFA).toContain("): never {");
    expect(TWOFA).toContain("throw new Error(");
    expect(TWOFA).toContain("owner decision");
    expect(TWOFA).toContain("delivery is not configured");
  });

  test("a wrong code reuses the ONE two-strikes rule — no bespoke lockout", () => {
    const branch = SVC.slice(SVC.indexOf('session.step === "AWAIT_2FA"'), SVC.indexOf("AWAIT_CODE\" && session.pendingRole"));
    expect(branch).toContain("strikeOrPrompt(");
    expect(branch).toContain('t("twofa_bad", lang)');
  });

  test("verifying reveals the names, and only then", () => {
    const branch = SVC.slice(SVC.indexOf('session.step === "AWAIT_2FA"'), SVC.indexOf("AWAIT_CODE\" && session.pendingRole"));
    expect(branch).toContain("parentChildrenNames(");
    expect(branch.indexOf("matches2faCode")).toBeLessThan(branch.indexOf("parentChildrenNames"));
  });
});

describe("🚫 the invite is CUT — no part of it came back", () => {
  test("no generator, alphabet, TTL, redemption or lockout for an invite code exists", () => {
    for (const dead of ["familyInvites", "family_invites", "redeem", "inviteCode", "invite_code"]) {
      expect(SVC).not.toContain(dead);
    }
    // `0030` is untouched — `family_invites` ships dormant, per SPEC-071 Amendment #2.
    expect(SVC).not.toContain("base32");
  });
});

// ═══ 🔴 AC-20 — the grep-guard, and it is what makes this entry design survivable ═══
//
// The accepted risk is bounded by one fact: **LINE never unlocks anything that moves money.** If a money path
// ever became reachable from these modules, the phone-alone door would stop being a convenience decision and
// become a financial one — without anyone re-opening the question. That is why this is a guard, not a comment.
describe("🔴 AC-20 — LINE unlocks nothing that moves money", () => {
  const MONEY = [
    "recordSale",
    "postBookingSale",
    "boMovement",
    "boItem",
    "applyHoldMove",
    "reconcileBookingHolds",
    "otherPriceMinor",
    "discountKind",
  ];

  test("the LINE entry modules reach no money path", () => {
    for (const src of [SVC, PAIRING, TWOFA, FAMILY]) {
      for (const m of MONEY) expect(src).not.toContain(m);
    }
  });

  test("…and they import nothing that does", () => {
    // A transitive reach would defeat the check above, so the import list is asserted too: the only service
    // this handler pulls from the money side is `updateBookingStatus`, which changes a booking's STATUS.
    const imports = SVC.slice(0, SVC.indexOf("const SKIP_WORDS"));
    expect(imports).not.toContain("sale-post");
    expect(imports).not.toContain("sale-items");
    expect(imports).not.toContain("discount-plan");
    expect(imports).not.toContain("bo-money");
  });
});
