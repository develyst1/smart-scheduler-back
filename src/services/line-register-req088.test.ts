// TASK-347 (`REQ-088`) — TWO DOORS, ONE DECISION. The page calls the SAME writer the chat calls; if the page
// grows a rule of its own, it is wrong. This file holds that by ABSENCE on both doors, and holds the contract.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { parseBirthDate } from "../lib/line-add-student";

const read = async (rel: string) => readSrc(await Bun.file(new URL(rel, import.meta.url)).text());
const CHAT = await read("./line-webhook.service.ts");
const REG = await read("./line-register.service.ts");
const ROUTE = await read("../routes/register.ts");
const INDEX = await read("../index.ts");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const chat = code(CHAT), reg = code(REG), route = code(ROUTE);
const fnIn = (S: string, sig: string) => {
  const i = S.indexOf(sig);
  if (i < 0) throw new Error("no " + sig);
  return S.slice(i, S.indexOf("\n}\n", i) + 2);
};

describe("🔴 RULE 1 — no decision exists in TWO places, by ABSENCE on both doors", () => {
  /** The writers and deciders that MUST live only in the one home. */
  const DECISIONS = [
    "findParentByPhone(",
    "bindFamilyLine(",
    "findOrCreateParentByPhone(",
    "linkParentLine(",
    "moveRosterLink(",
    "createStudentForParent(",
    "decideDuplicate(",
    "isReservedWord(",
    "assertCanAddStudent(",
    'kind: "student_registered"',
    'getSetting("line_parent_2fa")',
    "draft: { twoFaCode: code }",
    "linkKnownRichMenu(",
  ];

  test("🔑 the one home has every one of them", () => {
    for (const d of DECISIONS) expect({ d, inHome: reg.includes(d) }).toEqual({ d, inHome: true });
  });

  test("🚫 the CHAT has NONE of them any more — it kept its replies and lost its decisions", () => {
    // ⚠️ `isReservedWord` stays in the chat: it is asked at the NAME STEP there, and the chat asks one step at a
    // time. It is the same function from `line-commands`, not a copy — the exception is named, not hidden.
    for (const d of DECISIONS.filter((x) => x !== "isReservedWord(" && x !== "assertCanAddStudent(")) {
      expect({ d, inChat: chat.includes(d) }).toEqual({ d, inChat: false });
    }
  });

  test("🚫 …and the PAGE has NONE of them either — it calls the home, it does not re-implement it", () => {
    for (const d of [...DECISIONS, "parseBirthDate(", "normalizePhone(", "listStudentsOfParent(", "familyOfLineUser("]) {
      expect({ d, inPage: route.includes(d) }).toEqual({ d, inPage: false });
    }
    // 🚫 and no hand-rolled copies of two things the home already owns:
    expect(route).not.toMatch(/<\s*5\b/); // the cap is `MAX_STUDENTS_PER_PARENT`, not a `5`
    expect(route).not.toContain('split("-").reverse()'); // the date is `ddmmyyyy`, not a second formatter
    expect(route).toContain("MAX_STUDENTS_PER_PARENT");
    expect(route).toContain("ddmmyyyy(");
  });

  test("✅ BOTH doors call the SAME functions", () => {
    const shared = ["linkFamilyByPhone(", "settleLinkedRole(", "twoFaEnabled()", "setTwoFaChallenge("];
    for (const s of shared) {
      expect({ s, chat: chat.includes(s), page: route.includes(s) }).toEqual({ s, chat: true, page: true });
    }
    // The chat asks one step at a time; the page composes. What they SHARE is every function in the composition.
    expect(chat).toContain("createStudentFromLine(");
    expect(chat).toContain("duplicateOutcomeFor(");
    expect(route).toContain("addChildForLineParent(");
    const compose = fnIn(reg, "export async function addChildForLineParent(");
    for (const s of ["isReservedWord(", "assertCanAddStudent(", "duplicateOutcomeFor(", "parseBirthDate(", "createStudentFromLine("]) {
      expect({ s, inCompose: compose.includes(s) }).toEqual({ s, inCompose: true });
    }
  });

  test("🔑 the page's guard ORDER is the chat's guard ORDER: reserved → cap → duplicate → birthdate → write", () => {
    // The chat asks these across steps; the page asks them in one call. Same order, asserted on both sources.
    const compose = fnIn(reg, "export async function addChildForLineParent(");
    const wizard = fnIn(chat, "async function handleAddStudentStep(");
    const order = ["isReservedWord(", "assertCanAddStudent(", "duplicateOutcomeFor(", "parseBirthDate(", "createStudentFromLine("];
    for (const S of [compose, wizard]) {
      for (let i = 1; i < order.length; i++) expect(S.indexOf(order[i - 1]!)).toBeLessThan(S.indexOf(order[i]!));
    }
  });

  test("🔑 the chat's REPLIES did not move — five keys, unchanged, mapped from the extracted outcomes", () => {
    const verify = fnIn(chat, "async function verifyAndLink(");
    for (const k of ["verify_parent_badphone", "verify_parent_other", "verify_parent_other_family", "verify_parent_ok_new", "verify_parent_ok_existing"]) {
      expect({ k, present: verify.includes(`t("${k}"`) }).toEqual({ k, present: true });
    }
    expect(verify).toContain("const r = await linkFamilyByPhone(lineUserId, code);");
    // …and the outcome → key map is explicit, one line each.
    expect(verify).toContain('if (r.outcome === "phone-invalid") return { ok: false, message: (l) => t("verify_parent_badphone", l) };');
    expect(verify).toContain('if (r.outcome === "phone-bound-to-other-line") return { ok: false, message: (l) => t("verify_parent_other", l) };');
  });
});

