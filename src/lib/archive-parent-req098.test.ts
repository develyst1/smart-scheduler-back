// TASK-411 (`REQ-098`, SPEC-084) — archive a PARENT: migration `0046` (three NULL columns + the partial index as
// witness), the ONE `activeParentWhere` at every working read + `assertParentActive` on the by-id writes (pinned by
// source, no hand-written term), the archive by value (the household's live-future count ⇒ 409; the ONE unlinker
// clears every LINE account into the audit list; the cascade marks every child `parent:<id>`; idempotent), the restore
// (only the cascaded children, the LINE ids NOT restored), Finding B's two refusals (the admin's create, the LINE
// register's `phone-archived` with a PLACEHOLDER reply), the ghost unresolvable, the routes through the root app. 53 = 53.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiException } from "./http";
import { PARENT_ARCHIVED, activeParentWhere, cascadeMarker, isParentArchived } from "./parent-archive";
import { ACTION_KEYS, ACTION_REGISTRY } from "./permissions";
import { ROUTE_ACCESS } from "./route-access";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { t } from "./line-i18n";
import * as v from "../validation";
import * as parent from "../services/parent.service";
import * as register from "../services/line-register.service";
import { db } from "../db";
import { parents } from "../db/schema";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const src = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8"));
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const region = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  if (a < 0) throw new Error(`region start missing: ${from}`);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b < 0 ? undefined : b);
};
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const PS = code(src("src/services/parent.service.ts"));
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", S2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
afterAll(() => { delete process.env.SKIP_AUTH; });

