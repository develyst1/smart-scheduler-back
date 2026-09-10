// TASK-325 (`REQ-085 §16.3`) — the trailing blank line, fixed where messages are BUILT.
//
// 🔴 The customer reported it TWICE: *"เอาช่องว่างด้านล่างของ 📅CONFIRMED SCHEDULE ออกค่ะ ** ในคอมไม่ขึ้น แต่ใน
// โทรศัพท์ขึ้นค่ะ"* and, on the leave notice, *"ติดช่องข้างล่างไปเหมือนกัน"*. ⚠️ **It shows on a PHONE and not on
// a desktop**, which is why it survived every desktop screenshot we took of these messages.
//
// 🔑 It was never one message's bug. `.trimEnd()` sat on FIVE branches out of fourteen kinds, so nine messages
// were clean or dirty **by accident of which branch someone had happened to trim**.
//
// ⚠️ **THE POINT OF THIS FILE IS THAT IT IS ONE ASSERTION, NOT FOURTEEN.** Fourteen per-message pins would be
// the per-message version of the very mistake being fixed: the property would hold by fourteen coincidences
// instead of by construction, and the fifteenth kind would inherit nothing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const MSG = code(src("src/lib/line-message.ts"));

/**
 * 🔑 EVERY kind `formatOutboxMessage` has a branch for, plus an unknown one for the `default`.
 * ⚠️ Derived from the SOURCE, not hand-listed: a kind added next month joins this list without anyone
 * remembering to, which is the only way "all fourteen" stays true.
 */
const KINDS = [...new Set([...MSG.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!))];

const CTX = {
  studentName: "น้องเอ",
  subject: "Freeskate",
  date: "2026-09-10",
  startTime: "10:00",
  endTime: "11:00",
  coach: "Ek",
} as any;
const payloadFor = (kind: string) =>
  ({
    kind,
    bookingType: "COURSE_PACKAGE",
    // ⚠️ `course_confirmed` reads `subject` from the PAYLOAD (a course summary is not a fact about any one
    // booking); the per-session kinds read it from `ctx`. Both are supplied so no kind renders a short message
    // by accident of the fixture — which is how a trailing-line test could pass on a message missing a field.
    subject: "Freeskate",
    coach: "ครูหนึ่ง",
    size: 6,
    expiryDate: "2026-12-31",
    studentName: "น้องเอ",
    startDate: "2026-09-06",
    weekday: 0,
    startTime: "10:00",
    endTime: "11:00",
    plannedLeaveDates: ["2026-09-14"],
    note: "แพ้ถั่ว",
    attendeeNote: "แพ้ถั่ว",
    remaining: 3,
    weeks: 27,
    replaces: "2026-09-01",
    landedOn: "2027-03-09",
    rows: [],
    checks: [],
  }) as any;

describe("🔑 TASK-325 — NO message ends in whitespace. ONE property, ONE assertion, ALL fourteen kinds.", () => {
  test("the kind list is derived from the source and is complete", () => {
    // A floor, so a rename of the `case` shape cannot turn this whole file into a no-op over an empty list.
    // 🔻 TASK-334 Part A — FIFTEEN now: `teacher_link_approved` gained the `case` whose ABSENCE was live on
    // the deployed build (an approved teacher received the generic default). **The number moving is the
    // point of this assertion, not a nuisance: it is what makes a new kind visible here.**
    expect(KINDS.length).toBe(15);
    for (const k of ["booking_confirmed", "leave_notice", "course_confirmed", "daily_digest"]) {
      expect({ k, present: KINDS.includes(k) }).toEqual({ k, present: true });
    }
  });

  test("🔴 …and NOT ONE of them ends in whitespace — including the `default` branch", () => {
    // ⚠️ Every kind, both languages, both audiences, and with the optional fields both present and absent —
    // because the trailing line came from the LAST field rendered, so which field that is matters.
    for (const kind of [...KINDS, "a_kind_nobody_has_written_yet"]) {
      for (const lang of ["TH", "EN"] as const) {
        for (const audience of ["parent", "teacher"] as const) {
          for (const sparse of [false, true]) {
            const payload = sparse
              ? { ...payloadFor(kind), attendeeNote: null, note: null, plannedLeaveDates: [], expiryDate: undefined }
              : payloadFor(kind);
            const out = formatOutboxMessage(payload, sparse ? ({} as any) : CTX, lang, audience);
            expect({ kind, lang, audience, sparse, endsClean: out === out.trimEnd() }).toEqual({
              kind,
              lang,
              audience,
              sparse,
              endsClean: true,
            });
          }
        }
      }
    }
  });
});

