// TASK-706 (F3) — cancelling a GROUP date tells the families of its CONFIRMED seats even when the group row itself is still PENDING (a sale-added date). The notice is the existing
// `class_cancelled_parent` — no new words. A GROUP row is decided by its SEATS (as they were BEFORE the cancel); every non-group row and a CONFIRMED/EXTENDED group row are as before.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sched from "./scheduler.service";
import * as familyLink from "../lib/family-link";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const FAMILY: Record<string, string> = { s1: "U-fam1", s2: "U-fam1" /* siblings: ONE family */, s3: "U-fam3", s4: "U-fam4" };
function run() {
  const asked: Array<Array<string | null>> = [];
  const inserts: any[] = [];
  spies.push(spyOn(familyLink, "householdLineUserIds").mockImplementation((async (_e: any, ids: Array<string | null>) => { asked.push(ids); return [...new Set(ids.filter(Boolean).map((i) => FAMILY[i as string]))]; }) as any));
  const tx: any = { query: { bookings: { findMany: async () => [] } }, insert: () => ({ values: async (v: any) => { inserts.push(v); } }) };
  return { asked, inserts, tx };
}
const group = (status: string, seats: any[]) => ({ id: "G1", status, bookingType: "GROUP", studentId: null, coStudentId: null, seats, course: null, voucher: null });
const seat = (id: string, studentId: string, status: string) => ({ id, studentId, status });

describe("🔴 F3 — a PENDING group row decides by its CONFIRMED seats", () => {
  test("PENDING group row + a CONFIRMED seat ⇒ that seat's family gets the ordinary cancel notice", async () => {
    const h = run();
    const out = await sched.classCancelledFamilyAccounts(h.tx, group("PENDING", [seat("a", "s3", "CONFIRMED")]), null);
    expect(out).toEqual(["U-fam3"]);
    expect(h.inserts.map((v) => [v.recipientLineUserId, v.payload.kind])).toEqual([["U-fam3", "class_cancelled_parent"]]);
  });
  test("PENDING group row + one CONFIRMED and one PENDING seat ⇒ ONLY the confirmed seat's family (the pending one was never told that date)", async () => {
    const h = run();
    const out = await sched.classCancelledFamilyAccounts(h.tx, group("PENDING", [seat("a", "s3", "CONFIRMED"), seat("b", "s4", "PENDING")]), null);
    expect(out).toEqual(["U-fam3"]);
    expect(h.asked).toEqual([["s3"]]);
  });
  test("PENDING group row + only PENDING (or CANCELLED) seats ⇒ nothing sent", async () => {
    const h = run();
    expect(await sched.classCancelledFamilyAccounts(h.tx, group("PENDING", [seat("a", "s4", "PENDING"), seat("b", "s3", "CANCELLED")]), null)).toBeNull();
    expect(h.inserts).toEqual([]);
  });
  test("two siblings seated on one PENDING group date ⇒ their family ONCE (TASK-445 de-dup intact)", async () => {
    const h = run();
    const out = await sched.classCancelledFamilyAccounts(h.tx, group("PENDING", [seat("a", "s1", "CONFIRMED"), seat("b", "s2", "CONFIRMED")]), null);
    expect(out).toEqual(["U-fam1"]);
    expect(h.inserts).toHaveLength(1);
  });
  test("seats not handed in are read for the GROUP (the caller passed none)", async () => {
    const h = run();
    h.tx.query.bookings.findMany = async () => [seat("a", "s3", "CONFIRMED")];
    expect(await sched.classCancelledFamilyAccounts(h.tx, { ...group("PENDING", []), seats: undefined } as any, null)).toEqual(["U-fam3"]);
  });
});

describe("🚫 F3 — everything else is byte-identical", () => {
  test("a CONFIRMED group row ⇒ as today: every non-cancelled seat's family (a PENDING seat included)", async () => {
    const h = run();
    const out = await sched.classCancelledFamilyAccounts(h.tx, group("CONFIRMED", [seat("a", "s3", "CONFIRMED"), seat("b", "s4", "PENDING"), seat("c", "s1", "CANCELLED")]), null);
    expect(out).toEqual(["U-fam3", "U-fam4"]);
  });
  test("a NON-group PENDING row ⇒ nothing (the early return stands), even if it carries confirmed-looking seats", async () => {
    const h = run();
    const row = { id: "P1", status: "PENDING", bookingType: "COURSE_PACKAGE", studentId: "s3", coStudentId: null, seats: [seat("a", "s3", "CONFIRMED")], course: { size: 4 } };
    expect(await sched.classCancelledFamilyAccounts(h.tx, row as any, null)).toBeNull();
    expect(h.inserts).toEqual([]);
  });
  test("a NON-group CONFIRMED row ⇒ the row's own children, the ordinary notice", async () => {
    const h = run();
    const row = { id: "P2", status: "CONFIRMED", bookingType: "COURSE_PACKAGE", studentId: "s3", coStudentId: "s4", course: { size: 4 } };
    expect(await sched.classCancelledFamilyAccounts(h.tx, row as any, null)).toEqual(["U-fam3", "U-fam4"]);
    expect(h.inserts[0].payload.kind).toBe("class_cancelled_parent");
  });
});

describe("🔑 F3 — by source", () => {
  const S = readFileSync(resolve(import.meta.dir, "scheduler.service.ts"), "utf8");
  test("the gate is the group branch over the PRE-cancel seats: CONFIRMED only, nothing else; the move notice's accessor is untouched", () => {
    expect(S).toContain('if (current.bookingType !== "GROUP") return null;');
    expect(S).toContain('const confirmed = preSeats.filter((st: any) => st.status === "CONFIRMED");');
    expect(S).toContain("const preSeats: any[] = current.seats ?? (await tx.query.bookings.findMany(");
    expect(S).toContain(".filter((st: any) => st.status !== \"CANCELLED\")"); // familyAccountsOfRow itself: unchanged (still every non-cancelled seat)
  });
});