describe("🔴 the migration — 0046, counted, three NULLABLE adds on `parents`, the partial index LAST = the witness (source)", () => {
  const files = readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const sql = readFileSync(resolve(root, "drizzle/0046_parent_archive.sql"), "utf8");
  test("53 = 53: `0046_parent_archive` is the 47th file, idx 46 (TASK-418 added 0047 after it); 'expects 47' in the header", () => {
    expect(files.length).toBe(53);
    expect(journal.entries.length).toBe(53);
    expect(files[46]).toBe("0046_parent_archive.sql");
    expect(journal.entries[46]).toMatchObject({ idx: 46, tag: "0046_parent_archive" });
    expect(sql).toContain("`db:verify` expects 47");
  });
  test("four statements: three `ADD COLUMN IF NOT EXISTS … NULL` (archived_at · archived_by · archived_line_user_ids text[]), then the partial index; no enum, no bookings; the phone column untouched", () => {
    const stmts = sql.split("\n").filter((l) => !l.startsWith("--") && l.trim()).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
    expect(stmts.length).toBe(4);
    expect(stmts.slice(0, 3).map((s) => s.match(/ADD COLUMN IF NOT EXISTS "(\w+)"/)![1])).toEqual(["archived_at", "archived_by", "archived_line_user_ids"]);
    for (const s of stmts.slice(0, 3)) { expect(s.startsWith('ALTER TABLE "parents" ADD COLUMN IF NOT EXISTS')).toBe(true); expect(s.endsWith("NULL")).toBe(true); expect(s).not.toContain("DEFAULT"); }
    expect(stmts[2]).toContain('"archived_line_user_ids" text[] NULL');
    expect(stmts[3]).toBe('CREATE INDEX IF NOT EXISTS "parents_archived_idx" ON "parents" ("archived_at") WHERE "archived_at" IS NOT NULL');
    expect(stmts.join(";")).not.toMatch(/CREATE TYPE|ALTER TYPE|'GROUP'|"bookings"|phone|line_user_id"/);
    expect(sql).toContain("No lock on any hot table");
    expect(SCHEDULING_WITNESSES.find((x) => x.tag === "0046_parent_archive")).toMatchObject({ probe: { kind: "index", index: "parents_archived_idx" }, rerunnable: true });
    const schema = region(code(src("src/db/schema.ts")), "export const parents = pgTable(", "\n);");
    for (const col of ['timestamp("archived_at"', 'text("archived_by")', 'text("archived_line_user_ids").array()', 'index("parents_archived_idx").on(t.archivedAt).where(']) expect(schema).toContain(col);
    expect(schema).toContain('uniqueIndex("parents_phone_uq").on(t.phone)'); // the phone stays unique — Finding B's premise
  });
});

describe("🔴 the ONE predicate and the ONE guard — by value and by source at every site", () => {
  test("`activeParentWhere` is `parents.archived_at IS NULL`; `isParentArchived`; the refusal; the cascade marker", () => {
    const q = db.select({ id: parents.id }).from(parents).where(activeParentWhere()).toSQL();
    expect(q.sql).toMatch(/"parents"\."archived_at" is null/);
    expect(isParentArchived({ archivedAt: new Date() })).toBe(true);
    expect(isParentArchived({ archivedAt: null })).toBe(false);
    expect(isParentArchived(null)).toBe(false);
    const e = PARENT_ARCHIVED();
    expect([e.status, e.code, e.message]).toEqual([409, "PARENT_ARCHIVED", "ผู้ปกครองรายนี้ถูกเก็บแล้ว — คืนสถานะก่อน"]);
    expect(cascadeMarker(P1)).toBe(`parent:${P1}`);
  });
  test("by source: the list/search/count (ONE where for the page and the count), the phone lookup, the notice recipients, the nag, the SOM, the LINE language — all name `activeParentWhere`; nobody writes the term by hand", () => {
    const L = region(PS, "export async function listParents(", "export async function getParent(");
    expect(L).toContain("const scope = archived ? isNotNull(parents.archivedAt) : activeParentWhere();");
    expect(L).toContain(".where(and(or(...conditions), scope));");
    expect(L).toContain("const where = ids ? and(inArray(parents.id, ids), scope) : scope;");
    expect(L).toContain("const total = Number((await db.select({ n: sql<number>`count(*)` }).from(parents).where(where))[0]?.n ?? 0);");
    expect(region(PS, "export async function findParentByPhone(", "export async function findArchivedParentByPhone(")).toContain("a(e(x.phone, p), activeParentWhere())");
    expect(code(src("src/lib/family-link.ts"))).toContain("where: (p: any, { inArray: inA }: any) => and(inA(p.id, parentIds), activeParentWhere()),");
    expect(code(src("src/lib/line-lang.ts"))).toContain("and(eq(x.lineUserId, lineUserId), activeParentWhere())");
    expect(code(src("src/services/attention.service.ts"))).toContain("db.query.parents.findMany({ where: activeParentWhere() })");
    expect(code(src("src/services/som-report.service.ts"))).toContain("db.query.parents.findMany({ where: activeParentWhere() })");
    for (const f of ["src/services/parent.service.ts", "src/lib/family-link.ts", "src/lib/line-lang.ts", "src/services/attention.service.ts", "src/services/som-report.service.ts", "src/services/line-register.service.ts", "src/services/jobs.service.ts"]) {
      expect({ f, hand: /isNull\(parents\.archivedAt\)|isNull\(p\.archivedAt\)|archivedAt, null/.test(code(src(f))) }).toEqual({ f, hand: false });
    }
    expect(code(src("src/lib/parent-archive.ts"))).toContain("export const activeParentWhere = () => isNull(parents.archivedAt);"); // the ONE definition
  });
  test("by source: `assertParentActive` / `isParentArchived` at every by-id WRITE (add a student ×2, edit, suspend, clear-link, the LINE link, the student's own restore); the detail 404s unless asked", () => {
    expect(region(PS, "export async function createStudentForParent(", "export async function createStudent(")).toContain("await assertParentActive(exec, parentId);");
    expect(region(PS, "export async function createStudent(", "async function loadParentWithStudents(")).toContain("if (isParentArchived(parent)) throw PARENT_ARCHIVED();");
    expect(region(PS, "export async function updateParent(", "export async function updateStudent(")).toContain("await assertParentActive(db, id);");
    expect(region(PS, "export async function setParentSuspended(", "export async function archiveParent(")).toContain("if (isParentArchived(parent)) throw PARENT_ARCHIVED();");
    expect(region(PS, "export async function clearParentLineLink(", "export async function createParent(")).toContain("if (isParentArchived(parent)) throw PARENT_ARCHIVED();");
    expect(region(PS, "export async function linkParentLine(", "export async function listStudentsOfParent(")).toContain("await assertParentActive(exec, parentId);");
    expect(region(PS, "export async function unarchiveStudent(", "\n}\n")).toContain("if (row.parentId) await assertParentActive(db, row.parentId);");
    const G = region(PS, "export async function getParent(", "export async function clearParentLineLink(");
    expect(G).toContain('if (isParentArchived(row) && !opts.archived) throw notFound("ไม่พบผู้ปกครอง");');
  });
});

describe("🔴 the archive / restore by VALUE through fake reads (no DB) — the count, the unlinker, the audit list, the cascade, idempotence, the restore's selectivity", () => {
  test("the household's live-future count is ONE grouped statement shared with REQ-093's `archiveStudent`", () => {
    const C = region(PS, "export async function liveFutureSessionCount(", "\n}\n");
    expect(C).toContain("if (!studentIds.length) return 0;");
    expect(C).toContain("or(inArray(bookings.studentId, studentIds), inArray(bookings.coStudentId, studentIds)), sql`${bookings.date} >= ${today}`, inArray(bookings.status, [...COURSE_LIVE_STATUSES])");
    expect(region(PS, "export async function archiveStudent(", "\n}\n")).toContain("const n = await liveFutureSessionCount(db, [id]);");
    expect((PS.match(/liveFutureSessionCount\(/g) ?? []).length).toBe(3); // the definition, the student's, the parent's
  });
  test("`archiveParent` by source: 404 · idempotent · the count ⇒ 409 PARENT_HAS_SESSIONS naming n BEFORE the tx · ONE tx: `clearFamilyLine` → the three columns with the cleared list → every child `markStudentArchived(parent:<id>)` · the phone never written", () => {
    const A = region(PS, "export async function archiveParent(", "export async function unarchiveParent(");
    expect(A).toContain('if (!parent) throw notFound("ไม่พบผู้ปกครอง");');
    expect(A).toContain("if (parent.archivedAt) return { parent: await getParent(id, { archived: true }), archivedStudents: 0, clearedLineAccounts: 0 };");
    expect(A).toContain("const n = await liveFutureSessionCount(db, kids.map((s) => s.id));");
    expect(A).toContain('if (n > 0) throw conflict("PARENT_HAS_SESSIONS", `มีคาบเรียนในอนาคต ${n} คาบ — ยกเลิก/ย้ายก่อน`);');
    expect(A.indexOf("PARENT_HAS_SESSIONS")).toBeLessThan(A.indexOf("db.transaction("));
    expect((A.match(/db\.transaction\(/g) ?? []).length).toBe(1);
    expect(A).toContain("const { cleared } = await clearFamilyLine(id, actor, tx);");
    expect(A).toContain("await tx.update(parents).set({ archivedAt: new Date(), archivedBy: actor, archivedLineUserIds: cleared }).where(eq(parents.id, id));");
    expect(A).toContain("for (const s of kids) await markStudentArchived(tx, s.id, cascadeMarker(id));");
    expect(A.indexOf("clearFamilyLine(")).toBeLessThan(A.indexOf("archivedLineUserIds: cleared")); // the list is what the unlinker returned
    expect(A).not.toMatch(/phone|lineUserId:|\.delete\(|suspendedAt/); // the phone stays; nothing deleted; suspend untouched
    expect(A).toContain("return { parent: await getParent(id, { archived: true }), ...result };");
  });
  test("`unarchiveParent` by source: the three columns cleared (the LINE ids NOT restored — the audit list stays); ONLY the children with `archived_by = parent:<id>` come back; no household-cap check", () => {
    const U = region(PS, "export async function unarchiveParent(", "export async function findParentOfStudent(");
    expect(U).toContain("await tx.update(parents).set({ archivedAt: null, archivedBy: null }).where(eq(parents.id, id));");
    expect(U).not.toContain("archivedLineUserIds"); // the audit stays; nothing put back
    expect(U).not.toMatch(/lineUserId|familyLineLinks|bindFamilyLine|assertCanAddStudent/);
    expect(U).toContain("where(and(eq(students.parentId, id), eq(students.archivedBy, cascadeMarker(id))))");
    expect(U).toContain("if (!parent.archivedAt) return { parent: await getParent(id), restoredStudents: 0 };");
  });
  test("the archive + restore by VALUE: a fake db carries a family with two children, two devices — the count refuses; then the tx clears, marks, cascades; the restore brings back only the cascaded child", async () => {
    // a minimal in-memory `db` with the calls the two functions make (the module's `db` is spied at the accessor level)
    const state = {
      parent: { id: P1, phone: "0812345678", lineUserId: "Up1", archivedAt: null as Date | null, archivedBy: null as string | null, archivedLineUserIds: null as string[] | null },
      students: [{ id: S1, parentId: P1, archivedAt: null as Date | null, archivedBy: null as string | null }, { id: S2, parentId: P1, archivedAt: new Date("2026-09-01"), archivedBy: "admin" }],
      links: ["Up1", "Up1b"],
      liveFuture: 2,
    };
    const updates: any[] = [];
    const fakeTx: any = {
      update: (table: any) => ({ set: (patch: any) => ({ where: (_w: any) => { const rec = { table: table === parents ? "parents" : "students", patch }; updates.push(rec); const r = { returning: async () => (rec.table === "students" ? state.students.filter((s) => s.parentId === P1 && s.archivedBy === cascadeMarker(P1)).map((s) => ({ id: s.id })) : []) }; return Object.assign(Promise.resolve(undefined), r); } }) }),
      delete: () => ({ where: async () => {} }),
      select: () => ({ from: () => ({ where: async () => state.links.slice(1).map((lineUserId) => ({ parentId: P1, lineUserId })) }) }),
      query: { parents: { findMany: async () => [{ id: P1, lineUserId: state.links[0] }] } },
    };
    const spies = [
      spyOn(db.query.parents, "findFirst").mockImplementation((async () => ({ ...state.parent })) as any),
      spyOn(db, "transaction").mockImplementation((async (fn: any) => fn(fakeTx)) as any),
      spyOn(parent, "listStudentsOfParent").mockImplementation((async () => state.students.filter((s) => !s.archivedAt)) as any),
      spyOn(parent, "liveFutureSessionCount").mockImplementation((async () => state.liveFuture) as any),
      spyOn(parent, "getParent").mockImplementation((async (id: string, o?: any) => ({ id, archived: !!o?.archived })) as any),
      spyOn(await import("../lib/line-rich-menu"), "unlinkRichMenuFromUser").mockImplementation((async () => {}) as any), // no LINE call from a test
      spyOn(parent, "markStudentArchived").mockImplementation((async (_tx: any, id: string, by: string) => { updates.push({ table: "students", patch: { id, archivedBy: by } }); return { id } as any; }) as any),
    ];
    try {
      // 1. refused with the household count, nothing written
      const refused = await parent.archiveParent(P1, "admin").then(() => null, (e) => ({ status: e.status, code: e.code, message: e.message }));
      expect(refused).toEqual({ status: 409, code: "PARENT_HAS_SESSIONS", message: "มีคาบเรียนในอนาคต 2 คาบ — ยกเลิก/ย้ายก่อน" });
      expect(updates).toEqual([]);
      // 2. no live future ⇒ the tx: the unlinker's list into the audit column, the cascade marks ONLY the active child
      state.liveFuture = 0;
      const done = await parent.archiveParent(P1, "admin");
      expect(done).toMatchObject({ archivedStudents: 1, clearedLineAccounts: 2, parent: { id: P1, archived: true } });
      const parentWrites = updates.filter((u) => u.table === "parents");
      expect(parentWrites[0]!.patch).toEqual({ lineUserId: null }); // the unlinker's own write (clearFamilyLine), first
      const parentWrite = parentWrites.at(-1)!;
      expect(parentWrite.patch).toMatchObject({ archivedBy: "admin", archivedLineUserIds: ["Up1", "Up1b"] });
      expect(parentWrite.patch.archivedAt).toBeInstanceOf(Date);
      expect(updates.filter((u) => u.table === "students").map((u) => u.patch)).toEqual([{ id: S1, archivedBy: `parent:${P1}` }]); // S2 was archived on its own — untouched
      // 3. idempotent
      updates.length = 0;
      state.parent.archivedAt = new Date();
      expect(await parent.archiveParent(P1, "admin")).toMatchObject({ archivedStudents: 0, clearedLineAccounts: 0 });
      expect(updates).toEqual([]);
      // 4. the restore: the parent's columns cleared (not the ids), only the cascaded child restored
      state.students[0]!.archivedAt = new Date(); state.students[0]!.archivedBy = cascadeMarker(P1);
      const back = await parent.unarchiveParent(P1);
      expect(back).toMatchObject({ restoredStudents: 1, parent: { id: P1, archived: false } });
      expect(updates.filter((u) => u.table === "parents").at(-1)!.patch).toEqual({ archivedAt: null, archivedBy: null });
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
});

describe("🔴 Finding B — the phone is unique and stays: the admin's create ⇒ 409 PARENT_ARCHIVED; the LINE register ⇒ `phone-archived` (a PLACEHOLDER reply, never a silent restore, never a duplicate)", () => {
  test("by source: `findArchivedParentByPhone` is the ONE read past the predicate; `findOrCreateParentByPhone` refuses before its insert; `createParent` refuses with the message; both register doors return the outcome before any write", () => {
    expect(region(PS, "export async function findArchivedParentByPhone(", "export async function assertParentActive(")).toContain("a(e(x.phone, p), nn(x.archivedAt))");
    expect(region(PS, "export async function findOrCreateParentByPhone(", "export async function linkParentLine(")).toContain("if (await findArchivedParentByPhone(p, exec)) throw PARENT_ARCHIVED();");
    expect(region(PS, "export async function createParent(", "export async function updateParent(")).toContain('if (await findArchivedParentByPhone(phone)) throw conflict("PARENT_ARCHIVED", "เบอร์นี้เป็นของผู้ปกครองที่ถูกเก็บแล้ว — คืนสถานะแทน");');
    const RG = code(src("src/services/line-register.service.ts"));
    const lookup = region(RG, "export async function lookupFamilyByPhone(", "export type FamilyLink");
    expect(lookup).toContain('if (!existing && (await findArchivedParentByPhone(phone))) return { outcome: "phone-archived" };');
    const link = region(RG, "export async function linkFamilyByPhone(", "\n}\n");
    expect(link).toContain('if (await findArchivedParentByPhone(phone)) return { outcome: "phone-archived" };');
    expect(link.indexOf('outcome: "phone-archived"')).toBeLessThan(link.indexOf("findOrCreateParentByPhone(phone, { lineUserId })"));
    expect(RG).not.toMatch(/unarchiveParent|archivedAt: null/); // never a silent restore
    expect(code(src("src/services/line-webhook.service.ts"))).toContain('if (r.outcome === "phone-archived") return { ok: false, message: (l) => t("verify_parent_archived", l) };');
    expect(code(src("src/routes/register.ts"))).toContain('"phone-archived": [409, "PHONE_ARCHIVED"],');
  });
  test("🔴 TASK-413 — the reply by VALUE (the owner's words), both languages; the webhook's `phone-archived` branch reaches them through the reply mapper; the placeholder sentence is gone", () => {
    expect(t("verify_parent_archived", "TH")).toBe("เบอร์นี้เคยลงทะเบียนไว้แล้ว กรุณาติดต่อร้านเพื่อคืนสถานะ");
    expect(t("verify_parent_archived", "EN")).toBe("This number was registered before — please contact the shop to restore it.");
    const I = src("src/lib/line-i18n.ts");
    expect(I).not.toContain("PLACEHOLDER — MINE, and the owner has NOT seen it.** The number belongs to an");
    expect(code(I)).not.toMatch(/reactivate|แอดมินเพื่อเปิดใช้งาน/);
    const W = code(src("src/services/line-webhook.service.ts"));
    expect(W).toContain('if (r.outcome === "phone-archived") return { ok: false, message: (l) => t("verify_parent_archived", l) };');
    expect(W.indexOf('"phone-archived"')).toBeLessThan(W.indexOf("if (r.isNew)")); // refused before the success branches
  });
  test("by VALUE: `lookupFamilyByPhone` on an archived family's number ⇒ `phone-archived` (the active lookup null, the archived one found); a fresh number ⇒ `new`", async () => {
    const s1 = spyOn(parent, "findParentByPhone").mockImplementation((async () => null) as any);
    const s2 = spyOn(parent, "findArchivedParentByPhone").mockImplementation((async (phone: string) => (phone === "0812345678" ? { id: P1 } : null)) as any);
    const s3 = spyOn(await import("../lib/family-link"), "familyOfLineUser").mockImplementation((async () => null) as any);
    try {
      expect(await register.lookupFamilyByPhone("Ux", "081-234-5678")).toEqual({ outcome: "phone-archived" });
      expect(await register.lookupFamilyByPhone("Ux", "0899999999")).toEqual({ outcome: "new", phone: "0899999999" });
    } finally { s1.mockRestore(); s2.mockRestore(); s3.mockRestore(); }
  });
});

describe("🔑 the key (56), the access rows, the validators, the routes through the ROOT app", () => {
  test("`action:people.parent-archive` is the 56th key with both labels; two access rows on it; `?archived` on the list and the detail", () => {
    expect(ACTION_KEYS.length).toBe(59); // 🔻 TASK-431: + bookings.coach-rate // 🔻 TASK-428: + calendar.other-cancel-all // 🔻 TASK-426: + teachers.budget-view
    expect(ACTION_REGISTRY.find((a) => a.key === "action:people.parent-archive")).toMatchObject({ labelTh: "เก็บ/คืนสถานะผู้ปกครอง", labelEn: "Archive & restore a parent" });
    expect((ROUTE_ACCESS as any)["POST /parents/:id/archive"]).toMatchObject({ action: "action:people.parent-archive" });
    expect((ROUTE_ACCESS as any)["POST /parents/:id/unarchive"]).toMatchObject({ action: "action:people.parent-archive" });
    expect(v.parentsQuery.parse({ archived: "1" }).archived).toBe(true);
    expect(v.parentsQuery.parse({ archived: "true" }).archived).toBe(true);
    expect(v.parentsQuery.parse({}).archived).toBe(false);
    expect(v.parentDetailQuery.parse({ archived: "1" }).archived).toBe(true);
    expect(v.parentDetailQuery.parse({}).archived).toBe(false);
  });
  test("through the ROOT app (services spied): archive ⇒ the counts; the 409 envelope; restore; the list passes `archived`; the detail passes `archived`", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: any[] = [];
    const a = spyOn(parent, "archiveParent").mockImplementation((async (id: string, actor: any) => { calls.push(["archive", id, actor]); if (id === S1) throw new ApiException(409, "PARENT_HAS_SESSIONS", "มีคาบเรียนในอนาคต 3 คาบ — ยกเลิก/ย้ายก่อน"); return { parent: { id }, archivedStudents: 2, clearedLineAccounts: 1 }; }) as any);
    const u = spyOn(parent, "unarchiveParent").mockImplementation((async (id: string) => ({ parent: { id }, restoredStudents: 2 })) as any);
    const l = spyOn(parent, "listParents").mockImplementation((async (...args: any[]) => { calls.push(["list", ...args]); return { parents: [], total: 0 }; }) as any);
    const g = spyOn(parent, "getParent").mockImplementation((async (id: string, o: any) => { calls.push(["get", id, o]); return { id }; }) as any);
    try {
      const post = (p: string) => rootApp.fetch(new Request(`http://localhost/api${p}`, { method: "POST" }));
      const ok = await post(`/parents/${P1}/archive`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ parent: { id: P1 }, archivedStudents: 2, clearedLineAccounts: 1 });
      expect(calls.at(-1)).toEqual(["archive", P1, "dev"]);
      const refused = await post(`/parents/${S1}/archive`);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: { code: "PARENT_HAS_SESSIONS", message: "มีคาบเรียนในอนาคต 3 คาบ — ยกเลิก/ย้ายก่อน" } });
      expect(await (await post(`/parents/${P1}/unarchive`)).json()).toEqual({ parent: { id: P1 }, restoredStudents: 2 });
      await rootApp.fetch(new Request("http://localhost/api/parents?archived=1"));
      expect(calls.at(-1)).toEqual(["list", undefined, undefined, undefined, true]);
      await rootApp.fetch(new Request("http://localhost/api/parents"));
      expect(calls.at(-1)).toEqual(["list", undefined, undefined, undefined, false]);
      await rootApp.fetch(new Request(`http://localhost/api/parents/${P1}?archived=1`));
      expect(calls.at(-1)).toEqual(["get", P1, { archived: true }]);
    } finally { a.mockRestore(); u.mockRestore(); l.mockRestore(); g.mockRestore(); }
  });
});