describe("✅ TASK-325 §2 — ONE trim, at the builder's exit", () => {
  test("🔑 the public function trims and delegates; the switch does not trim at all", () => {
    expect(MSG).toContain("return buildOutboxMessage(payload, ctx, lang, recipientType).trimEnd();");
    expect(MSG).toContain("function buildOutboxMessage(");
    // 🔑 Exactly one trim in the whole file — and it is that one.
    expect(MSG.match(/trimEnd\(\)/g)!.length).toBe(1);
  });

  test("🚫 the five per-branch `.trimEnd()`s are GONE — asserted as an absence so a new branch cannot re-add one", () => {
    // 📌 DECIDED: they come out. **A redundant trim is a second writer that agrees today** (TASK-314's lesson),
    // and this week has been spent on rules that lived in one of two places. ⚠️ Keeping them would also make
    // the next branch's author think a per-branch trim is the convention — which is how five happened.
    // ⚠️ Asserted on the SWITCH BODY, not on the file: the one surviving trim is itself written
    // `).trimEnd();`, so a file-wide negative would have failed on the fix. **My first version did.**
    const switchBody = MSG.slice(MSG.indexOf("function buildOutboxMessage("));
    expect(switchBody).not.toContain("trimEnd");
    expect(switchBody.match(/case "/g)!.length).toBe(15); // …and it really is the whole switch

  });

  test("📌 every branch's return passes through it — asserted by there being ONE exported entry point", () => {
    // The property holds because there is nowhere else to return from: the switch is private.
    expect(MSG).toContain("export function formatOutboxMessage(");
    expect(MSG.match(/export function formatOutboxMessage/g)!.length).toBe(1);
    expect(MSG).not.toContain("export function buildOutboxMessage");
  });
});

describe("🚫 TASK-325 §4 — the only byte that changed is a trailing one", () => {
  test("🔑 trimming is the WHOLE difference — every message equals its old self minus trailing space", () => {
    // ⚠️ The assertion that keeps this task from becoming a copy change. If any branch's text had moved, the
    // rendered message would differ somewhere other than its end — and `trimEnd` is idempotent, so comparing a
    // message to its own trimmed self cannot catch that. **Comparing the two RENDERINGS can**: the message with
    // its fields present must still contain every label it did.
    const out = formatOutboxMessage(payloadFor("course_confirmed"), CTX, "TH", "parent");
    for (const label of ["Student : ", "Program : ", "Date : ", "Time : ", "Coach : ", "*Expiry date : "]) {
      expect({ label, present: out.includes(label) }).toEqual({ label, present: true });
    }
    expect(out.startsWith("📅CONFIRMED SCHEDULE:")).toBe(true);
    // 🚫 …and no message gained or lost an interior blank line: the trim only ever touches the end.
    expect(out).not.toContain("\n\n");
  });

  test("📌 the two messages that HAD the artefact are the two the customer reported", () => {
    // 🔑 Measured, not assumed (see the report): of fourteen kinds, exactly TWO ended in whitespace before this
    // change — `booking_confirmed` (`§7.3`) and `leave_notice` — and **both with a single `\n`, never `\n\n`**.
    // ⇒ **no trailing whitespace anywhere was deliberate**; all of it came from `renderFieldBlock` ending every
    // line with a newline, so the last field left one behind.
    // ⚠️ `course_confirmed` (`§7.1`) was NOT one of them — its branch was already among the five that trimmed.
    // 📌 Which means the `📅CONFIRMED SCHEDULE` the customer photographed was the PER-SESSION one: both
    // messages open with `ob_course_title`, so their report could not distinguish them and neither could we.
    for (const kind of ["booking_confirmed", "leave_notice"]) {
      const out = formatOutboxMessage(payloadFor(kind), CTX, "TH", "teacher");
      expect({ kind, endsClean: out === out.trimEnd() }).toEqual({ kind, endsClean: true });
    }
    // Both still open with the shared header, which is the reason the report was ambiguous in the first place.
    expect(formatOutboxMessage(payloadFor("booking_confirmed"), CTX, "TH", "parent")).toStartWith("📅CONFIRMED SCHEDULE:");
    expect(formatOutboxMessage(payloadFor("course_confirmed"), CTX, "TH", "parent")).toStartWith("📅CONFIRMED SCHEDULE:");
  });
});
