// LINE account-pairing safety decisions (REQ-020 Stage 1 / TASK-047). Pure, so the two security rules are
// unit-testable and stated in one place.
import { t, type Lang } from "./line-i18n";

/**
 * Teacher-nickname match outcome. `ambiguous` (2+ teachers share the nickname) must bind **nobody**: the old
 * code took the first match, which could silently hand one teacher's account to a different person.
 */
export type TeacherMatch = "none" | "one" | "ambiguous";

export const decideTeacherMatch = (matchCount: number): TeacherMatch =>
  matchCount === 0 ? "none" : matchCount === 1 ? "one" : "ambiguous";

/**
 * Non-identifying confirmation that a parent reached the right account: a **count**, never names. Parent
 * linking matches on phone alone, so anyone who types a phone number would otherwise be told that family's
 * children's names. Empty string when there are none (nothing to confirm).
 */
export const parentChildrenNote = (count: number, lang: Lang): string =>
  count > 0 ? t("verify_parent_children_count", lang, { n: count }) : "";
