// TASK-583 (ruling 4: "the chat matches the page — no ข้าม, the same duplicate-name wording") — the parts built.
//   · every SKIP shape in the chat, DERIVED from the two skip vocabularies' uses, each named with what it now does;
//   · the birthday is required at the ONE LINE-side writer (the floor under every door), proven by value;
//   · ONE duplicate sentence: the chat's key IS the page's words (the refusal carries it), proven by value through the root app.
// ⛔ F-C (province + district + sub-district from ONE rule) and D11(a) (bind only when finished) are STOPPED — see the TASK report.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "./line-i18n";
import { SKIP, isSkip, parseBirthDate } from "./line-add-student";
import { provinceFromTyped } from "./full-address"; // TASK-590
import { CMD_SKIP } from "./line-commands";
import * as parentSvc from "../services/parent.service";
import * as lineAdmin from "./line-admin";
import * as reg from "../services/line-register.service";
import * as idToken from "./line-id-token";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });
const srcFiles = (dir: string): string[] => readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? srcFiles(`${dir}/${d.name}`) : d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [`${dir}/${d.name}`] : []);
const ALL = srcFiles("src").map((f) => [f, code(read(f))] as const);
const WEBHOOK = code(read("src/services/line-webhook.service.ts"));

describe("🔑 every ข้าม SHAPE in the chat, DERIVED — each use of the two skip vocabularies, named with what it does now", () => {
  test("`isSkip` (the per-FIELD vocabulary): every caller named, and at EACH a skip is a REFUSAL, not an answer", () => {
    const callers = ALL.flatMap(([f, s]) => [...s.matchAll(/isSkip\(([^)]*)\)/g)].map((m) => `${f}: isSkip(${m[1]})`)).filter((x) => !x.includes("export const isSkip"));
    // 🔻 TASK-590 (F-C) — the one address answer became three questions; the province is resolved to one of the 77 (a skip word is
    // simply not a province), the district and sub-district refuse a skip word by name.
    expect(callers).toEqual(["src/lib/line-add-student.ts: isSkip(raw)", "src/services/line-webhook.service.ts: isSkip(district)", "src/services/line-webhook.service.ts: isSkip(subDistrict)"]);
    // (1) the birthday parser reads a skip word as "no date" — and BOTH doors refuse "no date"
    expect(parseBirthDate("ข้าม")).toEqual({ ok: true, value: null });
    expect(WEBHOOK).toContain('if (parsed.value == null) return strikeOrPrompt(lineUserId, session, replyToken, t("add_birthdate_prompt", lang), lang);');
    expect(read("src/services/line-register.service.ts")).toContain('if (parsed.value == null) return { ok: false, refusal: { outcome: "birthdate-required" } };');
    // (2) the address steps
    expect(WEBHOOK).toContain('if (!province) return strikeOrPrompt(lineUserId, session, replyToken, t("add_addr_province_bad", lang), lang);');
    for (const w of SKIP) expect(provinceFromTyped(w)).toBeNull();
    expect(WEBHOOK).toContain('if (!district || isSkip(district)) return strikeOrPrompt(');
    expect(WEBHOOK).toContain('if (!subDistrict || isSkip(subDistrict)) return strikeOrPrompt(');
    expect(WEBHOOK).not.toContain("isSkip(text) ? null");
    for (const w of SKIP) expect(isSkip(w)).toBe(true); // the whole vocabulary is caught, not only ข้าม
  });
  test("`SKIP_WORDS` (CMD_SKIP) has ONE use: ending the add-ANOTHER-child loop — a parent with NO child still cannot (TASK-307); no FIELD is skipped", () => {
    expect([...WEBHOOK.matchAll(/SKIP_WORDS\.includes\(/g)].length).toBe(1);
    const at = WEBHOOK.indexOf('if (SKIP_WORDS.includes(lower) && session?.step === "AWAIT_STUDENT_NAME")');
    const guard = WEBHOOK.slice(at, WEBHOOK.indexOf("return handleAddStudentStep(", at));
    expect(guard).toContain("if (!kids.length) {"); // the first child cannot be skipped
    expect(CMD_SKIP).toContain("ข้าม"); // ⚖️ kept, deliberately: at the NAME step with a child on file it means "no more children"
  });
  test("the SILENT accept: `add น้องเอ` no longer writes a child from the name alone — it enters the wizard", () => {
    expect(WEBHOOK).not.toMatch(/addStudentAndReply|createStudentFromLine\(parent, \{ name \}\)/);
    expect(ALL.filter(([, s]) => /createStudentFromLine\(/.test(s)).map(([f]) => f).sort()).toEqual(["src/services/line-register.service.ts", "src/services/line-webhook.service.ts"]);
    expect([...WEBHOOK.matchAll(/createStudentFromLine\(/g)].length).toBe(1); // the wizard's CONFIRM, and nothing else in the chat
  });
  test("the CONFIRM carries no hole to the write: a draft missing its birthday or address goes BACK to that question first", () => {
    const confirm = WEBHOOK.slice(WEBHOOK.indexOf('if (session.step === "AWAIT_STUDENT_CONFIRM") {'));
    // 🔻 TASK-590 — the address hole is "not a full address by THE rule" (three parts), not "no province"
    const order = ["if (!draft.birthDate) {", 'setDraft(lineUserId, "AWAIT_STUDENT_BIRTHDATE", draft)', "if (!addressOnFile && !checkFullAddress(draft).ok) {", 'setDraft(lineUserId, "AWAIT_STUDENT_PROVINCE", draft)', "registerFamilyWithFirstChild(", "createStudentFromLine(parent!, {"];
    const at = order.map((o) => confirm.indexOf(o));
    expect({ missing: order.filter((_, i) => at[i]! < 0) }).toEqual({ missing: [] }); // PRESENT, each — a -1 would pass the order check below
    for (let i = 1; i < order.length; i++) expect(at[i - 1]!).toBeLessThan(at[i]!);
  });
  test("the HINTS: no string the chat's registration shows advertises ข้าม / skip any more (the `added_more` key went with its sender)", () => {
    for (const k of ["add_birthdate_prompt", "add_birthdate_bad", "add_addr_province_prompt", "add_addr_province_bad", "add_addr_district_prompt", "add_addr_subdistrict_prompt", "add_student_name_prompt", "add_dup_detail", "add_summary_confirm", "add_another_hint", "add_phone_now_registered"]) {
      for (const lang of ["TH", "EN"] as const) expect({ k, lang, skip: /ข้าม|\bskip\b/i.test(t(k, lang)) }).toEqual({ k, lang, skip: false });
    }
    expect(read("src/lib/line-i18n.ts")).not.toMatch(/^\s*added_more:/m);
  });
});

describe("🔴 the ONE rule under every LINE door: a child is never written without a birthday", () => {
  test("by value: `createStudentFromLine` with no birthday ⇒ 400 BEFORE the student write and before any admin notice", async () => {
    const calls: string[] = [];
    spies.push(spyOn(parentSvc, "createStudentForParent").mockImplementation((async () => { calls.push("write"); return { student: { id: "s", name: "x" }, count: 1 }; }) as any));
    spies.push(spyOn(lineAdmin, "notifyAdmins").mockImplementation((async () => { calls.push("notify"); }) as any));
    for (const birthDate of [undefined, null, ""]) {
      const e: any = await reg.createStudentFromLine({ id: "p1", phone: "0800000000" }, { name: "น้องเอ", birthDate }).catch((x) => x);
      expect([e.status, e.message]).toEqual([400, "กรุณาระบุวันเกิดของนักเรียน"]); // 📋 DRAFT
    }
    expect(calls).toEqual([]);
    await reg.createStudentFromLine({ id: "p1", phone: "0800000000" }, { name: "น้องเอ", birthDate: "2019-02-01" });
    expect(calls).toEqual(["write", "notify"]);
  });
});

describe("🔑 ONE duplicate sentence, ONE source — the chat's key, carried by the page's refusal", () => {
  test("by value through the ROOT app: NAME_DUPLICATE_NEEDS_DETAIL carries `message` = exactly the chat's `add_dup_detail`, both languages", async () => {
    spies.push(spyOn(idToken, "verifyLiffIdToken").mockImplementation((async () => ({ ok: true, sub: "U-parent" })) as any));
    spies.push(spyOn(reg, "addChildForLineParent").mockImplementation((async () => ({ outcome: "name-duplicate-needs-detail", name: "น้องเอ" })) as any));
    const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
    const r = await app.fetch(new Request("http://localhost/api/register/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "t", name: "น้องเอ", birthDate: "01-02-2019" }) }));
    const body: any = await r.json();
    expect([r.status, body]).toEqual([409, { ok: false, code: "NAME_DUPLICATE_NEEDS_DETAIL", name: "น้องเอ", message: { TH: t("add_dup_detail", "TH"), EN: t("add_dup_detail", "EN") } }]);
  });
  test("and the chat asks with that same key; the words are the page's (COPY §8 DRAFT): the REAL name, never a rename", () => {
    expect(WEBHOOK).toContain('withExit(t("add_dup_detail", lang), lang)');
    expect(t("add_dup_detail", "TH")).toBe("มีน้องชื่อนี้ในครอบครัวแล้ว — กรุณาใส่ชื่อจริงของน้อง (ชื่อ-นามสกุล) เพื่อไม่ให้สับสนกันค่ะ");
    expect(t("add_dup_detail", "EN")).toBe("There is already a child with this name. Please enter the child's real name (first name and surname) so they are not mixed up.");
  });
});
