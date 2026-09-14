// TASK-354 (`REQ-088 §10.3`) — a linked account is TOLD, and can UNLINK through the ONE writer; item 12 closed.
//
// 🔴 The owner found item 12 on his phone: *"เมื่อเราเชื่อมรหัสไปแล้วครั้งนึง แต่กดลิ้งอีกแล้วพอกดเบอร์อื่น … มันไม่มี error
// หรือ warning มาเตือน แต่เงียบไปเฉยๆเลย"*. TASK-347 had mirrored that gap from the chat per Rule 1 and NAMED it;
// two days later a person met it by USING the product. His fix is better than a refusal: TELL them, let them UNLINK.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { maskPhone } from "./line-register.service";

const read = async (rel: string) => readSrc(await Bun.file(new URL(rel, import.meta.url)).text());
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const REG = code(await read("./line-register.service.ts"));
const ROUTE = code(await read("../routes/register.ts"));
const CHAT = code(await read("./line-webhook.service.ts"));
const PARENT = code(await read("./parent.service.ts"));
const VAL = await read("../validation.ts");
const REG_RAW = await read("./line-register.service.ts");
const API = code(await read("../routes/api.ts"));
const FAMILY_RAW = await read("../lib/family-link.ts");
const fnIn = (S: string, sig: string) => { const i = S.indexOf(sig); if (i < 0) throw new Error("no " + sig); return S.slice(i, S.indexOf("\n}\n", i) + 2); };
const handler = (path: string) => { const i = ROUTE.indexOf(`"${path}"`); const rest = ROUTE.slice(i); const next = rest.indexOf(".post(", 10); return next > 0 ? rest.slice(0, next) : rest; };

