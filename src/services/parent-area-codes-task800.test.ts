// TASK-800 (REQ-118) — the parent's address as AREA CODES, by value through the doors: the register page's writer, the admin PATCH rule, the DTO, the chat that no longer asks, the backfill's decisions, the migration.
// Contract (ruled by @Sober 2026-10-12): keys provinceCode / districtCode / subdistrictCode · codes WIN, names only = today · admin all-or-none, null×3 clears, a name-only change must be one of the 77 ·
// the DTO carries the three codes + addressTh / addressEn · the register responses are unchanged.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildGeography, useGeographyForTests } from "../lib/area-codes";
import { parentAddressPatch, parentAddressView } from "./parent.service";
import * as parentSvc from "./parent.service";
import * as lineAdmin from "../lib/line-admin";
import * as reg from "./line-register.service";
import { checkAddress, createStudentFromLine, registerFamilyWithFirstChild } from "./line-register.service";
import * as familyLinkLib from "../lib/family-link";
import * as rosterLink from "../lib/roster-link";
import * as lineIdToken from "../lib/line-id-token";
import { planBackfill, type BackfillRow } from "../lib/area-backfill";
import { nextStep } from "../lib/line-add-student";
import { db } from "../db";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const FIXTURE = buildGeography(JSON.parse(read("src/lib/__fixtures__/thai-geography.fixture.json")));
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); useGeographyForTests(null); });
const useFixture = () => useGeographyForTests(FIXTURE);
const BKK = { provinceCode: "10", districtCode: "1001", subdistrictCode: "100101" };

describe("🔴 the ADMIN door (POST/PATCH /parents) — `parentAddressPatch`", () => {
  test("codes WIN: a consistent triple is stored and `province` is DERIVED from the code (a name in the same body is ignored)", () => {
    useFixture();
    expect(parentAddressPatch({ ...BKK, province: "ภูเก็ต" })).toEqual({ province: "กรุงเทพมหานคร", provinceCode: "10", districtCode: "1001", subdistrictCode: "100101" });
  });
  test("all or none: a half triple is REFUSED — two keys, one key, a value beside a null, a value beside an empty string", () => {
    useFixture();
    for (const half of [{ provinceCode: "10", districtCode: "1001" }, { provinceCode: "10" }, { provinceCode: "10", districtCode: null, subdistrictCode: null }, { provinceCode: "10", districtCode: "1001", subdistrictCode: "" },
      { provinceCode: null }, { provinceCode: null, districtCode: null }, { districtCode: null, subdistrictCode: null }]) { // a MISSING key is not a null: clearing needs all THREE keys
      expect(() => parentAddressPatch(half as any)).toThrow(/ที่อยู่ต้องมีจังหวัด อำเภอ\/เขต และตำบล\/แขวง/);
    }
  });
  test("null × 3 (or empty × 3) CLEARS the address: the three codes AND `province` become NULL", () => {
    expect(parentAddressPatch({ provinceCode: null, districtCode: null, subdistrictCode: null })).toEqual({ province: null, provinceCode: null, districtCode: null, subdistrictCode: null });
    expect(parentAddressPatch({ provinceCode: "", districtCode: "", subdistrictCode: "" })).toEqual({ province: null, provinceCode: null, districtCode: null, subdistrictCode: null });
  });
  test("an INCONSISTENT triple is refused (the district not in the province; the sub-district not in the district); an unknown province code carries the existing PROVINCE_UNKNOWN code", () => {
    useFixture();
    expect(() => parentAddressPatch({ provinceCode: "10", districtCode: "1201", subdistrictCode: "120101" })).toThrow(/ที่อยู่ต้องมีจังหวัด/);
    expect(() => parentAddressPatch({ provinceCode: "10", districtCode: "1001", subdistrictCode: "100201" })).toThrow(/ที่อยู่ต้องมีจังหวัด/);
    try { parentAddressPatch({ provinceCode: "99", districtCode: "9901", subdistrictCode: "990101" }); throw new Error("not refused"); } catch (e: any) { expect([e.status, e.code]).toEqual([400, "PROVINCE_UNKNOWN"]); }
  });
  test("a PATCH with only the old province NAME: accepted ONLY if it is one of the 77 (today's PATCH checked nothing — the find behind the 3 bad uat rows); a name CHANGE clears stale codes", () => {
    expect(parentAddressPatch({ province: "ภูเก็ต" }, { province: "เชียงใหม่" })).toEqual({ province: "ภูเก็ต", provinceCode: null, districtCode: null, subdistrictCode: null });
    for (const bad of ["พระนคร", "Bangkok", "กทม", "จังหวัดภูเก็ต"]) {
      try { parentAddressPatch({ province: bad }, { province: "เชียงใหม่" }); throw new Error("not refused"); } catch (e: any) { expect([bad, e.status, e.code]).toEqual([bad, 400, "PROVINCE_UNKNOWN"]); }
    }
  });
  test("a name EQUAL to what the row already holds changes NOTHING: the current admin form re-sends the province on every save — it must not wipe the codes, nor refuse a row's other edits (the 3 bad uat rows)", () => {
    expect(parentAddressPatch({ province: "กรุงเทพมหานคร" }, { province: "กรุงเทพมหานคร" })).toEqual({});
    expect(parentAddressPatch({ province: "ที่อยู่ภาษาอังกฤษ 12 Some Street" }, { province: "ที่อยู่ภาษาอังกฤษ 12 Some Street" })).toEqual({}); // legacy text it already holds
  });
  test("no address key at all ⇒ nothing (a note-only PATCH never touches the address)", () => {
    expect(parentAddressPatch({})).toEqual({});
  });
});

