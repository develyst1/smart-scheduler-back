// TASK-250 — the DECISION half of `line:remove-menus`, pure so it can be read and tested without a network.
//
// 🔴 The owner was offered the raw API calls and refused them: *"สั่งทีมทำเครื่องมือ แบบนี้เสี่ยงไป"*. **He is
// not asking for a delete; he is asking for a delete he can review before it fires.** So the plan — what will be
// deleted, what will be left alone, and what the account looks like afterwards — is the deliverable, and it is
// computed here, in one place, from data that can be handed to it in a test.
//
// The IO shell (`scripts/line-remove-menus.ts`) only fetches, prints this, and — with `--apply` — performs it.
// Same shape as `db-reset-plan` (TASK-151), and for the same reason: a destructive act against someone else's
// live account should be decidable on paper.
import type { MenuIds } from "./line-rich-menu";

/** One row of `GET /v2/bot/richmenu/list`, reduced to what the decision needs. */
export interface ChannelMenu {
  richMenuId?: string;
  name?: string;
}

export interface PlannedDelete {
  /** Our own label — `unknownTH`, `parentTH`… — because an id means nothing to the person reading this. */
  label: string;
  id: string;
  /** The name LINE holds for it, or `null` when the channel does not have it any more. */
  name: string | null;
  onChannel: boolean;
  isDefault: boolean;
}

export interface RemovalPlan {
  /** Ours, by STORED ID. Never "everything the channel lists". */
  toDelete: PlannedDelete[];
  /** On the channel but not ours — reported and LEFT. Information, not an obstacle. */
  foreign: Array<{ id: string; name: string | null }>;
  /** The channel default as LINE reports it. */
  defaultId: string | null;
  /** Cancel it first — but only when it is one of ours (see below). */
  cancelDefault: boolean;
  /** The default is set and is NOT ours ⇒ the customer configured it; say so and do not touch it. */
  foreignDefault: boolean;
}

/**
 * 🔴 **Ours only, by stored id.** `inspect` says the channel holds six and all six are ours — true today, and
 * not a guarantee: the customer may add one tomorrow from the OA Manager. A tool that deletes what it finds
 * would take that with it.
 *
 * ⚠️ **The default is cancelled only when it is OURS.** §1 says "cancel the channel default", and taken
 * literally that would clear a default the customer set for a menu we never made — a configuration change
 * nobody asked for, on a live account. Cancelling ours is part of removing ours; cancelling theirs is not.
 * (If the default is one of our ids, it is also in `toDelete`, which is why cancelling FIRST matters: deleting
 * a menu that is still the default leaves the channel pointing at a dead id for the length of the run.)
 */
export function planMenuRemoval(
  stored: MenuIds,
  channel: ChannelMenu[],
  defaultId: string | null,
): RemovalPlan {
  const ours = Object.entries(stored).filter(([, id]) => !!id) as Array<[string, string]>;
  const byId = new Map(channel.filter((m) => m.richMenuId).map((m) => [m.richMenuId!, m.name ?? null]));

  const toDelete: PlannedDelete[] = ours.map(([label, id]) => ({
    label,
    id,
    name: byId.get(id) ?? null,
    onChannel: byId.has(id),
    isDefault: !!defaultId && defaultId === id,
  }));

  const ourIds = new Set(ours.map(([, id]) => id));
  const foreign = channel
    .filter((m) => m.richMenuId && !ourIds.has(m.richMenuId))
    .map((m) => ({ id: m.richMenuId!, name: m.name ?? null }));

  return {
    toDelete,
    foreign,
    defaultId,
    cancelDefault: !!defaultId && ourIds.has(defaultId),
    foreignDefault: !!defaultId && !ourIds.has(defaultId),
  };
}

/**
 * The ids to KEEP in `app_settings` after a run.
 *
 * ⚠️ §4's last line: **clear only what was actually deleted.** An id whose delete failed must survive, or the
 * survivor is stranded — nothing left pointing at a menu that is still on the channel, and the next run cannot
 * finish the job. `deleted` is the set of ids the API confirmed gone (including 404s: already gone IS gone).
 */
