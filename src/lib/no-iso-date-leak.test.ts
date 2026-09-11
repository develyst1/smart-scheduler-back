// TASK-345 — **no message can emit a RAW ISO date.** The check is the deliverable; the fixes are what it found.
//
// 🔴 **Three sweeps searched the SHAPE OF THE SOURCE and three undercounted: 5 → 8 → 9+.** Each looked for a
// field *named* `date`, so each missed the ones that are not — a date inside a `Time` value, an `Expiry date`,
// a `Start`, a joined list of leave dates. ⇒ 🔑 ***@Porter's requirement: the check must be able to FAIL on a
// site it has never been told about.***
//
// ✅ **THE PROPERTY THAT MAKES THIS ROBUST RATHER THAN A FRAGILE REGEX:** the probe CONTROLS every input, so
// **any ISO date in the output came from US.** ⚠️ *No false positive from a parent's typed `Remark`, because
// the probe decides what the `Remark` says.*
//
// 🚫 It is TEST-ONLY and it is the same harness shape TASK-327 built for `{placeholder}` leaks.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { renderTodaySchedule, type TodayRow } from "./line-today-schedule";
import { readSrc } from "./read-src";

const src = (f: string) => readSrc(readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const MSG = code(src("src/lib/line-message.ts"));

/** Derived from the SOURCE, so a kind added next month is checked without anyone adding it here. */
const KINDS = [...new Set([...MSG.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!))];

/** 🔑 An ISO date as a reader would meet one. Deliberately the ONLY thing this file knows about. */
const ISO = /\d{4}-\d{2}-\d{2}/g;

/**
 * 🔑 **Every date-bearing input the builder can read, each a DISTINCT value**, so a hit names its own source
 * rather than leaving us to guess which field leaked.
 * ⚠️ Not a list of the fields we *fixed* — a list of every field that carries a date at all. **The whole point
 * is that a leak from a field nobody remembered still shows up.**
 */
const D = {
  ctx: "2026-09-11",
  expiry: "2027-03-11",
  start: "2026-10-16",
  leaveA: "2026-11-21",
  leaveB: "2026-12-25",
  to: "2026-09-18",
} as const;

const PAYLOAD = (kind: string) => ({
  kind,
  bookingType: "COURSE_PACKAGE",
  size: 6,
  total: 6,
  remaining: "2/6 HR",
  studentName: "น้องเอ",
  subject: "Freeskate",
  weekday: 2,
  text: "ok",
  via: "line",
  weeks: 2,
  attendeeNote: "ไม่มีวันที่ในโน้ต",
  note: "ไม่มีวันที่ในโน้ต",
  expiryDate: D.expiry,
  startDate: D.start,
  plannedLeaveDates: [D.leaveA, D.leaveB],
  to: { date: D.to, startTime: "10:00" },
  checks: [],
});
const CTX = {
  studentName: "น้องเอ", subject: "Freeskate", title: "อื่นๆ", coach: "Ek", teacherNickname: "Ek",
  date: D.ctx, startTime: "10:00", endTime: "11:00",
} as any;

/** Every rendering of every kind, in both languages and for both audiences. */
const everyRendering = (): Array<{ where: string; out: string }> => {
  const all: Array<{ where: string; out: string }> = [];
  for (const kind of KINDS) {
    for (const lang of ["TH", "EN"] as const) {
      for (const audience of ["parent", "teacher"] as const) {
        all.push({ where: `${kind}/${lang}/${audience}`, out: formatOutboxMessage(PAYLOAD(kind) as any, CTX, lang, audience) });
      }
    }
  }
  // 📌 The AUTO daily schedule is a MESSAGE and does not go through the switch — it would have been invisible
  // to a check that only knew about `formatOutboxMessage`, which is the same blind spot in a different place.
  const row: TodayRow = {
    date: D.ctx, startTime: "10:00", endTime: "11:00", studentName: "Aiwa", subjectName: "Freeskate",
    bookingType: "COURSE_PACKAGE", size: 6, remaining: "2/6 HR", expiryDate: D.expiry, coach: "Ek",
    attendeeNote: "ไม่มีวันที่ในโน้ต", status: "CONFIRMED",
  } as any;
  for (const lang of ["TH", "EN"] as const) {
    for (const audience of ["parent", "teacher"] as const) {
      all.push({ where: `todays_schedule/${lang}/${audience}`, out: renderTodaySchedule([row], lang, audience) });
    }
  }
  return all;
};

describe("🔴 TASK-345 — NO message emits a RAW ISO date. ONE assertion, every kind, over the OUTPUT.", () => {
  test("🔑 the probe actually renders something — a check looking nowhere passes as quietly as a clean tree", () => {
    // ⚠️ @Fern's rule, and the reason `§3.4` demands the probe be emptied: **an empty region and a clean region
    // are indistinguishable from the assertion's side.** This is the floor that tells them apart.
    const all = everyRendering();
    expect(all.length).toBeGreaterThanOrEqual((KINDS.length + 1) * 4);
    expect(KINDS.length).toBe(15);
    // …and every rendering is non-trivial: a builder returning `""` would satisfy the ISO assertion perfectly.
    for (const { where, out } of all) expect({ where, empty: out.trim().length === 0 }).toEqual({ where, empty: false });
  });

  test("🔴 …and NOT ONE of them contains `YYYY-MM-DD`", () => {
    // 🔑 Every date the probe supplies is DISTINCT, so a failure names its own source instead of leaving the
    // reader to guess which field leaked.
    const leaks = everyRendering()
      .map(({ where, out }) => ({ where, found: [...new Set(out.match(ISO) ?? [])] }))
      .filter((x) => x.found.length > 0);
    expect(leaks).toEqual([]);
  });
});

describe("🚫 TASK-345 §4 — what this check does NOT reach, and WHY. Each one is a DECISION, not a gap.", () => {
  test("🔴 `§7.1`'s `Date : Tuesday` — a WEEKDAY IS NOT A DATE, so there is nothing here to sweep", () => {
    // 🔑 `REQ-085 §15` is the OWNER'S ruling and he re-affirmed it by keeping `§7.1` out of `§6b`.
    // ⚠️ **This check would never have flagged it** — a weekday contains no `YYYY-MM-DD` — 📌 *which is worth
    // stating, because "the check is silent" and "the rule is safe" are different facts and only one is
    // evidence.* ✅ So the weekday is asserted PRESENT here, in the sweep's own file.
    const course = formatOutboxMessage(PAYLOAD("course_confirmed") as any, CTX, "TH", "parent");
    expect(course).toContain("Date : Tuesday");
  });

  test("🟡 the PICKER and the weekly HEADING — KNOWN-OPEN with @Porter, and OUT OF THIS CHECK'S REACH", () => {
    // 🔑 `line-leave.ts` and `line-schedule.ts` render **`อังคาร 22/09`** — a weekday PLUS a date fragment, a
    // THIRD form that was CHOSEN (TASK-316 decided it, TASK-318 ruled `§16d` must not reach it, @Sober
    // ratified it). ⇒ **`ทุกที่` either reverses a ratified decision or does not apply, and that is @Porter's.**
    // ⚠️ **TWO separate reasons they are absent here, and only one of them is the decision:**
    //   1. they are not `formatOutboxMessage` renderings at all, and
    //   2. `22/09` contains no `YYYY-MM-DD`, so this check could not flag them even if it rendered them.
    // 📌 *Recorded so nobody later reads this check's silence as clearance.*
    for (const f of ["src/lib/line-leave.ts", "src/lib/line-schedule.ts"]) {
      expect({ f, formatted: code(src(f)).includes("ddmmyyyy") }).toEqual({ f, formatted: false });
    }
  });

  test("🔻 the DAILY DIGEST — and this CORRECTS what I told @Sober on TASK-344", () => {
    // 🔴 **I reported `attention.ts`'s raw ISO as "a label an ADMIN reads" and implied it reaches a message.**
    // ⚠️ **It does not.** `buildDigestMessage` renders only the COUNT per check — `• <label> : 3` — and then
    // *"ดูรายละเอียดทั้งหมดในเว็บแอป"*. **The item labels never enter the LINE message; they go to the WEB APP.**
    // ⇒ 📌 **it is not a message-date question at all, and my "two lines if he says yes" sizing was on a false
    // premise.** ✅ Asserted, so the correction is executable rather than a sentence in a report.
    const digest = formatOutboxMessage(
      { kind: "daily_digest", checks: [{ key: "pending_soon", count: 1, items: [{ id: "b1", label: "2026-09-11 10:00 · น้องเอ" }] }] } as any,
      {}, "TH", "parent",
    );
    expect(digest).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(digest).not.toContain("น้องเอ"); // the ITEMS do not reach the message at all
  });
});