describe("🔴 RULE 2 — the page NEVER says who it is", () => {
  test("every handler verifies the ID token FIRST, and `sub` is the identity", () => {
    for (const h of ["/register/lookup", "/register/link", "/register/create"]) {
      const body = route.slice(route.indexOf(`"${h}"`));
      const handler = body.slice(0, body.indexOf(".post(", 10) > 0 ? body.indexOf(".post(", 10) : undefined);
      expect({ h, verifies: handler.includes("await verifyLiffIdToken(idToken)") }).toEqual({ h, verifies: true });
      // …before any decision: the verify call precedes the first call into the home.
      const firstDecision = Math.min(...["lookupFamilyByPhone(", "linkFamilyByPhone(", "addChildForLineParent("].map((d) => handler.indexOf(d)).filter((i) => i >= 0));
      expect(handler.indexOf("verifyLiffIdToken(")).toBeLessThan(firstDecision);
    }
  });

  test("🚫 no request body carries an identity — `lineUserId`, `parentId`, `familyId` are not fields", () => {
    const bodies = route.slice(route.indexOf("const withToken"), route.indexOf("const refuse"));
    for (const id of ["lineUserId", "parentId", "familyId", "sub:"]) {
      expect({ id, inBodies: bodies.includes(id) }).toEqual({ id, inBodies: false });
    }
  });

  test("🔴 TOKEN_WRONG_CHANNEL is distinguished from TOKEN_INVALID, and the local decode is trusted for nothing else", async () => {
    const TOKEN = await read("../lib/line-id-token.ts");
    expect(TOKEN).toContain("Trusted for NOTHING but choosing the error code");
    expect(code(TOKEN)).toContain('return { ok: false, code: "TOKEN_WRONG_CHANNEL" };');
    expect(code(TOKEN)).toContain("[line-id-token] WRONG CHANNEL");
    // …and the route maps all four token failures to their own status.
    for (const c of ["TOKEN_MISSING: 400", "TOKEN_WRONG_CHANNEL: 401", "TOKEN_INVALID: 401", "TOKEN_EXPIRED: 401"]) {
      expect({ c, present: route.includes(c) }).toEqual({ c, present: true });
    }
  });
});