describe("🔴 ITEM 12 — a bound account + a phone that is not its family's is REFUSED, even when the phone is NEW", () => {
  test("🔑 `linkFamilyByPhone` checks `familyOfLineUser` BEFORE creating any parent row on the new-phone path", () => {
    const link = fnIn(REG, "export async function linkFamilyByPhone(");
    const newPath = link.slice(link.lastIndexOf("findParentByPhone(phone)"));
    expect(newPath).toContain('if (await familyOfLineUser(lineUserId)) return { outcome: "line-bound-to-other-family" };');
    expect(newPath.indexOf("familyOfLineUser(")).toBeLessThan(newPath.indexOf("findOrCreateParentByPhone("));
    // 🚫 …and the old NAMED-NOT-FIXED note is gone from the code: the gap is closed, not documented.
    expect(REG_RAW).not.toContain("NAMED, NOT FIXED");
  });

  test("🔑 `lookupFamilyByPhone` says the same thing on the read-only path — the page can warn before a tap", () => {
    const lookup = fnIn(REG, "export async function lookupFamilyByPhone(");
    expect(lookup).toContain('if (!existing) return current ? { outcome: "line-bound-to-other-family" } : { outcome: "new", phone };');
  });

  test("⚠️ the CHAT changed with it — same writer — and the reply it now gives ALREADY EXISTS for this meaning", () => {
    // A linked parent typing `สมัคร` + another phone used to reach `verify_parent_ok_new` (and an orphan row).
    // The extracted outcome now says `line-bound-to-other-family`, and the chat maps that to the key that has
    // meant exactly this since SPEC-071: *"this LINE account belongs to another family — contact an admin."*
    const verify = fnIn(CHAT, "async function verifyAndLink(");
    expect(verify).toContain('if (r.outcome === "line-bound-to-other-family") return { ok: false, message: (l) => t("verify_parent_other_family", l) };');
    expect(verify.indexOf('"line-bound-to-other-family"')).toBeLessThan(verify.indexOf("if (r.isNew)"));
    // 🚫 no new key, no new copy: the chat's five verify keys are still five.
    // (`verify_parent_ok_existing` is rendered twice — with and without the 2FA note — so count DISTINCT keys.)
    expect(new Set(verify.match(/t\("verify_parent_[a-z_]+"/g) ?? []).size).toBe(5);
  });
});

describe("🔑 `status` — TOLD, with a MASKED phone and NO names", () => {
  test("the mask: first TWO digits, every other digit `x`, the customer's grouping", () => {
    expect(maskPhone("0812345678")).toBe("08x-xxx-xxxx");
    expect(maskPhone("0999999999")).toBe("09x-xxx-xxxx");
    // 🚫 nothing beyond the prefix survives — the last four are NOT shown, on purpose.
    expect(maskPhone("0812345678")).not.toContain("5678");
    expect(maskPhone("0812345678")).not.toContain("123");
  });

  test("🚫 a non-standard phone is masked ENTIRELY rather than leaked", () => {
    for (const odd of ["+66812345678", "812345678", "02123456", "", "abc"]) {
      expect({ odd, masked: maskPhone(odd) }).toEqual({ odd, masked: "xxx-xxx-xxxx" });
    }
  });

  test("🔑 the route hands the page ONLY `linked`, the masked `phone` and a `childCount` — no ids, no names", () => {
    const h = handler("/register/status");
    expect(h).toContain("await linkStatus(who.sub)");
    expect(h).toContain("phone: s.phone, childCount: s.childCount");
    for (const leak of ["parentId", "children:", "name", "nickname"]) expect({ leak, inReply: h.includes(leak) }).toEqual({ leak, inReply: false });
    // …and the decision masks on the SERVER: the raw phone never reaches the route.
    const status = fnIn(REG, "export async function linkStatus(");
    expect(status).toContain("phone: maskPhone(parent.phone)");
  });

  test("`status` writes nothing", () => {
    const status = fnIn(REG, "export async function linkStatus(");
    for (const w of ["insert(", "update(", "delete(", "clearParentLineLink("]) expect({ w, writes: status.includes(w) }).toEqual({ w, writes: false });
  });
});

describe("🔑 `unlink` — the ONE writer, one more door, actor stated", () => {
  test("🔴 it calls `clearParentLineLink` — the admin's own service function — and nothing else clears a link", () => {
    const un = fnIn(REG, "export async function unlinkSelf(");
    expect(un).toContain("await clearParentLineLink(parent.id, `line:${lineUserId}`)");
    // 🚫 by ABSENCE: no second unlink path — not in the home, not in the route.
    for (const S of [REG, ROUTE]) {
      expect(S).not.toContain("delete(familyLineLinks)");
      expect(S).not.toContain("lineUserId: null");
      expect(S).not.toContain("clearFamilyLine(");
    }
    // …and the admin's door is UNCHANGED: the same function, the admin as actor.
    expect(PARENT).toContain("export async function clearParentLineLink(id: string, actor: string | null)");
    expect(API).toContain('parent.clearParentLineLink(c.req.param("id"), c.get("user")?.sub ?? null)');
  });

  test("🔑 the actor is `line:<sub>` — the audit says a PARENT did this to themselves", () => {
    expect(fnIn(REG, "export async function unlinkSelf(")).toContain("`line:${lineUserId}`");
    // …and the audit line prints it.
    expect(FAMILY_RAW).toContain('by=${actor ?? "unknown"}');
  });

  test("not linked ⇒ `unlinked: false`, idempotent, not an error — the page proceeds to `lookup` either way", () => {
    const un = fnIn(REG, "export async function unlinkSelf(");
    expect(un).toContain("if (!parent) return { unlinked: false, cleared: 0 };");
    const h = handler("/register/unlink");
    expect(h).toContain("c.json({ ok: true, unlinked: false })");
    expect(h).not.toContain("refuse(c, 4");
  });

  test("⚠️ the consequence is written where the writer is: it clears the FAMILY's binding, every account", () => {
    const raw = REG_RAW;
    expect(raw).toContain("EVERY account the family holds, not only this one");
    expect(raw).toContain("this door does not narrow it");
  });

  test("Rule 4 still — the chat session goes with the family", () => {
    expect(handler("/register/unlink")).toContain("await clearLinkSession(who.sub)");
  });

  test("both new routes are token-first, POST, `{ idToken }` only", () => {
    for (const p of ["/register/status", "/register/unlink"]) {
      const h = handler(p);
      expect({ p, tokenFirst: h.indexOf("verifyLiffIdToken(") < h.indexOf("who.sub") }).toEqual({ p, tokenFirst: true });
      expect({ p, body: h.includes('zValidator("json", withToken)') }).toEqual({ p, body: true });
    }
  });
});

describe("✅ the cap — the PARENT's note is 2000; every other `max(500)` is untouched", () => {
  test("`createParent.note` and `updateParent.note` are 2000", () => {
    const create = VAL.slice(VAL.indexOf("export const createParent = z.object({"), VAL.indexOf("export const updateParent"));
    const update = VAL.slice(VAL.indexOf("export const updateParent = z.object({"), VAL.indexOf("export const createParentStudent"));
    expect(create).toContain("note: z.string().trim().max(2000).nullish()");
    expect(update).toContain("note: z.string().trim().max(2000).nullish()");
    expect(create).not.toContain("max(500)");
    expect(update).not.toContain("max(500)");
  });

  test("🚫 …and the other SIX `max(500)`s on that file are other fields, still 500", () => {
    // 8 before this task; the two parent-note caps moved; six remain, and they are not the parent's.
    expect((VAL.match(/max\(500\)/g) ?? []).length).toBe(6);
    expect((VAL.match(/max\(2000\)/g) ?? []).length).toBe(2);
    // the reason is beside the number, so the next reader does not lower it back for tidiness.
    expect(VAL).toContain("a cap the machine can exceed means the ADMIN cannot save what the SYSTEM wrote");
  });
});
