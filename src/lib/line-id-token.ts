// TASK-347 (`REQ-088` Rule 2) — **the page must PROVE who it is.**
//
// 🔴 A LIFF page runs in the parent's LINE app and can ask LIFF for an ID TOKEN — a JWT LINE signed, naming the
// user (`sub`) and the Login channel it was issued for (`aud`). **We verify it SERVER-SIDE against the customer's
// Login channel ID.** 🚫 A page that trusts the client's claim of who it is, is TASK-047's failure by a new route:
// anyone who can POST can say `lineUserId: <someone else>` and open another family's children.
//
// 🔑 `sub` is the `lineUserId` — the SAME identity the webhook sees on a message. That is what lets the page and
// the chat be two doors to ONE family binding.
export type IdTokenVerification =
  | { ok: true; sub: string }
  | { ok: false; code: "TOKEN_MISSING" | "TOKEN_WRONG_CHANNEL" | "TOKEN_INVALID" | "TOKEN_EXPIRED" };

/** LINE's verification endpoint. `id_token` + `client_id` ⇒ the claims, or an error. */
export const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";

/** The customer's LINE Login channel ID — from THEIR console, the same class of setting as the webhook URL. */
export const loginChannelId = (): string | undefined => process.env.LINE_LOGIN_CHANNEL_ID?.trim() || undefined;

/**
 * The `aud` claim, read WITHOUT verifying. 🔑 **Trusted for NOTHING but choosing the error code**: it decides
 * whether a refusal reads `TOKEN_WRONG_CHANNEL` or `TOKEN_INVALID`; verification still happens, at LINE, for
 * every token that passes this. ⚠️ A token whose payload cannot even be decoded is simply `TOKEN_INVALID`.
 */
export function decodeAud(idToken: string): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return typeof payload?.aud === "string" ? payload.aud : null;
  } catch {
    return null;
  }
}

/**
 * Verify a LIFF ID token and return the LINE user it names.
 *
 * ⚠️ **The three failures are DIFFERENT replies on purpose, and the middle one is the interesting one:**
 * - `TOKEN_MISSING` — the page sent nothing.
 * - 🔴 `TOKEN_WRONG_CHANNEL` — the token's `aud` is not OUR Login channel. **That is a page built on ANOTHER
 *   channel pointed at our API — a misconfiguration or an impersonation — and it is logged LOUDLY as such**, not
 *   folded into "invalid" where nobody would look. It is decided from the local decode BEFORE calling LINE,
 *   because LINE's own reply does not distinguish it.
 * - `TOKEN_EXPIRED` / `TOKEN_INVALID` — LINE's verdict. Expired ⇒ the page re-inits LIFF and retries; invalid ⇒
 *   it does not.
 * 🚫 **No `LINE_LOGIN_CHANNEL_ID` ⇒ every token is `TOKEN_WRONG_CHANNEL`.** Never "skip verification": an unset
 * secret must fail closed, and fail in the reply that names the missing thing.
 */
export async function verifyLiffIdToken(
  idToken: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<IdTokenVerification> {
  if (!idToken || typeof idToken !== "string" || !idToken.trim()) return { ok: false, code: "TOKEN_MISSING" };
  const channel = loginChannelId();
  const aud = decodeAud(idToken);
  if (!channel || aud !== channel) {
    console.error(
      `[line-id-token] WRONG CHANNEL: token aud=${aud ?? "<undecodable>"} expected=${channel ?? "<LINE_LOGIN_CHANNEL_ID unset>"} — ` +
        "a page on another channel is calling this API, or the channel ID is not configured",
    );
    return { ok: false, code: "TOKEN_WRONG_CHANNEL" };
  }
  let res: Response;
  try {
    res = await fetchImpl(LINE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: channel }),
    });
  } catch (e) {
    console.error("[line-id-token] verify call failed:", e);
    return { ok: false, code: "TOKEN_INVALID" };
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // LINE: `{ error: "invalid_request", error_description: "IdToken expired." }` for an expired one.
    const desc = String(body?.error_description ?? "").toLowerCase();
    return { ok: false, code: desc.includes("expired") ? "TOKEN_EXPIRED" : "TOKEN_INVALID" };
  }
  // Belt and braces: LINE has already checked `aud`; we compare once more against what we decoded, so a
  // verifier that ever stopped checking would still not let a foreign token through.
  if (body?.aud !== channel || typeof body?.sub !== "string" || !body.sub) return { ok: false, code: "TOKEN_INVALID" };
  return { ok: true, sub: body.sub };
}
