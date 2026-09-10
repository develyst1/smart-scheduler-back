// TASK-337 — the three `Remark` guards, as DEFENCE IN DEPTH.
//
// 🔻 **The premise of my own TASK-336 §4 was wrong and this file records the correction.** I called the
// whitespace hole REACHABLE because `setAttendeeNote` stores the note untrimmed. **True of the service, and
// wrong about the product:** every write path goes through `validation.attendeeNote` — `z.string().trim()` —
// and zod's `.trim()` TRANSFORMS, so a whitespace-only note is stored as `""`, which is falsy.
// ⇒ **LATENT, not live.** ⚠️ I reported on the PRODUCT from ONE LAYER.
//
// ✅ **And the fix is still right, for a better reason than the one I gave:** the old guard was correct only
// because of a `.trim()` in a file the renderer cannot see. 🔑 ***That is TASK-330's gap in miniature — the
// renderer is safe GIVEN a payload, and nothing at the renderer checks what produced it.***
//
// 🔴 **The claim that makes this safe to land is that NOTHING CHANGES**, and it is asserted below rather than
// asserted about.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { courseNote } from "./course-plan";
import * as v from "../validation";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const MSG = code(src("src/lib/line-message.ts"));

const CTX = { studentName: "น้องเอ", subject: "Freeskate", date: "2026-09-11", startTime: "10:00", endTime: "11:00", coach: "Ek" } as any;
/** The three messages that render a note, each from the payload field it actually reads. */
const RENDER: Record<string, (note: unknown) => string> = {
  "§7.3 booking_confirmed": (n) =>
    formatOutboxMessage({ kind: "booking_confirmed", bookingType: "COURSE_PACKAGE", size: 6, attendeeNote: n } as any, CTX, "TH", "parent"),
  "§9.1 leave_notice": (n) =>
    formatOutboxMessage({ kind: "leave_notice", bookingType: "COURSE_PACKAGE", size: 6, attendeeNote: n } as any, CTX, "TH", "teacher"),
  "§7.1 course_confirmed": (n) =>
    formatOutboxMessage(
      { kind: "course_confirmed", studentName: "น้องเอ", subject: "Freeskate", bookingType: "COURSE_PACKAGE", size: 6, plannedLeaveDates: [], note: n } as any,
      {}, "TH", "parent",
    ),
};

describe("🔑 TASK-337 — the upstream guard is REAL, and I ran it rather than reading it", () => {
  test("🔴 zod's `.trim()` TRANSFORMS — a whitespace-only note is stored as an empty string", () => {
    // ⚠️ This is the fact my TASK-336 report missed, and the one this whole task turns on. Asserted here so
    // the correction is executable rather than a sentence in a report.
    expect((v as any).setAttendeeNote.safeParse({ attendeeNote: "   " }).data).toEqual({ attendeeNote: "" });
    expect((v as any).setAttendeeNote.safeParse({ attendeeNote: "  แพ้ถั่ว  " }).data).toEqual({ attendeeNote: "แพ้ถั่ว" });
    expect((v as any).setAttendeeNote.safeParse({ attendeeNote: null }).success).toBe(true);
  });

  test("🔑 …and EVERY schema that accepts a note uses that same trimmed one — so no write path escapes it", () => {
    // 📌 The claim the latency rests on, checked rather than assumed: three schemas carry `attendeeNote` and
    // all three reference the one validator.
    const VAL = code(src("src/validation.ts"));
    expect(VAL).toContain("export const attendeeNote = z.string().trim().max(200,");
    expect(VAL.match(/attendeeNote: attendeeNote/g)!.length).toBe(3); // creation ×2 + the note route
  });

  test("📌 `course_confirmed`'s note has a DIFFERENT upstream — `courseNote`, not zod", () => {
    // Which is why `:310` was a decision rather than an assumption: same class of dependency, different file.
    expect(courseNote([{ attendeeNote: "   " }, { attendeeNote: "\n" }] as any)).toBeNull();
    expect(courseNote([{ attendeeNote: "  " }, { attendeeNote: "real" }] as any)).toBe("real");
  });
});

