// Route-level dispatch tests for TASK-029 §3: the literal `/teachers/<word>` PATCH routes must win over
// the param route `/teachers/:id`. Previously `PATCH /teachers/availability` matched `/teachers/:id` with
// id="availability" → updateTeacher("availability") → Postgres 22P02 (invalid uuid) → 500. A service-level
// test can't catch this (it bypasses the router), so we exercise the real Hono app via `api.request(...)`.
//
// The scheduler service is stubbed so dispatch is verified without a DB; each stub tags its own name so a
// mis-route (dispatch to updateTeacher) is visible even though both paths would return 200 under stubs.
import { describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here

mock.module("../services/scheduler.service", () => ({
  setAvailability: async () => ({ handler: "setAvailability" }),
  setTeacherTypeOrder: async () => ({ handler: "setTeacherTypeOrder" }),
  updateTeacher: async (id: string) => ({ handler: "updateTeacher", id }),
  // Named exports pulled in TRANSITIVELY by modules `./api` imports — they must exist on the stub or the ESM
  // link fails ("Export named 'x' not found"). `updateBookingStatus` ← checkin.service;
  // `getCourses`/`getVouchers`/`listFreelanceCeilings` ← attention.service (REQ-023).
  updateBookingStatus: async () => ({}),
  getCourses: async () => [],
  getVouchers: async () => [],
  listFreelanceCeilings: async () => [],
  getDailyReport: async () => ({ totalBooked: 0, attended: 0 }), // ← som-report.service (REQ-013)
}));

const { api } = await import("./api");

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
});
