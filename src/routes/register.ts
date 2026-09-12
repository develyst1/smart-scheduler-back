// TASK-347 (`REQ-088`) — `/register`, the sibling of `/checkin`: **registration by LINK, not by typing.**
//
// 🔑 THE CONTRACT (TASK-347 §C0–§C5), in three principles:
//   1. The server returns CODES; the page renders words. There is no `message` field anywhere below.
//   2. The page NEVER says who it is. Every call carries `idToken`; `sub` is the `lineUserId`; no body carries a
//      `lineUserId`, `parentId` or `familyId`. The family is re-derived from the phone or from `sub`, every time.
//   3. Every decision here is the CHAT's function, called — `line-register.service.ts` is the one home, and the
//      chat calls the same functions with its own replies. **If the page grows a rule of its own, it is wrong.**
//
// Rule 6: ONE stable public URL family, mounted beside `publicCheckin`. The token IS the credential, exactly as
// `/checkin?token=` and `/calendar/<token>.ics` already work. No JWT, no per-parent URL.
import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import { z } from "zod";
import { verifyLiffIdToken } from "../lib/line-id-token";
import { deliver2faCode, generate2faCode, matches2faCode } from "../lib/line-2fa";
import { formatPhoneForDisplay } from "../lib/line-webhook";
import { ddmmyyyy } from "../lib/time";
import { MAX_STUDENTS_PER_PARENT } from "../services/parent.service";
import {
  addChildForLineParent,
  clearLinkSession,
  linkFamilyByPhone,
  lookupFamilyByPhone,
  parkedTwoFaCode,
  setTwoFaChallenge,
  settleLinkedRole,
  twoFaEnabled,
} from "../services/line-register.service";

const withToken = z.object({ idToken: z.string().optional() });
const lookupBody = withToken.extend({ phone: z.string().trim().min(1) });
const linkBody = withToken.extend({ phone: z.string().trim().min(1), code: z.string().trim().optional() });
const createBody = withToken.extend({
  name: z.string().optional(),
  birthDate: z.string().optional(), // the customer's `DD-MM-YYYY` text, or absent = ข้าม
  province: z.string().optional(),
  detailProvided: z.boolean().optional(),
});

/** Refusal envelope. 🚫 Never a `message` — the page owns its copy (§C0). */
const refuse = (c: any, status: number, code: string, extra: Record<string, unknown> = {}) =>
  c.json({ ok: false, code, ...extra }, status);

/** The token failures, each its own status/code (§C0). */
const TOKEN_STATUS: Record<string, number> = {
  TOKEN_MISSING: 400,
  TOKEN_WRONG_CHANNEL: 401,
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
};

/** Every decision outcome the chat can produce, as the page's NAMED code (§C1–§C3). One table, both directions. */
const REFUSAL: Record<string, [number, string]> = {
  "phone-invalid": [400, "PHONE_INVALID"],
  "phone-bound-to-other-line": [409, "PHONE_BOUND_TO_OTHER_LINE"],
  "line-bound-to-other-family": [409, "LINE_BOUND_TO_OTHER_FAMILY"],
  "not-linked": [403, "NOT_LINKED"],
  "name-required": [400, "NAME_REQUIRED"],
  "name-reserved": [400, "NAME_RESERVED"],
  "family-full": [409, "FAMILY_FULL"],
  "name-duplicate-needs-detail": [409, "NAME_DUPLICATE_NEEDS_DETAIL"],
  "birthdate-invalid": [400, "BIRTHDATE_INVALID"],
};

const childView = (k: any) => ({ id: k.id, name: k.name, nickname: k.nickname ?? null });

