// TASK-448 (REQ-105) — 🔴 **which LINE account am I about to write to?**
//
// The owner ran `line:relink-menus` on a checkout whose `.env` pointed at the CUSTOMER'S live OA. The run printed
// `LINE account: SOM.BALANCE.SCHOOL (@427ybeky)` and listed 201 real families — and the only thing standing between a
// dry run and 201 re-linked strangers was that a human read that header. **A header is something a human skims past.**
//
// So every OA-WRITING script must now NAME the account it means (`--account @125vuzsj`), and the tool refuses unless
// that name matches the token's real account AND the account is on this machine's write allow-list. The decision is
// pure and exhaustive below; the IO is one `GET /v2/bot/info` above it.
//
// 🔑 The order of the checks is the point: **an unreadable identity refuses.** A tool that cannot say which account it
// is holding must not write to it — "probably the test one" is exactly the reasoning this guard exists to remove.

export interface OaIdentity {
  displayName?: string | null;
  basicId?: string | null;
}

export type OaGuardDecision =
  | { ok: true; account: string }
  | { ok: false; reason: "unreadable" | "not-requested" | "mismatch" | "not-allowed"; message: string };

/** `@125VUZSJ` · `125vuzsj` · ` @125vuzsj ` all mean the same account. A display name is compared the same way. */
const norm = (v: string | null | undefined): string => (v ?? "").trim().replace(/^@/, "").toLowerCase();
const label = (a: OaIdentity): string => `${a.displayName ?? "?"} (${a.basicId ?? "?"})`;

/** The accounts THIS checkout may write to — `LINE_OA_WRITE_ALLOW=@125vuzsj,@other`. Empty ⇒ nothing is writable. */
export function oaWriteAllowList(env: Record<string, string | undefined> = process.env): string[] {
  return (env.LINE_OA_WRITE_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * May this run write to the account the token actually holds?
 *
 * `actual` — what `GET /v2/bot/info` said (null / no ids ⇒ unreadable ⇒ REFUSE).
 * `requested` — the operator's `--account`; absent ⇒ REFUSE (naming it is the point of the guard).
 * `allow` — this machine's allow-list; the account must be on it, however confidently it was named.
 */
export function decideOaWrite(actual: OaIdentity | null, requested: string | undefined, allow: string[]): OaGuardDecision {
  if (!actual || (!actual.basicId && !actual.displayName)) {
    return { ok: false, reason: "unreadable", message: "✗ refusing to write: cannot read which LINE account this token holds (GET /v2/bot/info failed). A tool that cannot name the account must not write to it." };
  }
  const account = label(actual);
  const names = [norm(actual.basicId), norm(actual.displayName)].filter(Boolean);
  if (!requested || !norm(requested)) {
    return { ok: false, reason: "not-requested", message: `✗ refusing to write: token points at ${account}; name it with --account ${actual.basicId ?? actual.displayName} to proceed.` };
  }
  if (!names.includes(norm(requested))) {
    return { ok: false, reason: "mismatch", message: `✗ refusing to write: token points at ${account}; you asked for ${requested.trim()} — refusing.` };
  }
  if (!allow.some((a) => names.includes(norm(a)))) {
    return { ok: false, reason: "not-allowed", message: `✗ refusing to write: ${account} is not on this machine's write allow-list (LINE_OA_WRITE_ALLOW=${allow.join(",") || "empty"}).` };
  }
  return { ok: true, account };
}

/** `--account @125vuzsj` or `--account=@125vuzsj` — the operator's naming of the account, as typed. */
export function accountArg(argv: string[]): string | undefined {
  const eq = argv.find((a) => a.startsWith("--account="));
  if (eq) return eq.slice("--account=".length);
  const i = argv.indexOf("--account");
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `GET /v2/bot/info` — the account the TOKEN holds. null on any failure, which the decision reads as "refuse". */
export async function getBotIdentity(): Promise<OaIdentity | null> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch("https://api.line.me/v2/bot/info", { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const b = (await res.json()) as OaIdentity;
    return { displayName: b.displayName ?? null, basicId: b.basicId ?? null };
  } catch {
    return null;
  }
}

/**
 * The ONE line every OA-writing script runs before its first write: refuse loudly and exit, or return the account it
 * is allowed to write to. Exits rather than throwing so a script cannot swallow the refusal by accident.
 */
export async function guardOaWriteOrExit(argv: string[] = process.argv): Promise<string> {
  const decision = decideOaWrite(await getBotIdentity(), accountArg(argv), oaWriteAllowList());
  if (!decision.ok) {
    console.error(decision.message);
    process.exit(1);
  }
  console.log(`✓ writing to ${decision.account} (named with --account, on the allow-list)`);
  return decision.account;
}