describe("the parent DTO — the three codes + addressTh / addressEn", () => {
  test("`parentAddressView` renders each language from the codes; null when there are no codes (and the dataset is not even read)", () => {
    useFixture();
    expect(parentAddressView(BKK)).toEqual({ addressTh: "พระบรมมหาราชวัง พระนคร กรุงเทพมหานคร", addressEn: "Phra Borom Maha Ratchawang Phra Nakhon Bangkok" });
    expect(parentAddressView({ provinceCode: null, districtCode: null, subdistrictCode: null })).toEqual({ addressTh: null, addressEn: null });
    expect(parentAddressView({ provinceCode: "10", districtCode: null, subdistrictCode: null })).toEqual({ addressTh: null, addressEn: null }); // the backfill's province-only rows: the card keeps the raw `province`
  });
  test("by source: every parent the API returns carries it — the list, the detail, the create (the codes are columns of the row, spread with it)", () => {
    const S = read("src/services/parent.service.ts");
    expect(S).toContain("return { ...p, ...parentAddressView(p), students: all.filter");
    expect(S).toContain("return { ...row, ...parentAddressView(row), lineAccounts: lineAccounts.length");
    expect(S).toContain("return { ...row, ...parentAddressView(row), students: [] };");
    expect(S).toContain("...parentAddressPatch(input), // 🔻 TASK-800");
    expect(S).toContain("Object.assign(patch, parentAddressPatch(input, current));");
  });
  test("by source: the validation carries the three keys on BOTH parent schemas (nullable, so `null` can clear)", () => {
    const V = read("src/validation.ts");
    expect([...V.matchAll(/provinceCode: z\.string\(\)\.trim\(\)\.max\(8\)\.nullish\(\)/g)]).toHaveLength(2);
    expect([...V.matchAll(/subdistrictCode: z\.string\(\)\.trim\(\)\.max\(8\)\.nullish\(\)/g)]).toHaveLength(2);
  });
});

