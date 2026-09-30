// TASK-578 — Tanya's TEST-076 on sid: D9 (a count, not a flag) and D11 (a linked family with 0 children is not a dead end).
// F-D (garbled English sub-district names) is third-party DATA in the FE's address package — reported, no code here.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { planCourseStartChange, isStartChangeRefusal, type StartChangePlan, type StartChangeRow } from "./course-start-change";
import * as idToken from "./line-id-token";
import * as reg from "../services/line-register.service";
import * as parentSvc from "../services/parent.service";
import * as lineAdmin from "./line-admin";
import { db } from "../db";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });

// 🔑 D9, pinned AT COMPILE TIME: the field is a number, and a boolean is not assignable to it. `tsc` fails this file if it drifts.
type IsExactlyNumber<T> = [T] extends [number] ? ([boolean] extends [T] ? false : true) : false;
const needsReconfirmIsANumber: IsExactlyNumber<StartChangePlan["needsReconfirm"]> = true;

describe("🔴 D9 — the start-date result carries the COUNT of sessions to re-confirm, never a boolean", () => {
  const C = { startDate: "2026-10-05", size: 4, expiryDate: "2026-11-02", priorSessions: 0 };
  const R = (id: string, date: string, status: string): StartChangeRow => ({ id, date, status, teacherId: "t1", extendedFromId: null, bookingType: "COURSE_PACKAGE" });
  const plan = async (statuses: string[]) => {
    const p = await planCourseStartChange(C, statuses.map((s, i) => R(`b${i}`, `2026-10-${String(5 + 7 * i).padStart(2, "0")}`, s)), "2026-10-12", "2026-10-01", async () => false);
    if (isStartChangeRefusal(p)) throw new Error(p.message);
    return p.needsReconfirm;
  };
  test("by value: 4 confirmed ⇒ 4 · 2 of 4 confirmed ⇒ 2 · none ⇒ 0 — and it is a NUMBER at run time too", async () => {
    expect(needsReconfirmIsANumber).toBe(true);
    expect(await plan(["CONFIRMED", "CONFIRMED", "CONFIRMED", "CONFIRMED"])).toBe(4);
    expect(await plan(["CONFIRMED", "PENDING", "CONFIRMED", "PENDING"])).toBe(2);
    const none = await plan(["PENDING", "PENDING", "PENDING", "PENDING"]);
    expect([none, typeof none]).toEqual([0, "number"]);
  });
});

describe("🔴 D11 (b) — a LINKED family is told it can add a child, including one with 0 children", () => {
  const status = async (childCount: number) => {
    process.env.SKIP_AUTH = "true";
    spies.push(spyOn(idToken, "verifyLiffIdToken").mockImplementation((async () => ({ ok: true, sub: "U-parent" })) as any));
    spies.push(spyOn(reg, "linkStatus").mockImplementation((async () => ({ linked: true, parentId: "p1", phone: "08x-xxx-0761", childCount, addressOnFile: false, province: null })) as any));
    const app = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
    const r = await app.fetch(new Request("http://localhost/api/register/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "t" }) }));
    for (const s of spies.splice(0)) s.mockRestore();
    return (await r.json()) as any;
  };
  test("0 children (Tanya's abandoned registration) ⇒ canAddMore TRUE · below the cap ⇒ TRUE · AT the cap (5) ⇒ FALSE", async () => {
    expect((await status(0)).canAddMore).toBe(true);
    expect((await status(4)).canAddMore).toBe(true);
    expect((await status(parentSvc.MAX_STUDENTS_PER_PARENT)).canAddMore).toBe(false);
  });
  test("and the add itself works for a linked family with 0 children: the page's one writer creates the FIRST child", async () => {
    const created: any[] = [];
    spies.push(spyOn(parentSvc, "findParentByLineUserId").mockImplementation((async () => ({ id: "p1", phone: "0899990761", province: null, note: null })) as any));
    spies.push(spyOn(parentSvc, "assertCanAddStudent").mockImplementation((async () => 0) as any));
    spies.push(spyOn(parentSvc, "listStudentsOfParent").mockImplementation((async () => []) as any)); // 0 children
    spies.push(spyOn(parentSvc, "createStudentForParent").mockImplementation((async (_p: string, i: any) => { created.push(i); return { student: { id: "s-new", name: i.name }, count: 1 }; }) as any));
    spies.push(spyOn(lineAdmin, "notifyAdmins").mockImplementation((async () => {}) as any));
    spies.push(spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ limit: async () => [{ note: null }] }) }) })) as any));
    spies.push(spyOn(db, "update").mockImplementation((() => ({ set: () => ({ where: async () => {} }) })) as any));
    const r: any = await reg.addChildForLineParent("U-parent", { name: "QARegOne", birthDate: "01-02-2019", province: "กรุงเทพมหานคร", district: "คลองสาน", subDistrict: "คลองต้นไทร" }); // 🔻 TASK-590: three parts
    expect([r.outcome, r.count, created.length]).toEqual(["created", 1, 1]);
  });
});
