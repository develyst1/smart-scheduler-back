// SPEC-073 / TASK-258 (REQ-083) — undo an attendance: entitlement back, revenue reversed, no leave quota spent.
//
// 🔴 The one that could break every booking in the system is **generation 0**. Rows already in the ledger carry
// the un-suffixed `rev:<bookingId>`; if generation 0 produced anything else, every historical booking would read
// as unposted and the next day-end would post it a second time. It is asserted against the literal, first.
//
// The behavioural half of AC-1…AC-8 needs a database (statuses, counters, movements). What is proven here is
// what can be proven without one: the KEY ALGEBRA, and the wiring of the branch that reverses. Labelled, so the
// second kind is never mistaken for the first (@Sober, TASK-248 §4).
import { describe, expect, test } from "bun:test";
import { readSrc } from "./read-src";
import { discountKey, revKey, revUndoKey } from "./sale-post";

const POST = readSrc(await Bun.file(new URL("./sale-post.ts", import.meta.url)).text());
const SCHED = readSrc(await Bun.file(new URL("../services/scheduler.service.ts", import.meta.url)).text());
const JOBS = readSrc(await Bun.file(new URL("../services/jobs.service.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const fn = (src: string, decl: string) => {
  const rest = code(src).slice(code(src).indexOf(decl));
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};
const B = "3f1c2b7e-0000-4000-8000-000000000001";

describe("🔴 generation 0 is the UN-SUFFIXED key — the line that could double-post every historical booking", () => {
  test("`revKey(id, 0)` is byte-for-byte `rev:<bookingId>`", () => {
    expect(revKey(B, 0)).toBe(`rev:${B}`);
    expect(revKey(B)).toBe(`rev:${B}`); // …and the default is generation 0, so an un-updated caller is safe
  });

  test("the sibling keys follow the same rule, so a pair always reads as a pair", () => {
    expect(revUndoKey(B, 0)).toBe(`rev-undo:${B}`);
    expect(discountKey(B, 0)).toBe(`discount:${B}`); // the string `discount-plan.ts` has always written
  });

  test("later generations are suffixed, and are distinct from every earlier one", () => {
    expect(revKey(B, 1)).toBe(`rev:${B}#1`);
    expect(revKey(B, 2)).toBe(`rev:${B}#2`);
    expect(new Set([revKey(B, 0), revKey(B, 1), revKey(B, 2)]).size).toBe(3);
  });

  test("🔑 a reversal can never collide with a posting — different prefixes, same generation", () => {
    expect(revUndoKey(B, 1)).not.toBe(revKey(B, 1));
    expect(revUndoKey(B, 1).startsWith("rev-undo:")).toBe(true);
    // …and `rev-undo:` is not matched by a `rev:<id>%` scan, which is what makes the generation count correct.
    expect(revUndoKey(B, 1).startsWith(`rev:${B}`)).toBe(false);
  });

  test("AC-7 vs AC-8, stated as the algebra that satisfies both", () => {
    // AC-7: the SAME undo, run twice, is the same key ⇒ the second write is skipped.
    expect(revUndoKey(B, 0)).toBe(revUndoKey(B, 0));
    // AC-8: the NEXT posting is a different key ⇒ it writes. One key could not do both; a generation can.
    expect(revKey(B, 1)).not.toBe(revKey(B, 0));
  });
});

describe("🔴 the generation is DERIVED from the ledger — no column, no second source of truth", () => {
  const gen = fn(POST, "export async function revGeneration");

  test("it counts this booking's `rev:` movements, including the un-suffixed one", () => {
    expect(gen).toContain("eq(boMovement.idempotencyKey, revKey(bookingId, 0))");
    expect(gen).toContain("like(boMovement.idempotencyKey, `rev:${bookingId}#%`)");
    expect(gen).toContain("or(");
  });

  test("🚫 nothing stores it — a counter column would be a second answer to what the ledger already knows", () => {
    // The generation is read, never written: no insert or update in this file sets one, and the count comes
    // from the movements themselves. (The task added no migration — 32 `drizzle/*.sql` = 32 journal tags.)
    expect(gen).not.toContain("insert(");
    expect(gen).not.toContain("update(");
    expect(gen).toContain("db\n    .select(");
  });

  test("the LIVE posting is generation − 1, and 0 when nothing was ever posted", () => {
    const posted = fn(POST, "export async function postedGeneration");
    expect(posted).toContain("Math.max(0, (await revGeneration(bookingId)) - 1)");
  });
});

describe("🔴 AC-5 / AC-6 / AC-7 — the reversal, asked of the ledger and not of a type list", () => {
  const rev = fn(POST, "export async function reverseBookingSale");

  test("AC-5 — a NEW movement of −฿X; the original is never edited and never deleted (AC-9)", () => {
    expect(rev).toContain("db.insert(boMovement)");
    expect(rev).not.toContain("db.update(boMovement)");
    expect(rev).not.toContain("db.delete(boMovement)");
    expect(rev).toContain("valueMinor: -netMinor");
    expect(rev).toContain("qty: -sale.qty"); // the mirror of the sale: one unit back IN
  });

  test("AC-6 — posted nothing ⇒ NO movement at all, and the reason is in the source", () => {
    // Not a ฿0 row: that reads as "a sale of nothing happened", which is a different and false claim. And the
    // condition is the ledger's own answer to *"did THIS attendance post?"*, never a booking-type list — a
    // course or a voucher posts at SALE time, so it simply has no `rev:` movement to find.
    expect(rev).toContain("if (!sale) return { ok: true, skipped: \"duplicate\" }");
    for (const typeList of ["COURSE_PACKAGE", "VOUCHER", "FIRST_TRIAL", "SINGLE_SESSION", "bookingType"]) {
      expect(rev).not.toContain(typeList);
    }
  });

  test("AC-7 — the reversal carries its own key, and a second run writes nothing", () => {
    expect(rev).toContain("idempotencyKey: revUndoKey(bookingId, generation)");
    expect(rev).toContain('if (pgErrorCode(e) === "23505") return { ok: true, skipped: "duplicate" }');
  });

  test("⚠️ it reverses the NET — the sale plus its discount, which is what was actually taken", () => {
    // Reversing the list price alone would refund money nobody was charged, and it is the same number
    // `postedSaleForBooking` shows the admin before they confirm.
    expect(rev).toContain("const netMinor = sale.valueMinor + (discount?.valueMinor ?? 0)");
    expect(rev).toContain("if (netMinor === 0)"); // a fully discounted session has nothing to give back
  });

  test("the ledger wording is REQ-083's own", () => {
    expect(rev).toContain('reason: "REVERSAL — attendance undone"');
  });
});

describe("WIRING — the undo branch, beside the attend it reverses", () => {
  const branch = (() => {
    const c = code(SCHED);
    const start = c.indexOf('} else if (action === "sick-leave" && current.status === "ATTENDED")');
    return c.slice(start, c.indexOf('} else if (action === "sick-leave" && current.status === "SICK_LEAVE")'));
  })();

  test("AC-1 — it is its own branch, and it does NOT run the advance-notice check", () => {
    // That rule asks whether leave was declared before the class; this session has already happened, so the
    // answer is always "too late" and every correction would be refused.
    expect(branch).toContain('status: "SICK_LEAVE"');
    expect(branch).not.toContain("hasEnoughLeaveNotice");
    expect(branch).not.toContain("LEAVE_NOTICE_TOO_LATE");
  });

  test("AC-2 — the entitlement goes back, on both kinds, floored at zero", () => {
    expect(branch).toContain("usedSessions: Math.max(0, current.course.usedSessions - 1)");
    expect(branch).toContain("usedHours: Math.max(0, current.voucher.usedHours - 1)");
    // 🚫 `priorSessions` is deliberately not derived from these, so a decrement cannot disturb it.
    expect(branch).not.toContain("priorSessions");
  });

  test("🔴 AC-4 — no leave quota, and the guard is the STATUS, not a request flag", () => {
    // Otherwise an admin could spend or save a family's allowance by choosing a button.
    expect(branch).not.toContain("leaveUsed");
    expect(branch).not.toContain("canTakeLeave");
    expect(branch).toContain('current.status === "ATTENDED"');
    expect(branch).not.toContain("override");
    expect(branch).not.toContain("reasonCode");
  });

  test("📌 and no auto-EXTENDED make-up — the entitlement itself came back", () => {
    // A real leave creates one because the family spent an entitlement on a session they missed. Here the
    // entitlement was returned, so a make-up would give them the same session twice.
    expect(branch).not.toContain('status: "EXTENDED"');
    expect(branch).not.toContain("findFreeExtensionDate");
  });

  test("AC-5 — the money reversal is called from the branch, best-effort like every other posting", () => {
    expect(branch).toContain("await reverseBookingSale(id)");
  });

  test("🚫 TASK-254's `COURSE DEDUCTION` does NOT fire on an undo", () => {
    // That message is enqueued inside the branch that WRITES a deduction; this branch reverses one. A
    // "session returned" message is @Porter's to decide, not something to slip in here.
    expect(branch).not.toContain("notifyCourseDeduction");
  });

  test("AC-10 — the edit/move guard is untouched", () => {
    // `C-24` was only ever about cancel/undo; nobody asked for attended sessions to become freely editable.
    expect(code(SCHED).match(/if \(isDelivered\(b\.status\)\) throw conflict\("SESSION_DELIVERED"/g)).toHaveLength(2);
    expect(code(SCHED)).toContain('if (isDelivered(current.status)) throw conflict("SESSION_DELIVERED"');
  });
});

describe("AC-8 — the day-end posts again after a correction", () => {
  test("both posting sites take the generation, so neither can silently skip", () => {
    expect(code(JOBS)).toContain("idempotencyKey: revKey(b.id, generation)");
    expect(code(JOBS)).toContain("const idempotencyKey = revKey(b.id, await revGeneration(b.id))");
  });

  test("🔑 …and the DISCOUNT follows its sale's generation", () => {
    // Without this the second posting writes the list price and skips the discount (its fixed key is taken),
    // and the books over-charge the family by exactly the discount — a silent money error, which is the class
    // of defect this whole task is about.
    expect(code(JOBS)).toContain("discountKey: discountKey(b.id, generation)");
    expect(code(POST)).toContain("...(opts.discountKey ? { idempotencyKey: opts.discountKey } : {})");
  });

  test("a first posting is unchanged — the default leaves `discount:<refId>` exactly as it was", () => {
    expect(discountKey(B)).toBe(`discount:${B}`);
  });
});
