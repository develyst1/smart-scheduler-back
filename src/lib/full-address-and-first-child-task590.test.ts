// TASK-590 — F-C (the full address, ONE rule for both doors, no backend geography) and D11(a) (a new family is created WITH its
// first child, in ONE transaction, or not at all). Both ship WITH @Fern's half (TASK-591): the page contract changes.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { addressLine, checkFullAddress, provinceFromTyped } from "./full-address";
import { SKIP } from "./line-add-student";
import * as reg from "../services/line-register.service";
import * as parentSvc from "../services/parent.service";
import * as familyLink from "./family-link";
import * as rosterLink from "./roster-link";
import * as lineAdmin from "./line-admin";
import * as idToken from "./line-id-token";
import { db } from "../db";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });
const trip = (what: string) => () => { throw new Error(`TASK-590 tripwire: ${what}`); };

describe("🔴 F-C — THE one address rule (`checkFullAddress`): three parts, the province one of the 77 — and its stated LIMIT", () => {
  test("by value: none ⇒ required · some ⇒ incomplete, naming what is missing · an unknown province ⇒ refused · three good parts ⇒ ok + the ONE line", () => {
    expect(checkFullAddress({})).toEqual({ ok: false, outcome: "address-required" });
    expect(checkFullAddress({ province: "  ", district: "", subDistrict: null })).toEqual({ ok: false, outcome: "address-required" });
    // 🔑 a TWO-part address is not accepted — every pair, every door
    expect(checkFullAddress({ province: "เชียงใหม่", district: "เมืองเชียงใหม่" })).toEqual({ ok: false, outcome: "address-incomplete", missing: ["subDistrict"] });
    expect(checkFullAddress({ province: "เชียงใหม่", subDistrict: "สุเทพ" })).toEqual({ ok: false, outcome: "address-incomplete", missing: ["district"] });
    expect(checkFullAddress({ district: "เมืองเชียงใหม่", subDistrict: "สุเทพ" })).toEqual({ ok: false, outcome: "address-incomplete", missing: ["province"] });
    expect(checkFullAddress({ province: "กทม", district: "วัฒนา", subDistrict: "คลองเตยเหนือ" })).toEqual({ ok: false, outcome: "province-unknown", province: "กทม" }); // the column takes the FULL form only
    expect(checkFullAddress({ province: " เชียงใหม่ ", district: "เมืองเชียงใหม่", subDistrict: "สุเทพ" })).toEqual({ ok: true, address: { province: "เชียงใหม่", district: "เมืองเชียงใหม่", subDistrict: "สุเทพ", line: "สุเทพ เมืองเชียงใหม่ เชียงใหม่" } });
    expect(addressLine({ province: "กรุงเทพมหานคร", district: "วัฒนา", subDistrict: "พระโขนงเหนือ" })).toBe("พระโขนงเหนือ วัฒนา กทม"); // the page's own order and spelling
  });
  test("🔴 THE LIMIT, pinned so nobody reads more into it: a district that does NOT belong to the province is ACCEPTED (no geography in the backend, by ruling)", () => {
    expect(checkFullAddress({ province: "เชียงใหม่", district: "บางรัก", subDistrict: "สีลม" }).ok).toBe(true); // บางรัก/สีลม are in Bangkok — we do not know that, by design
    const src = read("src/lib/full-address.ts");
    expect(src).toContain("we do NOT check that the district belongs to that province");
    expect(src).not.toMatch(/^import .*(thai-address|district-data|subdistrict)/m); // 🚫 no second dataset
    expect(read("package.json")).not.toContain("thai-address"); // the backend has no address dataset dependency
  });
  test("the chat's TYPED province ⇒ the full form, or null: 'จังหวัด' dropped, Bangkok's everyday spellings known, nothing fuzzy; no skip word is a province", () => {
    expect(["กทม", "กทม.", "กรุงเทพ", "กรุงเทพฯ", "Bangkok", "BKK", "กรุงเทพมหานคร"].map(provinceFromTyped)).toEqual(Array(7).fill("กรุงเทพมหานคร"));
    expect([provinceFromTyped("จังหวัดเชียงใหม่"), provinceFromTyped(" เชียงใหม่ "), provinceFromTyped("เชียงใหม")]).toEqual(["เชียงใหม่", "เชียงใหม่", null]);
    for (const w of SKIP) expect(provinceFromTyped(w)).toBeNull();
  });
  test("🔴 the WRITER is the floor: an address written through it is ALWAYS full — a two-part one is refused (400) before the student, the household and the notice", async () => {
    const calls: string[] = [];
    spies.push(spyOn(parentSvc, "createStudentForParent").mockImplementation((async () => { calls.push("student"); return { student: { id: "s", name: "x" }, count: 1 }; }) as any));
    spies.push(spyOn(lineAdmin, "notifyAdmins").mockImplementation((async () => { calls.push("notice"); }) as any));
    const exec: any = { select: trip("household read"), update: trip("household write") };
    for (const address of [{ province: "เชียงใหม่", district: "เมืองเชียงใหม่" }, { district: "บางรัก", subDistrict: "สีลม" }, { province: "กทม", district: "วัฒนา", subDistrict: "คลองเตยเหนือ" }]) {
      const e: any = await reg.createStudentFromLine({ id: "p", phone: "0800000000" }, { name: "น้อง", birthDate: "2019-02-01", address }, exec).catch((x) => x);
      expect([e.status, e.message]).toEqual([400, "ที่อยู่ต้องมีจังหวัด อำเภอ/เขต และตำบล/แขวง"]); // 📋 DRAFT
    }
    expect(calls).toEqual([]);
    // …and NO address at all (a household with one on file) writes the child and nothing else
    await reg.createStudentFromLine({ id: "p", phone: "0800000000" }, { name: "น้อง", birthDate: "2019-02-01", address: null }, exec);
    expect(calls).toEqual(["student", "notice"]);
  });
  test("ONE rule for both doors: the page's composition, the one-transaction register, the chat's confirm AND the writer all call `checkFullAddress`", () => {
    const REG = read("src/services/line-register.service.ts");
    expect(REG).toContain("const c = checkFullAddress(input);"); // the page's refusal codes (checkAddress)
    expect(REG).toContain("const checked = given ? checkFullAddress(given) : null;"); // the writer's floor
    expect(read("src/services/line-webhook.service.ts")).toContain("if (!addressOnFile && !checkFullAddress(draft).ok) {");
    expect(REG).not.toMatch(/isThaiProvince\(/); // no second province check beside the rule
  });
});

describe("🔑 F-C legacy — a household whose stored address has only a province: nothing fails; one with none is ASKED, never blocked", () => {
  const arm = (parent: any) => {
    const created: any[] = [];
    spies.push(spyOn(parentSvc, "findParentByLineUserId").mockImplementation((async () => parent) as any));
    spies.push(spyOn(parentSvc, "assertCanAddStudent").mockImplementation((async () => 1) as any));
    spies.push(spyOn(parentSvc, "listStudentsOfParent").mockImplementation((async () => [{ name: "พี่" }]) as any));
    spies.push(spyOn(parentSvc, "createStudentForParent").mockImplementation((async (_p: string, i: any) => { created.push(i); return { student: { id: "s", name: i.name }, count: 2 }; }) as any));
    spies.push(spyOn(lineAdmin, "notifyAdmins").mockImplementation((async () => {}) as any));
    spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ limit: async () => [{ note: null }] }) }) })) as any));
    spies.push(spyOn(db, "update").mockImplementation((() => ({ set: () => ({ where: async () => {} }) })) as any));
    return created;
  };
  test("province ONLY on file (collected when one part was valid) ⇒ the next child is created with NO address asked and nothing refused", async () => {
    const created = arm({ id: "p1", phone: "0812345678", province: "ชลบุรี", note: null });
    expect(await reg.addChildForLineParent("U1", { name: "น้อง", birthDate: "01-02-2019" })).toMatchObject({ outcome: "created", addressOnFile: true, province: "ชลบุรี" });
    expect(created).toHaveLength(1);
  });
  test("NOTHING on file (e.g. a chat-typed line in the note) ⇒ ASKED: refused only until the three parts come, then created", async () => {
    const created = arm({ id: "p1", phone: "0812345678", province: null, note: "12/3 บ้านบึง" });
    expect(await reg.addChildForLineParent("U1", { name: "น้อง", birthDate: "01-02-2019" })).toEqual({ outcome: "address-required" });
    expect(await reg.addChildForLineParent("U1", { name: "น้อง", birthDate: "01-02-2019", province: "ชลบุรี", district: "บ้านบึง", subDistrict: "บ้านบึง" })).toMatchObject({ outcome: "created" });
    expect(created).toHaveLength(1);
  });
});

