// TASK-473 (REQ-107 §7) — round 2, by value, both languages, through the REAL dispatcher where a parent can see it.
// K0a Sign Up's own words · K0b the publish report · K1 the toggle (BOTH directions) · K3 her admin words + collapsed
// menus · K4 `Teacher <name>` on what a tapped pick SENDS, with LINE's 20-character button cap pinned on a long name.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleLineWebhookEvents } from "./line-webhook.service";
import * as checkinSvc from "./checkin.service";
import * as lineClient from "../lib/line-client";
import { db } from "../db";
import { fakeDispatchBoundary } from "../test-support/line-dispatch-fakes"; // TASK-504 — the dispatcher's own un-mute write + family read, faked at the boundary
import { t, tb } from "../lib/line-i18n";
import { CUSTOMER_MENU, TEACHER_MENU, UNKNOWN_MENU } from "../lib/line-rich-menu";
import { sessionPick } from "../lib/line-leave";
import { bookingPicker } from "../lib/line-reply";
import { formatStoredIds } from "../../scripts/line-publish-menus";
import { readSrc } from "../lib/read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const U = "Uaeeb9c20ca9";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** A LINKED parent whose chat language is `lang` — every read and write faked (the TASK-447 harness shape). */
const parentChat = (lang: "TH" | "EN") => {
  const replies: any[] = [];
  const writes: any[] = [];
  spies.push(spyOn(db.query.lineLinkSessions, "findFirst").mockImplementation((async () => undefined) as any));
  fakeDispatchBoundary(spies); // TASK-504
  spies.push(spyOn(db.query.teachers, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.parents, "findFirst").mockImplementation((async () => ({ id: "p1", lineUserId: U, lineLang: lang, status: "active" })) as any));
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async () => undefined) as any));
  spies.push(spyOn(db.query.familyLineLinks, "findFirst").mockImplementation((async () => ({ parentId: "p1", lineUserId: U, lineLang: lang })) as any));
  spies.push(spyOn(db, "insert").mockImplementation((() => ({ values: (val: any) => ({ onConflictDoUpdate: async () => { writes.push(val); }, onConflictDoNothing: async () => {} }) })) as any));
  spies.push(spyOn(db, "update").mockImplementation((() => ({ set: (patch: any) => ({ where: async () => { writes.push(patch); } }) })) as any));
  spies.push(spyOn(lineClient, "replyMessage").mockImplementation((async (_t: string, messages: any[]) => { replies.push(...messages); }) as any));
  return { replies, writes };
};
const tap = (data: string) => ({ type: "postback", replyToken: "rt", source: { userId: U }, postback: { data } }) as any;

