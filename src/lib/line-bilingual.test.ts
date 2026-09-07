// TASK-275 (REQ-079 §18) — the CONVERSATION is bilingual; the labels and the notifications are not.
//
// ## The rule, and why it is split
// §18 reverses the 2026-09-06 ruling (*"มันจะยาวเกินไป"*) **narrowly**: the conversation becomes Thai and
// English together, the six notifications stay single-language because **the length objection still holds
// where it was strongest**. So there are two families and they must not leak into each other.
//
// 🔑 **The control is the signature.** `tb()` / `both()` take no `lang` and therefore cannot render one
// language; `t(key, lang)` still takes one and therefore cannot silently become 40 characters on a button that
// LINE caps at 20. That cap is not a detail — it is why the rule is split at all.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { both, t, tb } from "./line-i18n";
import { formatOutboxMessage } from "./line-message";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));

describe("TASK-275 — the body helpers render BOTH, by construction", () => {
  test("🔑 `tb()` takes no language, so it cannot render one", () => {
    // The whole mechanism. A body helper with a `lang` parameter is a body helper that will one day be handed
    // a single language by a caller in a hurry.
    expect(tb.length).toBe(2); // (key, vars?) — no `lang`
    expect(both.length).toBe(1); // (build) — no `lang`
    const out = tb("btn_back");
    expect(out).toBe(`${t("btn_back", "TH")}\n${t("btn_back", "EN")}`);
  });

  test("the separator is ONE newline — no brackets, no `(EN)` marker", () => {
    // The customer's own copy puts the English plainly under the Thai.
    expect(tb("welcome").split("\n").length).toBeGreaterThan(1);
    expect(tb("btn_back")).not.toMatch(/[()\[\]]|EN:|TH:/);
  });

  test("🔴 `both()` composes the WHOLE body per language — the reason it takes a builder", () => {
    // 📌 Q1/Q2's finding, pinned. Several keys are SUFFIX FRAGMENTS beginning with a newline
    // (`verify_parent_children_count`, `leave_extline`, …) and many bodies are two or three keys plus data.
    // A per-key `TH\nEN` would interleave TH/EN/TH/EN down the message; composing whole does not.
    const composed = both((l) => `${t("add_cancelled", l)}\n\n${t("menu_body", l)}`);
    const [th, en] = [
      `${t("add_cancelled", "TH")}\n\n${t("menu_body", "TH")}`,
      `${t("add_cancelled", "EN")}\n\n${t("menu_body", "EN")}`,
    ];
    expect(composed).toBe(`${th}\n${en}`);
    // …and the WRONG shape, stated so nobody rebuilds it: per-key joining puts the Thai menu above the English
    // cancellation line.
    expect(composed).not.toBe(`${tb("add_cancelled")}\n\n${tb("menu_body")}`);
  });
});

