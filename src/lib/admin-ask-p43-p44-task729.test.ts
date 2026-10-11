// 🔻 TASK-729 (P43 / P44; the text is APPROVED, the FALLBACK is 📋 DRAFT — Khwan Q7 pending) — the last two «คุยกับแอดมิน» admin notices.
// P43 \`admin_asked_for_admin\`: 🔔 Please support Admin "{chatName}".   P44 \`unlinked_asked_for_admin\`: 🔔 Please support "{chatName}".   ONE text for both languages.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOutboxMessage } from "./line-message";
import { getProfileDisplayName } from "./line-client";
import { bangkokNow } from "./bangkok-time";
import { t } from "./line-i18n";
import { withAskerName } from "../services/outbox.service";

const render = (payload: any, lang: "TH" | "EN") => formatOutboxMessage(payload, {}, lang, "parent");

describe("🔴 TASK-729 — P43 / P44 by value", () => {
  for (const lang of ["TH", "EN"] as const) {
    test("with the LINE display name — " + lang, () => {
      expect(render({ kind: "admin_asked_for_admin", chatName: "Anna" }, lang)).toBe('🔔 Please support Admin "Anna".');
      expect(render({ kind: "unlinked_asked_for_admin", chatName: "Anna" }, lang)).toBe('🔔 Please support "Anna".');
    });
    test("📋 DRAFT fallback (Khwan Q7): no name ⇒ `ผู้ใช้ LINE · HH:mm` of the press; blank name = no name; no time ⇒ the bare words — " + lang, () => {
      expect(render({ kind: "admin_asked_for_admin", pressedAt: "14:05" }, lang)).toBe('🔔 Please support Admin "ผู้ใช้ LINE · 14:05".');
      expect(render({ kind: "unlinked_asked_for_admin", chatName: "  ", pressedAt: "09:30" }, lang)).toBe('🔔 Please support "ผู้ใช้ LINE · 09:30".');
      expect(render({ kind: "unlinked_asked_for_admin", chatName: null }, lang)).toBe('🔔 Please support "ผู้ใช้ LINE".');
    });
    test("never the generic bell — " + lang, () => {
      for (const kind of ["admin_asked_for_admin", "unlinked_asked_for_admin"]) expect(render({ kind }, lang)).not.toBe(t("ob_default", lang));
    });
  }
  test("the fallback key is the DRAFT-marked one and the time is HH:mm (the house format)", () => {
    expect(t("aa_chat_fallback", "TH")).toBe("ผู้ใช้ LINE");
    expect(readFileSync(resolve(import.meta.dir, "line-i18n.ts"), "utf8")).toContain("📋 DRAFT wording: Khwan Q7 pending");
    expect(bangkokNow().time).toMatch(/^\d{2}:\d{2}$/);
  });
  test("P40 · P41 · P42 are unchanged (727's words)", () => {
    expect(render({ kind: "student_registered", studentName: "B" }, "EN")).toBe("🔔 Student: B registered");
    expect(render({ kind: "parent_asked_for_admin", studentNames: ["B"] }, "EN")).toBe("🔔 Please support Parent of Student B.");
    expect(render({ kind: "teacher_asked_for_admin", coachName: "B" }, "EN")).toBe("🔔 Please support Coach B.");
  });
});

describe("🔴 TASK-729 — the display-name read: best-effort, a failure costs the NAME, never the alert", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  const saved = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); if (saved === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN; else process.env.LINE_CHANNEL_ACCESS_TOKEN = saved; });
  const fetchAs = (impl: () => Promise<any>) => { process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token"; spies.push(spyOn(globalThis, "fetch").mockImplementation(impl as any)); };
  test("the name is returned, trimmed", async () => {
    fetchAs(async () => ({ ok: true, json: async () => ({ displayName: "  Anna  ", language: "th" }) }));
    expect(await getProfileDisplayName("U1")).toBe("Anna");
  });
  test("no token · HTTP error · network throw · empty name ⇒ null (never throws)", async () => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    expect(await getProfileDisplayName("U1")).toBeNull();
    fetchAs(async () => ({ ok: false, json: async () => ({}) }));
    expect(await getProfileDisplayName("U1")).toBeNull();
    while (spies.length) spies.pop()!.mockRestore();
    fetchAs(async () => { throw new Error("network"); });
    expect(await getProfileDisplayName("U1")).toBeNull();
    while (spies.length) spies.pop()!.mockRestore();
    fetchAs(async () => ({ ok: true, json: async () => ({ displayName: "   " }) }));
    expect(await getProfileDisplayName("U1")).toBeNull();
  });
});