export function idsToKeep(stored: MenuIds, deleted: Set<string>): MenuIds {
  const keep: MenuIds = {};
  for (const [label, id] of Object.entries(stored)) {
    if (id && !deleted.has(id)) keep[label as keyof MenuIds] = id;
  }
  return keep;
}

/** 📌 Reused VERBATIM from `line-inspect-menus.ts` — one sentence for "no default", not a second wording. */
export const NO_DEFAULT_SENTENCE = "(no default menu set — users with no per-user link see NO menu)";

/**
 * The review the owner actually asked for. Every line here exists so the person running this at 11pm does not
 * have to infer anything: what goes, what stays, what is left of the account afterwards, and how to undo it.
 */
export function formatRemovalPlan(
  plan: RemovalPlan,
  opts: { apply: boolean; account: string },
): string {
  const out: string[] = [];
  out.push(`── line:remove-menus ── ${opts.apply ? "APPLY" : "DRY RUN (nothing will be changed)"}`);
  // 🔴 The token decides whether this is the demo OA or the CUSTOMER'S. A tool whose whole purpose is review
  // must not hide the one fact that makes the review meaningful.
  out.push(`Account (from the token): ${opts.account}`);
  out.push("");

  const present = plan.toDelete.filter((m) => m.onChannel);
  const gone = plan.toDelete.filter((m) => !m.onChannel);

  out.push(`DELETE — ours, matched by stored id (${present.length}):`);
  if (!present.length) out.push("  (none — nothing of ours is on this channel)");
  for (const m of present) {
    out.push(
      `  ${m.label.padEnd(10)} ${m.id}  name="${m.name ?? "?"}"${m.isDefault ? "   ← the current channel DEFAULT" : ""}`,
    );
  }

  if (gone.length) {
    out.push("");
    out.push(`Stored but already absent from LINE (${gone.length}) — the delete reports 404, which counts as done:`);
    for (const m of gone) out.push(`  ${m.label.padEnd(10)} ${m.id}`);
  }

  out.push("");
  if (plan.cancelDefault) {
    out.push("The channel default is one of ours ⇒ it is CANCELLED FIRST, before any menu is deleted.");
  } else if (plan.foreignDefault) {
    out.push(
      `🚫 The channel default (${plan.defaultId}) is NOT one of ours — it is left exactly as it is. ` +
        "Cancelling it would change a configuration this repo never made.",
    );
  } else {
    out.push("No channel default is set, so there is none to cancel.");
  }

  out.push("");
  out.push(`LEAVE ALONE — on the channel, not ours (${plan.foreign.length}):`);
  if (!plan.foreign.length) out.push("  (none)");
  for (const m of plan.foreign) out.push(`  ${m.id} name="${m.name ?? "?"}"   (created outside our publish)`);

  out.push("");
  out.push("AFTERWARDS:");
  if (plan.cancelDefault || !plan.defaultId) {
    // 🔴 This is a PRODUCT STATE, not a clean slate, and it must be said rather than inferred.
    out.push(`  ${NO_DEFAULT_SENTENCE}`);
    out.push("  Deleting a menu also drops every per-user link to it, so EVERY follower — linked or not —");
    out.push("  ends with NO menu at all and is back to typing keywords (สมัคร · เมนู · เช็คอิน · ลา).");
  } else {
    out.push("  The customer's own default menu stays, so followers keep seeing that one.");
  }
  out.push("  Reversal is `bun run line:publish-menus` — but it creates NEW ids, so anything still holding an");
  out.push("  old id (another environment's app_settings, a screenshot, a note) is stale afterwards.");

  out.push("");
  if (opts.apply) {
    out.push(`About to delete ${present.length + gone.length} menu(s) and ${plan.cancelDefault ? "cancel" : "keep"} the default.`);
  } else {
    out.push(
      `DRY RUN — nothing changed. ${present.length + gone.length} menu(s) would be deleted` +
        `${plan.cancelDefault ? " and the channel default cancelled" : ""}.`,
    );
    out.push("Re-run with --apply once the list above is what you expect.");
  }
  return out.join("\n");
}