describe("🔴 the REGISTER door — `checkAddress`: codes win, names only = today's behaviour", () => {
  const child = (over: any) => ({ name: "มะขิด", ...over });
  test("a complete consistent triple ⇒ ok, `province` derived from the code, the codes carried (the names in the body are ignored)", () => {
    useFixture();
    const r = checkAddress(child({ ...BKK, province: "ภูเก็ต", district: "x", subDistrict: "y" }));
    expect(r).toEqual({ ok: true, address: { province: "กรุงเทพมหานคร", codes: BKK } });
  });
  test("the refusals REUSE today's outcomes (no new words): an unknown province code ⇒ province-unknown · a half triple ⇒ address-incomplete naming the part · a district / sub-district outside its parent ⇒ address-incomplete naming it", () => {
    useFixture();
    expect(checkAddress(child({ provinceCode: "99", districtCode: "9901", subdistrictCode: "990101" }))).toEqual({ ok: false, refusal: { outcome: "province-unknown", province: "99" } });
    expect(checkAddress(child({ provinceCode: "10", districtCode: "1001" }))).toEqual({ ok: false, refusal: { outcome: "address-incomplete", missing: ["subDistrict"] } });
    expect(checkAddress(child({ provinceCode: "10" }))).toEqual({ ok: false, refusal: { outcome: "address-incomplete", missing: ["district", "subDistrict"] } });
    expect(checkAddress(child({ provinceCode: "10", districtCode: "1201", subdistrictCode: "120101" }))).toEqual({ ok: false, refusal: { outcome: "address-incomplete", missing: ["district"] } });
    expect(checkAddress(child({ provinceCode: "10", districtCode: "1001", subdistrictCode: "100201" }))).toEqual({ ok: false, refusal: { outcome: "address-incomplete", missing: ["subDistrict"] } });
  });
  test("NAMES ONLY (a LIFF page cached from before the release) ⇒ today's behaviour exactly: the shape check, no codes", () => {
    const r = checkAddress(child({ province: "กรุงเทพมหานคร", district: "พระนคร", subDistrict: "พระบรมมหาราชวัง" }));
    expect(r).toMatchObject({ ok: true, address: { province: "กรุงเทพมหานคร", district: "พระนคร", subDistrict: "พระบรมมหาราชวัง", line: "พระบรมมหาราชวัง พระนคร กทม" } });
    expect((r as any).address.codes).toBeUndefined();
    expect(checkAddress(child({}))).toEqual({ ok: false, refusal: { outcome: "address-required" } });
    expect(checkAddress(child({ province: "Atlantis", district: "a", subDistrict: "b" }))).toEqual({ ok: false, refusal: { outcome: "province-unknown", province: "Atlantis" } });
  });
});

describe("🔴 the register WRITER — `createStudentFromLine`", () => {
  const harness = () => {
    const updates: any[] = [];
    const exec: any = { update: () => ({ set: (p: any) => ({ where: async () => { updates.push(p); } }) }), select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ note: "staff note" }] }) }) }) };
    spies.push(spyOn(parentSvc, "createStudentForParent").mockImplementation((async () => ({ student: { id: "s1", name: "มะขิด" }, count: 1 })) as any));
    spies.push(spyOn(lineAdmin, "notifyAdmins").mockImplementation((async () => 0) as any));
    return { updates, exec };
  };
  const parent = { id: "p1", phone: "0811111111" };
  test("CODES: `province` DERIVED, the three codes written, and NO line appended to `note` (the codes ARE the address)", async () => {
    useFixture();
    const h = harness();
    await createStudentFromLine(parent, { name: "มะขิด", birthDate: "2018-05-01", address: { province: "กรุงเทพมหานคร", codes: BKK } }, h.exec);
    expect(h.updates).toEqual([{ province: "กรุงเทพมหานคร", provinceCode: "10", districtCode: "1001", subdistrictCode: "100101" }]);
    expect(h.updates[0]).not.toHaveProperty("note");
  });
  test("the writer asks AGAIN (the floor): an inconsistent triple that slipped past a door is refused before anything is written", async () => {
    useFixture();
    const h = harness();
    await expect(createStudentFromLine(parent, { name: "x", birthDate: "2018-05-01", address: { codes: { provinceCode: "10", districtCode: "1201", subdistrictCode: "120101" } } }, h.exec)).rejects.toThrow(/ที่อยู่ต้องมีจังหวัด/);
    expect(h.updates).toEqual([]);
  });
  test("NAMES ONLY: today's path — `province` and the one line APPENDED to the staff note, codes untouched", async () => {
    const h = harness();
    await createStudentFromLine(parent, { name: "มะขิด", birthDate: "2018-05-01", address: { province: "กรุงเทพมหานคร", district: "พระนคร", subDistrict: "พระบรมมหาราชวัง" } }, h.exec);
    expect(h.updates).toEqual([{ province: "กรุงเทพมหานคร", note: "staff note\nพระบรมมหาราชวัง พระนคร กทม" }]);
  });
  test("NO address ⇒ the child is created and the household is not touched (what the chat sends now)", async () => {
    const h = harness();
    await createStudentFromLine(parent, { name: "มะขิด", birthDate: "2018-05-01", address: null }, h.exec);
    expect(h.updates).toEqual([]);
  });
});