describe("TASK-275 — every LABEL fits LINE's 20-character cap, in BOTH languages", () => {
  // 🔑 The DoD assertion the whole shape rests on. `ตารางวันนี้ / Today` does not fit, which is why labels are
  // not bilingual — so the cap has to be a test, not a memory.
  const LABEL_KEYS = [
    "role_btn_customer",
    "role_btn_teacher",
    "role_btn_admin",
    "btn_checkin",
    "btn_leave",
    "btn_children",
    "btn_register",
    "btn_langhelp",
    "btn_back",
    "btn_week",
    "btn_today",
    "btn_calendar",
  ] as const;

  test("🔴 no label exceeds 20 characters, either language", () => {
    for (const key of LABEL_KEYS) {
      for (const lang of ["TH", "EN"] as const) {
        const label = t(key, lang);
        expect({ key, lang, len: label.length, over: label.length > 20 }).toEqual({
          key,
          lang,
          len: label.length,
          over: false,
        });
      }
    }
  });

  test("🚫 …and a BILINGUAL label would break the cap — which is why labels are not bilingual", () => {
    // Stated as a measurement rather than an argument: this is the constraint §2 is built on.
    const bilingual = tb("btn_children");
    expect(bilingual.length).toBeGreaterThan(20);
  });

  test("🚫 no label call site uses a body helper", () => {
    // The signature is the control, and this is the control's own test: a `label:` fed by `tb()` would be a
    // 40-character label LINE rejects, and the message would fail as a whole.
    for (const m of SVC.matchAll(/label: [^,\n]+/g)) {
      expect({ site: m[0], usesBodyHelper: /\btb\(|\bboth\(/.test(m[0]) }).toEqual({
        site: m[0],
        usesBodyHelper: false,
      });
    }
  });

  test("the LABEL keys are checked against the ones the code actually uses", () => {
    // A hand-written list here would rot. This asserts the list above covers every `label: t("…")` in the
    // service, so a new button either joins the list or fails here.
    const used = [...SVC.matchAll(/label: t\("([a-z_0-9]+)"/g)].map((m) => m[1]!);
    for (const key of used) expect({ key, covered: (LABEL_KEYS as readonly string[]).includes(key) }).toEqual({ key, covered: true });
  });
});

describe("TASK-275 §5 — the six notifications are BYTE-IDENTICAL", () => {
  // 🚫 Held with @Porter, and for three reasons a one-line change cannot survive: the customer's own template
  // writes `ไม่มี`; `4/6 ครั้ง` is hard-coded outside `t()`; and `booking_confirmed` is byte-frozen and
  // owner-verified. So this is not "we did not get to it" — it is a boundary, and it is asserted.
  const COURSE = {
    kind: "course_confirmed",
    studentName: "น้องเอ",
    subject: "Private Freeskate",
    bookingType: "COURSE_PACKAGE",
    size: 6,
    expiryDate: "2026-12-31",
    coach: "ครูหนึ่ง",
    startDate: "2026-09-06",
    weekday: 0,
    startTime: "10:00",
    endTime: "11:00",
    plannedLeaveDates: ["2026-09-14"],
    note: "แพ้ถั่ว",
  };

  test("🔴 a notification renders ONE language — not both", () => {
    const th = formatOutboxMessage(COURSE, {}, "TH", "parent");
    const en = formatOutboxMessage(COURSE, {}, "EN", "parent");
    expect(th).not.toBe(en); // the switch still switches
    // …and neither contains the other, which is what "bilingual" would mean.
    expect(th).not.toContain(en);
    expect(en).not.toContain(th);
  });

  test("🚫 `line-message.ts` uses no body helper at all", () => {
    const c = code(src("src/lib/line-message.ts"));
    expect(c).not.toMatch(/\btb\(/);
    expect(c).not.toMatch(/\bboth\(/);
    expect(c).toContain('t("ob_course_title", lang)');
  });

  test("🚫 and neither does the ICS feed — §5's other held decision", () => {
    const c = code(src("src/lib/ics.ts"));
    expect(c).not.toMatch(/\btb\(/);
    expect(c).toContain("t(`status_${b.status}`, lang)");
  });
});

describe("TASK-275 — what LANDED, by name", () => {
  // ⏱️ The scope is the REGISTRATION flow, per the task's own instruction to cut whole flows rather than
  // scattered strings. These are the bodies a new parent meets, in order, and they are asserted by call site
  // rather than by spot-check.
  test("🔑 the registration bodies are bilingual", () => {
    for (const site of [
      'textReply(tb("welcome"), lang)',
      'reply(replyToken, tb("welcome"))',
      'tb("role_prompt")',
      "reply(replyToken, tb(`code_${role}`))",
      'tb("twofa_bad"), lang)',
      "both(res.message)",
      'both((l) => `${t("add_cancelled", l)}',
      'both((l) => `${t("added_done", l, { name: student.name, note })}',
      'both((l) => `${t("skip_done", l)}',
      'both((l) => `${t("add_summary_head", l)}',
    ]) {
      expect({ site, present: SVC.includes(site) }).toEqual({ site, present: true });
    }
  });

  test("🚫 …and no body call site passes a language to a body helper", () => {
    // `tb(key, lang)` would be a silent single-language body. The signature refuses it, and this refuses the
    // shape as well, so a future overload cannot reopen it.
    expect(SVC).not.toMatch(/tb\("[a-z_0-9]+",\s*lang\)/);
    expect(SVC).not.toMatch(/both\([^)]*lang\s*\)/);
  });
});
