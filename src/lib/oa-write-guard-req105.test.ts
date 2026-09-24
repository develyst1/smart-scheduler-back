// TASK-448 (REQ-105) — 🔴 the owner ran `line:relink-menus` against the CUSTOMER'S live OA (201 real families) because a
// local `.env` pointed there, and the printed header was the only thing standing in the way. This pins the guard: the five
// decisions by value (ok · unreadable · not-requested · mismatch · not-allowed), the refusal text that names BOTH sides,
// the `--account` parsing, the allow-list, and — the load-bearing one — a SCAN over `scripts/` so that any script which
// calls an OA-writing function without the guard fails this suite. Read-only tools stay unguarded and keep working.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { accountArg, decideOaWrite, oaWriteAllowList, type OaIdentity } from "./oa-guard";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const script = (f: string) => code(readSrc(readFileSync(resolve(root, "scripts", f), "utf8")));
const REAL: OaIdentity = { displayName: "SOM.BALANCE.SCHOOL", basicId: "@427ybeky" }; // the customer's — the account of the slip
const DEMO: OaIdentity = { displayName: "SOM-Balance-Demo", basicId: "@125vuzsj" };
const ALLOW = ["@125vuzsj"];

describe("🔴 the five decisions, by value", () => {
  test("ok — the operator named the token's own account AND it is on this machine's allow-list", () => {
    expect(decideOaWrite(DEMO, "@125vuzsj", ALLOW)).toEqual({ ok: true, account: "SOM-Balance-Demo (@125vuzsj)" });
    // the same account, spelled the ways a human types it
    for (const typed of ["@125vuzsj", "125vuzsj", " @125VUZSJ ", "@125VUZSJ", "SOM-Balance-Demo", "som-balance-demo"]) {
      expect({ typed, ok: decideOaWrite(DEMO, typed, ALLOW).ok }).toEqual({ typed, ok: true });
    }
    // …and the allow-list is matched the same way (a machine that lists it by name, or without the @)
    for (const allow of [["125vuzsj"], ["@125VUZSJ"], ["SOM-Balance-Demo"], ["@other", "@125vuzsj"]]) {
      expect({ allow, ok: decideOaWrite(DEMO, "@125vuzsj", allow).ok }).toEqual({ allow, ok: true });
    }
  });
  test("🔴 mismatch — THE SLIP: the token holds the customer's OA while the operator meant the demo; the refusal names BOTH", () => {
    const d = decideOaWrite(REAL, "@125vuzsj", ALLOW);
    expect(d).toEqual({
      ok: false,
      reason: "mismatch",
      message: "✗ refusing to write: token points at SOM.BALANCE.SCHOOL (@427ybeky); you asked for @125vuzsj — refusing.",
    });
    expect(!d.ok && d.message).toContain("@427ybeky"); // what the token IS
    expect(!d.ok && d.message).toContain("@125vuzsj"); // what the human MEANT
  });
  test("not-requested — no `--account` at all is a refusal, and the message says how to name it", () => {
    for (const requested of [undefined, "", "   ", "@"]) {
      const d = decideOaWrite(REAL, requested, ["@427ybeky"]);
      expect({ requested, reason: !d.ok && d.reason }).toEqual({ requested, reason: "not-requested" });
      expect(!d.ok && d.message).toContain("token points at SOM.BALANCE.SCHOOL (@427ybeky)");
      expect(!d.ok && d.message).toContain("--account @427ybeky");
    }
  });
  test("🔴 unreadable — a tool that cannot say which account it holds must NOT write to it (checked FIRST)", () => {
    for (const actual of [null, {}, { displayName: null, basicId: null }, { displayName: "", basicId: "" }]) {
      const d = decideOaWrite(actual as OaIdentity | null, "@125vuzsj", ALLOW);
      expect(!d.ok && d.reason).toBe("unreadable");
      expect(!d.ok && d.message).toContain("cannot read which LINE account this token holds");
    }
    // …even when the operator names an allowed account confidently: the identity check comes first
    expect(decideOaWrite(null, "@125vuzsj", ["@125vuzsj"]).ok).toBe(false);
  });
  test("not-allowed — the right account, correctly named, but this checkout may not write to it (an EMPTY list writes nothing)", () => {
    const d = decideOaWrite(REAL, "@427ybeky", ALLOW);
    expect({ reason: !d.ok && d.reason }).toEqual({ reason: "not-allowed" });
    expect(!d.ok && d.message).toContain("LINE_OA_WRITE_ALLOW=@125vuzsj");
    expect(decideOaWrite(DEMO, "@125vuzsj", []).ok).toBe(false);
    const empty = decideOaWrite(DEMO, "@125vuzsj", []);
    expect(!empty.ok && empty.message).toContain("LINE_OA_WRITE_ALLOW=empty");
    expect(oaWriteAllowList({})).toEqual([]);
    expect(oaWriteAllowList({ LINE_OA_WRITE_ALLOW: "" })).toEqual([]);
    expect(oaWriteAllowList({ LINE_OA_WRITE_ALLOW: " @a , @b ,, " })).toEqual(["@a", "@b"]);
  });
  test("`accountArg` — both spellings, and nothing invented when it is absent", () => {
    expect(accountArg(["bun", "x", "--apply", "--account", "@125vuzsj"])).toBe("@125vuzsj");
    expect(accountArg(["bun", "x", "--account=@125vuzsj", "--apply"])).toBe("@125vuzsj");
    expect(accountArg(["bun", "x", "--apply"])).toBeUndefined();
    expect(accountArg(["bun", "x", "--account"])).toBeUndefined();
  });
});

