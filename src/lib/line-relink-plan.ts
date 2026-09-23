// TASK-446 (REQ-105 §6) — the RE-LINK sweep's decision half, pure. A rich-menu id is pinned PER USER: LINE serves the channel
// default only to a follower with no per-user link, so every follower who was linked before a re-publish keeps the id they were
// linked to — forever, on every future publish. This computes, for each known LINE account, the menu the CURRENT rules would
// give it and how the live link differs; the script does the network and the writing.
//
// 🔑 The expected menu MIRRORS the runtime sequence (`settleLinkedRole`), including its silent no-op:
//   1. `linkRoleRichMenu(role, lang)` → `parent|teacher` + `TH|EN`;
//   2. a CUSTOMER then gets `linkKnownRichMenu(lang)` → `knownTH|knownEN` — **which is a no-op when that id is not stored**,
//      and `knownEN` is deliberately never published (TASK-247 §4: a stored id with no image renders BLANK).
//   ⇒ a TH customer's expected menu is `knownTH`; an EN customer's is `parentEN` — not `knownEN`. Modelling the ideal instead
//   of the code would make the sweep "fix" every EN customer onto an id that does not exist.
import type { MenuIds } from "./line-rich-menu";

export type MenuRole = "customer" | "teacher";
export type MenuLang = "TH" | "EN";

export interface MenuUser {
  lineUserId: string;
  /** For the operator's eyes only — the plan is read before it is applied. */
  name: string;
  role: MenuRole;
  lang: MenuLang;
  /** `GET /user/{id}/richmenu` — null = no per-user link (they see the channel default). */
  linkedMenuId: string | null;
}

/** `ok` = already right · `stale` = an id that is not one of ours any more · `variant` = one of ours, but not the expected
 *  one (a language toggle leaves a customer on `parentTH`) · `unlinked` = a known user on the channel default ·
 *  `no-menu-published` = the expected menu was never published on this account — the sweep cannot fix it, and says so. */
export type RelinkOutcome = "ok" | "stale" | "variant" | "unlinked" | "no-menu-published";

export interface RelinkRow {
  user: MenuUser;
  expectedId: string | null;
  expectedLabel: string | null;
  /** Our label for what they hold now (`knownTH`…), or null when the id is not one we have stored. */
  linkedLabel: string | null;
  outcome: RelinkOutcome;
}

export interface RelinkPlan {
  rows: RelinkRow[];
  /** The ones `--apply` would link, in the order it would do it. */
  toRelink: RelinkRow[];
  counts: Record<RelinkOutcome, number>;
}

/** The menu key the runtime's two calls would leave this user on — the LAST one that actually has a stored id. */
export function expectedMenuKey(role: MenuRole, lang: MenuLang, ids: MenuIds): keyof MenuIds | null {
  const roleKey = ((role === "teacher" ? "teacher" : "parent") + lang) as keyof MenuIds;
  const knownKey = (lang === "EN" ? "knownEN" : "knownTH") as keyof MenuIds;
  if (role === "customer" && ids[knownKey]) return knownKey; // the second call wins when it is published
  if (ids[roleKey]) return roleKey;
  return null;
}

/**
 * 🔴 TASK-452 (REQ-105 §6b) — **THE answer to "which menu does this chat get", for every caller.**
 *
 * The rule itself is `expectedMenuKey` above and it has not changed; what changed is who asks. Until now the two
 * LIVE paths each spelled it out for themselves: the account-link called the role linker and then the known linker
 * (so the last write won — the orange menu), while the LANGUAGE TOGGLE called only the role linker (so it landed on
 * the old blue family, and stayed there). Two spellings of one rule is how a chat ends up on a menu no path ever
 * intended, and it is the `variant` drift TASK-446's sweep was built to REPAIR — repairing it was never the same as
 * preventing it.
 *
 * ⇒ `linkRoleRichMenu`, `linkKnownRichMenu` and the sweep now all resolve through THIS. One rule, three callers.
 */
export function menuIdFor(role: MenuRole, lang: MenuLang, ids: MenuIds): string | null {
  const key = expectedMenuKey(role, lang, ids);
  return key ? (ids[key] ?? null) : null;
}

const labelOf = (id: string, ids: MenuIds): string | null =>
  (Object.entries(ids).find(([, v]) => v === id)?.[0] as string | undefined) ?? null;

export function planRelink(users: MenuUser[], ids: MenuIds): RelinkPlan {
  const rows: RelinkRow[] = users.map((user) => {
    const key = expectedMenuKey(user.role, user.lang, ids);
    const expectedId = menuIdFor(user.role, user.lang, ids); // TASK-452 — the same expression the live links use
    const linkedLabel = user.linkedMenuId ? labelOf(user.linkedMenuId, ids) : null;
    const outcome: RelinkOutcome = !expectedId
      ? "no-menu-published"
      : user.linkedMenuId === expectedId
        ? "ok"
        : user.linkedMenuId === null
          ? "unlinked"
          : linkedLabel
            ? "variant"
            : "stale";
    return { user, expectedId, expectedLabel: key, linkedLabel, outcome };
  });
  const counts: Record<RelinkOutcome, number> = { ok: 0, stale: 0, variant: 0, unlinked: 0, "no-menu-published": 0 };
  for (const r of rows) counts[r.outcome]++;
  return { rows, toRelink: rows.filter((r) => r.outcome === "stale" || r.outcome === "variant" || r.outcome === "unlinked"), counts };
}

/** One LINE account may appear twice (a parent's primary column AND `family_line_links`; a coach who is also a parent).
 *  The FIRST occurrence wins — the script feeds teachers first, so a coach keeps the teacher menu. */
export function dedupeMenuUsers(users: MenuUser[]): MenuUser[] {
  const seen = new Set<string>();
  return users.filter((u) => (seen.has(u.lineUserId) ? false : (seen.add(u.lineUserId), true)));
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** The PLAN is the deliverable: it is read before anything is written. One line per user, the account named first. */
export function formatRelinkPlan(plan: RelinkPlan, opts: { apply: boolean; account: string }): string {
  const mark: Record<RelinkOutcome, string> = { ok: "ok      ", stale: "RELINK  ", variant: "RELINK  ", unlinked: "RELINK  ", "no-menu-published": "BLOCKED " };
  const lines = [
    `LINE account: ${opts.account}`,
    opts.apply ? "MODE: --apply (links will be written)" : "MODE: dry run (nothing is written)",
    "",
    ...plan.rows.map((r) =>
      `${mark[r.outcome]} ${pad(r.user.name, 22)} ${pad(r.user.role, 8)} ${r.user.lang}  linked ${pad(r.linkedLabel ?? (r.user.linkedMenuId ? "unknown-id" : "none"), 12)} expected ${r.expectedLabel ?? "— none published —"}`,
    ),
    "",
    `${plan.rows.length} known LINE account(s): ${plan.counts.ok} ok · ${plan.counts.stale} stale · ${plan.counts.variant} variant · ${plan.counts.unlinked} unlinked · ${plan.counts["no-menu-published"]} blocked (no menu published)`,
  ];
  if (plan.counts["no-menu-published"]) {
    lines.push("⚠️  BLOCKED users hold no fixable menu: their role+language menu was never published on this account.");
  }
  return lines.join("\n");
}