export const publicRegister = new Hono()
  // ── §C1 lookup — "is this phone a family we know?" WRITES NOTHING (except the 2FA send when ON) ──────────
  .post("/register/lookup", zValidator("json", lookupBody), async (c) => {
    const { idToken, phone } = c.req.valid("json");
    const who = await verifyLiffIdToken(idToken);
    if (!who.ok) return refuse(c, TOKEN_STATUS[who.code]!, who.code);
    const sub = who.sub;
    const r = await lookupFamilyByPhone(sub, phone);
    if (r.outcome === "new") return c.json({ ok: true, outcome: "new", phone: formatPhoneForDisplay(r.phone) });
    if (r.outcome !== "found") return refuse(c, ...REFUSAL[r.outcome]!);
    const { parent, children } = r;
    // 🔀 Rule 3 — `line_parent_2fa` is READ here, and when ON the names are gated behind the code (TASK-047's
    // rule wherever a gate exists — the chat's exact behaviour at the same point). `deliver2faCode` throws
    // loudly if delivery was never configured, as it does for the chat; that surfaces as `TWOFA_NOT_CONFIGURED`.
    if (await twoFaEnabled()) {
      try {
        const code = generate2faCode();
        deliver2faCode(sub, code);
        await setTwoFaChallenge(sub, code); // the chat's writer, the chat's row
      } catch (e) {
        console.error("[register] 2FA delivery not configured:", e);
        return refuse(c, 500, "TWOFA_NOT_CONFIGURED");
      }
      return c.json({ ok: true, outcome: "found", phone: formatPhoneForDisplay(parent.phone), twoFactor: "required", childCount: children.length });
    }
    return c.json({ ok: true, outcome: "found", phone: formatPhoneForDisplay(parent.phone), children: children.map(childView) });
  })

  // ── §C2 link — bind this LINE account to that family. THE WRITE. ─────────────────────────────────────────
  .post("/register/link", zValidator("json", linkBody), async (c) => {
    const { idToken, phone, code } = c.req.valid("json");
    const who = await verifyLiffIdToken(idToken);
    if (!who.ok) return refuse(c, TOKEN_STATUS[who.code]!, who.code);
    // 🔀 Rule 3 — when ON, the code is checked BEFORE the write, with the chat's own `matches2faCode`.
    if (await twoFaEnabled()) {
      if (!code) return refuse(c, 428, "TWOFA_CODE_REQUIRED");
      if (!matches2faCode(await parkedTwoFaCode(who.sub), code)) return refuse(c, 401, "TWOFA_CODE_BAD");
    }
    // 🔑 `phone` again, not a family id: the server re-looks it up and RE-CHECKS every refusal at the write.
    const r = await linkFamilyByPhone(who.sub, phone);
    if (r.outcome !== "linked") return refuse(c, ...REFUSAL[r.outcome]!);
    // The chat's post-link ORDER, exactly: seed the language → link the rich menus → THEN the session.
    await settleLinkedRole(who.sub, "customer");
    // 🔴 Rule 4 — no chat session step is left dangling: a parent may have half-started `สมัคร` before an admin
    // sent the link. (The chat does the same through `afterParentLink`: clear, or advance into the wizard.)
    await clearLinkSession(who.sub);
    const canAddMore = r.children.length < MAX_STUDENTS_PER_PARENT; // the cap, not a copy of it
    return c.json({ ok: true, outcome: "linked", isNew: r.isNew, children: r.children.map(childView), canAddMore });
  })

  // ── §C3 create — add a child to MY family. THE ONE WRITER. ───────────────────────────────────────────────
  .post("/register/create", zValidator("json", createBody), async (c) => {
    const { idToken, name, birthDate, province, detailProvided } = c.req.valid("json");
    const who = await verifyLiffIdToken(idToken);
    if (!who.ok) return refuse(c, TOKEN_STATUS[who.code]!, who.code);
    // 🔑 The family is `sub`'s — no phone, no id. The guards run in the CHAT's order inside this one call.
    const r = await addChildForLineParent(who.sub, { name: name ?? "", birthDate: birthDate ?? null, province: province ?? null, detailProvided });
    if (r.outcome !== "created") {
      const [status, code] = REFUSAL[r.outcome]!;
      const extra = r.outcome === "name-reserved" ? { word: r.word } : r.outcome === "family-full" ? { max: r.max } : r.outcome === "name-duplicate-needs-detail" ? { name: r.name } : {};
      return refuse(c, status, code, extra);
    }
    await clearLinkSession(who.sub); // Rule 4, on this door too
    return c.json({
      ok: true,
      outcome: "created",
      student: r.student,
      birthDate: r.birthDate ? ddmmyyyy(r.birthDate) : null, // the customer's `DD-MM-YYYY`, back — `time.ts`'s ONE formatter
      count: r.count,
      atMax: r.atMax,
      canAddMore: !r.atMax,
    });
  });