describe("🔴 THE SCAN — every OA-writing script is guarded, and the guard runs BEFORE the first write", () => {
  // The closed list of functions that write to the Messaging API. A script that calls ANY of them must call the guard.
  // 🔑 This is the census pin: a new OA-writing script added without `guardOaWriteOrExit` fails here, which is the whole
  // reason the guard is a rule and not a habit.
  const WRITERS = ["pushMessage", "replyMessage", "linkRichMenuToUser", "unlinkRichMenuFromUser", "createRichMenu", "uploadRichMenuImage", "deleteRichMenu", "setDefaultRichMenu", "clearDefaultRichMenu", "publishRichMenus"];
  const files = readdirSync(resolve(root, "scripts")).filter((f) => f.endsWith(".ts")).sort();
  const writesOA = (s: string) => WRITERS.filter((w) => new RegExp(`(^|[^\\w.])${w}\\(`, "m").test(s));

  test("the scan sees the scripts it is supposed to see (a check looking nowhere passes as quietly as a clean tree)", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files).toContain("line-relink-menus.ts");
    expect(writesOA(script("line-push.ts"))).toContain("pushMessage");
    expect(writesOA(script("line-inspect-menus.ts"))).toEqual([]); // read-only, and stays that way
  });

  test("🔴 every script that calls an OA writer calls `guardOaWriteOrExit`, before that writer", () => {
    const guarded: string[] = [];
    const unguarded: string[] = [];
    for (const f of files) {
      const s = script(f);
      const writers = writesOA(s);
      if (!writers.length) continue;
      if (!s.includes("guardOaWriteOrExit(")) {
        unguarded.push(`${f} (${writers.join(", ")})`);
        continue;
      }
      const firstWrite = Math.min(...writers.map((w) => s.search(new RegExp(`(^|[^\\w.])${w}\\(`, "m"))).filter((i) => i >= 0));
      expect({ f, guardBeforeFirstWrite: s.indexOf("guardOaWriteOrExit(") < firstWrite }).toEqual({ f, guardBeforeFirstWrite: true });
      guarded.push(f);
    }
    expect(unguarded).toEqual([]);
    expect(guarded.sort()).toEqual(["line-publish-menus.ts", "line-push.ts", "line-relink-menus.ts", "line-remove-menus.ts"]);
  });

  test("the two read-only tools are NOT guarded and still print the account they are reading", () => {
    for (const f of ["line-inspect-menus.ts", "line-adopt-menus.ts"]) {
      const s = script(f);
      expect({ f, writes: writesOA(s), guarded: s.includes("guardOaWriteOrExit(") }).toEqual({ f, writes: [], guarded: false });
    }
    expect(script("line-inspect-menus.ts")).toContain("getBotAccountLabel");
    // 🔻 `line-adopt-menus` writes only to OUR `app_settings` (`storeMenuIds`) — nothing reaches the customer's account.
    expect(script("line-adopt-menus.ts")).toContain("storeMenuIds");
    // 🔻 `line-webhook-test` POSTs to OUR OWN webhook with a signed fake event; it never calls the Messaging API.
    expect(writesOA(script("line-webhook-test.ts"))).toEqual([]);
  });

  test("the dry runs stay open: in both sweep scripts the guard sits AFTER the plan print and AFTER the `--apply` exit", () => {
    for (const [f, planLine] of [["line-relink-menus.ts", "console.log(formatRelinkPlan(plan, { apply, account }));"], ["line-remove-menus.ts", "console.log(formatRemovalPlan(plan, { apply, account }));"]] as const) {
      const s = script(f);
      expect({ f, afterPlan: s.indexOf("guardOaWriteOrExit(") > s.indexOf(planLine) }).toEqual({ f, afterPlan: true });
      expect({ f, afterApplyExit: s.indexOf("guardOaWriteOrExit(") > s.indexOf("if (!apply)") }).toEqual({ f, afterApplyExit: true });
      expect({ f, beforePrompt: s.indexOf("guardOaWriteOrExit(") < s.indexOf("const expected = confirmationPhrase(") }).toEqual({ f, beforePrompt: true });
    }
  });

  test("the guard exits rather than throwing — a script cannot swallow the refusal; and it prints what it allowed", () => {
    const G = code(readSrc(readFileSync(resolve(root, "src/lib/oa-guard.ts"), "utf8")));
    expect(G).toContain("console.error(decision.message);");
    expect(G).toContain("process.exit(1);");
    expect(G).toContain("✓ writing to ${decision.account} (named with --account, on the allow-list)");
    expect(G).toContain('const decision = decideOaWrite(await getBotIdentity(), accountArg(argv), oaWriteAllowList());');
    expect(G).toContain('if (!res.ok) return null;'); // an unreadable identity is a null, which the decision refuses
    expect(readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).length).toBe(55); // no migration
  });
});
