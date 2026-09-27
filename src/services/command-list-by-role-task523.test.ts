// TASK-523 — which list does each ROLE get, on every surface that offers one? ONE decision (`commandListKey` / `commandChips`),
// and this file is its table: 4 roles × every list surface, by value through the REAL dispatcher. A list is a promise about typing,
// so each role is shown only words that route for it — from copy that already exists.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes";
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as checkinSvc from "./checkin.service";
import * as lineClient from "../lib/line-client";
import { t, tb } from "../lib/line-i18n";
import * as lineAdmin from "../lib/line-admin"; // TASK-525
import { formatOutboxMessage } from "../lib/line-message"; // TASK-525

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const U = "Urole0523";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

type Role = "teacher" | "customer" | "admin" | "unlinked";
const FUTURE = () => new Date(Date.now() + 30 * 60_000);
function chat(role: Role, opts: { muted?: boolean } = {}) {
  const replies: any[] = [];
  const steps: string[] = [];
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () =>
    opts.muted ? { lineUserId: U, step: "MUTED", mutedUntil: FUTURE(), unexpectedCount: 0, updatedAt: new Date() } : undefined) as any));
  fakeDispatchBoundary(spies);
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => (role === "teacher" ? { id: "t1", lineUserId: U, nickname: "KK", lineLang: "TH" } : undefined)) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => (role === "customer" ? { id: "p1", lineUserId: U, lineLang: "TH", status: "active", suspendedAt: null } : undefined)) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => (role === "customer" ? { parentId: "p1", lineUserId: U, lineLang: "TH" } : undefined)) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => (role === "admin" ? { key: "line_admin_user_ids", value: [U] } : undefined)) as any));
  spies.push(spyOn(db, "update").mockImplementation((() => ({ set: () => ({ where: async () => {} }) })) as any));
  spies.push(spyOn(db, "insert").mockImplementation((() => ({ values: (v: any) => { if (v?.step) steps.push(v.step); return { onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} }; } })) as any));
  spies.push(spyOn(checkinSvc, "findBookingsForTeacher").mockImplementation((async () => []) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, m: any[]) => { replies.push(...m); }) as any));
  return { replies, steps };
}
const typed = (text: string) => ({ type: "message", replyToken: "rt", source: { userId: U }, message: { type: "text", text } }) as any;
const tap = (data: string) => ({ type: "postback", replyToken: "rt", source: { userId: U }, postback: { data } }) as any;
const chipsOf = (r: any) => (r.quickReply?.items ?? []).map((i: any) => i.action.data);

/** What each role SHOULD be shown: the list key and the chip actions (none for a role with no commands). */
const EXPECT: Record<Role, { key: string; chips: string[] }> = {
  teacher: { key: "teacher_menu_body", chips: ["action=schedule", "action=schedule&range=week", "action=calendar"] },
  customer: { key: "menu_body", chips: ["action=register", "action=mycourses", "action=checkin", "action=leave"] },
  admin: { key: "admin_linked_menu", chips: [] },
  unlinked: { key: "welcome", chips: [] },
};
const ROLES: Role[] = ["teacher", "customer", "admin", "unlinked"];

describe("🔑 TASK-523 — the table: every role × every list surface, by value", () => {
  for (const role of ROLES) {
    test(`${role} · Language/Help (the toggle, TH → EN): the confirmation + THEIR list`, async () => {
      const c = chat(role);
      await handleLineWebhookEvents([tap("action=lang")]);
      expect(c.replies.map((r) => r.text)).toEqual([`${t("lang_switched", "EN")}\n\n${t(EXPECT[role].key, "EN")}`]);
    });
    test(`${role} · reopen in a MUTED chat (the un-mute): THEIR list in the chat's language + THEIR chips (or none)`, async () => {
      const c = chat(role, { muted: true });
      await handleLineWebhookEvents([typed("reopen")]);
      expect(c.replies.map((r) => r.text)).toEqual([t(EXPECT[role].key, "TH")]);
      expect(chipsOf(c.replies[0])).toEqual(EXPECT[role].chips);
      if (!EXPECT[role].chips.length) expect(c.replies[0].quickReply).toBeUndefined(); // LINE refuses an empty items list
    });
  }
  for (const role of ["teacher", "customer", "admin"] as const) {
    for (const word of ["เมนู", "help", "reopen"]) {
      test(`${role} · types \`${word}\` (unmuted): THEIR list (bilingual) + THEIR chips`, async () => {
        const c = chat(role);
        await handleLineWebhookEvents([typed(word)]);
        expect(c.replies.map((r) => r.text)).toEqual([tb(EXPECT[role].key)]);
        expect(chipsOf(c.replies[0])).toEqual(EXPECT[role].chips);
      });
    }
  }
  test("unlinked · types `เมนู` (unmuted): SILENCE, unchanged — AC-16 (stray text from an unlinked chat is not answered)", async () => {
    const c = chat("unlinked");
    await handleLineWebhookEvents([typed("เมนู")]);
    expect(c.replies).toEqual([]);
  });
});

