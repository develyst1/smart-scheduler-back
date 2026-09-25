// TASK-453 (REQ-105 §3/§8/§8.1, SPEC-091 §3+§5) — the GROUP slot YIELDS its coach-hour to a Private and says so.
//
// 🔑 The property this whole file exists for: `bookings_teacher_slot_uq` is a PARTIAL UNIQUE INDEX, so two holders of
// one coach-hour are not storable. A visible clash is therefore the GROUP row stepping aside — and the index's own
// WHERE has to learn that, in the same migration, or the code and the database mean different things by "free".
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { readSrc } from "./read-src";
import { bookings } from "../db/schema";
import { holdsSlot, slotHolderWhere, SLOT_INACTIVE_STATUSES } from "./slot-holder";
import { CLASH_NOTE_DAILY, CLASH_NOTE_WEEKLY, isGroupSlotClash, takesYieldedSlot, YIELD_TAKING_TYPES } from "./group-clash";
import { ATTENTION_CHECKS } from "./attention";
import { SCHEDULING_WITNESSES } from "./migration-witness";
import { ROUTE_ACCESS } from "./route-access";
import { renderTodaySchedule } from "./line-today-schedule";
import { renderWeeklySchedule } from "./weekly-digest";
import { uuidFor } from "./test-uuid";
import * as v from "../validation";

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
const SCHED = code(src("src/services/scheduler.service.ts"));
const MIG = readFileSync(resolve(root, "drizzle/0054_group_slot_yield.sql"), "utf8");
const T1 = uuidFor("t-1"), T2 = uuidFor("t-2"), G1 = uuidFor("g-1"), S1 = uuidFor("s-1");

// ═══════════════════ §1 the THREE-WAY pin: the migration, the schema, the code mirror ═══════════════════

