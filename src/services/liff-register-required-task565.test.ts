// TASK-565 (REQ-110 item 10) — the LIFF register form: every field REQUIRED ("ข้าม" removed); the address asked ONCE per household,
// the server SAYING whether it is already on file. The owner named the LIFF form only — the admin form and the chat are untouched.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db";
import * as parentSvc from "./parent.service";
import * as lineAdmin from "../lib/line-admin";
import * as idToken from "../lib/line-id-token";
import * as reg from "./line-register.service";
import * as v from "../validation";

const root = resolve(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8").replace(/\r\n/g, "\n");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const PROVINCE = "เชียงใหม่";
/** The one writer, over spies: the parent this LINE account belongs to, and every write it would make. */
const arm = (parent: { id: string; phone: string; province: string | null; note?: string | null }) => {
  const created: any[] = [], parentWrites: any[] = [];
  spies.push(spyOn(parentSvc, "findParentByLineUserId").mockImplementation((async () => parent) as any));
  spies.push(spyOn(parentSvc, "assertCanAddStudent").mockImplementation((async () => 1) as any));
  spies.push(spyOn(parentSvc, "listStudentsOfParent").mockImplementation((async () => []) as any)); // no duplicate
  spies.push(spyOn(parentSvc, "createStudentForParent").mockImplementation((async (_p: string, input: any) => { created.push(input); return { student: { id: "s-new", name: input.name }, count: 2 }; }) as any));
  spies.push(spyOn(lineAdmin, "notifyAdmins").mockImplementation((async () => {}) as any));
  spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ limit: async () => [{ note: parent.note ?? null }] }) }) })) as any));
  spies.push(spyOn(db, "update").mockImplementation((() => ({ set: (patch: any) => ({ where: async () => { parentWrites.push(patch); } }) })) as any));
  return { created, parentWrites };
};
const add = (input: Record<string, unknown>) => reg.addChildForLineParent("U-parent", { name: "มะลิ", ...input } as any);

describe("🔴 TASK-565 — the birthday is REQUIRED for every child (ข้าม removed)", () => {
  test("absent, blank or the word ข้าม ⇒ BIRTHDATE_REQUIRED, nothing created; a bad date is still BIRTHDATE_INVALID", async () => {
    const { created } = arm({ id: "p1", phone: "0812345678", province: PROVINCE });
    for (const birthDate of [undefined, "", "  ", "ข้าม"]) expect(await add({ birthDate })).toEqual({ outcome: "birthdate-required" });
    expect(await add({ birthDate: "2024-12-02" })).toEqual({ outcome: "birthdate-invalid" }); // ISO still refused
    expect(created).toEqual([]);
  });
});

