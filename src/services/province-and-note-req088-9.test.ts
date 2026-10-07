// TASK-352 (`REQ-088 §9`) — `province` holds the PROVINCE; the address goes into `note`.
// Owner: *"เก็บจังหวัดลงจังหวัด และเอาจังหวัด อำเภอ ตำบล มาต่อกัน แล้วเซฟลง note แทน"*.
//
// 🔑 The rule is a PURE function (`householdPatch`) so every case in the DoD is asserted with VALUES, and the
// one writer is asserted to call it. The chat changed by CONSTRUCTION — it calls the same writer — and that is
// asserted at its call site by absence: it passes `address`, never `province`.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import { THAI_PROVINCES, isThaiProvince } from "../lib/thai-provinces";
import { householdPatch } from "./line-register.service";

const read = async (rel: string) => readSrc(await Bun.file(new URL(rel, import.meta.url)).text());
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const CHAT = code(await read("./line-webhook.service.ts"));
const REG = code(await read("./line-register.service.ts"));
const ROUTE = code(await read("../routes/register.ts"));
const fnIn = (S: string, sig: string) => { const i = S.indexOf(sig); if (i < 0) throw new Error("no " + sig); return S.slice(i, S.indexOf("\n}\n", i) + 2); };

const LINE = "พระโขนงเหนือ วัฒนา กรุงเทพมหานคร";

describe("🔴 §9 — the rule, with values", () => {
  test("🔑 PICKED ⇒ `province` = the name, `note` ← the line", () => {
    expect(householdPatch(null, { province: "กรุงเทพมหานคร", address: LINE })).toEqual({ province: "กรุงเทพมหานคร", note: LINE });
  });

  test("🔑 TYPED ⇒ `note` ← the string, `province` UNTOUCHED — the key is ABSENT from the patch, not set to null", () => {
    // ⚠️ "untouched" means the UPDATE carries no `province` key at all. A patch with `province: null` would CLEAR
    // a value an admin set — that is the difference between untouched and overwritten-with-nothing.
    const patch = householdPatch(null, { address: LINE });
    expect(patch).toEqual({ note: LINE });
    expect("province" in patch).toBe(false);
  });

  test("🔴 …including when `province` ALREADY held a value — a typed line does not clear it", () => {
    // The existing value lives in the ROW, not in the input; the patch simply does not mention it.
    const patch = householdPatch("แพ้ถั่ว", { province: null, address: LINE });
    expect("province" in patch).toBe(false);
    expect(patch.note).toBe(`แพ้ถั่ว\n${LINE}`);
  });

  test("🔴 `note` is APPENDED, never overwritten — the allergy note survives a re-registration", () => {
    expect(householdPatch("แพ้ถั่ว", { address: LINE })).toEqual({ note: `แพ้ถั่ว\n${LINE}` });
    // …and a second registration appends again, in arrival order.
    expect(householdPatch(`แพ้ถั่ว\n${LINE}`, { address: "บางนา บางนา กรุงเทพมหานคร" })).toEqual({ note: `แพ้ถั่ว\n${LINE}\nบางนา บางนา กรุงเทพมหานคร` });
    // A whitespace-only existing note is treated as empty — no leading blank line for the first address.
    expect(householdPatch("   ", { address: LINE })).toEqual({ note: LINE });
  });

  test("ข้าม / blanks write NOTHING — an empty patch, not an empty string into `note`", () => {
    for (const input of [{}, { province: "", address: "" }, { province: "  ", address: null }, { address: "   " }]) {
      expect(householdPatch("แพ้ถั่ว", input)).toEqual({});
    }
  });

  test("a province with no address still lands in `province` alone", () => {
    expect(householdPatch("แพ้ถั่ว", { province: "ชลบุรี" })).toEqual({ province: "ชลบุรี" });
  });
});