/** Lower-case, unqualify, unquote, collapse — so three spellings of ONE predicate compare as one string. */
const norm = (s: string) =>
  s.toLowerCase().replace(/"bookings"\./g, "").replace(/"/g, "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();

describe("🔴 §1 the predicate is ONE fact in three places — and they are asserted EQUAL", () => {
  const dialect = new PgDialect();
  const migPredicate = /create unique index[\s\S]*?where([\s\S]*?);/i.exec(MIG)![1]!;
  const schemaPredicate = dialect.sqlToQuery(
    (getTableConfig(bookings).indexes.find((i: any) => i.config.name === "bookings_teacher_slot_uq") as any).config.where,
  ).sql;
  const rendered = dialect.sqlToQuery(slotHolderWhere(bookings));
  // the mirror renders with PARAMS; substituting them is what makes it comparable to the two inline spellings
  const mirrorPredicate = rendered.sql.replace(/\$(\d+)/g, (_, i) => `'${rendered.params[Number(i) - 1]}'`);

  test("🔑 the migration's WHERE ⇔ the schema's `.where(sql…)` ⇔ `slotHolderWhere` rendered — all three, character for character after normalisation", () => {
    expect({ schema: norm(schemaPredicate), mirror: norm(mirrorPredicate) }).toEqual({
      schema: norm(migPredicate),
      mirror: norm(migPredicate),
    });
  });

  test("…and all three carry the THIRD term, the two old ones, and the SAME status set", () => {
    for (const [where, p] of Object.entries({ migration: migPredicate, schema: schemaPredicate, mirror: mirrorPredicate })) {
      expect({ where, third: norm(p).includes("slot_yielded_at is null") }).toEqual({ where, third: true });
      expect({ where, seat: norm(p).includes("group_id is null") }).toEqual({ where, seat: true });
      for (const s of SLOT_INACTIVE_STATUSES) expect({ where, s, has: norm(p).includes(s.toLowerCase()) }).toEqual({ where, s, has: true });
    }
  });

  test("🚫 a fourth status / a renamed column / a term on one side only cannot pass: the comparison is the WHOLE predicate, not a `contains`", () => {
    // The guard on the guard: if `norm` collapsed everything to a constant, the test above would pass on anything.
    expect(norm(`WHERE "status" not in ('CANCELLED') and "group_id" is null`)).not.toEqual(norm(migPredicate));
    expect(norm(migPredicate).length).toBeGreaterThan(60);
  });
});

describe("🔴 §1 the mirror, by value — and what it is NOT", () => {
  test("`holdsSlot`: live ⇒ holds · a seat ⇒ no · an INACTIVE status ⇒ no · YIELDED ⇒ no (the third case)", () => {
    for (const status of ["PENDING", "CONFIRMED", "EXTENDED", "ATTENDED"]) expect({ status, holds: holdsSlot({ status }) }).toEqual({ status, holds: true });
    for (const status of SLOT_INACTIVE_STATUSES) expect({ status, holds: holdsSlot({ status }) }).toEqual({ status, holds: false });
    expect(holdsSlot({ status: "CONFIRMED", groupId: G1 })).toBe(false);
    expect(holdsSlot({ status: "CONFIRMED", slotYieldedAt: new Date("2026-10-01T03:00:00Z") })).toBe(false);
    expect(holdsSlot({ status: "CONFIRMED", groupId: null, slotYieldedAt: null })).toBe(true);
  });

  test("📌 stated, not implied: `holdsSlot` has NO product caller — every read goes through `slotHolderWhere`", () => {
    const callers = ["src/services/scheduler.service.ts", "src/services/other-series.service.ts", "src/services/camp.service.ts", "src/services/jobs.service.ts", "src/db/mappers.ts"]
      .filter((f) => /\bholdsSlot\(/.test(code(src(f))));
    expect(callers).toEqual([]);
    expect(src("src/lib/slot-holder.ts")).toContain("no product caller today");
  });

  test("🔴 the four service mirrors read the ONE predicate, so the third case reached them with no edit of their own", () => {
    for (const fn of ["async function describeSlotClash(", "async function assertAdditionalTeacherFree(", "async function findFreeExtensionDate(", "export async function getSlotAvailability("]) {
      const F = region(SCHED, fn, "\n}\n");
      expect({ fn, uses: F.includes("slotHolderWhere(b)") }).toEqual({ fn, uses: true });
      expect({ fn, restates: /slot_?[Yy]ielded/.test(F) }).toEqual({ fn, restates: false });
    }
  });
});

// ═══════════════════ §2 the migration ═══════════════════

describe("🔴 §2 `0054`, counted; the column FIRST, the rebuild LAST; the PREDICATE is the witness", () => {
  test("56 = 56: `0054_group_slot_yield` is the 55th file, idx 54, the last; 'expects 55'; the four statements in THIS order", () => {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    expect(readdirSync(resolve(root, "drizzle")).filter((f) => f.endsWith(".sql")).length).toBe(57);
    expect(journal.entries.length).toBe(57);
    expect(journal.entries[54]).toMatchObject({ idx: 54, tag: "0054_group_slot_yield" });
    expect(MIG).toContain("db:verify` expects 55");
    const stmts = MIG.split("--> statement-breakpoint").map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    expect(stmts).toEqual([
      `ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "slot_yielded_at" timestamptz NULL;`,
      `ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "group_closed_at" timestamptz NULL;`,
      `DROP INDEX IF EXISTS "bookings_teacher_slot_uq";`,
      stmts[3]!,
    ]);
    // the order IS the correctness: the new predicate names a column that must already exist
    expect(MIG.indexOf(`ADD COLUMN IF NOT EXISTS "slot_yielded_at"`)).toBeLessThan(MIG.indexOf("CREATE UNIQUE INDEX"));
    expect(MIG.indexOf("DROP INDEX")).toBeLessThan(MIG.indexOf("CREATE UNIQUE INDEX"));
  });

  test("🔑 the witness is the index's PREDICATE — not its existence, and not the column (which is added first)", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0054_group_slot_yield")!;
    expect(w).toMatchObject({ probe: { kind: "index-predicate", index: "bookings_teacher_slot_uq", contains: "slot_yielded_at" }, rerunnable: true });
    expect(w.why).toContain("NOT the index's existence");
    expect(w.why).toContain("NOT the column");
    // 🔻 TASK-460 added `0055` after this one, so "the last entry" is no longer the property — "registered, in the
    // journal's own order" is, and that is what this asserts.
    const i = SCHEDULING_WITNESSES.findIndex((x) => x.tag === "0054_group_slot_yield");
    expect(SCHEDULING_WITNESSES[i + 1]?.tag).toBe("0055_line_webhook_events");
  });

  test("⚠️ the HOT-table lock is named in the header, with the honest reason CONCURRENTLY is not used", () => {
    expect(MIG).toContain("ACCESS EXCLUSIVE");
    expect(MIG).toContain("No CONCURRENTLY");
  });
});

// ═══════════════════ §3 the YIELD — set only by the Private's own path, before the insert ═══════════════════

const teacher = { id: T1, nickname: "Bank", name: "Bank", archived: false, workDays: [0, 1, 2, 3, 4, 5, 6], type: "FULL_TIME" };
/** A fake transaction that records what `insertBooking` did, in the order it did it. */
const fakeTx = (o: { group?: any; liveSeats?: number } = {}) => {
  const ops: Array<{ op: string; v?: any }> = [];
  return {
    ops,
    tx: {
      query: {
        teachers: { findFirst: async () => teacher },
        bookings: { findFirst: async () => o.group ?? null },
        freelanceCeilings: { findFirst: async () => null },
        students: { findFirst: async () => ({ id: S1, parentId: null, archivedAt: null, name: "Ploy", nickname: "Ploy" }) },
        parents: { findFirst: async () => null },
      },
      select: () => ({ from: () => ({ where: async () => [{ n: o.liveSeats ?? 0 }] }) }),
      update: () => ({ set: (v: any) => ({ where: () => { ops.push({ op: "yield", v }); return Promise.resolve(); } }) }),
      insert: () => ({ values: (v: any) => ({ returning: async () => { ops.push({ op: "insert", v }); return [{ id: uuidFor("b-1") }]; } }) }),
    } as any,
  };
};
const PRIVATE = { teacherId: T1, subjectId: uuidFor("subj"), date: "2026-10-06", startTime: "15:00", bookingType: "FIRST_TRIAL" };
const emptyGroup = { id: G1, teacherId: T1, date: "2026-10-06", startTime: "15:00", bookingType: "GROUP", status: "CONFIRMED", otherTitle: "Skate Kids" };

describe("🔴 §3 a PRIVATE into an EMPTY group date: the group yields FIRST, then the Private is stored", () => {
  test("by value: the yield is a `slot_yielded_at` timestamp on the GROUP row, and it lands BEFORE the insert", async () => {
    const svc = await import("../services/scheduler.service");
    const { tx, ops } = fakeTx({ group: emptyGroup, liveSeats: 0 });
    await svc.insertBooking(tx, S1, PRIVATE);
    expect(ops.map((o) => o.op)).toEqual(["yield", "insert"]); // 🔑 the index never sees two holders
    expect(ops[0]!.v.slotYieldedAt).toBeInstanceOf(Date);
    expect(Object.keys(ops[0]!.v)).toEqual(["slotYieldedAt"]); // 🚫 nothing else about the group row is touched
  });

  test("🚫 a group date WITH a live kid does not yield — the Private meets the index and is refused with today's words", async () => {
    const svc = await import("../services/scheduler.service");
    const { tx, ops } = fakeTx({ group: emptyGroup, liveSeats: 1 });
    await svc.insertBooking(tx, S1, PRIVATE);
    expect(ops.map((o) => o.op)).toEqual(["insert"]); // no yield: the insert proceeds and `23505` does the refusing
  });

  test("🚫 a GROUP row, an OTHER, a CAMP hour and a SEAT never make anything yield", async () => {
    const svc = await import("../services/scheduler.service");
    for (const bookingType of ["GROUP", "OTHER"]) {
      const { tx, ops } = fakeTx({ group: emptyGroup, liveSeats: 0 });
      await svc.insertBooking(tx, null, { ...PRIVATE, bookingType, otherTitle: "x", otherKind: bookingType === "GROUP" ? "GROUP" : "ECA", headCount: 4 });
      expect({ bookingType, ops: ops.map((o) => o.op) }).toEqual({ bookingType, ops: ["insert"] });
    }
    const { tx, ops } = fakeTx({ group: emptyGroup, liveSeats: 0 });
    await svc.insertBooking(tx, S1, { ...PRIVATE, bookingType: "COURSE_PACKAGE", groupId: G1 }); // a SEAT
    expect(ops.map((o) => o.op)).toEqual(["insert"]);
  });

  test("📌 an ENROLMENT onto a yielded date keeps the yield — by construction: a seat carries `group_id` and returns before the read", async () => {
    const svc = await import("../services/scheduler.service");
    const { tx, ops } = fakeTx({ group: { ...emptyGroup, slotYieldedAt: new Date() }, liveSeats: 0 });
    await svc.insertBooking(tx, S1, { ...PRIVATE, bookingType: "COURSE_PACKAGE", groupId: G1 });
    expect(ops.map((o) => o.op)).toEqual(["insert"]);
    expect(ops[0]!.v.groupId).toBe(G1);
  });

  test("the four types that may take a yielded hour are NAMED, and they are the lesson types", () => {
    expect([...YIELD_TAKING_TYPES]).toEqual(["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"]);
    for (const t of YIELD_TAKING_TYPES) expect({ t, takes: takesYieldedSlot(t) }).toEqual({ t, takes: true });
    for (const t of ["GROUP", "OTHER", null, undefined, ""]) expect({ t, takes: takesYieldedSlot(t as any) }).toEqual({ t, takes: false });
  });

  test("🔴 by source: the yield runs INSIDE the caller's transaction, before the insert, and every call site passes a `tx`", () => {
    const I = region(SCHED, "export async function insertBooking(", "\n}\n");
    expect(I.indexOf("await yieldEmptyGroupSlot(exec, input);")).toBeLessThan(I.indexOf("await exec\n      .insert(bookings)"));
    const Y = region(SCHED, "async function yieldEmptyGroupSlot(", "\n}\n");
    expect(Y).toContain("inA(b.status, [...COURSE_LIVE_STATUSES])"); // "empty" by THE live set, not a second list
    expect(Y).toContain("if ((await liveSeatCount(exec, g.id)) >= 1) return;");
    for (const f of ["src/services/scheduler.service.ts", "src/services/other-series.service.ts", "src/services/camp.service.ts"]) {
      const calls = code(src(f)).match(/insertBooking\((\w+)/g) ?? [];
      expect({ f, nonTx: calls.filter((c) => !/\(tx$/.test(c) && !/\(\s*$/.test(c)).filter((c) => c !== "insertBooking(tx") }).toEqual({ f, nonTx: [] });
    }
  });

  test("🚫 nothing else in `src` writes `slotYieldedAt` — one writer, two clearers, and no job at all", () => {
    // 🔻 TASK-453b — `jobs.service` now MENTIONS the column, reading it onto the reminder row (`slotYieldedAt:
    // r.slotYieldedAt ?? null`). That is a READ, not a write, and the distinction is the whole point of this test —
    // so the copy is excluded by its own shape and a real write there would still fail here.
    const writers = ["scheduler.service", "other-series.service", "camp.service", "jobs.service", "line-webhook.service", "attention.service"]
      .flatMap((f) => (code(src(`src/services/${f}.ts`)).match(/slotYieldedAt: [^,\n}]+/g) ?? []).map((m) => `${f}: ${m.trim()}`))
      .filter((m) => m !== "jobs.service: slotYieldedAt: r.slotYieldedAt ?? null");
    expect(writers.sort()).toEqual([
      "scheduler.service: slotYieldedAt: new Date()", // the yield (the Private's path)
      "scheduler.service: slotYieldedAt: null", // ① the move
      "scheduler.service: slotYieldedAt: null", // ② the coach swap
    ].sort());
    // the day-end never resolves a clash: the ONE mention in the job file is the reminder's read, above
    expect((code(src("src/services/jobs.service.ts")).match(/slotYielded/g) ?? []).length).toBe(2);
    expect(code(src("src/services/jobs.service.ts"))).not.toContain("slotYieldedAt: null");
  });
});

// ═══════════════════ §4 the CLASH — derived once ═══════════════════

describe("🔴 §4 the clash is DERIVED, in one place", () => {
  test("by value: yielded + a kid ⇒ clash; either half alone ⇒ not", () => {
    const at = new Date("2026-10-01T08:00:00Z");
    expect(isGroupSlotClash({ slotYieldedAt: at, liveSeats: 1 })).toBe(true);
    expect(isGroupSlotClash({ slotYieldedAt: at, liveSeats: 3 })).toBe(true);
    expect(isGroupSlotClash({ slotYieldedAt: at, liveSeats: 0 })).toBe(false);
    expect(isGroupSlotClash({ slotYieldedAt: at })).toBe(false);
    expect(isGroupSlotClash({ slotYieldedAt: null, liveSeats: 2 })).toBe(false);
    expect(isGroupSlotClash({})).toBe(false);
  });

  test("🔴 TASK-453 §4 (@Sober's ruling (c)) — when the PRIVATE is gone the card SAYS so, and it is the only difference", async () => {
    const check = ATTENTION_CHECKS.find((c) => c.key === "group_slot_clashes")!;
    const row = { booking: { id: G1, date: "2026-10-06", startTime: "15:00:00", otherTitle: "Skate Kids", bookingType: "GROUP", slotYieldedAt: new Date() }, teacher: { nickname: "Bank" }, liveSeats: 2 };
    const gone = await check.run({ load: { yieldedGroupDates: async () => [{ ...row, privateLive: false }] } } as any);
    expect(gone).toEqual({ count: 1, items: [{ id: G1, label: "2026-10-06 15:00 · Skate Kids · Bank · 2 · PRIVATE CANCELLED" }] });
    // 🚫 and the card is STILL listed — nothing auto-resolves, which is the whole of ruling (c)
    expect(gone.count).toBe(1);
    expect(code(src("src/services/scheduler.service.ts"))).not.toMatch(/cancel[\s\S]{0,200}slotYieldedAt: null/);
  });

  test("🚫 no second spelling: every reader calls `isGroupSlotClash`, nobody re-writes the two halves", () => {
    const readers = ["src/db/mappers.ts", "src/lib/attention.ts"];
    for (const f of readers) expect({ f, calls: code(src(f)).includes("isGroupSlotClash(") }).toEqual({ f, calls: true });
    for (const f of [...readers, "src/services/scheduler.service.ts"]) {
      expect({ f, rewrites: /slotYieldedAt\s*!=\s*null\s*&&/.test(code(src(f))) }).toEqual({ f, rewrites: false });
    }
  });

  test("the attention card, by value through a fake ctx — a yielded date with a kid is listed, an empty one is not", async () => {
    const check = ATTENTION_CHECKS.find((c) => c.key === "group_slot_clashes")!;
    expect(check.titleKey).toBe("att_group_slot_clashes");
    expect(check.namesPeopleInDigest).toBeUndefined(); // 🚫 it names a CLASS and a COACH, never a child
    const rows = [
      { booking: { id: G1, date: "2026-10-06", startTime: "15:00:00", otherTitle: "Skate Kids", bookingType: "GROUP", slotYieldedAt: new Date() }, teacher: { nickname: "Bank" }, liveSeats: 2, privateLive: true },
      { booking: { id: uuidFor("g-2"), date: "2026-10-07", startTime: "16:00:00", otherTitle: "Empty", bookingType: "GROUP", slotYieldedAt: new Date() }, teacher: { nickname: "Ann" }, liveSeats: 0, privateLive: true },
    ];
    const out = await check.run({ load: { yieldedGroupDates: async () => rows } } as any);
    expect(out).toEqual({ count: 1, items: [{ id: G1, label: "2026-10-06 15:00 · Skate Kids · Bank · 2" }] });
  });
});

// ═══════════════════ §5 the two resolutions ═══════════════════

describe("🔴 §5 the two resolutions — one tx each, and the re-check that leaves the clash STANDING", () => {
  const MOVE = region(SCHED, "export async function resolveClashByMovingPrivate(", "\n}\n");
  const SWAP = region(SCHED, "export async function resolveClashBySwappingCoach(", "\n}\n");

  test("① the PRIVATE moves, then the group un-yields — in that order, in ONE transaction", () => {
    expect(MOVE).toContain("await db.transaction(async (tx) => {");
    expect(MOVE.indexOf("await tx.update(bookings).set(patch)")).toBeLessThan(MOVE.indexOf("set({ slotYieldedAt: null })"));
    expect(MOVE).toContain("await assertBookingCourseWritable(db, id);"); // TASK-185's rule through a new door
    expect(MOVE).toContain("if (isDelivered(current.status))");
  });

  test("🔑 the re-check IS the unique index: a `23505` on the un-yield refuses, and the whole tx rolls back ⇒ the clash stands", () => {
    const unyield = MOVE.slice(MOVE.indexOf("set({ slotYieldedAt: null })"));
    expect(unyield).toContain(`if (pgErrorCode(e) === "23505") throw conflict("SLOT_TAKEN"`);
    expect(unyield).toContain("กลุ่มจึงยังทับอยู่"); // the sentence says the clash is still there
    expect(unyield).toContain("describeSlotClash(group.teacherId, group.date, group.startTime)"); // it NAMES the new holder
    // 🔴 and the refusal is not swallowed: the update sits DIRECTLY in the try whose catch re-throws it. A
    // `catch {}` around it would leave the group having lost its hour with nobody told — the one shape that
    // turns this whole design back into the silence it replaced.
    expect(MOVE).toContain(`try {\n      await tx.update(bookings).set({ slotYieldedAt: null })`);
    expect(MOVE).not.toContain("catch {");
    // 🚫 no hand-written "is it still free?" read — a second predicate is what drifts from the index
    expect(MOVE).not.toContain("slotHolderWhere");
  });

  test("② the GROUP takes the new coach and un-yields in ONE update; its seats follow; the PRIVATE is untouched", () => {
    expect(SWAP).toContain("set({ teacherId: input.teacherId, slotYieldedAt: null })");
    expect(SWAP).toContain("await tx.update(bookings).set({ teacherId: input.teacherId }).where(and(eq(bookings.groupId, group.id), inArray(bookings.status, [...COURSE_LIVE_STATUSES])));");
    expect(SWAP).toContain("await assertTeacherBookable(tx, input.teacherId, group.date);");
    expect(SWAP).toContain(`if (pgErrorCode(e) === "23505") throw conflict("SLOT_TAKEN", await describeSlotClash(input.teacherId, group.date, group.startTime));`);
    expect(SWAP).not.toContain("bookings.id, id"); // it never writes the Private's row
  });

  test("both refuse a row that is not in a clash at all, with one sentence", () => {
    for (const F of [MOVE, SWAP]) expect(F).toContain("throw NOT_IN_CLASH();");
    expect(SCHED).toContain(`const NOT_IN_CLASH = () => conflict("NOT_IN_CLASH", "คาบนี้ไม่ได้ทับกับกลุ่มที่รอแก้");`);
  });

  test("the routes exist, are validated, and are the calendar's own act", () => {
    const API = code(src("src/routes/api.ts"));
    expect(API).toContain(`.post("/bookings/:id/resolve-clash/move", zValidator("json", v.resolveClashMove)`);
    expect(API).toContain(`.post("/bookings/:id/resolve-clash/swap-coach", zValidator("json", v.resolveClashSwapCoach)`);
    expect(ROUTE_ACCESS["POST /bookings/:id/resolve-clash/move"]).toEqual({ menus: ["menu:calendar", "menu:bookings"], action: "action:calendar.booking-edit" });
    expect(ROUTE_ACCESS["POST /bookings/:id/resolve-clash/swap-coach"]).toEqual({ menus: ["menu:calendar", "menu:bookings"], action: "action:calendar.booking-edit" });
    expect(v.resolveClashMove.safeParse({}).success).toBe(false); // at least one of the three
    expect(v.resolveClashMove.safeParse({ date: "2026-10-13" }).success).toBe(true);
    expect(v.resolveClashSwapCoach.safeParse({ teacherId: T2 }).success).toBe(true);
    expect(v.resolveClashSwapCoach.safeParse({}).success).toBe(false);
  });

  test("🚫 nothing resolves a clash on its own — no auto-resolution anywhere, and the day-end least of all", () => {
    expect(code(src("src/services/jobs.service.ts"))).not.toContain("resolveClash");
    expect(SCHED.match(/set\(\{ slotYieldedAt: null \}\)|slotYieldedAt: null \}\)/g)!.length).toBe(2); // exactly the two resolutions
  });
});

// ═══════════════════ §6 the coach messages — 📖 GATED ═══════════════════

describe("🟢 §6 the clash note — the owner approved the bytes (TASK-453b), so both messages print them", () => {
  const row = { date: "2026-10-06", startTime: "15:00", endTime: "16:00", studentName: null, title: "Skate Kids", bookingType: "GROUP", coach: "Bank", seats: [{ studentName: "Ploy" }], headCount: null };

  test("the two bytes live in ONE place and they differ — each follows its own message's language rule", () => {
    expect(CLASH_NOTE_DAILY).toBe("⚠️ CLASH : awaiting admin");
    expect(CLASH_NOTE_WEEKLY).toBe("⚠️ CLASH — awaiting admin");
    // 🔴 EN in BOTH, and the reason is the existing rule: the daily's appended lines print with `TEMPLATE_LANG`.
    expect(code(src("src/lib/line-message-fields.ts"))).toContain(`export const TEMPLATE_LANG: Lang = "EN";`);
    expect(code(src("src/lib/line-today-schedule.ts"))).toContain(`t("ob_f_seats", TEMPLATE_LANG)`);
  });

  test("🔴 the DAILY, by value: the approved line prints on a clashing entry — English under BOTH `line_lang` values, right after `Coach`", () => {
    for (const lang of ["TH", "EN"] as const) {
      const out = renderTodaySchedule([{ ...row, clash: true } as any], lang, "teacher");
      expect({ lang, has: out.includes("⚠️ CLASH : awaiting admin") }).toEqual({ lang, has: true });
      // the note comes after `Coach` and before the roll — where a coach reads it first
      expect(out.indexOf("Bank")).toBeLessThan(out.indexOf("⚠️ CLASH"));
      expect(out.indexOf("⚠️ CLASH")).toBeLessThan(out.indexOf("Ploy"));
    }
    // 🚫 and NOT on an ordinary entry — the flag is the whole condition
    expect(renderTodaySchedule([row as any], "TH", "teacher")).not.toContain("CLASH");
  });

  test("🔴 the WEEKLY, by value: the approved suffix on the clashing line only", () => {
    const rows = [
      { date: "2026-10-06", startTime: "15:00", endTime: "16:00", program: "Skate Kids", studentName: null, clash: true },
      { date: "2026-10-07", startTime: "16:00", endTime: "17:00", program: "Freeskate", studentName: "Aiwa", clash: false },
    ];
    expect(renderWeeklySchedule(rows)).toContain("06-10-2026 · 15:00-16:00 · Skate Kids ⚠️ CLASH — awaiting admin");
    expect(renderWeeklySchedule(rows)).toContain("07-10-2026 · 16:00-17:00 · Freeskate / Aiwa\n");
    expect(renderWeeklySchedule([rows[1]!])).not.toContain("CLASH");
  });

  test("🔑 BOTH classes carry it, and the PARENT never does — the derivation is keyed on the coach-HOUR", async () => {
    const { groupReminders } = await import("./daily-reminder");
    const at = new Date("2026-10-01T08:00:00Z");
    const base = { date: "2026-10-06", startTime: "15:00:00", status: "CONFIRMED", teacherId: T1, teacherLineUserId: "U1", studentId: null, studentName: "-", subjectName: null };
    const groups = groupReminders([
      { ...base, id: G1, bookingType: "GROUP", title: "Skate Kids", studentName: "Skate Kids", slotYieldedAt: at, seats: [{ studentName: "Ploy" }] },
      { ...base, id: S1, bookingType: "COURSE_PACKAGE", studentId: S1, studentName: "Aiwa", parentId: "p1", parentLineUserId: "P1", parentLineUserIds: ["P1"] },
      // 🔑 the SAME coach, the SAME day, a DIFFERENT hour — the note is keyed on the coach-HOUR, so this one is clean.
      // (Without the hour in the key, a coach with one clash would read as if their whole day were disputed.)
      { ...base, id: uuidFor("s-2"), startTime: "16:00:00", bookingType: "COURSE_PACKAGE", studentId: uuidFor("s-2"), studentName: "Nine" },
    ] as any);
    const coach = groups.find((g) => g.recipientType === "teacher")!;
    expect(coach.rows.map((r: any) => [r.studentName, r.clash ?? false])).toEqual([["Skate Kids", true], ["Aiwa", true], ["Nine", false]]); // BOTH, and only those two
    expect(renderTodaySchedule(coach.rows as any, "EN", "teacher").match(/CLASH/g) ?? []).toHaveLength(2);
    const parent = groups.find((g) => g.recipientType === "parent");
    expect(parent?.rows.every((r: any) => !r.clash)).toBe(true); // 🚫 a family is never told their child's class is disputed
    expect(renderTodaySchedule(parent!.rows as any, "TH", "parent")).not.toContain("CLASH");
  });

  test("🚫 an empty group date is not a clash, so nothing prints — the note only ever follows a real one", async () => {
    const { groupReminders } = await import("./daily-reminder");
    const base = { date: "2026-10-06", startTime: "15:00:00", status: "CONFIRMED", teacherId: T1, teacherLineUserId: "U1", studentId: null, studentName: "-", subjectName: null };
    const groups = groupReminders([{ ...base, id: G1, bookingType: "GROUP", title: "Skate Kids", studentName: "Skate Kids", slotYieldedAt: new Date(), seats: [] }] as any);
    expect(groups[0]!.rows.every((r: any) => !r.clash)).toBe(true);
  });

  test("📌 a yielded row is a NORMAL live row — it was never filtered off either schedule, and the note is all that was added", () => {
    // The yield is not a status and not a filter: the row keeps `CONFIRMED`, so every schedule that listed it still does.
    const Y = region(SCHED, "async function yieldEmptyGroupSlot(", "\n}\n");
    expect(Y).not.toContain("status:");
    // 🔑 ONE derivation feeds both messages — neither renderer re-spells what a clash is
    for (const f of ["src/lib/daily-reminder.ts", "src/lib/weekly-digest.ts"]) {
      expect({ f, uses: code(src(f)).includes("clashingSlotKeys(") }).toEqual({ f, uses: true });
      expect({ f, rewrites: /slotYieldedAt\s*!=\s*null/.test(code(src(f))) }).toEqual({ f, rewrites: false });
    }
  });
});

// ═══════════════════ §7 the three small gaps ═══════════════════

describe("🔴 §7 the small gaps — uncapped · closed · one-session extra coach", () => {
  test("`head_count` NULL = UNCAPPED: the cap check returns early, and NOTHING else about the number changed", () => {
    const F = region(SCHED, "async function assertSeatFree(", "\n}\n");
    expect(F).toContain("if (row?.headCount == null) return;");
    expect(F.indexOf("if (row?.headCount == null) return;")).toBeLessThan(F.indexOf("GROUP_FULL"));
    expect(v.groupSeries.safeParse({ name: "G", groupKind: "GROUP", seatCap: null, teacherId: T1, startTime: "15:00", dates: ["2026-10-06"] }).success).toBe(true);
    expect(v.groupSeries.safeParse({ name: "G", groupKind: "GROUP", seatCap: 1, teacherId: T1, startTime: "15:00", dates: ["2026-10-06"] }).success).toBe(false); // the 2..12 rule for a NUMBER stands
    // the coach's `Seats : n/cap` line already handled a missing cap and is deliberately untouched
    expect(renderTodaySchedule([{ date: "2026-10-06", startTime: "15:00", endTime: "16:00", title: "Skate Kids", bookingType: "GROUP", coach: "Bank", seats: [{ studentName: "Ploy" }, { studentName: "Pun" }], headCount: null } as any], "EN", "teacher")).toContain("Seats : 2/2");
  });

  test("CLOSED: no new enrolment, no new date — and every existing row is untouched", () => {
    const OS = code(src("src/services/other-series.service.ts"));
    expect(SCHED).toContain("await assertGroupSeriesOpen(tx, groupKey); // TASK-453");
    expect(region(SCHED, "export async function assertGroupSeriesOpen(", "\n}\n")).toContain("nn(b.groupClosedAt)");
    expect(OS).toContain("if ((t as any).groupClosedAt) throw GROUP_SERIES_CLOSED();");
    const C = region(OS, "export async function closeGroupSeries(", "\n}\n");
    expect(C).toContain("set({ groupClosedAt: now })");
    expect(C).toContain("if (rows.some((r: any) => r.groupClosedAt)) return { closed: 0, alreadyClosed: true };"); // idempotent
    expect(C).not.toContain("CANCELLED"); // 🚫 closing does not end anything that already exists
    expect(ROUTE_ACCESS["POST /group-series/:key/close"]).toEqual({ menus: ["menu:calendar"], action: "action:calendar.group-series" });
  });

  test("`onDate`: ONE session gains the extra coach — the same live filter, restated as one date; `fromDate` + `onDate` together ⇒ 400", () => {
    const A = region(code(src("src/services/other-series.service.ts")), "export async function addTeacherToOtherSeries(", "\n}\n");
    expect(A).toContain("const targets = input.onDate ? rows.filter((r) => isLive(r) && r.date === input.onDate) : seriesRowsFrom(rows, input.fromDate ?? today());");
    expect(v.otherSeriesAddTeacher.safeParse({ teacherId: T1, onDate: "2026-10-06" }).success).toBe(true);
    expect(v.otherSeriesAddTeacher.safeParse({ teacherId: T1, fromDate: "2026-10-06", onDate: "2026-10-06" }).success).toBe(false);
  });
});

// ═══════════════════ §8 what the grid says ═══════════════════

describe("🔴 §8 the DTO — the yield, the close, and the clash, on the group's own object", () => {
  test("by value: a yielded row with a live seat says `clash: true`; with only a cancelled seat it does not", async () => {
    const { toBookingDTO } = await import("../db/mappers");
    const at = new Date("2026-10-01T08:00:00Z");
    const base = { id: G1, date: "2026-10-06", startTime: "15:00:00", endTime: "16:00:00", bookingType: "GROUP", status: "CONFIRMED", teacher: { id: T1, name: "Bank", nickname: "Bank" }, otherTitle: "Skate Kids", otherKind: "GROUP", headCount: null, groupKey: uuidFor("k-1"), student: null, subject: null };
    const live: any = toBookingDTO({ ...base, slotYieldedAt: at, seats: [{ id: S1, studentId: S1, status: "CONFIRMED", courseId: null, student: { nickname: "Ploy" } }] } as any);
    expect({ clash: live.group.clash, yielded: live.group.yieldedAt, cap: live.group.seatCap }).toEqual({ clash: true, yielded: at.toISOString(), cap: null });
    const dead: any = toBookingDTO({ ...base, slotYieldedAt: at, seats: [{ id: S1, studentId: S1, status: "CANCELLED", courseId: null, student: { nickname: "Ploy" } }] } as any);
    expect(dead.group.clash).toBe(false);
    const closed: any = toBookingDTO({ ...base, groupClosedAt: at, seats: [] } as any);
    expect({ clash: closed.group.clash, closedAt: closed.group.closedAt }).toEqual({ clash: false, closedAt: at.toISOString() });
  });
});