describe("✅ K1 — the language toggle: confirmation, a BLANK LINE, the list — in ONE message, BOTH directions", () => {
  const EN = "Switched to English ✅\n\nAvailable Commands:\n\n· Add Student — Up to 5\n· My Course — Registered Course\n· Check-in — Check in today's class\n· Request Leave";
  const TH = "เปลี่ยนเป็นภาษาไทยแล้ว ✅\n\nคำสั่งที่ใช้ได้:\n\n· เพิ่มนักเรียน — สูงสุด 5 คน\n· คอร์สของฉัน — คอร์สเรียนที่มี\n· เช็คอิน — ลงทะเบียนเข้าเรียน\n· แจ้งลา";
  test("TH chat → EN: one reply, the whole EN message", async () => {
    const c = parentChat("TH");
    await handleLineWebhookEvents([tap("action=lang")]);
    expect(c.replies.map((r) => r.text)).toEqual([EN]);
  });
  test("🔴 EN chat → TH (the direction Tanya's shot questioned): one reply, the confirmation AND the TH list", async () => {
    const c = parentChat("EN");
    await handleLineWebhookEvents([tap("action=lang")]);
    expect(c.replies.map((r) => r.text)).toEqual([TH]);
  });
  test("there is ONE toggle path in the service — no second branch that could send the line alone", () => {
    const SVC = code(readSrc(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8")));
    expect((SVC.match(/await toggleLang\(/g) ?? []).length).toBe(1); // the one CALL (the definition is not a call)
    expect((SVC.match(/t\("lang_switched"/g) ?? []).length).toBe(1);
  });
});

describe("✅ K0a — Sign Up has its own words (the link unchanged, TASK-469)", () => {
  test("by value", () => {
    expect(tb("liff_signup")).toBe("กรุณากดที่ลิ้งค์ด้านล่างเพื่อสมัครสมาชิกค่ะ\nPlease click the link below to sign up.");
    expect(tb("liff_signup")).not.toBe(tb("liff_add_student"));
  });
});

describe("🔴 K0b — the publish prints the ids it STORED (read back after the merge), never `undefined`", () => {
  const created = { unknown: "richmenu-U2", customer: "richmenu-C2", teacher: "richmenu-T2" };
  test("by value: the three role ids marked NEW, the default named, every legacy id still stored listed", () => {
    const stored = { ...created, knownTH: "richmenu-K1", parentTH: "richmenu-P1", unknownTH: "richmenu-X1", knownEN: "" };
    expect(formatStoredIds(stored, created)).toEqual([
      "✓ Published rich menus — ids STORED in app_settings.line_rich_menu_ids (read back after the merge):",
      "  unknown  : richmenu-U2   ← NEW · account DEFAULT",
      "  customer : richmenu-C2   ← NEW",
      "  teacher  : richmenu-T2   ← NEW",
      "  legacy ids still stored (the relink sweep reads them to recognise old followers; removed only with the old menus):",
      "    knownTH   : richmenu-K1",
      "    parentTH  : richmenu-P1",
      "    unknownTH : richmenu-X1",
    ]);
  });
  test("🔴 a role id the read-back LACKS is said out loud — and no line ever prints `undefined`", () => {
    const out = formatStoredIds({ unknown: "richmenu-U2" }, created);
    expect(out[2]).toBe("  customer : -   ← ⚠️ NOT STORED");
    expect(out.join("\n")).not.toContain("undefined");
    expect(formatStoredIds({ unknown: "old", customer: "richmenu-C2", teacher: "richmenu-T2" }, created)[1]).toBe(
      "  unknown  : old   ← kept from an earlier publish · account DEFAULT",
    );
  });
  test("the script prints THAT, from the read-back — not the ids it assumed", () => {
    const S = code(readFileSync(resolve(root, "scripts/line-publish-menus.ts"), "utf8"));
    expect(S).toContain("for (const line of formatStoredIds(await getMenuIds(), ids)) console.log(line);");
    expect(S).not.toMatch(/ids\.(parentTH|parentEN|teacherTH|teacherEN|unknownTH|knownTH)\}/);
  });
});

describe("📌 §3 — what the SECOND publish's dry run will say (a fact for the runbook, pinned so it cannot drift unseen)", () => {
  test("🔴 a follower on a RUN-1 per-role menu reads `stale`, NOT `variant` — the merge overwrites the role keys, so run 1's ids are no longer stored; a legacy follower still reads `variant`; BOTH are relinked", () => {
    const { planRelink } = require("../lib/line-relink-plan");
    const run2 = { unknown: "U2", customer: "C2", teacher: "T2", knownTH: "K0", teacherTH: "T0" };
    const users = [
      { lineUserId: "a", name: "on run-1 customer", role: "customer", lang: "TH", linkedMenuId: "C1" },
      { lineUserId: "b", name: "on legacy knownTH", role: "customer", lang: "TH", linkedMenuId: "K0" },
      { lineUserId: "c", name: "on run-2 already", role: "customer", lang: "EN", linkedMenuId: "C2" },
    ];
    const plan = planRelink(users, run2);
    expect(plan.rows.map((r: any) => [r.user.lineUserId, r.outcome, r.linkedLabel])).toEqual([
      ["a", "stale", null],
      ["b", "variant", "knownTH"],
      ["c", "ok", "customer"],
    ]);
    expect(plan.toRelink.map((r: any) => r.user.lineUserId)).toEqual(["a", "b"]);
  });
});

describe("⛔ §3 — `line:remove-menus` has NO 'old menus only' mode: it plans the CURRENT set too (a runbook hazard, pinned as fact)", () => {
  test("🔴 with run 2 stored and run 1 left on the channel, the removal plan deletes BOTH — the live menus included", () => {
    const { planMenuRemoval } = require("../lib/line-menu-removal-plan");
    const stored = { unknown: "U2", customer: "C2", teacher: "T2" };
    const channel = [
      { richMenuId: "U1", name: "smart-scheduler-unknown" }, { richMenuId: "C1", name: "smart-scheduler-customer" },
      { richMenuId: "U2", name: "smart-scheduler-unknown" }, { richMenuId: "C2", name: "smart-scheduler-customer" }, { richMenuId: "T2", name: "smart-scheduler-teacher" },
    ];
    const ids = planMenuRemoval(stored, channel, "U2").toDelete.map((d: any) => d.id).sort();
    expect(ids).toEqual(["C1", "C2", "T2", "U1", "U2"]); // ⚠️ the three LIVE ids are in it — "delete the old menus" with this tool deletes all
  });
});

describe("✅ K3 — Chat with Admin: her words; all three menus published COLLAPSED", () => {
  test("her words, both languages, and no reopen hint", () => {
    expect(t("admin_called", "TH")).toBe("สักครู่นะคะ แอดมินจะเข้ามาตอบกลับเร็ว ๆ นี้นะคะ");
    expect(t("admin_called", "EN")).toBe("Admin will talk to you soon.");
  });
  test("🔑 `selected: false` on all three per-role definitions — and the unlinked one is STILL the account default", () => {
    expect([UNKNOWN_MENU, CUSTOMER_MENU, TEACHER_MENU].map((m) => [m.name, m.selected])).toEqual([
      ["smart-scheduler-unknown", false],
      ["smart-scheduler-customer", false],
      ["smart-scheduler-teacher", false],
    ]);
    expect(code(readFileSync(resolve(root, "src/lib/line-rich-menu.ts"), "utf8"))).toContain("await setDefaultRichMenu(unknown);");
  });
});

describe("✅ K4 — what a tapped pick SENDS says `Teacher <name>`, check-in AND leave; the button fits 20", () => {
  const LONG = "Maximiliana-Rosalind"; // 20 characters on its own — a real risk, not a contrived one
  const row = (id: string, time: string, extra: Record<string, unknown> = {}) => ({
    id, studentId: "s1", date: "2026-09-25", startTime: time, status: "confirmed",
    student: { id: "s1", name: "Feen Full", nickname: "Feen" }, teacher: { nickname: LONG }, subject: { name: "Private BALLET" }, ...extra,
  });

  test("🔴 CHECK-IN through the dispatcher, both languages: the chat shows the FULL row; the button is ≤ 20", async () => {
    for (const lang of ["TH", "EN"] as const) {
      const c = parentChat(lang);
      spies.push(spyOn(checkinSvc, "findTodayBookingsForParent").mockImplementation((async () => [row("b1", "10:00:00"), row("b2", "11:00:00", { coStudent: { id: "s2", name: "Pun Full", nickname: "Pun" } })]) as any));
      await handleLineWebhookEvents([tap("action=checkin")]);
      const items = c.replies[0].quickReply.items.filter((i: any) => i.action.data?.startsWith("action=checkin&"));
      expect(items.map((i: any) => i.action.displayText)).toEqual([
        `Feen · 10:00 · Teacher ${LONG} · Private BALLET`,
        `Feen & Pun · 11:00 · Teacher ${LONG} · Private BALLET`, // the ONE name rule — a DUO row names both
      ]);
      for (const i of items) expect({ lang, label: i.action.label, fits: [...i.action.label].length <= 20 }).toEqual({ lang, label: i.action.label, fits: true });
      for (const s of spies.splice(0)) s.mockRestore();
    }
  });

  test("🔴 LEAVE: the tap now SENDS the full row too (it used to send only `25/09 10:00` — no teacher); the button stays the 11-char date+time", () => {
    for (const lang of ["TH", "EN"] as const) {
      const p = sessionPick(row("b1", "10:00:00") as any, lang);
      expect(p.button).toBe("25/09 10:00");
      expect(p.body).toBe(`${lang === "TH" ? "ศุกร์" : "Friday"} 25/09 · 10:00 · Teacher ${LONG} · Private BALLET`);
    }
    const SVC = code(readSrc(readFileSync(resolve(root, "src/services/line-webhook.service.ts"), "utf8")));
    expect(SVC).toContain("return { id: b.id, label: dated?.button ?? label, body: dated?.body ?? label, text: dated?.body ?? label };");
  });

  test("the picker: `displayText` is the full text, `label` is clamped to 20 — never the other way round", () => {
    const m: any = bookingPicker("p", "leave", [{ id: "b1", label: `10:00 · Teacher ${LONG} · Private BALLET`, text: "FULL ROW" }], "EN");
    expect(m.quickReply.items[0].action.displayText).toBe("FULL ROW");
    expect([...m.quickReply.items[0].action.label].length).toBeLessThanOrEqual(20);
  });
});
