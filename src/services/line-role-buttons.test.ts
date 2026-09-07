// TASK-251 (REQ-079 §16) — the role step stops accepting bare numbers, and becomes buttons.
//
// 🔴 This is a LIVE-ACCOUNT collision, not a hypothesis: the customer's own OA already owns numbered replies,
// and our role step asked for `1 / 2 / 3` on the same account. So the assertion that matters most here is the
// NEGATIVE one — `parseRoleChoice("1")` must be null, and `role_prompt` must not contain a digit — because a
// prompt that still teaches `1` would keep manufacturing the collision even after the parser stopped accepting
// it. The copy and the parser have to move together or the fix is only half done.
//
// ⚠️ The second thing guarded here is that a TAP and a TYPED word reach ONE transition. Two paths would be two
// places to forget `resetStrikes`, and the symptom — a parent handed to a human after answering correctly —
// would look like the strike rule misbehaving rather than like a duplicated transition.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { t, type Lang } from "../lib/line-i18n";
import { rolePicker } from "../lib/line-reply";
import { parsePostback, parseRoleChoice } from "../lib/line-webhook";

const SVC = readSrc(await Bun.file("src/services/line-webhook.service.ts").text());
const REPLY = readSrc(await Bun.file("src/lib/line-reply.ts").text());
const PARSER = readSrc(await Bun.file("src/lib/line-webhook.ts").text());

/** Comment text is prose, not behaviour — strip it before counting identifiers or slicing on landmarks. */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const LANGS: Lang[] = ["TH", "EN"];
/** ASCII digits AND Thai digits ๐-๙ — the TH copy is the one the customer reads. */
const ANY_DIGIT = /[0-9๐-๙]/;

const picker = (lang: Lang) =>
  rolePicker(
    t("role_prompt", lang),
    {
      customer: t("role_btn_customer", lang),
      teacher: t("role_btn_teacher", lang),
      admin: t("role_btn_admin", lang),
    },
    lang,
  );

describe("TASK-251 — the bare number is gone from the PARSER", () => {
  test("1 / 2 / 3 no longer resolve to a role", () => {
    // 📌 The whole point of the task. Each asserted separately so a failure names which one came back.
    expect(parseRoleChoice("1")).toBeNull();
    expect(parseRoleChoice("2")).toBeNull();
    expect(parseRoleChoice("3")).toBeNull();
    // …and neither do the shapes someone might "helpfully" re-add: padded, or Thai digits.
    expect(parseRoleChoice(" 1 ")).toBeNull();
    expect(parseRoleChoice("๑")).toBeNull();
  });

  test("every typed WORD still resolves — this is the path that must not close", () => {
    // ⚠️ SYSTEM-FACTS (corrected 2026-09-02): quick-reply chips ARE tappable on LINE PC, but they vanish the
    // moment the user types, and PC has no rich menu to bring them back. A PC user therefore ends up typing,
    // so the words below are not a nicety — for that user they are the only door.
    for (const w of ["ลูกค้า", "ผู้ปกครอง", "นักเรียน", "พ่อ", "แม่", "customer", "parent"]) {
      expect(parseRoleChoice(w)).toBe("customer");
    }
    for (const w of ["ครู", "teacher"]) expect(parseRoleChoice(w)).toBe("teacher");
    for (const w of ["แอดมิน", "admin"]) expect(parseRoleChoice(w)).toBe("admin");
    // Typed by a human, so case and stray spacing must not decide the outcome.
    expect(parseRoleChoice("  Teacher  ")).toBe("teacher");
    expect(parseRoleChoice("ADMIN")).toBe("admin");
    expect(parseRoleChoice("xyz")).toBeNull();
  });

  test("🚫 no digit literal survives in the parser's accepted sets", () => {
    // A source guard, because the regression would be a one-character re-add during a merge.
    const body = code(PARSER).slice(code(PARSER).indexOf("export function parseRoleChoice"));
    const accepted = body.slice(0, body.indexOf("return null;"));
    expect(accepted).not.toMatch(/"[0-9]"/);
  });
});

