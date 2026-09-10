// SPEC-072 / TASK-253 (REQ-077) — one payload, two renderings; and the per-type table.
//
// 🔴 The failure this whole design exists to avoid is NOT the privacy one. `scheduler.service.ts` builds the
// course payload once for the parent and the teacher on purpose — *"two copies… one of them would be missed,
// which is how the parent ends up reading a different schedule from the teacher."* A second payload, or a
// `teacher_course_confirmed` kind, would re-create exactly that, and a coach and a family disagreeing about
// **when the class is** is worse than the privacy problem being solved.
//
// ⇒ The assertions below are mostly about IDENTITY: the two copies must differ in the removed lines **and in
// nothing else**. Asserting only the absence would pass for two renderers that had quietly drifted apart.
import { describe, expect, test } from "bun:test";
import { formatOutboxMessage } from "./line-message";
import {
  AUDIENCE_OMITS,
  TEMPLATE_FIELDS,
  TYPE_OMITS,
  notifyTypeOf,
  programLabel,
  visibleFields,
  type NotifyType,
} from "./line-message-fields";
import { readSrc } from "./read-src";
import { readFileSync } from "node:fs";
import { t } from "./line-i18n";

// Read at module top level: `await` inside a `describe`/`test` callback is a syntax error (they are sync).
const MSG_SRC = readSrc(await Bun.file(new URL("./line-message.ts", import.meta.url)).text());
const SCHED_SRC = readSrc(await Bun.file(new URL("../services/scheduler.service.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const COURSE = {
  kind: "course_confirmed",
  courseId: "c1",
  studentName: "น้องเอ",
  subject: "Private Freeskate",
  bookingType: "COURSE_PACKAGE",
  size: 6,
  expiryDate: "2026-12-31",
  coach: "ครูหนึ่ง",
  startDate: "2026-09-06",
  weekday: 0,
  startTime: "10:00",
  // TASK-257 §2 — carried on the payload, derived once by `confirmCourse` (`addHour`), never by the renderer.
  endTime: "11:00",
  // 🔴 TASK-269 — deliberately NOT equal to `size` (6). It was `6`, which is the same number, so this
  // fixture could not tell `Sessions : size` from `Sessions : confirmed` — the two agreed and the test
  // passed either way. A field left on the payload that nothing renders is still worth a fixture that
  // would notice if something started rendering it again.
  confirmed: 8,
  plannedLeaveDates: ["2026-09-14"],
  note: "แพ้ถั่ว",
};

describe("🔴 ONE payload, TWO renderings — the same object, projected", () => {
  const parent = formatOutboxMessage(COURSE, {}, "TH", "parent");
  const teacher = formatOutboxMessage(COURSE, {}, "TH", "teacher");

  test("🔴 the teacher's copy IS the parent's — byte-identical (owner: เอาหมด, 2026-09-07)", () => {
    // 🔻 TASK-269 §3 REVERSES @Porter's Decision 5. This test used to assert the teacher LOST
    // `*Expiry date` and `**Advance Leave Notice`, on the reading that they are the family's business.
    // The customer's own draft had them on the teacher's copy, and the owner confirmed it: *เอาหมด*.
    //
    // 🔑 Rewritten as the REQUIREMENT, not as the table. `expect(AUDIENCE_OMITS.teacher).toEqual([])` would
    // prove the table equals itself; comparing the two RENDERINGS is what the customer actually asked for,
    // and it stays true however the projection is implemented.
    expect(parent).toContain("*Expiry date : 2026-12-31");
    expect(parent).toContain("**Advance Leave Notice : 2026-09-14");
    expect(teacher).toBe(parent);
  });

  test("🔑 …and EVERY OTHER LINE is identical — the identity, not just the absence", () => {
    // The real risk is drift, not disclosure. If these two ever stop being one payload projected two ways, this
    // is the assertion that says so — a parent and a coach reading a different schedule.
    const strip = (s: string) =>
      s.split("\n").filter((l) => !l.includes("Expiry date") && !l.includes("Advance Leave"));
    expect(strip(parent)).toEqual(strip(teacher));
  });

  test("📌 `Coach` is KEPT on the teacher's copy — someone covering needs to see whose class it is", () => {
    expect(teacher).toContain("Coach : ครูหนึ่ง");
    expect(parent).toContain("Coach : ครูหนึ่ง");
  });

  test("the default audience is the FULLER message, so an un-updated caller cannot strip lines", () => {
    expect(formatOutboxMessage(COURSE, {}, "TH")).toEqual(parent);
  });

  test("the customer's labels and separator, so a rendered message diffs against their draft", () => {
    expect(parent).toContain("Student : น้องเอ");
    expect(parent).toContain("Program : Private Freeskate 6 HR");
    expect(parent).toContain("Start : 2026-09-06");
    // 🔴 TASK-257 §2 — `Date` is the weekday ALONE and `Time` is a RANGE, which is what `COURSE DEDUCTION`
    // always printed. The two messages disagreeing about what `Time` means is the difference a customer reads
    // as an error rather than a preference; asserted here so they cannot drift apart again.
    expect(parent).toContain("Date : Sunday");
    expect(parent).toContain("Time : 10:00-11:00");
    expect(parent).not.toContain("Date : Sunday 10:00");
  });

  test("⚠️ the count and the note survive BELOW the block — one line each to delete", () => {
    // The template does not list them, but removing them would drop the number this message exists to announce
    // and TASK-219's fix (a note typed at booking reaching the one message a teacher reads). Additive and
    // reversible; flagged for @Sober rather than decided silently.
    expect(parent).toContain("แพ้ถั่ว");
    expect(teacher).toContain("แพ้ถั่ว");
    expect(parent).toContain("6");
  });
});

describe("🔴 the per-type table — all five types, both audiences, one table-shaped place", () => {
  const ALL: NotifyType[] = ["COURSE", "VOUCHER", "ONE_HOUR", "FIRST_TRIAL", "OTHER"];

  test("`Remaining` and `*Expiry date` exist ONLY for course and voucher", () => {
    // A 1HR, a 1st Trial and an อื่นๆ have no balance and no expiry; printing an empty or a zero would state
    // something false about money.
    for (const type of ALL) {
      const fields = visibleFields("todays_schedule", type, "parent");
      const moneyed = type === "COURSE" || type === "VOUCHER";
      expect(fields.includes("remaining")).toBe(moneyed);
      expect(fields.includes("expiry")).toBe(moneyed);
    }
  });

  test("🔴 the teacher sees EXACTLY what the parent sees, whatever the type or template", () => {
    // Was: *the teacher never sees expiry or advance-leave, whatever the type.* The rule reversed; the
    // SHAPE of the guard is what was worth keeping — every type, every template, one loop.
    for (const type of ALL) {
      for (const template of ["confirmed_schedule", "todays_schedule", "course_deduction"] as const) {
        expect({ type, template, fields: visibleFields(template, type, "teacher") }).toEqual({
          type,
          template,
          fields: visibleFields(template, type, "parent"),
        });
      }
    }
  });

  test("`Start` is on CONFIRMED SCHEDULE only — a single session IS its date", () => {
    expect(TEMPLATE_FIELDS.confirmed_schedule).toContain("start");
    expect(TEMPLATE_FIELDS.todays_schedule).not.toContain("start");
    expect(TEMPLATE_FIELDS.course_deduction).not.toContain("start");
  });

  test("🔑 every rule is DATA — and reverting one of @Porter's decisions really did cost one line", () => {
    // 📌 This is no longer a claim. On 2026-09-07 the owner reversed Decision 5 (*เอาหมด*) and the change
    // was `teacher: ["expiry", "advanceLeave"]` → `teacher: []`. The mechanism paid for itself.
    expect(TYPE_OMITS.COURSE).toEqual([]);
    expect(TYPE_OMITS.ONE_HOUR).toEqual(["remaining", "expiry"]);
    expect(AUDIENCE_OMITS.parent).toEqual([]);
    // 🚫 The table is EMPTY, not deleted — see its comment. This customer has changed their mind about
    // these two fields twice, and deleting it means re-threading `audience` through five signatures.
    expect(AUDIENCE_OMITS.teacher).toEqual([]);
  });

  test("field order is the customer's own line order", () => {
    expect(visibleFields("confirmed_schedule", "COURSE", "parent")).toEqual([
      "student", "program", "date", "time", "start", "coach", "expiry", "advanceLeave",
    ]);
    expect(visibleFields("todays_schedule", "COURSE", "parent")).toEqual([
      "student", "program", "date", "time", "coach", "remaining", "expiry",
    ]);
  });
});

describe("`Program` per type — the REQ's table, as data", () => {
  test("course = package with its size · voucher = its programme", () => {
    expect(programLabel("COURSE", { subject: "Private Freeskate", size: 6 })).toBe("Private Freeskate 6 HR");
    expect(programLabel("VOUCHER", { subject: "Surfskate" })).toBe("Surfskate");
  });

  test("1HR and 1st Trial name the activity and what it is", () => {
    expect(programLabel("ONE_HOUR", { subject: "Surfskate" })).toBe("Surfskate 1 HR");
    expect(programLabel("FIRST_TRIAL", { subject: "Surfskate" })).toBe("Surfskate 1st Trial");
  });

  test("🔴 อื่นๆ is named by the TITLE the admin typed — it has no subject", () => {
    // Being asked to type a real name is the entire point of that field (REQ-078), and it is never the word
    // "อื่นๆ" itself.
    expect(programLabel("OTHER", { title: "ประชุมผู้ปกครอง" })).toBe("ประชุมผู้ปกครอง");
    expect(programLabel("OTHER", { subject: "Surfskate", title: null })).toBeUndefined();
  });

  test("nothing true to say ⇒ `undefined`, so the omit-empty rule prints no blank label", () => {
    expect(programLabel("ONE_HOUR", { subject: null })).toBeUndefined();
    expect(programLabel("COURSE", { subject: "  " })).toBeUndefined();
    expect(programLabel("COURSE", { subject: "Surfskate", size: null })).toBe("Surfskate");
  });

  test("the DB enum maps once, and an unknown type renders the SMALLEST message", () => {
    expect(notifyTypeOf("COURSE_PACKAGE")).toBe("COURSE");
    expect(notifyTypeOf("SINGLE_SESSION")).toBe("ONE_HOUR");
    expect(notifyTypeOf("FIRST_TRIAL")).toBe("FIRST_TRIAL");
    expect(notifyTypeOf("VOUCHER")).toBe("VOUCHER");
    expect(notifyTypeOf("OTHER")).toBe("OTHER");
    // Never one that invents a balance it cannot know.
    expect(notifyTypeOf(undefined)).toBe("ONE_HOUR");
    expect(TYPE_OMITS[notifyTypeOf("SOMETHING_NEW")]).toContain("remaining");
  });
});

describe("🔴 TASK-257 — one message, ONE labelling convention (the cause, not the three symptoms)", () => {
  const CODE = code(MSG_SRC);
  const reqCase = (name: string) => {
    const rest = CODE.slice(CODE.indexOf(`case "${name}":`));
    return rest.slice(0, rest.indexOf("\n    case "));
  };

  test("🔑 no REQ-077 message prints a bilingual `ob_l_*` label — that is the whole defect class", () => {
    // `จำนวนคาบที่ยืนยัน` and `หมายเหตุ` under eight English labels were two instances of ONE cause: the old
    // `line()` printer with bilingual labels, used inside a block written in the customer's convention. A net,
    // not three fixes — the next line appended to one of these messages cannot reintroduce it silently.
    for (const kind of ["course_confirmed", "course_deduction", "daily_reminder"]) {
      expect(reqCase(kind)).not.toContain("line(t(");
      expect(reqCase(kind)).not.toContain("ob_l_");
    }
  });

  test("🔻 …and the ONE kept line prints in the customer's convention", () => {
    const parent = formatOutboxMessage(COURSE, {}, "TH", "parent");
    // 🔻 TASK-318 (`§16.4`) — this asserted TWO kept lines. **`Sessions :` is gone, on the customer's own
    // reasoning: the program name already carries the hours** (`Program : … 6 HR`). ⇒ rewritten to the line
    // that remains, with the absence pinned beside it.
    expect(parent).not.toContain("Sessions :");
    expect(parent).toContain("Program : Private Freeskate 6 HR"); // where the 6 lives now
    expect(parent).toContain("Remark : แพ้ถั่ว");
    expect(parent).not.toContain("จำนวนคาบที่ยืนยัน");
    expect(parent).not.toContain("หมายเหตุ");
  });

  test("the labels are English in BOTH languages — the customer's template, not a translation", () => {
    const en = formatOutboxMessage(COURSE, {}, "EN", "parent");
    expect(en).toContain("Program : Private Freeskate 6 HR");
    expect(en).toContain("Remark : แพ้ถั่ว"); // the VALUE stays as typed; only the label is theirs
  });

  test("§1 — the heading is the customer's own, in both languages, emoji kept", () => {
    for (const lang of ["TH", "EN"] as const) {
      expect(formatOutboxMessage(COURSE, {}, lang, "parent")).toContain("📅CONFIRMED SCHEDULE:");
    }
  });

  test("🔴 §2 — `Time` means the same thing here as in `COURSE DEDUCTION`", () => {
    // The defect was not the format itself; it was two messages disagreeing. So the assertion compares them
    // rather than pinning each separately — a future change to one alone fails here.
    const confirmed = formatOutboxMessage(COURSE, {}, "TH", "parent");
    const deduction = formatOutboxMessage(
      { kind: "course_deduction", bookingType: "COURSE_PACKAGE", remaining: "2 HR", total: 6 },
      { studentName: "น้องเอ", date: "2026-09-06", startTime: "10:00", endTime: "11:00" },
      "TH",
      "parent",
    );
    const timeLine = (s: string) => s.split("\n").find((l) => l.startsWith("Time : "))!;
    expect(timeLine(confirmed)).toBe("Time : 10:00-11:00");
    expect(timeLine(deduction)).toBe(timeLine(confirmed));
    // …and `Date` no longer repeats the time it used to carry.
    expect(confirmed).toContain("Date : Sunday");
    expect(confirmed.split("\n").find((l) => l.startsWith("Date : "))).toBe("Date : Sunday");
  });

  test("§2 — the +1h rule lives ONCE, where the payload is built", () => {
    // The renderer reads `endTime`; it never derives it. Deriving in both places is how the next duration
    // change fixes only one of them.
    expect(CODE).not.toContain("addHour");
    expect(reqCase("course_confirmed")).toContain("payload.endTime");
    expect(code(SCHED_SRC)).toContain("endTime: addHour(course.startTime)");
  });

  test("a payload from BEFORE this task still renders — an old outbox row must not print a dangling dash", () => {
    // The worker renders whatever is in the outbox, including rows queued by an older deploy (the existing
    // `daily_reminder` rule, applied here).
    const { endTime: _e, ...old } = COURSE;
    expect(formatOutboxMessage(old, {}, "TH", "parent")).toContain("Time : 10:00");
    expect(formatOutboxMessage(old, {}, "TH", "parent")).not.toContain("10:00-");
  });
});

describe("🚫 the four lesson types' `booking_confirmed` is BYTE-IDENTICAL — owner-verified (TASK-228 / AC-16)", () => {
  const ctx = { studentName: "น้องเอ", subject: "Surfskate", date: "2026-09-06", startTime: "10:00", endTime: "11:00" };

  const session = { kind: "booking_confirmed", bookingType: "SINGLE_SESSION" };

  test("the shipped text, asserted in full rather than eyeballed", () => {
    // 🔻 TASK-303 (REQ-085 §7.3) — **REWRITTEN, not deleted.** The customer REPLACED this message: every label
    // changed and `เวลา: 2026-09-06 10:00-11:00` split into `Date` (a WEEKDAY) + `Time`. It used to read
    //
    //     📅 ยืนยันตารางสอน · นักเรียน: น้องเอ · วิชา: Surfskate · เวลา: 2026-09-06 10:00-11:00
    //
    // 🔑 §4 — this is the highest-volume notification in the product: a parent, per booking, on the ordinary
    // path. A break here is not a wrong label on a screen someone can re-read; it is a wrong message in a
    // family's LINE, unrecallable. **So the pin stays a pin — to the new text.**
    // 📌 An assertion that changes because a requirement changed is correct; one deleted because it failed is
    // how this class of defect ships.
    expect(formatOutboxMessage(session, ctx, "TH")).toBe(
      "📅CONFIRMED SCHEDULE:\nStudent : น้องเอ\nProgram : Surfskate 1 HR\nDate : Sunday\nTime : 10:00-11:00",
    );
  });

  test("🔑 the calendar DATE appears NOWHERE — that absence is what the split actually did", () => {
    // `เวลา` carried `2026-09-06 10:00-11:00`; `Date` now names the weekday and `Time` the range, so the date
    // itself is gone from the message. Asserted as an absence, because that is the part a reader would miss.
    expect(formatOutboxMessage(session, ctx, "TH")).not.toContain("2026-09-06");
  });

  test("…and the audience does not change it — this template has no family-only line", () => {
    const parent = formatOutboxMessage(session, ctx, "TH", "parent");
    const teacher = formatOutboxMessage(session, ctx, "TH", "teacher");
    expect(parent).toBe(teacher);
  });

  test("an อื่นๆ booking is still named by the typed title — now as its `Program`", () => {
    // 🔻 TASK-303 — it used to lead on its own unlabelled line. `programLabel` names it now, which is what
    // §7.1 does for an อื่นๆ course: one rule across both messages.
    const out = formatOutboxMessage(
      { kind: "booking_confirmed", bookingType: "OTHER" },
      { ...ctx, studentName: undefined, subject: undefined, title: "ประชุมผู้ปกครอง" },
      "TH",
    );
    expect(out.split("\n")[1]).toBe("Program : ประชุมผู้ปกครอง");
  });

  test("the other three live kinds are unchanged by the audience too", () => {
    const kinds = [
      { kind: "sick_leave", studentName: "น้องเอ" },
      { kind: "leave_teacher", studentName: "น้องเอ" },
      { kind: "teacher_assigned" },
    ];
    for (const payload of kinds) {
      expect(formatOutboxMessage(payload, ctx, "TH", "parent")).toBe(
        formatOutboxMessage(payload, ctx, "TH", "teacher"),
      );
    }
  });
});

describe("🔴 TASK-269 — the live `sid` message, and the three corrections it produced", () => {
  // The owner sent two real messages from `sid`. This is the parent's, as a payload: a 10-session course
  // with TWO advance leaves declared — the shape that printed `Program : Surfskate 10 HR` and
  // `Sessions : 8` in the same message.
  const LIVE = {
    ...COURSE,
    subject: "Surfskate",
    size: 10,
    confirmed: 8, // what the old code printed: two leaves were SICK_LEAVE and never PENDING
    plannedLeaveDates: ["2026-09-14", "2026-09-28"],
  };

  test("🔻 §1 — the two derivations AGREED, and that is what made removing one safe (TASK-318)", () => {
    // The defect was not the number; it was two derivations of one fact disagreeing in front of a parent.
    // 🔻 `§16.4` now deletes the `Sessions` line entirely — the program name already carries the hours — so
    // this is rewritten rather than dropped. 🔑 **TASK-269's fix is exactly what makes the deletion safe:**
    // the two numbers had been made to agree, so nothing is lost with the line. Had they still disagreed,
    // removing one would have HIDDEN a defect instead of closing it.
    const out = formatOutboxMessage(LIVE, {}, "TH", "parent");
    expect(out).toContain("Program : Surfskate 10 HR"); // the course AS BOUGHT — now the only place it prints
    expect(out).not.toContain("Sessions");
    expect(out).not.toContain(" 8"); // 🚫 the count this confirm flipped reaches a parent by no route at all
    // …and the leaves are still there, which is what made the old number 8.
    expect(out).toContain("**Advance Leave Notice : 2026-09-14, 2026-09-28");
  });

  test("🚫 §1 — with `size` absent, no count appears and nothing invents a zero", () => {
    // 🔻 It read *"`Sessions` is OMITTED when `size` is absent, never `Sessions : 0`"*. There is no `Sessions`
    // line to omit now; **the rule it protected — a course never states a size it does not know — lives on the
    // program label**, which is where the number went.
    const { size: _s, ...noSize } = LIVE;
    const out = formatOutboxMessage(noSize, {}, "TH", "parent");
    expect(out).not.toContain("Sessions");
    expect(out).toContain("Program : Surfskate"); // the rest of the message is unaffected
    expect(out).not.toContain("0 HR");
  });

  test("🔴 §1 — a re-confirm still reads the COURSE, not the zero rows it flipped", () => {
    // The second symptom the reported fix would have left: `confirmed + leaves` prints 2 on a re-confirm.
    // 🔑 Still asserted, on the line that survived — `programLabel` reads `size`, so a re-confirm is unaffected.
    const reconfirm = { ...LIVE, confirmed: 0 };
    expect(formatOutboxMessage(reconfirm, {}, "TH", "parent")).toContain("Program : Surfskate 10 HR");
  });

  test("🔑 §2 — the note renders as `Remark`, asserted with a note PRESENT", () => {
    // ⚠️ Its absence from both live samples was omit-empty working. A field verified only by its absence is
    // a field nobody has watched render.
    const out = formatOutboxMessage(LIVE, {}, "TH", "parent");
    expect(out).toContain("Remark : แพ้ถั่ว");
    expect(out.trimEnd().endsWith("Remark : แพ้ถั่ว")).toBe(true); // last line, unchanged position
    expect(out).not.toContain("Note :");
  });

  test("✅ §2 — omit-empty stays: no note, no line", () => {
    const { note: _n, ...noNote } = LIVE;
    expect(formatOutboxMessage(noNote, {}, "TH", "parent")).not.toContain("Remark");
  });

  test("🚫 §2 — `ob_l_note` is a DIFFERENT key and is untouched (booking_confirmed is byte-frozen)", () => {
    // Merging the two keys is the obvious tidy-up and the reason this stays a one-line change.
    expect(t("ob_l_note", "TH")).toBe("หมายเหตุ");
    expect(t("ob_l_note", "EN")).toBe("Note");
    expect(t("ob_f_note", "TH")).toBe("Remark");
    expect(t("ob_f_note", "EN")).toBe("Remark");
  });

  test("🔴 §3 — teacher == parent, byte-identical, WITH leaves and WITHOUT", () => {
    // *เอาหมด* made mechanical: the requirement, not a restatement of the omissions table.
    for (const leaves of [["2026-09-14", "2026-09-28"], []]) {
      const payload = { ...LIVE, plannedLeaveDates: leaves };
      for (const lang of ["TH", "EN"] as const) {
        expect({ leaves: leaves.length, lang, same: formatOutboxMessage(payload, {}, lang, "teacher") }).toEqual({
          leaves: leaves.length,
          lang,
          same: formatOutboxMessage(payload, {}, lang, "parent"),
        });
      }
    }
  });
});

describe("🔴 TASK-269 §1 — the GATE and the printed figure are two different questions", () => {
  // They were one variable: `confirmed` decided whether to send AND was printed as `Sessions`. Splitting
  // them is the fix, so both halves need a guard — and the gate's half can only be asserted against the
  // service's source, because reaching it needs a database.
  const SVC = readSrc(readFileSync(new URL("../services/scheduler.service.ts", import.meta.url), "utf8"));
  const code = (x: string) => x.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  const CONFIRM = (() => {
    const c = code(SVC);
    const at = c.indexOf("const coursePayload = {");
    return c.slice(at, c.indexOf("const updated =", at));
  })();

  test("🚫 `confirmed` is NOT on the payload any more", () => {
    const payload = CONFIRM.slice(0, CONFIRM.indexOf("};"));
    expect(payload).toContain("size: course.size,");
    expect(payload).not.toMatch(/^\s*confirmed,$/m);
  });

  test("🔑 …but it still GATES the send — a 0-confirm announces nothing, to either person", () => {
    // *Nothing changed ⇒ nothing to announce.* Sending "confirmed 0 sessions" would train a teacher to
    // ignore the message that matters. Both the teacher's row and the parent's copies are behind it.
    expect(CONFIRM).toContain("const notification = confirmed");
    expect(CONFIRM).toContain("const parentLines = confirmed ? await parentLineUserIds(");
    expect(CONFIRM).toContain("const parentNotification = confirmed");
  });

  test("…and it is still what the ADMIN is told — the return value is unchanged", () => {
    const c = code(SVC);
    const ret = c.slice(c.indexOf("    return {", c.indexOf("const coursePayload = {")));
    expect(ret.slice(0, ret.indexOf("    };"))).toContain("confirmed,");
  });
});
