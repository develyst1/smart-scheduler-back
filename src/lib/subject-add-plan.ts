// SPEC-053 / TASK-153 (REQ-058) — the PURE decision behind `subjects:add`: create or leave alone, is the price
// group real, and does the optional teacher resolve. Kept out of the script (mirroring `db-reset-plan.ts`) so the
// rules are unit-tested without a database.
//
// The whole safety story is "insert-if-missing": this tool can create a program and link a teacher, and that is
// ALL it can do. It cannot rename, re-group or delete an existing row — which is what makes REQ-058's AC-5
// (nothing existing changes, incl. the KEPT combined program) true by construction rather than by care.
import { PRICE_GROUPS, type PriceGroup } from "./sale-items";

export interface TeacherRef {
  id: string;
  nickname: string;
}

export interface SubjectAddPlan {
  ok: boolean;
  /** Reasons the run must refuse — checked BEFORE anything is written. */
  problems: string[];
  name: string;
  group: PriceGroup | null;
  /** false ⇒ the name already exists and is left completely untouched. */
  willCreate: boolean;
  alreadyPresent: boolean;
  /** The resolved teacher to link, when `--teacher` was given and matched exactly one. */
  link: TeacherRef | null;
}

export const isPriceGroup = (v: string): v is PriceGroup => (PRICE_GROUPS as string[]).includes(v);

/**
 * Decide what one `subjects:add` invocation would do.
 * `existingNames` / `teachers` are read by the caller; nothing here touches IO.
 */
export function planSubjectAdd(input: {
  name: string;
  group: string;
  existingNames: readonly string[];
  /** Only supplied when `--teacher` was passed. */
  teacherQuery?: string;
  teachers?: readonly TeacherRef[];
}): SubjectAddPlan {
  const problems: string[] = [];
  const name = (input.name ?? "").trim();
  if (!name) problems.push("ต้องระบุ --name (ชื่อโปรแกรม)");

  const groupRaw = (input.group ?? "").trim();
  // A typo'd group would create a program with no price and no voucher rule — an unsellable row that looks fine
  // in the dropdown. Refused loudly instead.
  const group = isPriceGroup(groupRaw) ? groupRaw : null;
  if (!group) problems.push(`--group ไม่ถูกต้อง: "${groupRaw}" — ต้องเป็นหนึ่งใน ${PRICE_GROUPS.join(" | ")}`);

  const alreadyPresent = input.existingNames.some((n) => (n ?? "").trim() === name);

  let link: TeacherRef | null = null;
  const query = (input.teacherQuery ?? "").trim();
  if (query) {
    const pool = input.teachers ?? [];
    const byId = pool.filter((t) => t.id === query);
    const byNick = pool.filter((t) => (t.nickname ?? "").trim() === query);
    const matches = byId.length ? byId : byNick;
    if (matches.length === 1) link = matches[0]!;
    else if (matches.length === 0) problems.push(`ไม่พบครู "${query}"`);
    // Ambiguity is refused, never resolved by picking the first — the same discipline as TASK-047's nickname rule.
    else problems.push(`มีครูชื่อเล่น "${query}" มากกว่า 1 คน — ระบุเป็น id แทน`);
  }

  return {
    ok: problems.length === 0,
    problems,
    name,
    group,
    willCreate: problems.length === 0 && !alreadyPresent,
    alreadyPresent,
    link,
  };
}

/** Operator-facing summary — program and teacher names only (catalogue data; no student/parent row is touched). */
export function formatSubjectAddPlan(plan: SubjectAddPlan): string {
  const lines = [
    `  โปรแกรม : ${plan.name || "(ไม่ระบุ)"}`,
    `  กลุ่มราคา: ${plan.group ?? "(ไม่ถูกต้อง)"}`,
    `  การทำงาน : ${plan.alreadyPresent ? "มีอยู่แล้ว — ไม่แก้ไข" : "จะสร้างใหม่"}`,
  ];
  if (plan.link) lines.push(`  ผูกครู   : ${plan.link.nickname}`);
  for (const p of plan.problems) lines.push(`  🔴 ${p}`);
  return lines.join("\n");
}