describe("🔴 §9 — the one writer applies the rule, and the CHAT changed by construction", () => {
  test("🔑 `createStudentFromLine` reads the row's CURRENT note and writes `householdPatch(...)`", () => {
    const w = fnIn(REG, "export async function createStudentFromLine(");
    // 🔻 TASK-590 — the writer runs on the caller's `exec` (a new family's ONE transaction), and the three parts arrive CHECKED
    expect(w).toContain("exec.select({ note: parents.note }).from(parents)");
    expect(w).toContain("householdPatch(row?.note ?? null, { province: checked.address.province, address: checked.address.line })");
    // …and the read is of the ROW, not the `parent` argument — a note written since the chat loaded it survives.
    expect(w.indexOf("exec.select({ note: parents.note })")).toBeLessThan(w.indexOf("householdPatch("));
    // 🚫 the old direct `province` write is GONE — one rule, one place.
    expect(REG).not.toContain("set({ province: input.province })");
  });

  test("🔻 TASK-590 (F-C) — the CHAT's call site passes the THREE parts; its province is RESOLVED to one of the 77, so it may fill the column", () => {
    // TASK-352's "the chat never writes `province`" rested on "a typed line cannot pick one". The chat now asks the province ALONE and
    // resolves it to one of the 77 (`provinceFromTyped`) — the same list the page picks from — so it is not a guess any more.
    const confirm = fnIn(CHAT, "async function handleAddStudentStep(");
    expect(confirm).toContain("const address = addressOnFile ? null : { province: draft.province, district: draft.district, subDistrict: draft.subDistrict };");
    expect(confirm).toContain("const province = provinceFromTyped(text);");
    expect(confirm).toContain("await createStudentFromLine(parent!, { name: draft.name!, birthDate: draft.birthDate ?? null, address })");
  });

  test("🔑 an unknown province is refused in the WRITER (for every caller) and as a NAMED CODE (for the page)", () => {
    const w = fnIn(REG, "export async function createStudentFromLine(");
    // 🔻 TASK-590 — through THE rule (`checkFullAddress`, which calls `isThaiProvince`): in the writer, and as a code for the page
    expect(w).toContain("const checked = given ? checkFullAddress(given) : null;");
    expect(w).toContain("if (checked && !checked.ok) throw badRequest(");
    const compose = fnIn(REG, "export async function addChildForLineParent(");
    expect(compose.indexOf("checkAddress(input)")).toBeLessThan(compose.indexOf("createStudentFromLine("));
    expect(REG).toContain('return { ok: false, refusal: { outcome: "province-unknown", province: c.province } };');
    expect(ROUTE).toContain('"province-unknown": [400, "PROVINCE_UNKNOWN"]');
    expect(ROUTE).toContain('r.outcome === "province-unknown" ? { province: r.province }');
  });

  test("🔻 TASK-590 (F-C) — the route accepts the THREE picked parts; a pre-joined `address` line is no longer read", () => {
    const body = ROUTE.slice(ROUTE.indexOf("const createBody"), ROUTE.indexOf("const refuse"));
    for (const f of ["province: z.string().optional()", "district: z.string().optional()", "subDistrict: z.string().optional()"]) expect(body).toContain(f);
    expect(body).not.toContain("address: z.string()");
  });
});

describe("📌 the 77 — full form, exactly as the admin's list spells them", () => {
  test("there are 77, all distinct, none abbreviated", () => {
    expect(THAI_PROVINCES.length).toBe(77);
    expect(new Set(THAI_PROVINCES).size).toBe(77);
    expect(THAI_PROVINCES).toContain("กรุงเทพมหานคร");
    for (const short of ["กทม", "กรุงเทพ", "กทม."]) expect({ short, listed: isThaiProvince(short) }).toEqual({ short, listed: false });
  });

  test("🚫 exact match only — a near-miss is a refusal, not a guess", () => {
    expect(isThaiProvince("กรุงเทพมหานคร")).toBe(true);
    expect(isThaiProvince(" กรุงเทพมหานคร ")).toBe(true); // whitespace is not a difference
    expect(isThaiProvince("จังหวัดชลบุรี")).toBe(false); // the prefix is not part of the name on the form
    expect(isThaiProvince("Bangkok")).toBe(false);
    expect(isThaiProvince("")).toBe(false);
    expect(isThaiProvince(null)).toBe(false);
  });
});

describe("🚫 §9.1 — what this task deliberately does NOT do", () => {
  test("no cleanup of existing rows — no script, no migration touched", async () => {
    // The owner MOVED the addresses himself and is LEAVING `province` dirty ON PURPOSE, so a visibly broken
    // dashboard gets fixed by the admins who know the family. If anyone proposes a script, `§9.1` is the answer.
    const journal = await Bun.file(new URL("../../drizzle/meta/_journal.json", import.meta.url)).text();
    expect((journal.match(/"tag"/g) ?? []).length).toBe(67); // TASK-497: +0059 // 🔻 0035 … 0053 added since — none a province script · 🔻 TASK-540: +0060 · 🔻 TASK-556: +0061 · 🔻 TASK-561: +0062 · 🔻 TASK-568: +0063 · 🔻 TASK-573: +0064 · 🔻 TASK-690: +0065 · 🔻 TASK-702: +0066
    expect(REG).not.toMatch(/UPDATE parents SET province/i);
  });
});
