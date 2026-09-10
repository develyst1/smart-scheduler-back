// TASK-336 (`REQ-087 §1b`) — `Remark` on BOTH deductions. Owner: *"เพิ่มทั้งคู่เลยไม่ต้องถาม"*.
//
// 🔑 It was NOT a rendering fix. The note reached neither the payload nor `ctx` — `COURSE DEDUCTION` has never
// carried a `Remark`, for a course or a voucher. **The plumbing was the task; the render is one line.**
//
// ⚠️ And the `*ถ้ามี` rule is why it shipped without asking the customer: **the line appears only when a note
// exists, so it cannot make an existing message noisier.** That half is asserted as carefully as the other.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { deductionPayload } from "./course-deduction";
import { t } from "./line-i18n";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const CTX = { studentName: "น้องเอ", subject: "Freeskate", date: "2026-09-11", startTime: "10:00", endTime: "11:00", coach: "Ek" } as any;
/** A rendered deduction, from the payload the producer actually builds. */
const render = (kind: "course" | "voucher", attendeeNote: string | null) =>
  formatOutboxMessage(
    deductionPayload({ bookingId: "b1", studentId: "s1", kind, used: 2, total: 6, expiryDate: "2026-12-31" }, attendeeNote) as any,
    CTX,
    "TH",
    "parent",
  );

describe("🔴 TASK-336 — BOTH deductions carry the session's `Remark`", () => {
  test("🔑 a COURSE deduction renders it", () => {
    expect(render("course", "แพ้ถั่ว")).toContain("Remark : แพ้ถั่ว");
  });

  test("🔑 a VOUCHER deduction renders it — *"+"เพิ่มทั้งคู่"+"*, and the voucher was the reported half", () => {
    expect(render("voucher", "เตรียมรองเท้าสเกต")).toContain("Remark : เตรียมรองเท้าสเกต");
  });

  test("🔑 NEITHER renders it when there is no note — the `*ถ้ามี` half", () => {
    // ⚠️ **This is the assertion that made the change safe to ship without asking**: the line appears only
    // when a note exists, so no existing message becomes noisier. The customer approved this message without
    // a `Remark`, and every one of those messages renders exactly as before.
    for (const kind of ["course", "voucher"] as const) {
      for (const none of [null, ""]) {
        expect({ kind, none, out: render(kind, none as any).includes("Remark") }).toEqual({ kind, none, out: false });
      }
    }
  });

  test("🔴 a WHITESPACE-ONLY note produces NO bare label — `§4`'s trap", () => {
    // 🔑 `(payload.attendeeNote as string) || undefined` — the idiom its siblings used — is TRUTHY for `"   "`
    // ⇒ `Remark :` with nothing after it, TASK-219's *information that went missing*.
    // 🔻 CORRECTION to what this comment first said: I called it REACHABLE because `setAttendeeNote` stores the
    // note untrimmed. **True of the service and wrong about the product** — every write path goes through
    // `validation.attendeeNote`, `z.string().trim()`, and zod's `.trim()` TRANSFORMS: a whitespace-only note
    // parses to `""`. ⇒ **LATENT, not live.** ⚠️ I had reported on the product from ONE LAYER.
    // ✅ The guard stays, as DEFENCE IN DEPTH (TASK-337): it does not depend on a layer it cannot see.
    for (const blank of ["   ", "\n", "\t "]) {
      const out = render("course", blank);
      expect({ blank, bare: /Remark :\s*$/m.test(out) }).toEqual({ blank, bare: false });
      expect({ blank, present: out.includes("Remark") }).toEqual({ blank, present: false });
    }
    expect(code(src("src/lib/line-message.ts"))).toContain('extra(t("ob_f_note", lang), fieldValue(payload.attendeeNote))');
  });

  test("📌 `Remark` sits BELOW the block, like its two siblings — the field ORDER is untouched", () => {
    const out = render("course", "แพ้ถั่ว");
    const lines = out.split("\n");
    expect(lines[0]).toBe("💡COURSE DEDUCTION");
    expect(lines[lines.length - 1]).toBe("Remark : แพ้ถั่ว");
    // The money lines are still in the customer's order, above it.
    expect(out.indexOf("Remaining : ")).toBeLessThan(out.indexOf("*Expiry date : "));
    expect(out.indexOf("*Expiry date : ")).toBeLessThan(out.indexOf("Remark : "));
    // 🚫 …and it is NOT a template field — appended by the composer, as `§7.1`/`§7.3` do.
    const { TEMPLATE_FIELDS } = require("./line-message-fields");
    expect(TEMPLATE_FIELDS.course_deduction).not.toContain("note");
  });
});

