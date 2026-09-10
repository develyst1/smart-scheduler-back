// TASK-332 — `Remaining` must be able to say ZERO.
//
// 🔴 `line-message.ts` rendered `remaining: (payload.remaining as string) || undefined`. **`0` is falsy**, so
// the field became `undefined` and omit-empty deleted the WHOLE LINE. ⇒ a `COURSE DEDUCTION` that empties a
// course would have arrived **without the balance it exists to report**.
//
// 🔑 And nobody would ever have told us: **omit-empty makes a missing line look DELIBERATE** — the owner's own
// `(-)` reasoning pointed back at us. *A parent reading a receipt with no balance has no way to know a line is
// missing.* ⚠️ **That is why this needed a test and not a report.**
//
// 🚫 It was LATENT — `remainingLabel` returns `"0 HR"` / `"0/6 ครั้ง"`, never a bare number — so nothing
// @Tanya can produce changes. The fix is invisible on every message that exists today.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { deductionPayload, remainingLabel } from "./course-deduction";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const MSG = code(src("src/lib/line-message.ts"));

const CTX = { studentName: "น้องเอ", subject: "Freeskate", date: "2026-09-10", startTime: "10:00", endTime: "11:00", coach: "Ek" } as any;
const deduct = (remaining: unknown) =>
  formatOutboxMessage(
    { kind: "course_deduction", bookingType: "COURSE_PACKAGE", total: 6, expiryDate: "2026-12-31", remaining } as any,
    CTX,
    "TH",
    "parent",
  );

describe("🔴 TASK-332 — the assertion that did not exist, and is the whole task", () => {
  test("🔑 `remaining: 0` RENDERS `Remaining : 0`", () => {
    // The number path — the one `||` deleted. A balance of zero is the most important one this message ever
    // carries, and it was the only value it could not say.
    expect(deduct(0)).toContain("Remaining : 0");
  });

  test("🔑 …and `\"0 HR\"` still renders — the shape the producer actually sends today", () => {
    expect(deduct("0 HR")).toContain("Remaining : 0 HR");
    expect(deduct("3 HR")).toContain("Remaining : 3 HR");
    expect(deduct("0/6 ครั้ง")).toContain("Remaining : 0/6 ครั้ง");
  });

  test("🔴 `remaining: \"\"` does NOT produce a bare label — THE TRAP", () => {
    // ⚠️ `?? undefined` ALONE would have converted an absent line into `Remaining :` with nothing after it,
    // which TASK-219 established reads as **information that went missing**. ⇒ you would trade a silent
    // absence for a visible lie. **Asserted as an absence, because that is the failure the obvious fix has.**
    for (const empty of ["", "   ", "\n"]) {
      const out = deduct(empty);
      expect({ empty, bare: /Remaining :\s*$/m.test(out) }).toEqual({ empty, bare: false });
      expect({ empty, present: out.includes("Remaining") }).toEqual({ empty, present: false });
    }
    // …and genuinely absent stays absent.
    for (const nothing of [null, undefined]) expect(deduct(nothing)).not.toContain("Remaining");
  });

  test("📌 the message is otherwise untouched — only the one field's guard changed", () => {
    const out = deduct(0);
    expect(out).toStartWith("💡COURSE DEDUCTION");
    for (const label of ["Student : ", "Program : ", "Date : ", "Time : ", "Coach : ", "*Expiry date : "]) {
      expect({ label, present: out.includes(label) }).toEqual({ label, present: true });
    }
  });
});

