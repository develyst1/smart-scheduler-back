// TASK-607 (REQ-111 H, owner ruling §6.6) — the course history's freelance drawn/refunded rows are the coach's hour-ceiling
// ledger ⇒ only a viewer holding `action:teachers.budget-view` sees them; a linked teacher account never does; no viewer ⇒
// hidden (fail closed). Every other event keeps its count and order; `summary` is untouched. Pure + through the root app.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BUDGET_VIEW_KEY, hideLedgerRows, type Viewer } from "./budget-visibility";
import { ACTION_KEYS, MENU_KEYS } from "./permissions";
import * as sched from "../services/scheduler.service";
import { DEV_USER } from "../middleware/auth";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const C1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ALL_BUT_VIEW = [...MENU_KEYS, ...ACTION_KEYS.filter((k) => k !== BUDGET_VIEW_KEY)];
const WITH_KEY = { isSuperAdmin: false, grants: new Set<string>([...ALL_BUT_VIEW, BUDGET_VIEW_KEY]) };
const WITHOUT_KEY = { isSuperAdmin: false, grants: new Set<string>(ALL_BUT_VIEW) };
const LINKED_WITH_KEY = { isSuperAdmin: false, grants: new Set<string>([...ALL_BUT_VIEW, BUDGET_VIEW_KEY]), teacherId: T1 };

const history = () => ({
  courseId: C1,
  summary: { size: 10, usedSessions: 2, leaveUsed: 0, remaining: 8, liveEndDate: "2026-12-01" },
  events: [
    { at: "2026-10-01T10:00:00Z", kind: "scheduled", actor: null },
    { at: "2026-10-01T11:00:00Z", kind: "freelance-drawn", valueMinor: 50000, actor: null },
    { at: "2026-10-02T10:00:00Z", kind: "attended", actor: null },
    { at: "2026-10-02T11:00:00Z", kind: "freelance-refunded", valueMinor: 50000, actor: null },
    { at: "2026-10-03T10:00:00Z", kind: "cancelled", actor: null },
  ],
});
const LEDGER = ["freelance-drawn", "freelance-refunded"];
const kinds = (h: { events: Array<{ kind: string }> }) => h.events.map((e) => e.kind);
const NON_LEDGER = kinds(history()).filter((k) => !LEDGER.includes(k));

describe("TASK-607 — hideLedgerRows (pure)", () => {
  test("with the key ⇒ the ledger rows are present, the history unchanged", () => {
    expect(hideLedgerRows(WITH_KEY, history())).toEqual(history());
  });
  const hidden: Array<[string, Viewer]> = [
    ["without the key", WITHOUT_KEY],
    ["a linked teacher account that HOLDS the key", LINKED_WITH_KEY],
    ["no viewer (null)", null],
  ];
  for (const [name, viewer] of hidden)
    test(`${name} ⇒ the ledger rows are absent; every other event unchanged in count and order; summary untouched`, () => {
      const out = hideLedgerRows(viewer, history());
      expect(kinds(out)).toEqual(NON_LEDGER);
      expect(out.events).toEqual(history().events.filter((e) => !LEDGER.includes(e.kind)));
      expect(out.summary).toEqual(history().summary);
      expect(out.courseId).toBe(C1);
    });
});

describe("TASK-607 — GET /api/courses/:id/history through the ROOT app", () => {
  const saved = { isSuperAdmin: DEV_USER.isSuperAdmin, grants: DEV_USER.grants, teacherId: DEV_USER.teacherId };
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; Object.assign(DEV_USER as any, saved); });
  const call = (u: { isSuperAdmin: boolean; grants: Set<string>; teacherId?: string }) => {
    process.env.SKIP_AUTH = "true";
    Object.assign(DEV_USER as any, { isSuperAdmin: u.isSuperAdmin, grants: u.grants, teacherId: u.teacherId ?? null });
    spies.push(spyOn(sched, "getCourseHistory").mockImplementation((async () => history()) as any));
    return rootApp.fetch(new Request(`http://localhost/api/courses/${C1}/history`));
  };
  const asUser = async (u: Parameters<typeof call>[0]) => {
    const res = await call(u);
    expect(res.status).toBe(200);
    return (await res.json()) as ReturnType<typeof history>;
  };
  test("with the key ⇒ rows present", async () => {
    expect(kinds(await asUser(WITH_KEY))).toEqual(kinds(history()));
  });
  test("without the key ⇒ rows absent, the rest in order", async () => {
    expect(kinds(await asUser(WITHOUT_KEY))).toEqual(NON_LEDGER);
  });
  test("a linked teacher account holding the key ⇒ refused at the door (403 SCOPE_TEACHER) — it never reaches the rows; the pure test above covers the filter for it", async () => {
    const res = await call(LINKED_WITH_KEY);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error?.code).toBe("SCOPE_TEACHER");
  });
});