describe("🔑 TASK-336 §1 — it is THE SESSION'S OWN note, not the course's", () => {
  test("🔴 a course whose OTHER sessions carry DIFFERENT notes — the deduction shows THIS one", () => {
    // ⚠️ Proven rather than coincidental: `courseNote`'s rule is *the first non-empty in date order*, which
    // exists because a COURSE SUMMARY has no true answer to "which session's note". **A deduction has one.**
    // ⇒ if this message ever started using `courseNote`, it would print `session one` here and pass a test
    // that only checked "a Remark appears".
    const { courseNote } = require("./course-plan");
    const rows = [{ attendeeNote: "session one" }, { attendeeNote: "session two" }, { attendeeNote: "session three" }];
    expect(courseNote(rows)).toBe("session one"); // what the COURSE rule would have said
    expect(render("course", "session three")).toContain("Remark : session three"); // what the DEDUCTION says
    expect(render("course", "session three")).not.toContain("session one");
  });

  test("📌 the same field name the two existing `Remark` renderers use — nothing arrives under a wrong key", () => {
    // @Porter's *check the name* (TASK-320's shape): `attendeeNote` is the column, the payload field, and what
    // `§7.3` and `§9.1` both read. It was genuinely ABSENT rather than silently discarded.
    const MSG = code(src("src/lib/line-message.ts"));
    expect(MSG.match(/payload\.attendeeNote/g)!.length).toBe(3); // §7.3 · §9.1 · the deduction
    expect(code(src("src/db/schema.ts"))).toContain("attendeeNote");
  });
});

describe("🔑 TASK-336 §3 — ONE decision, not four copies", () => {
  test("🔴 the note is read inside `notifyCourseDeduction`, from the `bookingId` it already takes", () => {
    const DED = code(src("src/lib/course-deduction.ts"));
    expect(DED).toContain("const booking = await exec.query.bookings.findFirst({");
    expect(DED).toContain("const payload = deductionPayload(input, booking?.attendeeNote ?? null);");
  });

  test("🚫 …and NOT ONE of the four call sites passes it", () => {
    // ⇒ a deduction site added later inherits the note without its author knowing it exists.
    for (const f of ["src/services/scheduler.service.ts", "src/services/jobs.service.ts"]) {
      const calls = [...code(src(f)).matchAll(/notifyCourseDeduction\(tx, \{[^}]*\}/g)];
      expect(calls.length).toBe(2);
      for (const c of calls) expect({ f, passesNote: c[0].includes("attendeeNote") }).toEqual({ f, passesNote: false });
    }
  });

  test("🔴 the DECIDING fact: the day-end's select does NOT carry the note, and it is the MAJORITY path", () => {
    // ⚠️ The task said "all four have the booking row in hand" and asked me to check rather than trust it.
    // **Half right:** the two scheduler sites have `current.attendeeNote`; the day-end selects an explicit
    // column list — `id · courseId · voucherId · studentId` — and **the note is not in it.**
    // ⇒ passing it from the callers would have meant widening that query. Reading it in the one writer needs
    // nothing from anybody.
    const JOBS = code(src("src/services/jobs.service.ts"));
    const select = JOBS.slice(JOBS.indexOf("const due = await tx"), JOBS.indexOf(".from(bookings)"));
    expect(select).toContain("studentId: bookings.studentId,");
    expect(select).not.toContain("attendeeNote");
    expect(src("src/services/jobs.service.ts")).toContain("since REQ-070 it is the MAJORITY path");
  });

  test("📌 a second PARAMETER, not a field on `DeductionInput` — an input nobody sets reads as one somebody forgot", () => {
    const DED = code(src("src/lib/course-deduction.ts"));
    const iface = DED.slice(DED.indexOf("export interface DeductionInput"), DED.indexOf("export function deductionPayload"));
    expect(iface).not.toContain("attendeeNote");
    expect(DED).toContain("attendeeNote: string | null,");
  });
});

describe("🚫 TASK-336 §5 — what this did not touch", () => {
  test("TASK-335's headers and `Remaining` are unchanged", () => {
    expect(render("course", null)).toStartWith("💡COURSE DEDUCTION");
    expect(render("voucher", null)).toStartWith("💡VOUCHER DEDUCTION");
    expect(render("course", null)).toContain("Remaining : 4 HR");
    expect(render("voucher", null)).toContain("Remaining : 4/6");
  });

  test("🔻 the two existing `Remark` lines still render exactly as they did — TASK-337 changed the GUARD, not the output", () => {
    // 🔻 They have since moved to `fieldValue` (TASK-337), and **the point of that change was that the
    // rendered output does not move**: the old guard was already correct, because zod's `.trim()` cannot
    // deliver whitespace. ⇒ this assertion is what proves a defence-in-depth change stayed invisible.
    const session = formatOutboxMessage({ kind: "booking_confirmed", bookingType: "COURSE_PACKAGE", size: 6, attendeeNote: "แพ้ถั่ว" } as any, CTX, "TH", "parent");
    expect(session).toContain("Remark : แพ้ถั่ว");
    expect(code(src("src/lib/line-message.ts")).match(/fieldValue\(payload\.attendeeNote\)/g)!.length).toBe(3);
  });
});