describe("🔴 the register ROUTE plumbs the codes to the writer (the reproduction: it used to THROW THEM AWAY)", () => {
  test("POST /api/register/create with the three codes ⇒ `addChildForLineParent` receives them; names-only ⇒ receives none", async () => {
    spies.push(spyOn(lineIdToken, "verifyLiffIdToken").mockImplementation((async () => ({ ok: true, sub: "Uline" })) as any));
    spies.push(spyOn(reg, "linkStatus").mockImplementation((async () => ({ linked: true, parentId: "p1", phone: "0xx", childCount: 0, addressOnFile: false, province: null })) as any));
    spies.push(spyOn(reg, "clearLinkSession").mockImplementation((async () => {}) as any)); // (the session row is not under test)
    const seen: any[] = [];
    spies.push(spyOn(reg, "addChildForLineParent").mockImplementation((async (_sub: string, child: any) => { seen.push(child); return { outcome: "created", student: { id: "s1", name: "x" }, birthDate: "2018-05-01", count: 1, atMax: false, addressOnFile: true, province: "กรุงเทพมหานคร" }; }) as any));
    const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
    const post = (body: unknown) => app.fetch(new Request("http://localhost/api/register/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await post({ idToken: "t", name: "x", birthDate: "01-05-2018", province: "กรุงเทพมหานคร", district: "พระนคร", subDistrict: "พระบรมมหาราชวัง", ...BKK })).status).toBe(200);
    expect(seen[0]).toMatchObject(BKK);
    expect((await post({ idToken: "t", name: "x", birthDate: "01-05-2018", province: "กรุงเทพมหานคร", district: "พระนคร", subDistrict: "พระบรมมหาราชวัง" })).status).toBe(200);
    expect(seen[1]).toMatchObject({ provinceCode: null, districtCode: null, subdistrictCode: null, province: "กรุงเทพมหานคร" });
  });
});

describe("🔴 the LINE CHAT asks NO address (owner ruling 2)", () => {
  const W = read("src/services/line-webhook.service.ts");
  test("the step machine: the birthday goes STRAIGHT to the confirm; a session parked on an old address step is routed to it too", () => {
    expect(nextStep("AWAIT_STUDENT_BIRTHDATE")).toBe("AWAIT_STUDENT_CONFIRM");
    for (const old of ["AWAIT_STUDENT_PROVINCE", "AWAIT_STUDENT_DISTRICT", "AWAIT_STUDENT_SUBDISTRICT"] as const) expect(nextStep(old)).toBe("AWAIT_STUDENT_CONFIRM");
  });
  test("by source: after the birthday → the summary (no setDraft into an address step), the three question handlers are GONE, no address prompt/refusal key is read by the flow", () => {
    const birth = W.slice(W.indexOf('if (session.step === "AWAIT_STUDENT_BIRTHDATE") {'), W.indexOf('if (session.step === "AWAIT_STUDENT_CONFIRM") {'));
    expect(birth).toContain("return showStudentSummary(lineUserId, { ...draft, birthDate: parsed.value }, replyToken, lang, addressOnFile ?");
    expect(birth).not.toContain('setDraft(lineUserId, "AWAIT_STUDENT_PROVINCE"');
    expect(birth).not.toMatch(/provinceFromTyped|checkFullAddress/);
    for (const key of ["add_addr_province_prompt", "add_addr_district_prompt", "add_addr_subdistrict_prompt", "add_addr_province_bad", "add_province_prompt"]) expect(W).not.toContain(key);
    expect(W).not.toContain("provinceFromTyped");
  });
  test("by source: the legacy session on an address step goes to the summary (or back to the birthday question when it has none) — never dropped, never re-asked", () => {
    expect(W).toContain('if (session.step === "AWAIT_STUDENT_PROVINCE" || session.step === "AWAIT_STUDENT_DISTRICT" || session.step === "AWAIT_STUDENT_SUBDISTRICT") {');
  });
  test("by source: the summary carries an address line ONLY when one is on file; the confirm writes none — a linked family `address = null`, a new family `addressOptional: true`", () => {
    expect(W).toContain(".filter((l) => addressText !== null || !l.startsWith(`${provinceLabel}:`));");
    const confirm = W.slice(W.indexOf('if (session.step === "AWAIT_STUDENT_CONFIRM") {'), W.indexOf("// Unknown step inside this flow"));
    expect(confirm).toContain("const address = null;");
    expect(confirm).toContain("{ addressOptional: true }");
    expect(confirm).not.toContain("checkFullAddress");
  });
  test("a NEW family from the chat is registered WITHOUT an address (`addressOptional`), while the page still requires one", async () => {
    spies.push(spyOn(familyLinkLib, "familyOfLineUser").mockImplementation((async () => null) as any));
    spies.push(spyOn(parentSvc, "findArchivedParentByPhone").mockImplementation((async () => null) as any));
    spies.push(spyOn(parentSvc, "findParentByPhone").mockImplementation((async () => null) as any));
    const calls: any[] = [];
    spies.push(spyOn(reg, "createStudentFromLine").mockImplementation((async (_p: any, input: any) => { calls.push(input); return { student: { id: "s1", name: "มะขิด" }, count: 1 }; }) as any));
    spies.push(spyOn(parentSvc, "findOrCreateParentByPhone").mockImplementation((async () => ({ id: "p1", phone: "0811111111" })) as any));
    spies.push(spyOn(db, "transaction").mockImplementation((async (fn: any) => fn({})) as any));
    spies.push(spyOn(rosterLink, "moveRosterLink").mockImplementation((async () => {}) as any));
    const chat = await registerFamilyWithFirstChild("Uline", "0811111111", { name: "มะขิด", birthDate: "01-05-2018" }, { addressOptional: true });
    expect(chat.outcome).toBe("registered");
    expect(calls[0].address).toBeNull();
    const page = await registerFamilyWithFirstChild("Uline", "0811111111", { name: "มะขิด", birthDate: "01-05-2018" });
    expect(page.outcome).toBe("address-required"); // the page's door keeps its rule
  });
});

describe("🔴 the BACKFILL — decisions by value (`planBackfill`), never a guess", () => {
  const row = (id: string, province: string | null, note: string | null, over: Partial<BackfillRow> = {}): BackfillRow => ({ id, province, note, provinceCode: null, districtCode: null, subdistrictCode: null, ...over });
  const plan = (rows: BackfillRow[]) => planBackfill(rows, FIXTURE);
  const only = (r: BackfillRow) => plan([r]).decisions[0]!;
  test("province code by EXACT name (one of the 77); a province-only parent gets the province code, district / sub-district stay NULL, and the reason is listed", () => {
    expect(only(row("a", "นนทบุรี", null))).toMatchObject({ action: "write", provinceCode: "12", districtCode: null, subdistrictCode: null, level: "province", unmatched: "no-address-line" });
  });
  test("a note line EXACTLY in our doors' format that resolves to ONE triple ⇒ the full triple (Bangkok's everyday short form `กทม` accepted); other note lines are ignored", () => {
    expect(only(row("b", "กรุงเทพมหานคร", "แพ้ถั่ว\nพระบรมมหาราชวัง พระนคร กทม"))).toMatchObject({ action: "write", provinceCode: "10", districtCode: "1001", subdistrictCode: "100101", level: "full", unmatched: null });
    expect(only(row("b2", "นนทบุรี", "สวนใหญ่ เมืองนนทบุรี นนทบุรี"))).toMatchObject({ level: "full", subdistrictCode: "120101" });
  });
  test("EVERY reason is produced: province-not-one-of-77 (never parsed) · no-province · no-address-line · line-not-our-format · name-not-in-dataset · ambiguous", () => {
    expect(only(row("c", "ซอยสุขุมวิท 12 Bangkok 10110", "พระบรมมหาราชวัง พระนคร กทม"))).toEqual({ id: "c", action: "none", unmatched: "province-not-one-of-77" });
    expect(only(row("d", null, "พระบรมมหาราชวัง พระนคร กทม"))).toEqual({ id: "d", action: "none", unmatched: "no-province" });
    expect(only(row("e", "เชียงใหม่", "ผู้ปกครองชอบโทรหลัง 6 โมง"))).toMatchObject({ level: "province", unmatched: "no-address-line" });
    expect(only(row("f", "เชียงใหม่", "บ้านอยู่ ศรีภูมิ เมืองเชียงใหม่ จังหวัดเชียงใหม่ ใกล้วัด"))).toMatchObject({ level: "province", unmatched: "line-not-our-format" });
    expect(only(row("g", "เชียงใหม่", "บางที่ไม่มี เมืองเชียงใหม่ เชียงใหม่"))).toMatchObject({ level: "province", unmatched: "name-not-in-dataset" });
    expect(only(row("h", "นนทบุรี", "บางซ้ำ บางกรวย นนทบุรี"))).toMatchObject({ level: "province", unmatched: "ambiguous" }); // two codes under one name set: never picked
    expect(only(row("h2", "กรุงเทพมหานคร", "พระบรมมหาราชวัง พระนคร กทม\nวังบูรพาภิรมย์ พระนคร กทม"))).toMatchObject({ level: "province", unmatched: "ambiguous" }); // two lines that disagree
  });
  test("a line whose province part is NOT the parent's province is not ours (the province must match `parents.province`)", () => {
    expect(only(row("i", "นนทบุรี", "พระบรมมหาราชวัง พระนคร กทม"))).toMatchObject({ level: "province", unmatched: expect.stringMatching(/line-not-our-format|no-address-line/) });
  });
  test("IDEMPOTENT: a parent that already holds codes is SKIPPED (a re-run changes nothing); the note and `province` are never part of a decision", () => {
    const first = plan([row("j", "กรุงเทพมหานคร", "พระบรมมหาราชวัง พระนคร กทม")]);
    const w = first.decisions[0] as any;
    const rerun = plan([row("j", "กรุงเทพมหานคร", "พระบรมมหาราชวัง พระนคร กทม", { provinceCode: w.provinceCode, districtCode: w.districtCode, subdistrictCode: w.subdistrictCode })]);
    expect(rerun.decisions).toEqual([{ id: "j", action: "skip", reason: "already-has-codes" }]);
    expect(Object.keys(w).sort()).toEqual(["action", "districtCode", "id", "level", "provinceCode", "subdistrictCode", "unmatched"]);
  });
  test("the report: counts by level and by reason, and the LISTED ids — ids and reasons only (no names, phones or note text anywhere in the plan)", () => {
    const p = plan([
      row("1", "กรุงเทพมหานคร", "พระบรมมหาราชวัง พระนคร กทม"), row("2", "นนทบุรี", null), row("3", null, null), row("4", "ซอยเสือ", null), row("5", "ภูเก็ต", "x"), row("6", "กรุงเทพมหานคร", null, { provinceCode: "10" }),
    ]);
    expect(p.counts).toMatchObject({ parents: 6, skippedAlreadyHaveCodes: 1, provinceCodes: 3, fullTriples: 1 });
    expect(p.counts.unmatched).toMatchObject({ "province-not-one-of-77": 1, "no-province": 1, "no-address-line": 2 });
    expect(p.unmatched.map((u) => u.id).sort()).toEqual(["2", "3", "4", "5"]);
    expect(JSON.stringify(p)).not.toMatch(/ถั่ว|0811/);
  });
  test("by source: the script is a DRY RUN by default — it exits before the first write unless `--apply`; one transaction; only matched rows; a re-run's WHERE re-asserts «no codes yet»; the note is never set", () => {
    const S = read("scripts/backfill-area-codes.ts");
    expect(S).toContain('const apply = process.argv.includes("--apply");');
    expect(S.indexOf("if (!apply) {")).toBeGreaterThan(-1);
    expect(S.indexOf("if (!apply) {")).toBeLessThan(S.indexOf(".update(parents)")); // the dry run leaves BEFORE any write…
    const dry = S.slice(S.indexOf("if (!apply) {"), S.indexOf(".update(parents)"));
    expect(dry).toContain("process.exit(0)"); // …by actually EXITING there (a branch that only prints would fall through to the write)
    expect(S).toContain("await db.transaction(async (tx) => {");
    expect(S).toContain('if (d.action !== "write") continue;');
    expect(S).toContain("isNull(parents.provinceCode), isNull(parents.districtCode), isNull(parents.subdistrictCode)");
    expect(S.match(/\.set\(\{[^}]*\}\)/g)!.join("")).not.toMatch(/note|province:/);
    expect(S).toContain("isNull(parents.archivedAt)"); // active parents only
  });
});

describe("🔴 the MIGRATION 0069 — three nullable columns, no data written, the witness, the schema", () => {
  const sql = read("drizzle/0069_parent_area_codes.sql");
  test("exactly three `ADD COLUMN IF NOT EXISTS … text` on `parents` (nullable), in this order, and NOTHING else (no UPDATE, INSERT, DROP, NOT NULL, DEFAULT)", () => {
    const stmts = sql.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(stmts).toEqual([
      'ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "province_code" text;',
      'ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "district_code" text;',
      'ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS "subdistrict_code" text;',
    ]);
    expect(stmts.join(" ")).not.toMatch(/UPDATE|INSERT|DELETE|DROP|NOT NULL|DEFAULT/i);
  });
  test("the journal entry (idx 69) and the witness: the LAST column is the probe, rerunnable", async () => {
    const J = JSON.parse(read("drizzle/meta/_journal.json"));
    expect(J.entries.find((e: any) => e.idx === 69)).toMatchObject({ idx: 69, tag: "0069_parent_area_codes" });
    const { SCHEDULING_WITNESSES } = await import("../lib/migration-witness");
    expect(SCHEDULING_WITNESSES.find((w: any) => w.tag === "0069_parent_area_codes")).toMatchObject({ probe: { kind: "column", table: "parents", column: "subdistrict_code" }, rerunnable: true });
  });
  test("the schema: the three columns are nullable text, beside `province` (which STAYS)", () => {
    const S = read("src/db/schema.ts");
    expect(S).toContain('province: text("province"),');
    expect(S).toContain('provinceCode: text("province_code"),');
    expect(S).toContain('districtCode: text("district_code"),');
    expect(S).toContain('subdistrictCode: text("subdistrict_code"),');
  });
});