describe("🔑 TASK-332 — the expression, and why it is a HELPER rather than an operator", () => {
  test("`fieldValue` keeps a zero and drops only true emptiness", () => {
    // 🔑 Chosen over `?? undefined` because BOTH conditions have to hold and an operator can only state one:
    // keep `0`, drop `""`. A helper is the only shape that says both, once, with the reason attached.
    expect(MSG).toContain("const fieldValue = (v: unknown): string | undefined => {");
    expect(MSG).toContain("remaining: fieldValue(payload.remaining),");
  });

  test("🔑 THE TWO-IDIOM SENTENCE is written into the code, next to the one I touched", () => {
    // @Sober asked for this specifically: the next person reaching for `??` to "fix" a `||` walks into the
    // mirror bug. It is recorded where they will be standing.
    const raw = src("src/lib/line-message.ts");
    expect(raw).toContain("`||` eats a legitimate `0`. `??` lets an empty string through.");
    expect(raw).toContain("swapping one operator for the other does not fix anything");
  });

  test("🚫 the OTHER TWELVE `|| undefined` sites are UNTOUCHED — with the reason, so nobody 'consistency-fixes' them", () => {
    // 🔴 They are CORRECT. An absent `Remark` is the customer's `*ถ้ามี` rule; an absent `expiryDate` is a TRUE
    // statement about a course with no expiry; an absent `studentName` is TASK-224's decision about a
    // studentless booking. **Changing them for consistency would delete a rule the customer asked for.**
    // 🔻 TASK-337 moved the THREE `Remark` sites to `fieldValue` as DEFENCE IN DEPTH ⇒ NINE remain.
    // ⚠️ **The claim this line makes is unchanged and is the one that matters**: the survivors are correct
    // and nobody may 'consistency-fix' them. The three that moved did NOT move for consistency — they moved
    // because their correctness depended on a `.trim()` in a file the renderer cannot see.
    expect(MSG.match(/as string\) \|\|/g)!.length).toBe(9);
    expect(src("src/lib/line-message.ts")).toContain("Changing them \"for consistency\" would delete a rule the customer asked for.");
    // …and the three that fall through to `-` are still the safe shape: a `-` is visible, a missing line is not.
    expect(MSG).toContain('student: (payload.studentName as string) || ctx.studentName || "-",');
  });

  test("✅ `Remark`'s omit-empty rule still works — the one most likely to be broken by a careless sweep", () => {
    const withNote = formatOutboxMessage(
      { kind: "course_confirmed", studentName: "น้องเอ", subject: "Freeskate", bookingType: "COURSE_PACKAGE", size: 6, note: "แพ้ถั่ว", plannedLeaveDates: [] } as any,
      {}, "TH", "parent",
    );
    const without = formatOutboxMessage(
      { kind: "course_confirmed", studentName: "น้องเอ", subject: "Freeskate", bookingType: "COURSE_PACKAGE", size: 6, note: "", plannedLeaveDates: [] } as any,
      {}, "TH", "parent",
    );
    expect(withNote).toContain("Remark : แพ้ถั่ว");
    expect(without).not.toContain("Remark");
  });
});

describe("✅ TASK-332 half 2 — the producer DECLARES what it sends", () => {
  test("🔑 `deductionPayload`'s return type is annotated, so `remaining: string` is held by the compiler", () => {
    // Until now it was inferred, i.e. a fact we re-established by reading `remainingLabel`. The annotation
    // makes a future change to that function fail at the producer instead of travelling.
    const DED = code(src("src/lib/course-deduction.ts"));
    // 🔻 TASK-336 gave it a second parameter (the session's note), so the signature spans lines. **The
    // property this asserts is unchanged: the return type is DECLARED rather than inferred.**
    expect(DED).toContain("export function deductionPayload(");
    expect(DED).toContain("attendeeNote: string | null,");
    expect(DED).toContain("remaining: string;");
    expect(DED).toContain("attendeeNote: string | null;"); // …and it is declared on the RETURN type too
  });

  test("📌 and what it actually sends at ZERO is a non-empty label — which is why this was LATENT", () => {
    expect(remainingLabel("course", 0, 6)).toBe("0 HR");
    expect(remainingLabel("voucher", 0, 6)).toBe("0/6"); // 🔻 TASK-335 removed the Thai unit word
    const p = deductionPayload({ bookingId: "b1", studentId: "s1", kind: "course", used: 6, total: 6, expiryDate: null }, null);
    expect(p.remaining).toBe("0 HR");
    // ⇒ the rendered message says zero today, and said zero before this task. **Nothing @Tanya can see changes.**
    expect(deduct(p.remaining)).toContain("Remaining : 0 HR");
  });

  test("⚠️ …and the declaration does NOT reach the renderer — that gap is TASK-333", () => {
    // The payload crosses a JSON column: `row.payload as any` destroys every type on it, so the renderer's
    // `fieldValue` is what protects the message, not the producer's annotation. Stated here so half 2 is not
    // mistaken for the whole fix.
    expect(code(src("src/services/outbox.service.ts"))).toContain("row.payload as any");
    expect(src("src/lib/course-deduction.ts")).toContain("It does NOT reach the renderer.");
  });
});
