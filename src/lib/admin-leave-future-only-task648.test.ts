// TASK-648 (QA F1, owner ruling 2026-10-04) — the ADMIN's leave door refuses TODAY and the PAST, at the SERVER.
//
// 🔴 The owner's reason: a call that accepts today CANCELS that day's classes and NOTIFIES the families in the same call —
//    **one wrong call is irreversible, and the customer has already seen it.** *A door the screen refuses must not stand open behind it.*
// 📌 How it came to be open: TASK-608 gave the admin route the whole act; TASK-611 made "future only" a rule of the DIALOG alone.
//    @Tanya's API call went straight past the screen.
// 🔑 The refusal is at the ROUTE and asks the SAME predicate the act forks on. 🚫 Never inside the act — the TEACHER's own door
//    shares it and must keep accepting today, and TASK-608's invariant is that `onBehalf` decides only WHO IS TOLD.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as svc from "../services/scheduler.service";
import * as leaveLib from "./teacher-leave";
import { isAdvanceLeave, ADMIN_LEAVE_FUTURE_ONLY } from "./teacher-leave";
import { bangkokNow } from "./bangkok-time";
import * as ownScope from "./own-scope";
import { ApiException } from "./http";
import { readSrc } from "./read-src";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const code = (f: string) => readSrc(readFileSync(resolve(root, f), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const API = code("src/routes/api.ts");
const SCHED = code("src/services/scheduler.service.ts");
const TEACHER = "88888888-8888-4888-8888-888888888888";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });

const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
const call = async (path: string, body: unknown) => {
  const res = await rootApp.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};
const TODAY = bangkokNow().date;
const PAST = new Date(Date.parse(TODAY) - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const FUTURE = new Date(Date.parse(TODAY) + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

/** Spies that make the ACT observable without a database: it must not be reached at all for today or the past. */
const watchAct = () => {
  const calls: Array<{ date: string; onBehalf: boolean }> = [];
  spies.push(spyOn(svc, "reportTeacherLeave").mockImplementation((async (_t: string, input: any, _a: any, opts: any) => { calls.push({ date: input.date, onBehalf: opts.onBehalf }); return { mode: "advance", cancelled: 0, bookingIds: [], familiesNotified: 0, leave: {}, alreadyRecorded: false, bookings: [], teacherNotified: 1 }; }) as any));
  spies.push(spyOn(svc, "reportOwnLeave").mockImplementation((async (_t: string, input: any) => { calls.push({ date: input.date, onBehalf: false }); return { mode: "same-day", cancelled: 2, bookingIds: ["b1", "b2"], familiesNotified: 2 }; }) as any));
  return calls;
};

describe("🔴 TASK-648 — the ADMIN door, through the ROOT app: future only", () => {
  test("🔴 TODAY ⇒ 400, and the act is NEVER CALLED — nothing cancelled, nobody notified", async () => {
    process.env.SKIP_AUTH = "true";
    const calls = watchAct();
    const r = await call("/teacher-leave-days", { teacherId: TEACHER, date: TODAY, reason: "ลาป่วย" });
    expect(r.status).toBe(400);
    expect(calls).toEqual([]); // 🔑 the refusal is BEFORE the act — not a rollback, not a no-op inside it
  });
  test("🔴 a PAST date ⇒ the same", async () => {
    process.env.SKIP_AUTH = "true";
    const calls = watchAct();
    expect((await call("/teacher-leave-days", { teacherId: TEACHER, date: PAST, reason: "ลาป่วย" })).status).toBe(400);
    expect(calls).toEqual([]);
  });
  test("✅ a FUTURE date ⇒ unchanged: the act runs, on behalf", async () => {
    process.env.SKIP_AUTH = "true";
    const calls = watchAct();
    const r = await call("/teacher-leave-days", { teacherId: TEACHER, date: FUTURE, reason: "ลาป่วย" });
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ date: FUTURE, onBehalf: true }]);
  });
  test("🔴 THE REGRESSION THIS IS MOST LIKELY TO CAUSE — the TEACHER's own door with TODAY still cancels, untouched", async () => {
    process.env.SKIP_AUTH = "true";
    const calls = watchAct();
    spies.push(spyOn(leaveLib, "recordAdvanceLeave").mockImplementation((async () => ({ leave: {}, alreadyRecorded: false, bookings: [] })) as any));
    // the own door is for a LINKED coach; `assertLinked` is the auth half and is not what this test is about
    spies.push(spyOn(ownScope, "assertLinked").mockImplementation((() => TEACHER) as any));
    const r = await call("/teachers/me/leave", { date: TODAY, reason: "ไม่สบาย" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cancelled: 2 }); // 🔑 a coach's legitimate SAME-DAY cancel, exactly as before
    expect(calls).toEqual([{ date: TODAY, onBehalf: false }]);
  });
});