describe("TASK-251 — the bare number is gone from the COPY", () => {
  test("role_prompt contains no digits, TH and EN", () => {
    // 🔴 Asserted per language, not on a join: the EN string could be clean while the TH one — the string the
    // customer's parents actually read — still says "1 =". That is the failure that would ship.
    for (const lang of LANGS) expect(t("role_prompt", lang)).not.toMatch(ANY_DIGIT);
  });

  test("the three button labels are digit-free too", () => {
    for (const lang of LANGS) {
      for (const key of ["role_btn_customer", "role_btn_teacher", "role_btn_admin"] as const) {
        expect(t(key, lang)).not.toMatch(ANY_DIGIT);
      }
    }
  });

  test("🔑 every label the user is SHOWN is a word the parser accepts", () => {
    // The drift this closes: someone renames a button to a friendlier word, the chip still works (it is a
    // postback), and only the PC user who copies the label by hand discovers it is not understood. Deriving
    // the expectation from the i18n table means the two can never disagree silently.
    for (const lang of LANGS) {
      expect(parseRoleChoice(t("role_btn_customer", lang))).toBe("customer");
      expect(parseRoleChoice(t("role_btn_teacher", lang))).toBe("teacher");
      expect(parseRoleChoice(t("role_btn_admin", lang))).toBe("admin");
    }
  });

  test("the prompt still NAMES the typed words, in both languages", () => {
    // Removing the digits must not remove the instruction — otherwise a PC user is shown chips they will lose
    // and never told what to type instead.
    expect(t("role_prompt", "TH")).toContain("ครู");
    expect(t("role_prompt", "TH")).toContain("แอดมิน");
    expect(t("role_prompt", "EN").toLowerCase()).toContain("teacher");
    expect(t("role_prompt", "EN").toLowerCase()).toContain("admin");
  });
});

describe("TASK-251 — rolePicker, the third sibling of bookingPicker / childPicker", () => {
  test("three role buttons, each a POSTBACK on our own namespace", () => {
    const msg = picker("TH") as { type: string; text: string; quickReply: { items: any[] } };
    expect(msg.type).toBe("text");
    expect(msg.text).toBe(t("role_prompt", "TH"));
    // ✅ postback, never `message`: a text quick-reply would put OUR word back into the same text stream the
    // customer's OA parses — the collision we are removing, re-introduced by the fix.
    const roleItems = msg.quickReply.items.filter((i) => i.action.data.startsWith("action=role"));
    expect(roleItems.length).toBe(3);
    for (const i of roleItems) expect(i.action.type).toBe("postback");
    expect(roleItems.map((i) => i.action.data)).toEqual([
      "action=role&role=customer",
      "action=role&role=teacher",
      "action=role&role=admin",
    ]);
    expect(roleItems.map((i) => i.action.label)).toEqual([
      t("role_btn_customer", "TH"),
      t("role_btn_teacher", "TH"),
      t("role_btn_admin", "TH"),
    ]);
  });

  test("the back-to-menu item is preserved, and it is LAST", () => {
    // Every reply in this file carries one so no reply is a dead end (`textReply`'s own rule). Last, because
    // the three answers should read before the escape hatch.
    for (const lang of LANGS) {
      const items = (picker(lang) as any).quickReply.items;
      expect(items.length).toBe(4);
      expect(items[3].action.data).toBe("action=menu");
      expect(items[3].action.label).toBe(t("btn_back", lang));
    }
  });

  test("labels are clamped to LINE's 20-character limit", () => {
    // SYSTEM-FACTS: quick-reply labels clamp at 20 characters. The i18n labels are short today; the guard is
    // on the BUILDER, so a longer translation later cannot make LINE reject the whole message.
    const long = "x".repeat(40);
    const items = (rolePicker("p", { customer: long, teacher: long, admin: long }, "EN") as any).quickReply.items;
    for (const i of items) expect(i.action.label.length).toBeLessThanOrEqual(20);
  });

  test("it is built like its two siblings, not like a new invention", () => {
    const c = code(REPLY);
    expect(c).toContain("export function rolePicker(");
    // Same three ingredients the other pickers use: clampLabel, a postback data string, backToMenuItem.
    const body = c.slice(c.indexOf("export function rolePicker("), c.indexOf("export function childPicker("));
    expect(body).toContain("clampLabel(");
    expect(body).toContain("backToMenuItem(lang)");
    expect(body).toContain('type: "postback"');
  });
});