describe("🔴 TASK-565 — the address is REQUIRED ONCE per household; the server says whether it is on file", () => {
  test("the definition: on file = `parents.province` set (showable); the note's typed line does NOT count", () => {
    expect(reg.householdAddressOf({ province: PROVINCE })).toEqual({ addressOnFile: true, province: PROVINCE });
    expect(reg.householdAddressOf({ province: null })).toEqual({ addressOnFile: false, province: null });
    expect(reg.householdAddressOf({ province: "  " })).toEqual({ addressOnFile: false, province: null });
  });
  test("no address on file ⇒ BOTH the picked province and the address line required; any missing ⇒ ADDRESS_REQUIRED, nothing created", async () => {
    const { created, parentWrites } = arm({ id: "p1", phone: "0812345678", province: null, note: "แพ้ถั่ว\n12/3 ต.สุเทพ อ.เมือง" }); // a CHAT-typed address in the note
    // 🔻 TASK-590 (F-C) — the address is THREE parts now: none ⇒ ADDRESS_REQUIRED; some ⇒ ADDRESS_INCOMPLETE naming what is
    // missing; a pre-joined `address` line is no longer read (it is simply "none").
    const cases: Array<[object, any]> = [
      [{}, { outcome: "address-required" }],
      [{ address: "12/3 ต.สุเทพ อ.เมือง" }, { outcome: "address-required" }],
      [{ province: PROVINCE }, { outcome: "address-incomplete", missing: ["district", "subDistrict"] }],
      [{ province: PROVINCE, district: "เมืองเชียงใหม่" }, { outcome: "address-incomplete", missing: ["subDistrict"] }],
      [{ district: "x", subDistrict: "y" }, { outcome: "address-incomplete", missing: ["province"] }],
    ];
    for (const [extra, want] of cases) expect(await add({ birthDate: "02-12-2020", ...extra } as any)).toEqual(want);
    expect([created, parentWrites]).toEqual([[], []]);
  });
  test("the FIRST child with a full address ⇒ created; the province stored and the line APPENDED (the staff note kept); the answer says it is now on file", async () => {
    const { created, parentWrites } = arm({ id: "p1", phone: "0812345678", province: null, note: "แพ้ถั่ว" });
    const r: any = await add({ birthDate: "02-12-2020", province: PROVINCE, district: "เมืองเชียงใหม่", subDistrict: "สุเทพ" } as any); // 🔻 TASK-590: three parts
    expect(r).toMatchObject({ outcome: "created", birthDate: "2020-12-02", addressOnFile: true, province: PROVINCE });
    expect(created).toEqual([{ name: "มะลิ", birthDate: "2020-12-02" }]);
    expect(parentWrites).toEqual([{ province: PROVINCE, note: "แพ้ถั่ว\nสุเทพ เมืองเชียงใหม่ เชียงใหม่" }]); // 🔻 TASK-590: the ONE line, built by the server (the page's order)
  });
  test("🔑 a LATER child of a household with the address on file ⇒ NOT asked; one sent anyway is NOT written (never a second line)", async () => {
    const { created, parentWrites } = arm({ id: "p1", phone: "0812345678", province: PROVINCE, note: "12/3 ต.สุเทพ" });
    expect(await add({ birthDate: "01-01-2022" })).toMatchObject({ outcome: "created", addressOnFile: true, province: PROVINCE });
    expect(await add({ birthDate: "01-01-2022", province: "ลำพูน", address: "99 อ.เมือง" })).toMatchObject({ outcome: "created", province: PROVINCE });
    expect(created.length).toBe(2);
    expect(parentWrites).toEqual([]); // the address was asked, and written, once
  });
});

describe("🔴 TASK-565 — the contract: the form is TOLD (status · link · create); codes, never words", () => {
  test("status carries `addressOnFile` + the province to show; the two new codes are named codes with no message", async () => {
    process.env.SKIP_AUTH = "true";
    spies.push(spyOn(idToken, "verifyLiffIdToken").mockImplementation((async () => ({ ok: true, sub: "U-parent" })) as any));
    spies.push(spyOn(reg, "linkStatus").mockImplementation((async () => ({ linked: true, parentId: "p1", phone: "08x-xxx-5678", childCount: 1, addressOnFile: true, province: PROVINCE })) as any));
    const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
    const r = await app.fetch(new Request("http://localhost/api/register/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "t" }) }));
    expect(await r.json()).toEqual({ ok: true, linked: true, phone: "08x-xxx-5678", childCount: 1, canAddMore: true, addressOnFile: true, province: PROVINCE }); // 🔻 TASK-578: + canAddMore
    const R = read("src/routes/register.ts");
    expect(R).toContain('"birthdate-required": [400, "BIRTHDATE_REQUIRED"]');
    expect(R).toContain('"address-required": [400, "ADDRESS_REQUIRED"]');
    expect(R).toContain("addressOnFile: addr.addressOnFile, province: addr.province"); // link
    expect(R).toContain("addressOnFile: r.addressOnFile"); // create
    delete process.env.SKIP_AUTH;
  });
  test("🚫 the ADMIN add-student form is untouched (the owner named the LIFF form only): no birthday / address, still accepted", () => {
    expect(v.createStudent.safeParse({ name: "มะลิ", parentPhone: "0812345678" }).success).toBe(true);
    const shape = (v.createStudent as any).shape ?? (v.createStudent as any)._def?.schema?.shape ?? (v.createStudent as any)._def?.in?.shape;
    expect(Object.keys(shape).sort()).toEqual(["name", "nickname", "note", "parentId", "parentName", "parentPhone"]);
  });
  test("🚫 the CHAT wizard keeps its own path (out of scope): it creates through `createStudentFromLine`, not the page's composition", () => {
    const chat = read("src/services/line-webhook.service.ts");
    expect(chat).not.toContain("addChildForLineParent(");
    expect(chat).toContain("createStudentFromLine(");
  });
});