describe("🔑 TASK-648 — ONE predicate, at the route, and the act's single fork untouched", () => {
  test("the route asks `isAdvanceLeave` — 🚫 not a second date comparison written by hand", () => {
    const at = API.indexOf('.post("/teacher-leave-days"');
    expect(at).toBeGreaterThan(0); // the anchor is checked before it is sliced on
    const DOOR = API.slice(at, API.indexOf("})", at));
    expect(DOOR).toContain("if (!isAdvanceLeave(input.date)) throw ADMIN_LEAVE_FUTURE_ONLY();");
    expect(DOOR).not.toMatch(/new Date\(|> *today|Date\.parse/);
    // …and it runs BEFORE the act
    expect(DOOR.indexOf("isAdvanceLeave")).toBeLessThan(DOOR.indexOf("svc.reportTeacherLeave"));
  });
  test("🔴 the ACT is untouched — it still forks ONCE, and nothing in it reads `onBehalf` to decide WHAT HAPPENS", () => {
    const at = SCHED.indexOf("export async function reportTeacherLeave(");
    expect(at).toBeGreaterThan(0);
    const ACT = SCHED.slice(at, SCHED.indexOf("export const reportOwnLeave", at));
    expect((ACT.match(/isAdvanceLeave\(/g) ?? []).length).toBe(1); // ONE fork, in the act, as TASK-608 built it
    expect(ACT).not.toMatch(/if \(opts\.onBehalf\) \{|onBehalf \?[^:]*cancel/); // 🚫 `onBehalf` never decides the branch
    // 🔑 and the refusal is NOT in the act: putting it there would break the teacher's own same-day door
    expect(ACT).not.toContain("ADMIN_LEAVE_FUTURE_ONLY");
  });
  test("⚠️ the `isAdvanceLeave` exactly-once pin is scoped to the ACT, and now says so", () => {
    // 🔑 @Sober asked for this explicitly: the predicate now has TWO call sites in the product (the act's fork and the admin
    // route's guard), so a pin that counted them ACROSS FILES would have to be loosened — which would stop proving anything.
    // ⇒ it is scoped to the act, where "exactly one fork" is the real claim, and the route's own call is pinned separately above.
    const inProduct = [code("src/services/scheduler.service.ts"), code("src/routes/api.ts"), code("src/lib/teacher-leave.ts")]
      .join("\n").match(/isAdvanceLeave\(/g) ?? [];
    expect(inProduct.length).toBe(3); // the lib's own refusal + the act's ONE fork + the route's guard (the definition is not a call)
  });
  test("by value: the predicate itself is unchanged — today is NOT an advance leave, tomorrow is", () => {
    expect(isAdvanceLeave(TODAY, TODAY)).toBe(false);
    expect(isAdvanceLeave(PAST, TODAY)).toBe(false);
    expect(isAdvanceLeave(FUTURE, TODAY)).toBe(true);
  });
  test("📋 the refusal names what to do INSTEAD — a refusal that only says no sends the admin back to the same button", () => {
    const e = ADMIN_LEAVE_FUTURE_ONLY() as ApiException;
    expect(e.status).toBe(400);
    expect(e.message).toContain("ปฏิทิน"); // handle the day's classes one by one on the calendar
    expect(/[A-Za-z]/.test(e.message)).toBe(false); // Thai only, like every refusal beside it
  });
});
