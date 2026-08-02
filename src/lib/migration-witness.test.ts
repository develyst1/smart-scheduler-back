// TASK-086 — the witness→verdict logic, proven without a database.
//
// I cannot run any of this against `sid` (and `env -u DATABASE_URL` would not protect me — that's the trap
// TASK-085 found). So the part that can be wrong in an interesting way is pure and tested here.
import { describe, expect, test } from "bun:test";
import {
  SCHEDULING_WITNESSES,
  appliedTags,
  blockers,
  describeProbe,
  judge,
  type Witness,
} from "./migration-witness";

const answers = (m: Record<string, boolean | null>) => new Map(Object.entries(m));

describe("the map itself — every entry must be justifiable", () => {
  test("🔑 every journal tag has exactly one witness, and every witness has a reason", () => {
    const journal = require("../../drizzle/meta/_journal.json") as { entries: { tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    expect(SCHEDULING_WITNESSES.map((w) => w.tag)).toEqual(tags); // same set, same order
    for (const w of SCHEDULING_WITNESSES) {
      expect(w.why.length).toBeGreaterThan(40); // "a witness nobody can justify is a guess with a query on it"
      expect(describeProbe(w.probe)).not.toBe("");
    }
  });

  test("🔴 0006 is rerunnable:false — its backfill reads a column the same file drops", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0006_parents")!;
    expect(w.rerunnable).toBe(false);
    expect(w.probe.kind).toBe("column-absent"); // completion proved by the DROP, its last effect
  });

  test("🔴 0007 probes the index PREDICATE, not its existence — 0002 creates the same name", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0007_leave_overbook_slot_index")!;
    expect(w.probe).toEqual({
      kind: "index-predicate",
      index: "bookings_teacher_slot_uq",
      contains: "SICK_LEAVE",
    });
  });

  test("🔴 0002 is superseded and never re-runnable — re-running it would REGRESS 0007", () => {
    const w = SCHEDULING_WITNESSES.find((x) => x.tag === "0002_reschedule_slot_index")!;
    expect(w.probe).toEqual({ kind: "superseded-by", tag: "0007_leave_overbook_slot_index" });
    expect(w.rerunnable).toBe(false);
  });

  test("the three known-never-applied migrations are all safely re-runnable", () => {
    for (const tag of ["0015_teacher_link_requests", "0016_subjects_price_group", "0017_entitlement_source"]) {
      expect(SCHEDULING_WITNESSES.find((w) => w.tag === tag)!.rerunnable).toBe(true);
    }
  });
});

describe("judge — the database answers, we don't assume", () => {
  const W: Witness[] = [
    { tag: "a", probe: { kind: "table", table: "t" }, why: "x".repeat(50), rerunnable: true },
    { tag: "b", probe: { kind: "table", table: "u" }, why: "x".repeat(50), rerunnable: false },
  ];

  test("found → applied; not found → not-applied", () => {
    const r = judge(W, answers({ a: true, b: false }));
    expect(r.map((x) => x.verdict)).toEqual(["applied", "not-applied"]);
  });

  test("🔑 an unevaluated probe is needs-human, NEVER an optimistic guess", () => {
    expect(judge(W, answers({ a: null })).map((x) => x.verdict)).toEqual(["needs-human", "needs-human"]);
  });

  test("🔴 a HALF-APPLIED migration reads as not-applied, so it re-runs and its guards absorb the rest", () => {
    // The whole point of witnessing the LAST object: the first object landed, the last didn't.
    // The verdict must be "not applied", not "applied".
    const half = judge(W, answers({ a: false, b: true }));
    expect(half[0].verdict).toBe("not-applied");
  });

  test("superseded inherits `applied` from its parent…", () => {
    const w: Witness[] = [
      ...W,
      { tag: "c", probe: { kind: "superseded-by", tag: "a" }, why: "x".repeat(50), rerunnable: false },
    ];
    expect(judge(w, answers({ a: true, b: true })).find((x) => x.tag === "c")!.verdict).toBe("applied");
  });

  test("🔑 …and refuses to inherit anything else — an unproven parent means needs-human", () => {
    const w: Witness[] = [
      ...W,
      { tag: "c", probe: { kind: "superseded-by", tag: "a" }, why: "x".repeat(50), rerunnable: false },
    ];
    expect(judge(w, answers({ a: false, b: true })).find((x) => x.tag === "c")!.verdict).toBe("needs-human");
    expect(judge(w, answers({ b: true })).find((x) => x.tag === "c")!.verdict).toBe("needs-human");
  });

  test("inheritance works regardless of declaration order (two-pass)", () => {
    const w: Witness[] = [
      { tag: "c", probe: { kind: "superseded-by", tag: "a" }, why: "x".repeat(50), rerunnable: false },
      ...W,
    ];
    expect(judge(w, answers({ a: true, b: true })).find((x) => x.tag === "c")!.verdict).toBe("applied");
  });
});

describe("🔴 blockers — what must HALT the operator", () => {
  const W: Witness[] = [
    { tag: "safe", probe: { kind: "table", table: "t" }, why: "x".repeat(50), rerunnable: true },
    { tag: "unsafe", probe: { kind: "table", table: "u" }, why: "x".repeat(50), rerunnable: false },
  ];

  test("🔑 a not-applied, NOT re-runnable migration halts — this is the 0006 case", () => {
    const b = blockers(judge(W, answers({ safe: false, unsafe: false })));
    expect(b.map((x) => x.tag)).toEqual(["unsafe"]);
  });

  test("a not-applied but re-runnable migration does NOT halt — db:migrate can handle it", () => {
    expect(blockers(judge(W, answers({ safe: false, unsafe: true })))).toHaveLength(0);
  });

  test("needs-human always halts, even when re-runnable", () => {
    expect(blockers(judge(W, answers({ safe: null, unsafe: true }))).map((x) => x.tag)).toEqual(["safe"]);
  });

  test("everything applied → nothing halts", () => {
    expect(blockers(judge(W, answers({ safe: true, unsafe: true })))).toHaveLength(0);
  });
});

describe("appliedTags — what gets seeded", () => {
  test("only 'applied' seeds; not-applied and needs-human do not", () => {
    const W: Witness[] = [
      { tag: "a", probe: { kind: "table", table: "t" }, why: "x".repeat(50), rerunnable: true },
      { tag: "b", probe: { kind: "table", table: "u" }, why: "x".repeat(50), rerunnable: true },
      { tag: "c", probe: { kind: "table", table: "v" }, why: "x".repeat(50), rerunnable: true },
    ];
    expect(appliedTags(judge(W, answers({ a: true, b: false, c: null })))).toEqual(["a"]);
  });

  test("🔑 one row per journal entry — which also kills the 0004/0005 duplicates", () => {
    const r = judge(SCHEDULING_WITNESSES, new Map(SCHEDULING_WITNESSES.map((w) => [w.tag, true])));
    expect(new Set(appliedTags(r)).size).toBe(appliedTags(r).length);
    expect(appliedTags(r)).toHaveLength(SCHEDULING_WITNESSES.length);
  });
});