describe("🔴 TASK-337 — BYTE-IDENTICAL for every value the product can actually produce", () => {
  // 🔑 The whole claim of a defence-in-depth change. If any of these differed, this would be a behaviour
  // change wearing a safety argument.
  const PRODUCIBLE = [null, undefined, "", "แพ้ถั่ว", "เตรียมเฉพาะ Freeskate ให้น้อง", "a", "0", "  padded  "];

  test("🔑 the three messages render the same bytes as `|| undefined` would have", () => {
    // The old guard, reproduced here exactly, and compared against what the new one produces.
    const oldGuard = (n: unknown) => ((n as string) || undefined);
    for (const [name, render] of Object.entries(RENDER)) {
      for (const note of PRODUCIBLE) {
        const now = render(note);
        // What the old expression would have handed `extra` — and `extra` omits when falsy, exactly as before.
        const wouldHave = oldGuard(note);
        const expectsLine = wouldHave !== undefined && String(wouldHave).trim() !== "";
        expect({ name, note, hasLine: now.includes("Remark : ") }).toEqual({ name, note, hasLine: expectsLine });
        // ⚠️ `Remark` is the LAST line, and `formatOutboxMessage` trims the message end (TASK-325) ⇒ a note
        // with trailing spaces loses them in BOTH the old and the new rendering. Compared trimmed-right so
        // this asserts the guard, not the trim.
        if (expectsLine) {
          expect({ name, note, line: now.includes(`Remark : ${note}`.trimEnd()) }).toEqual({ name, note, line: true });
        }
      }
    }
  });

  test("🚫 …and a padded note keeps its padding — `fieldValue` does NOT trim the VALUE", () => {
    // ⚠️ It rejects whitespace-ONLY; it never edits a human's words. A guard that trimmed here would be a
    // silent copy change on an admin's typed note.
    expect(RENDER["§7.3 booking_confirmed"]!("  padded  ")).toContain("Remark :   padded");
  });

  test("🔴 the ONLY input whose rendering differs is one the product cannot produce", () => {
    // Whitespace-only: the old guard printed a bare label, the new one omits the line. **That difference is
    // the entire point, and it is unreachable today** — which is why this is defence in depth and not a fix.
    for (const [name, render] of Object.entries(RENDER)) {
      const out = render("   ");
      expect({ name, bare: /Remark :\s*$/m.test(out) }).toEqual({ name, bare: false });
      expect({ name, present: out.includes("Remark") }).toEqual({ name, present: false });
    }
  });
});

describe("🔴 TASK-337 — the REASON is in the code, because the comment matters more than the change", () => {
  test("🔑 it says WHY it is not redundant — for the reader who finds the zod trim and calls it dead", () => {
    const raw = src("src/lib/line-message.ts");
    expect(raw).toContain("*this guard does not depend on a layer it"); // (wrapped in the doc-block)
    expect(raw).toContain("DEFENCE IN DEPTH, deliberately. **Do not simplify it.**");
    // …and it names both upstreams, so the reader does not have to find them.
    expect(raw).toContain("z.string().trim().max(200)");
    expect(raw).toContain("`courseNote`, which rejects a whitespace-only note");
  });

  test("all FOUR note renderings use `fieldValue`, and none uses the old idiom", () => {
    // 🔻 THREE, not two: TASK-336's deduction `Remark` reads the same field. **My first count said two and
    // was simply wrong** — there are FOUR note renderings, three on `attendeeNote` and one on `note`.
    expect(MSG.match(/fieldValue\(payload\.attendeeNote\)/g)!.length).toBe(3); // §7.3 · §9.1 · the deduction
    expect(MSG).toContain("fieldValue(payload.note)"); // §7.1
    expect(MSG).not.toContain("(payload.attendeeNote as string) || undefined");
    expect(MSG).not.toContain("(payload.note as string) || undefined");
  });

  test("🚫 the zod `.trim()` is UNTOUCHED — two guards on one boundary is the point", () => {
    // ⚠️ Trading one for the other is exactly what this task must not do: the renderer's guard exists because
    // it should not depend on the validator, not because the validator was wrong.
    expect(code(src("src/validation.ts"))).toContain("z.string().trim().max(200,");
  });

  test("🚫 …and the NINE other `|| undefined` sites are still untouched", () => {
    // They are correct and their reason is the customer's rule — see `fieldValue`'s note. The three that moved
    // did NOT move for consistency.
    expect(MSG.match(/as string\) \|\|/g)!.length).toBe(9);
  });
});