describe("🔑 every advertised word routes for its role (a list is a promise about typing)", () => {
  test("admin: `admin_linked_menu` advertises NO command — nothing to route, nothing false", () => {
    for (const lang of ["TH", "EN"] as const) expect(t("admin_linked_menu", lang)).not.toMatch(/^· /m);
  });
  test("unlinked: `welcome` advertises `สมัคร` / `register` — typed by an unlinked person, each STARTS registration (the role question)", async () => {
    for (const word of ["สมัคร", "register"]) {
      expect(t("welcome", "TH")).toContain(`"${word}"`);
      const c = chat("unlinked");
      await handleLineWebhookEvents([typed(word)]);
      expect({ word, replied: c.replies.length, step: c.steps }).toEqual({ word, replied: 1, step: ["CHOOSE_ROLE"] });
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
  test("🚫 no role is shown the PARENT's four unless it IS a parent (the lie this task closes: admin + unlinked were)", async () => {
    for (const role of ["teacher", "admin", "unlinked"] as const) {
      const c = chat(role, { muted: true });
      await handleLineWebhookEvents([typed("reopen")]);
      expect({ role, parentList: c.replies[0].text.includes(t("menu_body", "TH")) }).toEqual({ role, parentList: false });
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });
});

// ───────────────────────── TASK-524 — the POSTBACK answers, by role: an admin is no longer told to register ─────────────────────────
describe("🔴 TASK-524 — a menu postback is answered as the role that tapped it (the non-parent line reads the ONE decision)", () => {
  const BACK = (lang: "TH" | "EN") => ({ type: "action", action: { type: "postback", label: t("btn_back", lang), data: "action=menu", displayText: t("btn_back", lang) } });
  for (const action of ["menu", "checkin", "mycourses"]) {
    test(`admin taps \`action=${action}\` ⇒ THEIR line (\`admin_linked_menu\`), never \`welcome\``, async () => {
      const c = chat("admin");
      await handleLineWebhookEvents([tap(`action=${action}`)]);
      expect(c.replies).toEqual([{ type: "text", text: tb("admin_linked_menu"), quickReply: { items: [BACK("TH")] } }]);
      expect(c.replies[0].text).not.toContain("สมัคร");
    });
    test(`🚫 unlinked taps \`action=${action}\` ⇒ \`welcome\`, byte-identical to before (the reason the string exists)`, async () => {
      const c = chat("unlinked");
      await handleLineWebhookEvents([tap(`action=${action}`)]);
      expect(c.replies).toEqual([{ type: "text", text: tb("welcome"), quickReply: { items: [BACK("TH")] } }]);
    });
  }
  test("🚫 a TEACHER's postbacks are unchanged: an unknown action ⇒ `teacher_linked`; `schedule` ⇒ the schedule", async () => {
    let c = chat("teacher");
    await handleLineWebhookEvents([tap("action=checkin")]);
    expect(c.replies.map((r) => r.text)).toEqual([tb("teacher_linked")]);
    for (const s of spies.splice(0)) s.mockRestore();
    c = chat("teacher");
    await handleLineWebhookEvents([tap("action=menu")]);
    expect(c.replies.map((r) => r.text)).toEqual([tb("teacher_linked")]);
  });
  test("🚫 a PARENT's postbacks are unchanged: `action=menu` ⇒ their list + their four chips", async () => {
    const c = chat("customer");
    await handleLineWebhookEvents([tap("action=menu")]);
    expect(c.replies.map((r) => r.text)).toEqual([tb("menu_body")]);
    expect(chipsOf(c.replies[0])).toEqual(EXPECT.customer.chips);
  });
});

// ───────────────────────── TASK-525 — the "talk to an admin" alert says WHO asked ─────────────────────────
describe("🔴 TASK-525 — `คุยกับแอดมิน` alerts the admins with a kind naming WHO asked (a coach's is no longer a parent's)", () => {
  const alerts = () => {
    const seen: any[] = [];
    spies.push(spyOn(lineAdmin, "notifyAdmins").mockImplementation((async (p: any) => { seen.push(p); }) as any));
    return seen;
  };
  const EXPECT_KIND: Record<Role, string> = { customer: "parent_asked_for_admin", teacher: "teacher_asked_for_admin", admin: "admin_asked_for_admin", unlinked: "unlinked_asked_for_admin" };
  for (const role of ROLES) {
    test(`${role} taps \`action=admin\` ⇒ the alert's kind is \`${EXPECT_KIND[role]}\``, async () => {
      chat(role);
      const seen = alerts();
      await handleLineWebhookEvents([tap("action=admin")]);
      expect(seen.map((p) => p.kind)).toEqual([EXPECT_KIND[role]]);
    });
  }
  test("🚫 a PARENT's typed twin (`คุยกับแอดมิน`) is unchanged: `parent_asked_for_admin`", async () => {
    chat("customer");
    const seen = alerts();
    await handleLineWebhookEvents([typed("คุยกับแอดมิน")]);
    expect(seen.map((p) => p.kind)).toEqual(["parent_asked_for_admin"]);
  });
  test("📌 an ADMIN tapping it does what it does TODAY, unchanged (TASK-524's finding — the owner's to change): their OWN chat is muted, the admins are alerted, `admin_called` is the reply", async () => {
    const c = chat("admin");
    const seen = alerts();
    await handleLineWebhookEvents([tap("action=admin")]);
    expect(c.steps).toEqual(["MUTED"]); // the mute row, written for the admin's own chat
    expect(seen.length).toBe(1); // …and every admin (themselves included — `notifyAdmins`' own list) is alerted
    expect(c.replies.map((r) => r.text)).toEqual([tb("admin_called")]);
  });
  test("🚫 NO copy invented: all four kinds render the PARKED default (TASK-334), until the owner words them together", () => {
    for (const kind of Object.values(EXPECT_KIND)) {
      for (const lang of ["TH", "EN"] as const) expect({ kind, out: formatOutboxMessage({ kind, lineUserId: "U1" } as any, {}, lang, "admin" as any) }).toEqual({ kind, out: t("ob_default", lang) });
    }
  });
});