describe("🔴 D11(a) — a new phone writes NOTHING; the family is created WITH its first child, in ONE transaction, or not at all", () => {
  const noFamily = () => {
    spies.push(spyOn(parentSvc, "findParentByPhone").mockImplementation((async () => null) as any));
    spies.push(spyOn(parentSvc, "findArchivedParentByPhone").mockImplementation((async () => null) as any));
    spies.push(spyOn(familyLink, "familyOfLineUser").mockImplementation((async () => null) as any));
  };
  test("`linkFamilyByPhone` on a NEW phone ⇒ `{ outcome: 'new' }` and no row, no binding, no roster move", async () => {
    noFamily();
    spies.push(spyOn(parentSvc, "findOrCreateParentByPhone").mockImplementation(trip("the phone step created a parent") as any));
    spies.push(spyOn(familyLink, "bindFamilyLine").mockImplementation(trip("the phone step bound the LINE") as any));
    spies.push(spyOn(rosterLink, "moveRosterLink").mockImplementation(trip("the phone step moved the roster link") as any));
    expect(await reg.linkFamilyByPhone("U-new", "081-234-5678")).toEqual({ outcome: "new", phone: "0812345678" });
  });
  const child = { name: "มะลิ", birthDate: "02-12-2020", province: "เชียงใหม่", district: "เมืองเชียงใหม่", subDistrict: "สุเทพ" };
  /** A transaction that STAGES its writes and commits them only if the callback resolves — as Postgres does. */
  const armTx = (opts: { failAt?: "student" | "notice" } = {}) => {
    const committed: string[] = [];
    const moved: string[] = [];
    spies.push(spyOn(db, "transaction").mockImplementation((async (cb: any) => {
      const staged: string[] = [];
      const tx: any = {
        stage: staged,
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ note: null }] }) }) }),
        update: () => ({ set: (p: any) => ({ where: async () => { staged.push(`household:${p.province}|${p.note}`); } }) }),
      };
      (globalThis as any).__tx = tx;
      const r = await cb(tx); // a throw here discards `staged` — nothing reaches `committed`
      committed.push(...staged);
      return r;
    }) as any));
    spies.push(spyOn(parentSvc, "findOrCreateParentByPhone").mockImplementation((async (phone: string, o: any, exec: any) => { exec.stage.push(`parent:${phone}:${o.lineUserId}`); return { id: "p-new", phone, lineUserId: o.lineUserId, province: null }; }) as any));
    spies.push(spyOn(parentSvc, "createStudentForParent").mockImplementation((async (pid: string, i: any, exec: any) => { if (opts.failAt === "student") throw new Error("student insert failed"); exec.stage.push(`student:${pid}:${i.name}:${i.birthDate}`); return { student: { id: "s-1", name: i.name }, count: 1 }; }) as any));
    spies.push(spyOn(lineAdmin, "notifyAdmins").mockImplementation((async (p: any, exec: any) => { if (opts.failAt === "notice") throw new Error("outbox failed"); exec.stage.push(`notice:${p.kind}`); }) as any));
    spies.push(spyOn(rosterLink, "moveRosterLink").mockImplementation((async (u: string) => { moved.push(u); }) as any));
    return { committed, moved };
  };
  test("✅ registered: parent (this account as primary) + child + household + admin notice, all in ONE transaction; the roster link moves after the commit", async () => {
    noFamily();
    const { committed, moved } = armTx();
    const r: any = await reg.registerFamilyWithFirstChild("U-new", "0812345678", child);
    expect([r.outcome, r.student, r.birthDate, r.count]).toEqual(["registered", { id: "s-1", name: "มะลิ" }, "2020-12-02", 1]);
    expect(committed).toEqual(["parent:0812345678:U-new", "student:p-new:มะลิ:2020-12-02", "household:เชียงใหม่|สุเทพ เมืองเชียงใหม่ เชียงใหม่", "notice:student_registered"]);
    expect(moved).toEqual(["U-new"]);
  });
  for (const failAt of ["student", "notice"] as const) {
    test(`🔴 NOTHING LEFT BEHIND: a failure at the ${failAt} inside the transaction ⇒ no parent, no binding, no child, no notice, no roster move`, async () => {
      noFamily();
      const { committed, moved } = armTx({ failAt });
      await expect(reg.registerFamilyWithFirstChild("U-new", "0812345678", child)).rejects.toThrow();
      expect([committed, moved]).toEqual([[], []]);
    });
  }
  test("🔴 every rejection BEFORE the transaction opens it not at all: a bad phone · a two-part address · a skipped birthday · the phone registered meanwhile · this LINE already a family's", async () => {
    spies.push(spyOn(db, "transaction").mockImplementation(trip("a refused registration opened a transaction") as any));
    spies.push(spyOn(parentSvc, "findArchivedParentByPhone").mockImplementation((async () => null) as any));
    const found = spyOn(parentSvc, "findParentByPhone").mockImplementation((async () => null) as any); spies.push(found);
    const fam = spyOn(familyLink, "familyOfLineUser").mockImplementation((async () => null) as any); spies.push(fam);
    expect(await reg.registerFamilyWithFirstChild("U", "12", child)).toEqual({ outcome: "phone-invalid" });
    expect(await reg.registerFamilyWithFirstChild("U", "0812345678", { ...child, subDistrict: "" })).toEqual({ outcome: "address-incomplete", missing: ["subDistrict"] });
    expect(await reg.registerFamilyWithFirstChild("U", "0812345678", { ...child, birthDate: "ข้าม" })).toEqual({ outcome: "birthdate-required" });
    found.mockImplementation((async () => ({ id: "p-other" })) as any);
    expect(await reg.registerFamilyWithFirstChild("U", "0812345678", child)).toEqual({ outcome: "phone-now-registered" });
    found.mockImplementation((async () => null) as any);
    fam.mockImplementation((async () => "p-mine") as any);
    expect(await reg.registerFamilyWithFirstChild("U", "0812345678", child)).toEqual({ outcome: "line-bound-to-other-family" });
  });
});