describe("🔴 TASK-729 — 'never stored' (owner, literally): the row carries NO name; the push worker reads it at send time, on a copy", () => {
  const W = readFileSync(resolve(import.meta.dir, "../services/line-webhook.service.ts"), "utf8").replace(/\r\n/g, "\n");
  const O = readFileSync(resolve(import.meta.dir, "../services/outbox.service.ts"), "utf8").replace(/\r\n/g, "\n");
  const handler = W.slice(W.indexOf("async function doCallAdmin("), W.indexOf("async function doTeacherSchedule("));
  const spies: Array<{ mockRestore: () => void }> = [];
  const saved = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); if (saved === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN; else process.env.LINE_CHANNEL_ACCESS_TOKEN = saved; });
  const fetchAs = (impl: (url: string) => Promise<any>) => { process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token"; const sp = spyOn(globalThis, "fetch").mockImplementation(impl as any); spies.push(sp); return sp; };

  test("the HANDLER writes a payload with the asker's id and the press time — no name, and no profile read at all", () => {
    expect(handler).toContain("names = { pressedAt: bangkokNow().time };");
    expect(handler).toContain("await notifyAdmins({ kind: adminAskKind(who), lineUserId, ...names });");
    expect(handler).not.toContain("chatName");
    expect(handler).not.toContain("getProfileDisplayName");
    expect(W).not.toContain("getProfileDisplayName"); // not even imported into the webhook
  });
  test("🚫 the name is never written to a table of ours and never logged — handler and worker", () => {
    expect(handler.slice(handler.indexOf(".insert(lineLinkSessions)"))).not.toContain("chatName");
    for (const src of [handler, O]) {
      expect(src).not.toMatch(/console\.\w+\([^;]*chatName/); // the whole statement, not just up to the first `)`
      expect(src).not.toMatch(/console\.\w+\([^;]*displayName/);
    }
    // the worker never writes the enriched copy back: no `.set(` anywhere near the name
    expect(O).not.toMatch(/\.set\([^;]*chatName/);
    expect(O).toContain("formatOutboxMessage(await withAskerName(row.payload as any), ctx, lang, audience)");
  });
  test("the worker's read: the ASKER's name goes onto a COPY; the row's payload object is untouched (no name in the row)", async () => {
    const sp = fetchAs(async () => ({ ok: true, json: async () => ({ displayName: "Anna" }) }));
    const row = { kind: "admin_asked_for_admin", lineUserId: "U-asker", pressedAt: "14:05" };
    const out = await withAskerName(row);
    expect(out).toEqual({ ...row, chatName: "Anna" });
    expect(out).not.toBe(row);
    expect("chatName" in row).toBe(false); // the stored payload still carries no name
    expect(String(sp.mock.calls[0]![0])).toContain("/profile/U-asker"); // the ASKER's profile, not the recipient's
    expect(render(out, "EN")).toBe('🔔 Please support Admin "Anna".');
  });
  test("a failed read ⇒ no name ⇒ the DRAFT fallback with the press time; the send goes on (never throws)", async () => {
    fetchAs(async () => { throw new Error("network"); });
    const out = await withAskerName({ kind: "unlinked_asked_for_admin", lineUserId: "U-asker", pressedAt: "09:30" });
    expect(out.chatName).toBeNull();
    expect(render(out, "TH")).toBe('🔔 Please support "ผู้ใช้ LINE · 09:30".');
    expect((await withAskerName({ kind: "admin_asked_for_admin" })).chatName).toBeNull(); // no asker id ⇒ no read
  });
  test("every other kind passes through untouched — the same object, and NO profile read", async () => {
    const sp = fetchAs(async () => ({ ok: true, json: async () => ({ displayName: "Nope" }) }));
    for (const kind of ["parent_asked_for_admin", "teacher_asked_for_admin", "student_registered", "booking_confirmed"]) {
      const p = { kind, lineUserId: "U1" };
      expect(await withAskerName(p)).toBe(p);
    }
    expect(sp.mock.calls.length).toBe(0);
  });
});
