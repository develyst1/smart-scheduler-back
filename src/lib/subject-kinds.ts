// TASK-437 (REQ-095 §13.4a, SPEC-089 A) — a subject's TYPE. The closed set lives HERE; `0050`'s CHECK is its database copy
// (pinned equal by the suite — the TASK-410 lesson: a set with two homes drifts). The ONE rule both course creates ask:
// a DUO course needs a DUO subject, a Private course needs a non-DUO one — the owner hid each kind from the other's
// dropdown, and the server refuses what the dropdown would not have offered.
import { ApiException } from "./http";

export const SUBJECT_KINDS = ["PRIVATE", "DUO"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export const isSubjectKind = (v: unknown): v is SubjectKind => typeof v === "string" && (SUBJECT_KINDS as readonly string[]).includes(v);

export const NOT_A_DUO_SUBJECT = () => new ApiException(400, "NOT_A_DUO_SUBJECT", "คอร์ส DUO ต้องใช้โปรแกรม DUO");
export const DUO_SUBJECT = () => new ApiException(400, "DUO_SUBJECT", "โปรแกรม DUO ขายได้เฉพาะคอร์ส DUO");

/** The rule — pure: `duo` says what the course IS, the subject's `kind` says what the program IS; they must agree. */
export function assertSubjectKindForCourse(subject: { kind?: string | null } | null | undefined, duo: boolean): void {
  const kind = subject?.kind ?? "PRIVATE";
  if (duo && kind !== "DUO") throw NOT_A_DUO_SUBJECT();
  if (!duo && kind === "DUO") throw DUO_SUBJECT();
}

/** The two seeded DUO programs (`scripts/ensure-subjects.ts`) — the exact names on `uat` (Porter confirms the bytes). */
export const DUO_SUBJECT_SEEDS = [
  { name: "Duo INLINE SKATE", kind: "DUO" as const, priceGroup: "balance-duo" as const },
  { name: "Duo SURFSKATE", kind: "DUO" as const, priceGroup: "balance-duo" as const },
] as const;

export type SubjectSeedRow = { name: string; kind: string; priceGroup: string | null; active: boolean };
export type EnsureAction = { name: string; action: "create" | "update" | "unchanged"; changes: string[] };

/** Pure: what `ensure-subjects` would do — matched by exact name; an existing row is UPDATED in place (never duplicated). */
export function planEnsureSubjects(existing: readonly SubjectSeedRow[], wanted: ReadonlyArray<{ name: string; kind: string; priceGroup: string }> = DUO_SUBJECT_SEEDS): EnsureAction[] {
  return wanted.map((w) => {
    const row = existing.find((e) => e.name === w.name);
    if (!row) return { name: w.name, action: "create", changes: [`kind ${w.kind}`, `price_group ${w.priceGroup}`, "active true"] };
    const changes: string[] = [];
    if (row.kind !== w.kind) changes.push(`kind ${row.kind}→${w.kind}`);
    if (row.priceGroup !== w.priceGroup) changes.push(`price_group ${row.priceGroup ?? "null"}→${w.priceGroup}`);
    if (!row.active) changes.push("active false→true");
    return { name: w.name, action: changes.length ? "update" : "unchanged", changes };
  });
}
