// TASK-250 — `line:remove-menus`, decided on paper.
//
// 🔴 The owner refused the raw API calls — *"สั่งทีมทำเครื่องมือ แบบนี้เสี่ยงไป"* — so **the review is the
// product**, and the review is a pure function. Everything below runs the real planner and the real formatter
// against handed-in data; nothing here touches a network, and the OA this is written for is a customer's live
// account that nobody on this team may call.
//
// The IO shell is asserted from source at the bottom, labelled as such — a source assertion tests what the code
// says, and must not be mistaken for the test of what it does (@Sober, TASK-248 §4).
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";
import {
  NO_DEFAULT_SENTENCE,
  formatRemovalPlan,
  idsToKeep,
  planMenuRemoval,
} from "./line-menu-removal-plan";
import { mergeMenuIds, type MenuIds } from "./line-rich-menu";

const SCRIPT = readSrc(await Bun.file(new URL("../../scripts/line-remove-menus.ts", import.meta.url)).text());
const RICH = readSrc(await Bun.file(new URL("./line-rich-menu.ts", import.meta.url)).text());
const INSPECT = readSrc(await Bun.file(new URL("../../scripts/line-inspect-menus.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const STORED: MenuIds = {
  parentTH: "rm-p-th",
  parentEN: "rm-p-en",
  teacherTH: "rm-t-th",
  teacherEN: "rm-t-en",
  unknownTH: "rm-u-th",
  knownTH: "rm-k-th",
};
const CHANNEL = [
  { richMenuId: "rm-p-th", name: "smart-scheduler-parent-th" },
  { richMenuId: "rm-p-en", name: "smart-scheduler-parent-en" },
  { richMenuId: "rm-t-th", name: "smart-scheduler-teacher-th" },
  { richMenuId: "rm-t-en", name: "smart-scheduler-teacher-en" },
  { richMenuId: "rm-u-th", name: "smart-scheduler-unknown-th" },
  { richMenuId: "rm-k-th", name: "smart-scheduler-known-th" },
];

describe("🔴 OURS ONLY — by stored id, never 'everything the channel lists'", () => {
  test("the six stored menus are planned for deletion", () => {
    const plan = planMenuRemoval(STORED, CHANNEL, "rm-u-th");
    expect(plan.toDelete.map((m) => m.label)).toEqual([
      "parentTH", "parentEN", "teacherTH", "teacherEN", "unknownTH", "knownTH",
    ]);
    expect(plan.toDelete.every((m) => m.onChannel)).toBe(true);
    expect(plan.foreign).toEqual([]);
  });

  test("🔑 a menu the CUSTOMER made is reported and LEFT — information, not an obstacle", () => {
    // True today that all six are ours; not a guarantee. A tool that deletes what it finds would take the
    // customer's own menu with it, on their live account, on a run they asked for to remove ours.
    const plan = planMenuRemoval(STORED, [...CHANNEL, { richMenuId: "rm-promo", name: "promo-2026" }], "rm-u-th");
    expect(plan.foreign).toEqual([{ id: "rm-promo", name: "promo-2026" }]);
    expect(plan.toDelete.map((m) => m.id)).not.toContain("rm-promo");
    expect(formatRemovalPlan(plan, { apply: false, account: "acc" })).toContain("LEAVE ALONE");
  });

  test("a stored id that is already gone from LINE is still planned — and marked absent", () => {
    // Idempotence starts here: the end state is the goal, so a half-removed account must be finishable.
    const plan = planMenuRemoval(STORED, CHANNEL.slice(0, 4), "rm-p-th");
    const gone = plan.toDelete.filter((m) => !m.onChannel).map((m) => m.label);
    expect(gone).toEqual(["unknownTH", "knownTH"]);
    expect(formatRemovalPlan(plan, { apply: false, account: "acc" })).toContain("404, which counts as done");
  });

  test("nothing stored ⇒ nothing to delete, and the plan says so rather than erroring", () => {
    const plan = planMenuRemoval({}, CHANNEL, "rm-u-th");
    expect(plan.toDelete).toEqual([]);
    expect(plan.foreign).toHaveLength(6);
    expect(formatRemovalPlan(plan, { apply: false, account: "acc" })).toContain("nothing of ours is on this channel");
  });
});

describe("🔴 the default — cancelled first, and only when it is ours", () => {
  test("our default is cancelled, and the plan marks WHICH menu it is", () => {
    const plan = planMenuRemoval(STORED, CHANNEL, "rm-u-th");
    expect(plan.cancelDefault).toBe(true);
    expect(plan.toDelete.find((m) => m.isDefault)?.label).toBe("unknownTH");
    expect(formatRemovalPlan(plan, { apply: false, account: "acc" })).toContain("← the current channel DEFAULT");
    expect(formatRemovalPlan(plan, { apply: false, account: "acc" })).toContain("CANCELLED FIRST");
  });

  test("🚫 a default that is NOT ours is left exactly as it is", () => {
    // §1 says "cancel the channel default", and taken literally that clears a default set for a menu this repo
    // never made — a configuration change nobody asked for, on someone's live account. Cancelling ours is part
    // of removing ours; cancelling theirs is not.
    const plan = planMenuRemoval(STORED, [...CHANNEL, { richMenuId: "rm-promo", name: "promo" }], "rm-promo");
    expect(plan.cancelDefault).toBe(false);
    expect(plan.foreignDefault).toBe(true);
    expect(formatRemovalPlan(plan, { apply: false, account: "acc" })).toContain("is NOT one of ours");
  });

  test("no default set ⇒ nothing to cancel, said plainly", () => {
    const plan = planMenuRemoval(STORED, CHANNEL, null);
    expect(plan.cancelDefault).toBe(false);
    expect(plan.foreignDefault).toBe(false);
    expect(formatRemovalPlan(plan, { apply: false, account: "acc" })).toContain("No channel default is set");
  });
});

describe("🔴 the dry run IS the deliverable — the owner rejected a delete he could not review", () => {
  const plan = planMenuRemoval(STORED, CHANNEL, "rm-u-th");
  const dry = formatRemovalPlan(plan, { apply: false, account: "Smart Scheduler (@abc) userId=U1" });

  test("every menu appears with label · id · LINE's name", () => {
    for (const [label, id] of Object.entries(STORED)) {
      const line = dry.split("\n").find((l) => l.includes(id))!;
      expect(line).toContain(label);
      expect(line).toContain(id);
      expect(line).toContain('name="smart-scheduler-');
    }
  });

  test("🔑 it names WHICH ACCOUNT the token points at", () => {
    // The token decides whether this is the demo OA or the customer's. A tool whose whole purpose is review
    // must not hide the one fact that makes the review meaningful.
    expect(dry).toContain("Account (from the token): Smart Scheduler (@abc) userId=U1");
  });

  test("it states the count and that nothing changed", () => {
    expect(dry).toContain("6 menu(s) would be deleted and the channel default cancelled");
    expect(dry).toContain("DRY RUN — nothing changed");
    expect(dry).toContain("Re-run with --apply");
  });

  test("🔴 it says what a user SEES afterwards: nothing — and reuses inspect's own sentence", () => {
    // A product state, not a clean slate. One wording for it, not a second one that could drift.
    expect(dry).toContain(NO_DEFAULT_SENTENCE);
    expect(code(INSPECT)).toContain(NO_DEFAULT_SENTENCE);
    // …and the half `inspect` never had to say: a deleted menu also drops every PER-USER link to it.
    expect(dry).toContain("EVERY follower — linked or not —");
    expect(dry).toContain("back to typing keywords");
  });

  test("it says how to reverse it, and what reversal does NOT restore", () => {
    expect(dry).toContain("line:publish-menus");
    expect(dry).toContain("creates NEW ids");
  });

  test("the --apply header is the same review, not a shorter one", () => {
    const applied = formatRemovalPlan(plan, { apply: true, account: "acc" });
    expect(applied).toContain("APPLY");
    for (const id of Object.values(STORED)) expect(applied).toContain(id);
    expect(applied).toContain(NO_DEFAULT_SENTENCE);
    expect(applied).not.toContain("DRY RUN");
  });
});

describe("🔴 the trap: `storeMenuIds` cannot clear, so `clearMenuIds` exists", () => {
  test("`storeMenuIds({})` would be a NO-OP — the merge makes it so", () => {
    // TASK-247 made the store merge, for a good reason. The exact consequence is that the obvious way to clear
    // reports success and changes nothing, leaving the DB pointing at menus that no longer exist.
    expect(mergeMenuIds(STORED, {})).toEqual(STORED);
    expect(mergeMenuIds(STORED, { knownTH: undefined } as MenuIds)).toEqual(STORED);
  });

  test("`clearMenuIds` does NOT go through it, and removes the row outright", () => {
    const fn = code(RICH).slice(code(RICH).indexOf("export async function clearMenuIds"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).not.toContain("storeMenuIds");
    expect(body).not.toContain("mergeMenuIds");
    expect(body).toContain("db.delete(appSettings)");
  });

  test("⚠️ only what was ACTUALLY deleted is cleared — a survivor keeps its id", () => {
    // An id whose delete failed must survive, or the surviving menu is stranded with nothing pointing at it and
    // the next run cannot finish the job.
    const keep = idsToKeep(STORED, new Set(["rm-p-th", "rm-p-en", "rm-t-th", "rm-t-en", "rm-u-th"]));
    expect(keep).toEqual({ knownTH: "rm-k-th" });
    expect(idsToKeep(STORED, new Set(Object.values(STORED)))).toEqual({});
  });
});

describe("WIRING — the IO shell, read from source", () => {
  test("dry run by default; `--apply` is opt-in", () => {
    expect(code(SCRIPT)).toContain('const apply = process.argv.includes("--apply")');
    expect(code(SCRIPT)).toContain("if (!apply) process.exit(0)");
  });

  test("🔴 `--apply` requires a typed confirmation, and a non-interactive stdin cancels", () => {
    // A review nobody read is not a review — so this must never be runnable from a script or a cron.
    expect(code(SCRIPT)).toContain("const typed = prompt(");
    expect(code(SCRIPT)).toContain("if (typed?.trim() !== expected)");
    expect(code(SCRIPT)).toContain("Cancelled — nothing was changed.");
  });

  test("…and the phrase names the count, so it cannot be typed without reading the list", async () => {
    const { confirmationPhrase } = await import("../../scripts/line-remove-menus");
    expect(confirmationPhrase(6)).toBe("REMOVE 6");
    expect(confirmationPhrase(1)).not.toBe(confirmationPhrase(6));
  });

  test("🔴 §5 ORDER: default cancelled first, menus next, stored ids LAST", () => {
    // Deleting a menu that is still the default points the channel at a dead id for the length of the run; and
    // ids cleared first would strand the survivors of a run that dies midway.
    const s = code(SCRIPT);
    expect(s.indexOf("clearDefaultRichMenu()")).toBeLessThan(s.indexOf("deleteRichMenu(m.id)"));
    expect(s.indexOf("deleteRichMenu(m.id)")).toBeLessThan(s.indexOf("clearMenuIds("));
  });

  test("one failed delete does not abandon the rest, and the run reports it", () => {
    expect(code(SCRIPT)).toContain("failed.push(");
    expect(code(SCRIPT)).toContain("Re-run to finish");
  });

  test("no token ⇒ refuse before any call, non-zero", () => {
    const s = code(SCRIPT);
    expect(s.indexOf("LINE_CHANNEL_ACCESS_TOKEN")).toBeLessThan(s.indexOf("getMenuIds()"));
    expect(s).toContain("process.exit(1)");
  });

  test("a 404 on delete is success, in the function itself", () => {
    const fn = code(RICH).slice(code(RICH).indexOf("export async function deleteRichMenu"));
    expect(fn.slice(0, 500)).toContain('if (res.status === 404) return "already-gone"');
  });
});
