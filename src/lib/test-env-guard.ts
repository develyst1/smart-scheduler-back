// TASK-503 (owner ruling, 09-26) — the test suite REFUSES to run when `.env` points at the CUSTOMER'S system: the uat database
// or the real OA. Tests are meant to run against `sid` — that is by design (owner: "เทสบน sid นั่นแหละ ถูกแล้ว"); this guards the
// one case that must never happen. It is real: the owner's `.env` held uat + the real OA token during the 09-26 release, and the
// real OA again on 09-23.
//
// 🔑 IDENTIFIED BY NAME, NEVER BY SECRET: a database HOST, the OA's `@id`, the LIFF id, the login channel id. No password, token or
// full URL is compared, returned or printed — `dbHostOf` hands back the host and nothing else. (The channel ACCESS TOKEN itself is
// deliberately not examined: telling one token from another would mean reading it. The OA / LIFF / channel ids travel with it.)
// Pure: `src/test-env-guard.preload.ts` calls it before any test file loads and throws; no opt-out (an override would be used at
// 2 a.m. by the person this exists for).

/** The customer's system (uat) — non-secret identifiers only (owner's `.env.uat`, 09-26). */
export const CUSTOMER_ENV = {
  dbHosts: ["154.197.124.29"],
  oaIds: ["@427ybeky"],
  loginChannelIds: ["2011577840"],
} as const;
/** A LIFF id is `<login channel id>-<suffix>`: the customer's LIFF is recognised by its CHANNEL, so no LIFF id is written here. */
const isCustomerLiff = (liffId: string) => CUSTOMER_ENV.loginChannelIds.some((c) => liffId.startsWith(`${c}-`));

export type Signal = { setting: string; matched: string };

/** The HOST of a database URL, and nothing else — never the user, password, port or path. `null` if unparseable. */
export function dbHostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    const m = url.match(/@\[?([^\]/:?#\s]+)/);
    return m ? m[1]! : null;
  }
}

/** Every sign that this environment is the customer's. Empty for `sid` / local. */
export function customerEnvSignals(env: Record<string, string | undefined>): Signal[] {
  const out: Signal[] = [];
  const host = dbHostOf(env.DATABASE_URL);
  if (host && (CUSTOMER_ENV.dbHosts as readonly string[]).includes(host)) out.push({ setting: "DATABASE_URL", matched: `host ${host} — the uat database` });
  for (const id of (env.LINE_OA_WRITE_ALLOW ?? "").split(/[\s,]+/).filter(Boolean)) {
    if ((CUSTOMER_ENV.oaIds as readonly string[]).includes(id)) out.push({ setting: "LINE_OA_WRITE_ALLOW", matched: `${id} — the customer's real OA` });
  }
  const liff = (env.LIFF_ID ?? "").trim();
  if (isCustomerLiff(liff)) out.push({ setting: "LIFF_ID", matched: `${liff.split("-")[0]}-… — the customer's real LIFF` });
  const login = (env.LINE_LOGIN_CHANNEL_ID ?? "").trim();
  if ((CUSTOMER_ENV.loginChannelIds as readonly string[]).includes(login)) out.push({ setting: "LINE_LOGIN_CHANNEL_ID", matched: `${login} — the customer's real login channel` });
  return out;
}

/** What the person who trips this must DO — they are probably mid-release with the customer's values loaded. */
export function refusalMessage(signals: Signal[]): string {
  return [
    "",
    "🔴 REFUSING TO RUN THE TESTS — .env points at the CUSTOMER'S system (uat / the real OA):",
    ...signals.map((s) => `   · ${s.setting} → ${s.matched}`),
    "",
    "   The tests are meant to run against sid, never uat. NOTHING has connected: this check runs before any test file loads.",
    "   What to do: switch .env back to the sid values (e.g. copy .env.sid over .env), then run `bun test` again.",
    "   There is no override, on purpose.",
    "",
  ].join("\n");
}
