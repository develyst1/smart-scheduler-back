// TASK-327 — **no message can emit an un-interpolated `{placeholder}`.**
//
// 🔑 The property is TRUE today and **nothing holds it**. `t()` replaces only the vars it is HANDED —
// `if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(...)` — so a string containing
// `{student}` rendered without that key keeps the braces and **ships them to a parent's phone.**
//
// 🔴 It is true by fourteen separate acts of care, not by one mechanism. ⇒ ***the fifteenth branch is one
// forgotten `??` away from sending `{student}` to a parent, and before this file no test would have failed.***
//
// ⚠️ ONE assertion, all fourteen kinds — the same probe shape as `§16.3`'s trailing-whitespace test, and for
// the same reason: fourteen per-message pins would hold the property by fourteen coincidences, which is the
// thing being fixed.
//
// 🚫 **TEST-ONLY.** No product code changed — asserted below, because that is what makes this safe to land
// while @Tanya is reading these same messages on `uat`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { t } from "./line-i18n";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const MSG = code(src("src/lib/line-message.ts"));

/** Every kind the builder has a branch for — derived from the SOURCE, so a new one joins without being added. */
const KINDS = [...new Set([...MSG.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!))];

/**
 * 🔑 A placeholder as `t()` defines one: `{` + an identifier + `}`. **Narrow on purpose.**
 * ⚠️ `§3` warned about the false positive — a legitimate `{` in a customer string is not a leak. **I looked:
 * rendering all fourteen kinds in both languages and both audiences produces NO `{` or `}` of any kind, so
 * there is no exception to carve out today.** ⇒ the assertion below can afford to be strict, and a stray brace
 * that appears later will be judged against this comment rather than silently allowed by a loose regex.
 */
const PLACEHOLDER = /\{[a-zA-Z_][a-zA-Z0-9_]*\}/g;

describe("🔴 TASK-327 — NO message emits an un-interpolated placeholder. ONE assertion, ALL fourteen kinds.", () => {
  test("the kind list is derived from the source and is complete", () => {
    // A floor, so a rename of the `case` shape cannot turn this file into a pass over an empty list.
    expect(KINDS.length).toBe(14);
    for (const k of ["booking_confirmed", "leave_notice", "sick_leave", "daily_digest"]) {
      expect({ k, present: KINDS.includes(k) }).toEqual({ k, present: true });
    }
  });

  test("🔴 …and not one of them leaks a `{var}` — empty payload, empty ctx, both languages, both audiences", () => {
    // ⚠️ EMPTY EVERYTHING is the worst case on purpose: a branch passes the same var KEYS whatever the data,
    // so what a missing value exposes is exactly whether that key was passed at all.
    for (const kind of [...KINDS, "a_kind_nobody_has_written_yet"]) {
      for (const lang of ["TH", "EN"] as const) {
        for (const audience of ["parent", "teacher"] as const) {
          const out = formatOutboxMessage({ kind } as any, {}, lang, audience);
          expect({ kind, lang, audience, leaked: out.match(PLACEHOLDER) }).toEqual({
            kind,
            lang,
            audience,
            leaked: null,
          });
        }
      }
    }
  });

  test("🔑 …and the probe can actually SEE a leak — the assertion is not vacuous", () => {
    // 📌 A negative test that cannot fail is decoration. This proves the regex catches what it claims to:
    // `t()` leaves a placeholder verbatim when its key is not handed over, which is the exact failure mode.
    expect(t("added_atmax_note", "TH")).toMatch(PLACEHOLDER); // `{max}` — rendered with no vars at all
    expect(t("added_atmax_note", "TH", { max: 5 })).not.toMatch(PLACEHOLDER);
  });

  test("🚫 no rendered message contains a brace of ANY kind — so the strict regex has nothing to soften", () => {
    // `§3`: if a legitimate `{` existed, the assertion would have to be made precise around it. There is none.
    for (const kind of KINDS) {
      const out = formatOutboxMessage({ kind } as any, {}, "TH", "parent");
      expect({ kind, braces: out.match(/[{}]/g) }).toEqual({ kind, braces: null });
    }
  });
});

describe("📌 TASK-327 — WHICH branches are safe, and HOW. Two mechanisms, and only one of them scales.", () => {
  const switchBody = MSG.slice(MSG.indexOf("function buildOutboxMessage("));

  test("🔑 NINE kinds are safe BY CONSTRUCTION — the helpers drop an empty value, placeholder and all", () => {
    // `line()`, `extra()` and `renderFieldBlock` return nothing for a falsy value, so the LINE disappears
    // rather than rendering a half-filled one. ⇒ a branch that goes through them inherits the property
    // without its author knowing it exists — which is what "by construction" means.
    expect(MSG).toContain('const line = (label: string, value?: string) => (value ? `${label}: ${value}\\n` : "");');
    expect(MSG).toContain('const extra = (label: string, value?: string) => (value ? `${label} : ${value}\\n` : "");');
    // …and omitting the line is genuinely what happens, not merely what the helper says.
    const sparse = formatOutboxMessage({ kind: "course_confirmed" } as any, {}, "TH", "parent");
    expect(sparse).not.toContain("Student");
    expect(sparse).toContain("📅CONFIRMED SCHEDULE:");
  });

  test("🔴 FIVE kinds are safe BY REPETITION — `?? \"-\"` written out by hand, once per branch", () => {
    // ⚠️ **These are the fragile ones and they are NAMED rather than fixed** (`§3`: what a missing student's
    // name should render is not a testing question). Each interpolates `t(key, lang, {…})` directly, so its
    // safety is a habit its author had — and the next author may not.
    for (const kind of ["booking_paused", "booking_resumed", "makeup_far_out", "sick_leave", "leave_teacher"]) {
      expect({ kind, present: KINDS.includes(kind) }).toEqual({ kind, present: true });
    }
    // The shape that makes them safe, asserted so its removal is visible.
    expect(switchBody).toContain('date: ctx.date ?? "-",');
    expect(switchBody).toContain('weeks: String(payload.weeks ?? "-"),');
    expect(switchBody).toContain('student: (payload.studentName as string) || ctx.studentName || "-",');
    // 🚫 And this task added none of them: the count is the count that was already there.
    expect(switchBody.match(/\?\? "-"/g)!.length).toBe(12);
  });

  test("🚫 ZERO product-code changes — the reason this is safe during a `uat` round", () => {
    // 📌 The property is asserted, not enforced. If a future branch breaks it, THIS test fails and the fix is
    // a decision someone makes then — rather than a `?? "-"` added today to code a tester is reading.
    expect(MSG).toContain("return buildOutboxMessage(payload, ctx, lang, recipientType).trimEnd();");
    expect(switchBody.match(/case "/g)!.length).toBe(14);
  });
});