describe("TASK-251 — a tap and a typed word reach ONE transition", () => {
  test("the postback the picker EMITS is the one the service dispatches", () => {
    // Producer and consumer, tied together: the picker's own output is parsed with the service's own parser,
    // so a rename on either side fails here instead of in a live chat.
    const emitted = (picker("TH") as any).quickReply.items
      .map((i: any) => i.action.data as string)
      .filter((d: string) => d.startsWith("action=role"));
    expect(emitted.length).toBe(3);
    for (const data of emitted) {
      const { action, params } = parsePostback(data);
      const role = params.role as "customer" | "teacher" | "admin";
      expect(action).toBe("role");
      expect(parseRoleChoice(t(`role_btn_${role}`, "TH"))).toBe(role);
    }
    expect(code(SVC)).toContain('if (action === "role")');
  });

  test("🔴 both doors call acceptRole — the transition exists exactly once", () => {
    const c = code(SVC);
    // One definition, and it is the only place the role step advances.
    expect(c.match(/acceptRole\(/g)!.length).toBe(3); // the declaration + the typed word + the tap
    expect(c.match(/setStep\(lineUserId, "AWAIT_CODE", role\)/g)!.length).toBe(1);
    // The typed-word branch.
    const typed = c.slice(c.indexOf('if (session.step === "CHOOSE_ROLE")'));
    expect(typed.slice(0, typed.indexOf("\n  }"))).toContain("acceptRole(lineUserId, role, replyToken, lang)");
    // The tap branch.
    const tap = c.slice(c.indexOf('if (action === "role")'), c.indexOf('if (action === "enter")'));
    expect(tap).toContain("acceptRole(lineUserId, role, replyToken, lang)");
  });

  test("acceptRole resets the strike count and sets the role-specific prompt", () => {
    const c = code(SVC);
    const body = c.slice(c.indexOf("async function acceptRole("), c.indexOf("const FLOW_CLEARED"));
    expect(body).toContain("resetStrikes(lineUserId)"); // AC-19 — a valid answer clears the count
    expect(body).toContain('setStep(lineUserId, "AWAIT_CODE", role)');
    // TASK-275 (REQ-079 §18): the BODY is bilingual now (`tb`/`both`); the property this line guards is
    // unchanged, only the helper is. Labels deliberately still use `t(key, lang)` — LINE caps them at 20 chars.
    expect(body).toContain("tb(`code_${role}`)");
  });

  test("an unknown role in the payload re-asks instead of advancing", () => {
    // A postback is ours, but it arrives over the network; a payload we do not recognise must not fall through
    // to whatever branch comes next.
    const c = code(SVC);
    const tap = c.slice(c.indexOf('if (action === "role")'), c.indexOf('if (action === "enter")'));
    expect(tap).toContain('role === "customer" || role === "teacher" || role === "admin"');
    expect(tap).toContain("send(replyToken, [askRole(lang)])");
  });

  test("the picker is what the สมัคร door and the first-strike re-ask both send", () => {
    // ⚠️ The re-ask matters more than it looks: LINE removes a quick reply as soon as the user types, and PC
    // has no rich menu to bring it back. Re-prompting with text alone would offer the buttons exactly once —
    // to everyone except the person who just proved they needed them.
    const c = code(SVC);
    expect(c.match(/askRole\(lang\)/g)!.length).toBe(3); // the สมัคร door · the strike re-ask · the bad payload
    // TASK-275 (REQ-079 §18): the BODY is bilingual now (`tb`/`both`); the property this line guards is
    // unchanged, only the helper is. Labels deliberately still use `t(key, lang)` — LINE caps them at 20 chars.
    expect(c).toContain('tb("role_prompt"), lang, askRole(lang))');
  });
});