describe("📜 the new PAGE contract, through the ROOT app (what @Fern builds against)", () => {
  const app = async () => (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
  const post = async (path: string, body: object) => (await app()).fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "t", ...body }) }));
  const asSub = (sub: string) => spies.push(spyOn(idToken, "verifyLiffIdToken").mockImplementation((async () => ({ ok: true, sub })) as any));
  test("`/register/link` with a NEW phone ⇒ 200 `{ ok, outcome: 'new', phone }` — nothing written, no menus, no session touched", async () => {
    asSub("U-new");
    spies.push(spyOn(reg, "twoFaEnabled").mockImplementation((async () => false) as any)); // the route reads the 2FA setting — never the DB here
    spies.push(spyOn(reg, "linkFamilyByPhone").mockImplementation((async () => ({ outcome: "new", phone: "0812345678" })) as any));
    spies.push(spyOn(reg, "settleLinkedRole").mockImplementation(trip("menus linked for a family that does not exist yet") as any));
    spies.push(spyOn(reg, "clearLinkSession").mockImplementation(trip("session cleared for an unfinished registration") as any));
    const r = await post("/register/link", { phone: "0812345678" });
    expect([r.status, await r.json()]).toEqual([200, { ok: true, outcome: "new", phone: "081-234-5678" }]);
  });
  test("`/register/create` + `phone` from an UNLINKED account ⇒ the one-transaction register; then the menus and the session; the answer is `created` + `registered: true`", async () => {
    asSub("U-new");
    const order: string[] = [];
    spies.push(spyOn(reg, "linkStatus").mockImplementation((async () => ({ linked: false })) as any));
    spies.push(spyOn(reg, "registerFamilyWithFirstChild").mockImplementation((async (sub: string, phone: string, c: any) => { order.push(`register:${sub}:${phone}:${c.district}`); return { outcome: "registered", parent: { id: "p" }, student: { id: "s", name: "มะลิ" }, birthDate: "2020-12-02", count: 1 }; }) as any));
    spies.push(spyOn(reg, "addChildForLineParent").mockImplementation(trip("an unlinked account reached the linked-family door") as any));
    spies.push(spyOn(reg, "settleLinkedRole").mockImplementation((async () => { order.push("settle"); return "TH"; }) as any));
    spies.push(spyOn(reg, "clearLinkSession").mockImplementation((async () => { order.push("clear"); }) as any));
    const r = await post("/register/create", { phone: "0812345678", name: "มะลิ", birthDate: "02-12-2020", province: "เชียงใหม่", district: "เมืองเชียงใหม่", subDistrict: "สุเทพ" });
    expect([r.status, await r.json()]).toEqual([200, { ok: true, outcome: "created", registered: true, student: { id: "s", name: "มะลิ" }, birthDate: "02-12-2020", count: 1, atMax: false, canAddMore: true, addressOnFile: true, province: "เชียงใหม่" }]);
    expect(order).toEqual(["register:U-new:0812345678:เมืองเชียงใหม่", "settle", "clear"]);
  });
  test("a refused new-family create names its code (and `missing` for an incomplete address); nothing settled", async () => {
    asSub("U-new");
    spies.push(spyOn(reg, "linkStatus").mockImplementation((async () => ({ linked: false })) as any));
    spies.push(spyOn(reg, "registerFamilyWithFirstChild").mockImplementation((async () => ({ outcome: "address-incomplete", missing: ["district"] })) as any));
    spies.push(spyOn(reg, "settleLinkedRole").mockImplementation(trip("settled after a refusal") as any));
    const r = await post("/register/create", { phone: "0812345678", name: "มะลิ", birthDate: "02-12-2020", province: "เชียงใหม่", subDistrict: "สุเทพ" });
    expect([r.status, await r.json()]).toEqual([400, { ok: false, code: "ADDRESS_INCOMPLETE", missing: ["district"] }]);
  });
  test("a LINKED account's `phone` is IGNORED: its own family, the linked-family door (never re-pointed)", async () => {
    asSub("U-mine");
    spies.push(spyOn(reg, "linkStatus").mockImplementation((async () => ({ linked: true })) as any));
    spies.push(spyOn(reg, "registerFamilyWithFirstChild").mockImplementation(trip("a linked account created a second family") as any));
    const seen: any[] = [];
    spies.push(spyOn(reg, "addChildForLineParent").mockImplementation((async (sub: string, c: any) => { seen.push([sub, c.province, c.district, c.subDistrict]); return { outcome: "address-required" }; }) as any));
    const r = await post("/register/create", { phone: "0899999999", name: "ต้น", birthDate: "02-12-2020", province: "ชลบุรี", district: "บ้านบึง", subDistrict: "บ้านบึง" });
    expect(r.status).toBe(400);
    expect(seen).toEqual([["U-mine", "ชลบุรี", "บ้านบึง", "บ้านบึง"]]);
  });
});

