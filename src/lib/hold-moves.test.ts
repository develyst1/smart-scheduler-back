// TASK-091 — 🔴 which ITEM holds a booking's freelance hour.
//
// The live bug: `moveBooking` wrote `teacherId` and never reconciled, so moving A→B left A's ceiling drawn
// for a session they don't teach AND B's never drawn — so B could be booked past their cap. Both directions
// wrong, nothing said so.
//
// `planHoldMoves` is the item-selection rule, pure so the multi-move case is provable without a database.
// It deliberately does NOT decide how many hours a status holds — that stays heldTarget/reconcileDelta.
import { describe, expect, test } from "bun:test";
import { heldTarget, planHoldMoves, reconcileDelta } from "./freelance-budget";

const A = "item-A";
const B = "item-B";
const held = (itemId: string, n: number) => ({ itemId, held: n });
/** Apply the plan to a starting state — lets a round trip be asserted on the RESULT, not the steps. */
const apply = (start: Array<{ itemId: string; held: number }>, moves: ReturnType<typeof planHoldMoves>) => {
  const m = new Map(start.map((h) => [h.itemId, h.held]));
  for (const mv of moves) m.set(mv.itemId, (m.get(mv.itemId) ?? 0) + mv.delta);
  return [...m.entries()].filter(([, h]) => h !== 0).map(([itemId, h]) => held(itemId, h));
};

describe("🔴 the bug: moving A → B", () => {
  test("🔑 releases A and draws B — in one plan", () => {
    const moves = planHoldMoves([held(A, 1)], B, 1);
    expect(moves).toEqual([
      { itemId: A, delta: -1 }, // A stops paying for a session they no longer teach
      { itemId: B, delta: 1 }, // B's cap now actually counts it
    ]);
  });

  test("🔑 the result is exactly ONE hour, on the current teacher", () => {
    expect(apply([held(A, 1)], planHoldMoves([held(A, 1)], B, 1))).toEqual([held(B, 1)]);
  });
});

describe("the cases the DoD names", () => {
  test("FREELANCE → FT/PT releases A and draws nobody", () => {
    // currentItemId === null: the new teacher has no ceiling. The release must still happen — that's why
    // it isn't paired with a draw.
    expect(planHoldMoves([held(A, 1)], null, 1)).toEqual([{ itemId: A, delta: -1 }]);
    expect(apply([held(A, 1)], planHoldMoves([held(A, 1)], null, 1))).toEqual([]);
  });

  test("FT/PT → FREELANCE draws the new one (nothing was held before)", () => {
    expect(planHoldMoves([], B, 1)).toEqual([{ itemId: B, delta: 1 }]);
  });

  test("🔑 a status that holds NOTHING still holds nothing after a move", () => {
    // PENDING / CANCELLED / NO_SHOW → target 0. A move must not create a draw the status doesn't call for.
    for (const status of ["PENDING", "CANCELLED", "NO_SHOW"]) {
      expect(heldTarget(status)).toBe(0);
      expect(planHoldMoves([], B, heldTarget(status))).toEqual([]);
      // …and if the old teacher was holding one, the move releases it and draws nothing.
      expect(apply([held(A, 1)], planHoldMoves([held(A, 1)], B, heldTarget(status)))).toEqual([]);
    }
  });

  test("🔑 no teacher change → NO adjustments, so date/time-only moves are unchanged", () => {
    expect(planHoldMoves([held(A, 1)], A, 1)).toEqual([]);
    expect(planHoldMoves([], null, 0)).toEqual([]);
  });
});

describe("🔴 the round trip — where an off-by-one hides", () => {
  test("🔑 A→B→A→B leaves exactly ONE hour, on B", () => {
    let state = [held(A, 1)]; // starts held on A
    for (const to of [B, A, B]) {
      state = apply(state, planHoldMoves(state, to, 1));
    }
    expect(state).toEqual([held(B, 1)]);
  });

  test("every intermediate step also holds exactly one hour — never zero, never two", () => {
    let state = [held(A, 1)];
    for (const to of [B, A, B, A]) {
      state = apply(state, planHoldMoves(state, to, 1));
      expect(state).toHaveLength(1);
      expect(state[0]).toEqual(held(to, 1));
    }
  });

  test("re-running the same plan is a no-op — idempotent, like the status reconcile", () => {
    const state = apply([held(A, 1)], planHoldMoves([held(A, 1)], B, 1));
    expect(planHoldMoves(state, B, 1)).toEqual([]);
  });
});

describe("messy states are cleaned up, not compounded", () => {
  test("🔴 a booking somehow held on TWO items ends up on one — the state this bug could create", () => {
    // Exactly what the old code + colliding idempotency key could leave behind.
    const moves = planHoldMoves([held(A, 1), held(B, 1)], B, 1);
    expect(moves).toEqual([{ itemId: A, delta: -1 }]);
    expect(apply([held(A, 1), held(B, 1)], moves)).toEqual([held(B, 1)]);
  });

  test("an item recorded at zero is not 'released' again — no pointless movement rows", () => {
    expect(planHoldMoves([held(A, 0)], B, 1)).toEqual([{ itemId: B, delta: 1 }]);
  });

  test("🔑 no second definition of the target — it comes from heldTarget/reconcileDelta", () => {
    // planHoldMoves is handed the target; it never computes one. Same delta the status path would produce.
    expect(planHoldMoves([], B, heldTarget("CONFIRMED"))[0]!.delta).toBe(reconcileDelta(0, "CONFIRMED"));
    expect(planHoldMoves([held(B, 1)], B, heldTarget("CANCELLED"))[0]!.delta).toBe(
      reconcileDelta(1, "CANCELLED"),
    );
  });
});
