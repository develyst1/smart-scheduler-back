// SPEC-071 / TASK-243 — an admin clears a family's LINE binding.
//
// 🔴 Why it exists: entry is by phone alone, so the phone lookup binds the chat and
// `family_line_links_user_uq` makes that binding **permanent from the bot's side** — correctly, because a bot
// that could unbind itself would make the guarantee protecting every family worth nothing. But the refusal a
// parent reads says *"contact an admin"*, and until this there was no admin who could do anything about it.
//
// The clear itself needs rows, so the behavioural half is Tanya's. What is pinned here is the shape: ONE
// writer, no collateral damage, and no path from the bot to it.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";

const FAMILY = readSrc(await Bun.file(new URL("../lib/family-link.ts", import.meta.url)).text());
const PARENT_SVC = readSrc(await Bun.file(new URL("./parent.service.ts", import.meta.url)).text());
const API = readSrc(await Bun.file(new URL("../routes/api.ts", import.meta.url)).text());
const WEBHOOK = readSrc(await Bun.file(new URL("./line-webhook.service.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fn = (src: string, decl: string) => {
  const rest = src.slice(src.indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const CLEAR = fn(FAMILY, "export async function clearFamilyLine");

describe("🔴 BOTH sources are cleared together — one writer, never two", () => {
  test("it removes the join rows AND the parent's own `line_user_id`", () => {
    // TASK-230 kept the first link on `parents.line_user_id` so every existing reader stayed untouched.
    // Clearing one source and not the other is exactly the two-writer disagreement the accessor was built to
    // prevent — the family would look unbound to one reader and bound to the other.
    expect(code(CLEAR)).toContain("delete(familyLineLinks)");
    expect(code(CLEAR)).toContain("update(parents).set({ lineUserId: null })");
  });

  test("it reads WHICH accounts through the same accessor the binding side uses", () => {
    expect(code(CLEAR)).toContain("familyLineUserIds(parentId, tx)");
  });

  test("🔴 the two writes are ATOMIC — a half-cleared family is the state this function exists to prevent", () => {
    // Unbound to the accessor but still holding a stale `line_user_id` is exactly the two-reader disagreement
    // the clear was written to make impossible; leaving it reachable would have defeated its own argument.
    expect(code(CLEAR)).toContain("db.transaction(run)");
    // …and both writes are INSIDE the wrapped unit, not one in and one out.
    const unit = code(CLEAR).slice(code(CLEAR).indexOf("const run ="), code(CLEAR).indexOf("const result ="));
    expect(unit).toContain("delete(familyLineLinks)");
    expect(unit).toContain("update(parents)");
  });

  test("🔑 …and it stays COMPOSABLE — a caller with a transaction keeps using theirs", () => {
    // Every other writer in this file takes an `exec` and runs inside the caller's transaction. The standard
    // shape keeps both properties instead of trading one for the other.
    expect(code(CLEAR)).toContain("exec ? await run(exec) : await db.transaction(run)");
    // No default `= db` on the parameter — that is what makes "nobody supplied one" distinguishable.
    expect(code(CLEAR)).toContain("exec?: any");
  });

  test("the log line is written AFTER the write commits", () => {
    // A trail that claims something the database refused is worse than none — the same reason TASK-244 will
    // want the durable row inside this transaction rather than beside it.
    expect(code(CLEAR).indexOf("const result =")).toBeLessThan(code(CLEAR).indexOf("console.info"));
  });

  test("the service act is thin — the rule lives beside the binding it undoes", () => {
    // A second implementation in the service would let "what a family's accounts are" drift between the two
    // halves of the same question.
    const act = fn(PARENT_SVC, "export async function clearParentLineLink");
    expect(code(act)).toContain("clearFamilyLine(id, actor)");
    expect(code(act)).not.toContain("delete(");
    expect(code(act)).not.toContain("familyLineLinks");
  });
});

describe("🔴 it is an AUDITED, deliberate act — not a cleanup", () => {
  test("it takes an actor and records it", () => {
    // This is the ONLY way a LINE account can move between families, which is precisely what the unique index
    // exists to stop happening silently.
    expect(CLEAR).toContain("actor: string | null");
    expect(code(CLEAR)).toContain("by=${actor ?? \"unknown\"}");
    expect(code(CLEAR)).toContain("[family-link] CLEARED");
  });

  test("🔑 the actor comes from the TOKEN, never the request body", () => {
    // The rule TASK-160 set for discounts, for the same reason: an actor a caller can choose is not an actor.
    const route = API.slice(API.indexOf('.post("/parents/:id/clear-line-link"'));
    expect(route.slice(0, 300)).toContain('c.get("user")?.sub ?? null');
    expect(route.slice(0, 300)).not.toContain("body.actor");
  });
});

describe("🔴 it clears the LINK and nothing else — history is untouched", () => {
  test("no student, booking, note or message row is written", () => {
    // The tempting mistake is to read "unlink" as "remove the family". Asserted as an absence, because that is
    // the only way to prove collateral damage did not happen.
    for (const table of ["students", "bookings", "notificationOutbox", "coursePackages", "vouchers"]) {
      expect(code(CLEAR)).not.toContain(table);
    }
    const act = fn(PARENT_SVC, "export async function clearParentLineLink");
    for (const table of ["students", "bookings", "notificationOutbox"]) {
      expect(code(act)).not.toContain(`delete(${table}`);
    }
  });

  test("the family can bind again afterwards — that is the point", () => {
    // Nothing marks the parent as un-bindable; the same `bindFamilyLine` path is open again immediately.
    expect(code(CLEAR)).not.toContain("blocked");
    expect(FAMILY).toContain("export async function bindFamilyLine");
  });
});

describe("🚫 no LINE path can reach it — the AC-20 shape", () => {
  test("the webhook never calls the clear", () => {
    // `family-link.ts` IS imported by the bot (for `bindFamilyLine`), so the guard has to be about the CALL,
    // not the module. The bot must not be able to unbind anyone — that is the whole reason the binding is
    // permanent from its side.
    expect(code(WEBHOOK)).not.toContain("clearFamilyLine");
    expect(code(WEBHOOK)).not.toContain("clearParentLineLink");
    expect(code(WEBHOOK)).not.toContain("clear-line-link");
  });

  test("it is reachable only from the staff API", () => {
    expect(API).toContain('.post("/parents/:id/clear-line-link"');
    expect(code(PARENT_SVC)).toContain("export async function clearParentLineLink");
  });
});

describe("the People screen can see the state BEFORE acting", () => {
  test("`getParent` reports whether the family is linked, and how many accounts", () => {
    // The screen said nothing at all until now — which is why "contact an admin" pointed at someone with no
    // information as well as no button.
    const g = fn(PARENT_SVC, "export async function getParent");
    expect(code(g)).toContain("familyLineUserIds(id)");
    expect(code(g)).toContain("lineLinked: lineAccounts.length > 0");
    expect(code(g)).toContain("lineAccounts: lineAccounts.length");
  });

  test("🔑 it counts through the accessor, not off `parents.line_user_id`", () => {
    // Since TASK-230 a family can hold more than one account; reading the column would under-report and an
    // admin would clear something the screen said was not there.
    const g = fn(PARENT_SVC, "export async function getParent");
    expect(code(g)).not.toContain("row.lineUserId");
  });
});