describe("💬 the CHAT's half (by source — the chat has no DB harness): the new phone rides the draft; the family is created at CONFIRM", () => {
  const W = read("src/services/line-webhook.service.ts");
  test("verify: a NEW phone ⇒ `pendingPhone`, no menus, the draft carries it, the zero-children tail (`afterParentLink`) asks for the first child", () => {
    expect(W).toContain('if (r.outcome === "new") return { ok: true, pendingPhone: r.phone,');
    const code = W.slice(W.indexOf("if (res.pendingPhone) {"), W.indexOf('if (role !== "admin") await settleLinkedRole(lineUserId, role);'));
    expect(code).toContain("const tail = await afterParentLink(lineUserId, lang, []);");
    expect(code).toContain('await setDraft(lineUserId, "AWAIT_STUDENT_NAME", { newPhone: res.pendingPhone });');
    expect(code).not.toContain("settleLinkedRole(");
  });
  test("confirm: a new family ⇒ `registerFamilyWithFirstChild` (the birthday back in the customer's day-first form for the shared parser), THEN the menus", () => {
    const confirm = W.slice(W.indexOf('if (session.step === "AWAIT_STUDENT_CONFIRM") {'));
    expect(confirm).toContain("await registerFamilyWithFirstChild(lineUserId, newPhone, { name: draft.name!, birthDate: ddmmyyyy(draft.birthDate), ...address });");
    expect(confirm.indexOf("registerFamilyWithFirstChild(")).toBeLessThan(confirm.indexOf('await settleLinkedRole(lineUserId, "customer");'));
    expect(W).toContain('const newPhone = !parent && typeof draft.newPhone === "string" ? draft.newPhone : null;');
  });
});

describe("⚖️ the repair: DECLINED (Sober, TASK-590 §2) — nothing here writes to existing rows", () => {
  test("no script, no migration, no route touches the families already linked with no child", () => {
    const REG = read("src/services/line-register.service.ts");
    expect(REG).not.toMatch(/clearFamilyLine\(|archiveParent\(/);
  });
});
