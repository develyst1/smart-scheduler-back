// Route-level dispatch tests for TASK-029 §3: the literal `/teachers/<word>` PATCH routes must win over
// the param route `/teachers/:id`. Previously `PATCH /teachers/availability` matched `/teachers/:id` with
// id="availability" → updateTeacher("availability") → Postgres 22P02 (invalid uuid) → 500. A service-level
// test can't catch this (it bypasses the router), so we exercise the real Hono app via `api.request(...)`.
//
// ── TASK-072: narrow spies, not a whole-module stub ──────────────────────────────────────────────────
// This file used to `mock.module("../services/scheduler.service", …)`, which replaces the module in Bun's
// **process-wide** registry — so it leaked into every other test file, and an unrelated file importing a new
// export got `SyntaxError: Export named 'x' not found`. That cost five tasks (TASK-053, TASK-062, TASK-070
// and two before), each "fixed" by adding another name to a stub that had nothing to do with route dispatch.
//
// The module is now imported for real and only the **three functions these tests actually exercise** are
// spied, then restored. Consequences worth stating:
//   • nothing leaks — other files see the real module, so the long list of transitive exports this stub had
//     to carry (`getCourses`, `getVouchers`, `listFreelanceCeilings`, `listCoursesPaged`, `getDailyReport`, …)
//     is **gone**, along with the maintenance rule that you must remember to add to it;
//   • the spies are restored in `afterAll`, so they are scoped to this file's lifetime rather than the process;
//   • no DB is touched — the three spied functions are the only ones these two requests reach.
import { afterAll, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here

// Dynamic imports so the env guard above runs BEFORE the db module is evaluated (static imports hoist).
const svc = await import("../services/scheduler.service");
const { api } = await import("./api");

// Each spy tags its own name, so a mis-route (dispatch to updateTeacher) is visible even though both paths
// would return 200 under stubs.
const spies = [
  spyOn(svc, "setAvailability").mockResolvedValue({ handler: "setAvailability" } as any),
  spyOn(svc, "setTeacherTypeOrder").mockResolvedValue({ handler: "setTeacherTypeOrder" } as any),
  spyOn(svc, "updateTeacher").mockImplementation(
    async (id: string) => ({ handler: "updateTeacher", id }) as any,
  ),
];
afterAll(() => spies.forEach((s) => s.mockRestore()));

describe("teacher route ordering — literal paths beat /teachers/:id (TASK-029 §3)", () => {
  test("PATCH /teachers/availability dispatches to setAvailability, not updateTeacher('availability')", async () => {
    const res = await api.request("/teachers/availability", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "FREELANCE", active: false }),
    });
    expect(res.status).toBe(200); // was 500 (22P02) when shadowed by /teachers/:id
    expect(await res.json()).toEqual({ handler: "setAvailability" });
  });

  test("PATCH /teachers/type-order dispatches to setTeacherTypeOrder, not updateTeacher('type-order')", async () => {
    const res = await api.request("/teachers/type-order", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["FULL_TIME", "PART_TIME", "FREELANCE"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handler: "setTeacherTypeOrder" });
  });

  test("🔑 the param route still works — the guard isn't just 'literals win because :id is broken'", async () => {
    // Without this, the two tests above would pass even if `/teachers/:id` had stopped dispatching at all.
    const res = await api.request("/teachers/11111111-1111-1111-1111-111111111111", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "ครูเอ" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      handler: "updateTeacher",
      id: "11111111-1111-1111-1111-111111111111",
    });
  });
});
