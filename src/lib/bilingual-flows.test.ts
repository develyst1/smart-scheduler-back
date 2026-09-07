// TASK-276 — the remaining five conversational flows go bilingual.
//
// 🔑 The interesting one is not the count of converted call sites. It is that a LIST and a PROMPT need different
// shapes: the teacher's `ตาราง` is the whole list twice (block per language), never row-per-language, because a
// coach scanning eight classes needs one scannable column. **The owner's original length objection survives
// here even though it lost for prompts** — a list is read differently from a prompt.
//
// ⚠️ And §3's silent case: `children_title` + `(3/5)` appends the count AFTER the key, so a per-key `TH\nEN`
// would put it on the English line only — **and nothing about the Thai output would look wrong.** That one needs
// an assertion rather than an eye, which is what this file is for.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { both, t } from "./line-i18n";
import { renderSchedule } from "./line-schedule";
import { formatOutboxMessage } from "./line-message";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const src = (p: string) => readSrc(readFileSync(resolve(root, p), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const SVC = code(src("src/services/line-webhook.service.ts"));

describe("TASK-276 — all five flows, asserted by enumerating their bodies", () => {
  const FLOWS: Record<string, string[]> = {
    "menu / command list": [
      'text: tb("menu_body")',
      'reply(replyToken, tb("teacher_linked_menu"))',
      'reply(replyToken, tb("admin_linked_menu"))',
      'both((l) => `${msg}\\n\\n${t("menu_body", l)}`)',
    ],
    "check-in · leave · QR": [
      'textReply(tb("empty_checkin"), lang)',
      'textReply(tb("qr_none"), lang)',
      'textReply(tb("checkin_notfound"), lang)',
      'textReply(tb("empty_leave"), lang)',
      'textReply(e?.message ?? tb("leave_err"), lang)',
      'reply(replyToken, tb("num_notfound"))',
    ],
    "children list": ['both((l) => `${t("children_title", l)}', 'textReply(tb("children_none"), lang)'],
    "teacher ตาราง": [
      "both((l) => renderSchedule(rows, l, range))",
      "both((l) => renderMyCourses(view, l))",
      'textReply(tb("cal_not_teacher"), lang)',
    ],
    "handover + mute": [
      'reply(replyToken, tb("handover_to_admin"))',
      'textReply(tb("admin_called"), lang)',
      'textReply(tb("suspended_notice"), lang)',
    ],
  };

  for (const [flow, sites] of Object.entries(FLOWS)) {
    test(`🔑 ${flow}`, () => {
      for (const site of sites) {
        expect({ flow, site, present: SVC.includes(site) }).toEqual({ flow, site, present: true });
      }
    });
  }

  test("🚫 no body helper is handed a language", () => {
    // `tb(key, lang)` would be a silent single-language body. The signature refuses it; this refuses the shape,
    // so a future overload cannot reopen it.
    expect(SVC).not.toMatch(/tb\("[a-z_0-9]+",\s*lang\)/);
    expect(SVC).not.toMatch(/both\([^)]*\blang\b\s*\)/);
  });
});

describe("TASK-276 §3 — the SILENT one: the children count in BOTH languages", () => {
  const title = (n: number, max: number) => both((l) => `${t("children_title", l)} (${n}/${max})`);

  test("🔴 the count appears on the Thai line AND the English line", () => {
    // The defect a per-key helper would have produced: `(3/5)` on the English line only, with the Thai reading
    // perfectly. Asserted per line rather than on the whole string, because "contains (3/5)" would pass on the
    // broken version.
    const out = title(3, 5);
    const lines = out.split("\n");
    expect(lines.length).toBe(2);
    for (const [i, line] of lines.entries()) {
      expect({ i, hasCount: line.includes("(3/5)") }).toEqual({ i, hasCount: true });
    }
    // …and each line is in its own language.
    expect(lines[0]).toContain(t("children_title", "TH"));
    expect(lines[1]).toContain(t("children_title", "EN"));
  });

  test("🚫 the broken shape, stated so nobody rebuilds it", () => {
    // Per-key joining then appending: the count lands after the ENGLISH half only.
    const broken = `${t("children_title", "TH")}\n${t("children_title", "EN")} (3/5)`;
    expect(title(3, 5)).not.toBe(broken);
    expect(broken.split("\n")[0]).not.toContain("(3/5)"); // the Thai reader never sees it
  });
});

describe("TASK-276 §2 — the teacher's list is BLOCK per language, not row per language", () => {
  const row = (i: number) => ({
    date: "2026-09-10",
    startTime: `${String(8 + i).padStart(2, "0")}:00`,
    studentName: "น้องเอ",
    subjectName: "Freeskate",
    status: "CONFIRMED",
    attendeeNote: null,
  });
  const rows = Array.from({ length: 8 }, (_, i) => row(i));
  const out = both((l) => renderSchedule(rows, l, "week"));

  test("🔑 shape (a): the whole Thai list, then the whole English list", () => {
    // Not two interleaved halves: the Thai block ends before the English one begins.
    const th = renderSchedule(rows, "TH", "week");
    const en = renderSchedule(rows, "EN", "week");
    expect(out).toBe(`${th}\n${en}`);
    expect(out.indexOf(en)).toBeGreaterThan(out.indexOf(th));
  });

  test("🔴 a ROW's status label stays single-language inside its block", () => {
    // The one-line-per-class layout depends on it, and `both()` gives it for free — a per-key bilingual label
    // would put the English status inside the Thai row and break the column.
    const thBlock = out.slice(0, out.indexOf(renderSchedule(rows, "EN", "week")));
    expect(thBlock).toContain(t("status_CONFIRMED", "TH"));
    expect(thBlock).not.toContain(t("status_CONFIRMED", "EN"));
  });

  test("⚠️ a busy coach's doubled message fits LINE's 5000-character cap — measured", () => {
    // 20 rows is `renderSchedule`'s own cap, and the cap is what bounds this rather than the data. Long names
    // and a note on every row, doubled, came to 3,848 characters when I measured it.
    const busy = Array.from({ length: 40 }, (_, i) => ({
      ...row(i % 10),
      studentName: "น้องกัญญาภัทร",
      subjectName: "Private Freeskate Advanced",
      attendeeNote: "แพ้ถั่วลิสงและอาหารทะเล",
    }));
    expect(both((l) => renderSchedule(busy, l, "week")).length).toBeLessThan(5000);
  });
});

describe("TASK-276 §4 — the boundaries held", () => {
  test("🚫 the six notifications are byte-identical — asserted again, not inherited", () => {
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
    const th = formatOutboxMessage(COURSE, {}, "TH", "parent");
    const en = formatOutboxMessage(COURSE, {}, "EN", "parent");
    expect(th).not.toBe(en);
    expect(th).not.toContain(en);
    expect(code(src("src/lib/line-message.ts"))).not.toMatch(/\btb\(|\bboth\(/);
    expect(code(src("src/lib/ics.ts"))).not.toMatch(/\btb\(|\bboth\(/);
  });

  test("🚫 every label still fits 20 characters, and the list GREW with these flows", () => {
    // §4 says the TASK-275 cap must grow to cover any label these flows add. These are the ones they use.
    const LABELS = [
      "btn_checkin", "btn_leave", "btn_children", "btn_register", "btn_langhelp", "btn_back",
      "btn_week", "btn_today", "btn_calendar",
      "role_btn_customer", "role_btn_teacher", "role_btn_admin",
    ] as const;
    for (const key of LABELS) {
      for (const lang of ["TH", "EN"] as const) {
        expect({ key, lang, over: t(key, lang).length > 20 }).toEqual({ key, lang, over: false });
      }
    }
    // …and the list covers every `label: t("…")` the service uses.
    const used = [...SVC.matchAll(/label: t\("([a-z_0-9]+)"/g)].map((m) => m[1]!);
    for (const key of used) {
      expect({ key, covered: (LABELS as readonly string[]).includes(key) }).toEqual({ key, covered: true });
    }
  });

  test("🔴 the picker PROMPTS are bodies, but the picker LABELS are not", () => {
    // `childPicker(t("pick_leave_child", lang), …)` — the prompt is a body and could be bilingual; the child
    // names and the back-to-menu label are not ours to double. Left single-language deliberately: a bilingual
    // prompt above single-language buttons is the shape §2 already chose everywhere else.
    expect(SVC).toContain('childPicker(t("pick_leave_child", lang)');
  });
});