describe("✅ RULES 3–6, each an assertion", () => {
  test("Rule 3 — `line_parent_2fa` is READ on the page path, in BOTH lookup and link, and ON has a stated behaviour", () => {
    const lookup = route.slice(route.indexOf('"/register/lookup"'), route.indexOf('"/register/link"'));
    const link = route.slice(route.indexOf('"/register/link"'), route.indexOf('"/register/create"'));
    expect(lookup).toContain("if (await twoFaEnabled())");
    expect(link).toContain("if (await twoFaEnabled())");
    // ON: lookup gates the NAMES behind the code (count only) and parks the challenge through the chat's writer;
    // link demands the code and checks it with the chat's matcher, BEFORE the write.
    expect(lookup).toContain('twoFactor: "required", childCount: children.length');
    expect(lookup).toContain("await setTwoFaChallenge(sub, code)");
    expect(lookup).toContain('"TWOFA_NOT_CONFIGURED"');
    expect(link).toContain('"TWOFA_CODE_REQUIRED"');
    expect(link).toContain("matches2faCode(await parkedTwoFaCode(who.sub), code)");
    expect(link.indexOf("matches2faCode(")).toBeLessThan(link.indexOf("linkFamilyByPhone("));
  });

  test("Rule 4 — no chat session step is left dangling: BOTH writes clear it, AFTER the menus (the chat's order)", () => {
    const link = route.slice(route.indexOf('"/register/link"'), route.indexOf('"/register/create"'));
    const create = route.slice(route.indexOf('"/register/create"'));
    expect(link).toContain("await clearLinkSession(who.sub)");
    expect(create).toContain("await clearLinkSession(who.sub)");
    // lang → menus → session, exactly as the chat: `settleLinkedRole` then the clear.
    expect(link.indexOf("settleLinkedRole(")).toBeLessThan(link.indexOf("clearLinkSession("));
    const settle = fnIn(reg, "export async function settleLinkedRole(");
    expect(settle.indexOf("getProfileLang(")).toBeLessThan(settle.indexOf("linkRoleRichMenu("));
    expect(settle.indexOf("linkRoleRichMenu(")).toBeLessThan(settle.indexOf("linkKnownRichMenu("));
    // …and the chat runs the same sequence before it touches its session.
    const after = chat.slice(chat.indexOf("const res = await verifyAndLink(lineUserId, role, text, lang);"));
    expect(after.indexOf("settleLinkedRole(")).toBeLessThan(after.indexOf("afterParentLink("));
  });

  test("Rule 5 — `ข้าม` is simply an absent field; there is NO cancel code", () => {
    expect(route).toContain("birthDate: z.string().optional()");
    expect(route).toContain("province: z.string().optional()");
    expect(route).not.toMatch(/CANCEL/);
    // 🔑 and the date is the customer's day-first TEXT through the chat's parser — which refuses ISO on purpose.
    expect(parseBirthDate("02-12-2024")).toEqual({ ok: true, value: "2024-12-02" });
    expect(parseBirthDate("2024-12-02")).toEqual({ ok: false });
    // ⚠️ THE TRAP THIS TEST FOUND: `parseBirthDate("")` is a REFUSAL — only the WORD ข้าม is a skip in the chat.
    // On the page ข้าม is an absent field, so the composition must treat a blank as the skip BEFORE the parser
    // sees it — and hand every provided value to the SAME parser. First draft did not; this assertion did.
    expect(parseBirthDate("")).toEqual({ ok: false });
    expect(parseBirthDate("ข้าม")).toEqual({ ok: true, value: null });
    const compose = fnIn(reg, "export async function addChildForLineParent(");
    expect(compose).toContain("const parsed = given ? parseBirthDate(given) : ({ ok: true, value: null } as const);");
  });

  test("Rule 6 — one stable `/register`, mounted beside `/checkin`; the token IS the credential", () => {
    expect(INDEX).toContain('app.route("/api", publicRegister);');
    expect(INDEX.indexOf("publicCheckin);")).toBeLessThan(INDEX.indexOf("publicRegister);"));
    for (const p of ['"/register/lookup"', '"/register/link"', '"/register/create"']) expect(route).toContain(p);
    expect(route).not.toMatch(/\/register\/:/); // no per-parent path
    expect(route).not.toContain(".get("); // nothing is read without a token, and a token is a body
  });
});

describe("📜 THE CONTRACT — every code the page may render is named here and nowhere is there a `message`", () => {
  test("🔑 every chat-side error reaches the page as a NAMED code", () => {
    for (const c of [
      "PHONE_INVALID", "PHONE_BOUND_TO_OTHER_LINE", "LINE_BOUND_TO_OTHER_FAMILY",
      "NOT_LINKED", "NAME_REQUIRED", "NAME_RESERVED", "FAMILY_FULL", "NAME_DUPLICATE_NEEDS_DETAIL", "BIRTHDATE_INVALID",
      "TWOFA_NOT_CONFIGURED", "TWOFA_CODE_REQUIRED", "TWOFA_CODE_BAD",
    ]) {
      expect({ c, named: route.includes(`"${c}"`) }).toEqual({ c, named: true });
    }
    // …and every outcome the home can produce has a row in the page's table (the table is the contract).
    const outcomes = [...reg.matchAll(/outcome: "([a-z-]+)"/g)].map((m) => m[1]!).filter((o) => o !== "found" && o !== "new" && o !== "linked" && o !== "created");
    for (const o of new Set(outcomes)) expect({ o, mapped: route.includes(`"${o}": [`) }).toEqual({ o, mapped: true });
  });

  test("🚫 the server returns NO `message` and takes NO `lang` — the page owns words", () => {
    expect(route).not.toMatch(/\bmessage\s*:/);
    expect(route).not.toMatch(/\blang\b/);
    expect(route).not.toMatch(/\bt\(/); // no i18n on this door at all
  });

  test("📌 the two env values are documented where the others are", async () => {
    const env = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    expect(env).toContain("LINE_LOGIN_CHANNEL_ID=");
    expect(env).toContain("LIFF_ID=");
  });
});
