// TASK-347 (`REQ-088` Rule 2) — the page must PROVE who it is, and the three failures are three different replies.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LINE_VERIFY_URL, decodeAud, verifyLiffIdToken } from "./line-id-token";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A token-shaped string. The signature is nonsense on purpose: the SERVER never checks it — LINE does. */
const token = (aud: string, sub = "U1234567890abcdef") => `${b64({ alg: "ES256" })}.${b64({ aud, sub, iss: "https://access.line.me" })}.sig`;
const OURS = "1660000001";

/** A fake LINE: records the call, answers what the test says. */
const line = (status: number, body: unknown) => {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), form: init.body as URLSearchParams });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
};

let saved: string | undefined;
beforeEach(() => { saved = process.env.LINE_LOGIN_CHANNEL_ID; process.env.LINE_LOGIN_CHANNEL_ID = OURS; });
afterEach(() => { if (saved === undefined) delete process.env.LINE_LOGIN_CHANNEL_ID; else process.env.LINE_LOGIN_CHANNEL_ID = saved; });

describe("🔴 TASK-347 Rule 2 — the ID token is verified SERVER-SIDE against the customer's Login channel", () => {
  test("✅ a token LINE vouches for names its `sub`, and `sub` is the lineUserId", async () => {
    const { f, calls } = line(200, { aud: OURS, sub: "Uabc", exp: 9999999999 });
    expect(await verifyLiffIdToken(token(OURS, "Uabc"), f)).toEqual({ ok: true, sub: "Uabc" });
    // …and it was LINE that decided: the call went to the verify endpoint with OUR channel as `client_id`.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(LINE_VERIFY_URL);
    expect(calls[0]!.form.get("client_id")).toBe(OURS);
    expect(calls[0]!.form.get("id_token")).toBe(token(OURS, "Uabc"));
  });

  test("🔴 TOKEN_WRONG_CHANNEL — a token for ANOTHER channel is refused BEFORE LINE is even asked", async () => {
    // ⚠️ The interesting one: a page built on another channel pointed at our API. Misconfiguration or
    // impersonation — either way it must not read as a generic "invalid" that nobody investigates.
    const { f, calls } = line(200, { aud: "9999", sub: "Uabc" });
    expect(await verifyLiffIdToken(token("9999"), f)).toEqual({ ok: false, code: "TOKEN_WRONG_CHANNEL" });
    expect(calls).toHaveLength(0); // decided locally, from `aud`
  });

  test("🚫 …and with NO channel configured, EVERY token is WRONG_CHANNEL — never 'skip verification'", async () => {
    delete process.env.LINE_LOGIN_CHANNEL_ID;
    const { f, calls } = line(200, { aud: OURS, sub: "Uabc" });
    expect(await verifyLiffIdToken(token(OURS), f)).toEqual({ ok: false, code: "TOKEN_WRONG_CHANNEL" });
    expect(calls).toHaveLength(0);
  });

  test("🔑 the local decode is trusted for NOTHING but the error code — LINE still decides", async () => {
    // A token whose `aud` is ours but which LINE refuses: the local decode passed it through, and LINE's
    // verdict is what stands. This is the assertion that keeps `decodeAud` from ever becoming the verifier.
    const { f, calls } = line(400, { error: "invalid_request", error_description: "Invalid IdToken." });
    expect(await verifyLiffIdToken(token(OURS), f)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(calls).toHaveLength(1);
  });

  test("TOKEN_EXPIRED is its own reply — the page re-inits LIFF and retries; an INVALID one does not", async () => {
    const { f } = line(400, { error: "invalid_request", error_description: "IdToken expired." });
    expect(await verifyLiffIdToken(token(OURS), f)).toEqual({ ok: false, code: "TOKEN_EXPIRED" });
  });

  test("TOKEN_MISSING — nothing sent, nothing asked", async () => {
    const { f, calls } = line(200, {});
    for (const missing of [undefined, null, "", "   "]) {
      expect(await verifyLiffIdToken(missing as any, f)).toEqual({ ok: false, code: "TOKEN_MISSING" });
    }
    expect(calls).toHaveLength(0);
  });

  test("🚫 belt and braces — a 200 from LINE whose claims do not name OUR channel or a `sub` is still INVALID", async () => {
    // A verifier that ever stopped checking `aud` would still not let a foreign token through here.
    expect(await verifyLiffIdToken(token(OURS), line(200, { aud: "9999", sub: "Uabc" }).f)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(await verifyLiffIdToken(token(OURS), line(200, { aud: OURS }).f)).toEqual({ ok: false, code: "TOKEN_INVALID" });
  });

  test("a network failure is INVALID, not a crash and not a pass", async () => {
    const f = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await verifyLiffIdToken(token(OURS), f)).toEqual({ ok: false, code: "TOKEN_INVALID" });
  });

  test("`decodeAud` reads the claim without verifying, and says `null` for anything it cannot read", () => {
    expect(decodeAud(token("1660000001"))).toBe("1660000001");
    expect(decodeAud("not.a.jwt.at.all")).toBeNull();
    expect(decodeAud("two.parts")).toBeNull();
    expect(decodeAud(`x.${Buffer.from("not json").toString("base64url")}.y`)).toBeNull();
  });
});
