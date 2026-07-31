// Route-level shape test for the people endpoints (TASK-048). The service is stubbed so the contract the
// `/scheduler/people` screen consumes — parents with their students EMBEDDED, and suspend/unsuspend being
// reversible — is verified without a DB (the queries themselves are deploy smoke).
import { describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.SKIP_AUTH = "true";

const PARENT = {
  id: "p1",
  name: "คุณแม่เอ",
  phone: "0812345678",
  province: "กรุงเทพมหานคร",
  suspendedAt: null as Date | null,
  students: [
    { id: "s1", name: "น้องเอ", nickname: "เอ", gender: "female", birthDate: "2018-05-02", nationality: "TH" },
  ],
};

mock.module("../services/parent.service", () => ({
  listParents: async (q?: string) => ({
    parents: q && q !== "เอ" ? [] : [PARENT],
    total: q && q !== "เอ" ? 0 : 1,
  }),
  getParent: async () => PARENT,
  createParent: async () => ({ ...PARENT, students: [] }),
  updateParent: async () => PARENT,
  createStudentForParent: async () => ({ student: PARENT.students[0], count: 1 }),
  updateStudent: async () => PARENT.students[0],
  setParentSuspended: async (_id: string, suspended: boolean) => ({
    ...PARENT,
    suspendedAt: suspended ? new Date("2026-08-01T00:00:00Z") : null,
  }),
  // named exports the api route module pulls in transitively
  searchStudents: async () => [],
  createStudent: async () => ({}),
}));

const { api } = await import("./api");

describe("GET /parents — parents with students embedded (TASK-048)", () => {
  test("returns the household with its students nested (what the screen renders)", async () => {
    const res = await api.request("/parents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.parents[0].phone).toBe("0812345678");
    expect(body.parents[0].province).toBe("กรุงเทพมหานคร");
    expect(body.parents[0].students[0].name).toBe("น้องเอ"); // embedded, not a second round-trip
    expect(body.parents[0].students[0].birthDate).toBe("2018-05-02"); // DOB stored; age derived at read time
  });

  test("search by a child's name reaches the service (staff search across the household)", async () => {
    const hit = (await (await api.request("/parents?q=เอ")).json()) as any;
    expect(hit.parents).toHaveLength(1);
    const miss = (await (await api.request("/parents?q=zzz")).json()) as any;
    expect(miss.parents).toHaveLength(0);
  });
});

describe("suspend / unsuspend are reversible (TASK-048)", () => {
  test("suspend sets suspendedAt, unsuspend clears it — never a delete", async () => {
    const s = (await (await api.request("/parents/p1/suspend", { method: "POST" })).json()) as any;
    expect(s.suspendedAt).toBeTruthy();
    expect(s.students).toHaveLength(1); // students & history survive

    const u = (await (await api.request("/parents/p1/unsuspend", { method: "POST" })).json()) as any;
    expect(u.suspendedAt).toBeNull();
  });
});
