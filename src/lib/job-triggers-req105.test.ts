// TASK-461 — **a scheduled job and its trigger are one deliverable.** The walk goes BOTH ways, and each direction
// is a defect we have actually paid for:
//
//  → a route with NO trigger is **undeployable**: TASK-456 shipped the rolling extender's job, route, exe and
//    package script, and the owner had nothing to copy to the box (he was hand-writing the .ps1 himself).
//  ← a trigger pointing at a route that does not exist fails **silently, on the box, every night, for ever** —
//    nobody reads a Task Scheduler history until something else goes wrong. That is DEF-5's shape with a
//    scheduler in the middle, and it is the more expensive of the two.
//
// ⚠️ This asserts the ps1's URL **path**, never its whole body: pin the effect, not the text (TASK-460's mutation Q
// — a pin that matched the presence of a line while the behaviour was gone).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readSrc } from "./read-src";

const root = resolve(import.meta.dir, "..", "..");
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const INTERNAL = code(readSrc(readFileSync(resolve(root, "src/routes/internal.ts"), "utf8")));

/** The job names the API actually serves — read from the router, never a list typed here. */
// 🔻 TASK-467 — GET too: the read-only `job-runs` window is deployed the same way, so the same both-ways rule binds it.
const routeJobs = [...INTERNAL.matchAll(/\.(?:post|get)\("\/jobs\/([a-z0-9-]+)"/g)].map((m) => m[1]!).sort();

/** The triggers the owner copies to the box, and the job each one POSTs to. */
const triggers = readdirSync(resolve(root, "sm-jobs"))
  .filter((f) => f.endsWith(".ps1"))
  .map((file) => {
    const body = readFileSync(resolve(root, "sm-jobs", file), "utf8");
    const posted = /\/internal\/jobs\/([a-z0-9-]+)/.exec(body)?.[1] ?? null;
    return { file, name: file.replace(/\.ps1$/, ""), posted, body };
  })
  .sort((a, b) => a.file.localeCompare(b.file));

describe("🔑 TASK-461 — every internal job has a trigger, and every trigger has a job", () => {
  test("→ no job is UNDEPLOYABLE: every `POST /internal/jobs/:name` has `sm-jobs/<name>.ps1`", () => {
    const have = new Set(triggers.map((t) => t.name));
    expect(routeJobs.filter((j) => !have.has(j))).toEqual([]);
    // the census, so a route added without its trigger is visible as a number too
    expect(routeJobs).toEqual(["daily-digest", "daily-reminder", "end-of-day", "group-series-extender", "job-runs", "month-reset", "weekly-teacher-digest"]);
  });

  test("← no trigger is DANGLING: every `sm-jobs/*.ps1` posts to a job the router serves, and to its OWN name", () => {
    const serves = new Set(routeJobs);
    expect(triggers.filter((t) => !t.posted || !serves.has(t.posted)).map((t) => t.file)).toEqual([]);
    // a file called X that posts to Y is the same silent failure wearing a friendlier name
    expect(triggers.filter((t) => t.posted !== t.name).map((t) => `${t.file} → ${t.posted}`)).toEqual([]);
  });

  test("📌 the new trigger is in the siblings' exact shape — same verb, same port, same header, same body", () => {
    const mine = triggers.find((t) => t.name === "group-series-extender")!;
    const sibling = triggers.find((t) => t.name === "weekly-teacher-digest")!;
    // ⚠️ the URL PATH is the assertion; the rest is compared to a SIBLING rather than to a literal typed here, so
    // the day the owner changes the port or the header in all of them, this test follows him instead of fighting him.
    expect(mine.posted).toBe("group-series-extender");
    // 🔻 TASK-462 — ONE deliberate difference: this trigger says `{"apply":true}`, because the extender's route
    // defaults to a DRY RUN. Everything else is still the sibling, byte for byte.
    expect(mine.body.replace("group-series-extender", "weekly-teacher-digest").replace(`-Body '{"apply":true}'`, `-Body "{}"`)).toBe(sibling.body);
    expect(mine.body).toContain(`-Body '{"apply":true}'`);
  });

  test("🚫 the guard on the guard: a fabricated dangling trigger and a fabricated orphan job are both caught", () => {
    const serves = new Set(routeJobs);
    expect(serves.has("a-job-we-renamed")).toBe(false); // ← the dangling direction
    const have = new Set(triggers.map((t) => t.name));
    expect(have.has("group-series-extender")).toBe(true);
    expect(have.has("a-job-with-no-trigger")).toBe(false); // → the undeployable direction
    expect(/\/internal\/jobs\/([a-z0-9-]+)/.exec("nothing here")).toBeNull(); // a ps1 that posts nowhere reads as `null`
  });
});
