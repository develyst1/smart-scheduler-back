// TASK-467 — a READ-ONLY window into `job_runs`. TASK-462 moved a job's outcome there and gave the owner no way to read
// it; "open the database" is not an answer to "did last night's job finish?". This pins the window: the secret gate,
// newest first, the cap, and — the point of it all — that an UNFINISHED run reads as unfinished.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const { db } = await import("../db");
const rootApp = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
const get = (path: string, secret?: string) =>
  rootApp.fetch(new Request(`http://localhost${path}`, { headers: secret ? { "x-internal-secret": secret } : {} }));

/** Fake the select chain, RECORDING what the route asked the database for — the order and the limit are the claims. */
const fakeRuns = (rows: any[]) => {
  const asked: { where?: string; orderBy?: string; limit?: number; writes: number } = { writes: 0 };
  const d = new PgDialect();
  spies.push(spyOn(db, "select").mockImplementation((() => ({
    from: () => ({
      where: (w: any) => {
        asked.where = w ? d.sqlToQuery(w).sql : "(none)";
        return {
          orderBy: (o: any) => {
            asked.orderBy = d.sqlToQuery(o).sql;
            return { limit: async (n: number) => { asked.limit = n; return rows.slice(0, n); } };
          },
        };
      },
    }),
  })) as any));
  for (const w of ["insert", "update", "delete"] as const) spies.push(spyOn(db, w).mockImplementation((() => { asked.writes++; throw new Error("a read-only view wrote"); }) as any));
  return asked;
};

const T0 = new Date("2026-09-25T20:30:00Z"), T1 = new Date("2026-09-25T20:31:04Z");
const RUNS = [
  { id: "r-2", job: "group-series-extender", status: "running", startedAt: T1, finishedAt: null, summary: { apply: true } },
  { id: "r-1", job: "end-of-day", status: "success", startedAt: T0, finishedAt: T0, summary: { marked: 3 } },
];

describe("🔑 TASK-467 — `GET /internal/jobs/job-runs`, by value through the root app", () => {
  test("the SAME secret as the triggers: none ⇒ 401, and the database is never asked", async () => {
    process.env.INTERNAL_JOB_SECRET = "s467";
    const asked = fakeRuns(RUNS);
    expect((await get("/internal/jobs/job-runs")).status).toBe(401);
    expect(asked.orderBy).toBeUndefined();
  });

  test("🔑 newest FIRST, default 20, and an UNFINISHED run reads as exactly that — `running`, `finishedAt: null`", async () => {
    process.env.INTERNAL_JOB_SECRET = "s467";
    const asked = fakeRuns(RUNS);
    const res = await get("/internal/jobs/job-runs", "s467");
    expect(res.status).toBe(200);
    expect(asked.orderBy).toBe(`"job_runs"."started_at" desc`);
    expect(asked.limit).toBe(20);
    const body: any = await res.json();
    expect(body.runs[0]).toEqual({ job: "group-series-extender", runId: "r-2", status: "running", startedAt: T1.toISOString(), finishedAt: null, summary: { apply: true } });
    expect(body.runs[1].finishedAt).toBe(T0.toISOString());
    expect(asked.writes).toBe(0); // 🚫 a window, not a console
  });

  test("filter by job, and the CAP: 100 is honoured, 101 is refused before the database", async () => {
    process.env.INTERNAL_JOB_SECRET = "s467";
    const asked = fakeRuns(RUNS);
    await get("/internal/jobs/job-runs?job=end-of-day&limit=100", "s467");
    expect(asked.where).toContain(`"job_runs"."job" = $1`);
    expect(asked.limit).toBe(100);
    const refused = await get("/internal/jobs/job-runs?limit=101", "s467");
    expect(refused.status).toBe(400);
  });

  test("the trigger prints a run with no finish as `-- NOT FINISHED --`, never a blank that reads like success", () => {
    const ps = readFileSync(resolve(root, "sm-jobs/job-runs.ps1"), "utf8");
    expect(/\/internal\/jobs\/([a-z0-9-]+)/.exec(ps)?.[1]).toBe("job-runs");
    expect(ps).toContain("-Method Get");
    expect(ps).toContain("'-- NOT FINISHED --'");
  });
});
