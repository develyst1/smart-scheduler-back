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

/**
 * SPEC-071 Amendment #2 / TASK-232 (REQ-079 §2) — the children **by name**, for the phone-alone entry flow.
 *
 * 🔴 This is the opposite rule to `parentChildrenNote` above, deliberately, and both are correct — for
 * different paths. TASK-047 withheld names because *"anyone who types a phone number would otherwise be told
 * that family's children's names"*, and **that reasoning has not been refuted; it has been ACCEPTED.** The
 * owner put the danger to the customer in those words and **the customer chose the convenience** (REQ-079 §2,
 * `SYSTEM-FACTS.md`). So this is a recorded business decision, not an erosion of a safety rule — which is
 * exactly why the old function and its comment stay here untouched instead of being edited away.
 *
 * ⚠️ Which one a caller uses is **not a style choice**. Names are for the path the owner accepted the risk on.
 * With the 2FA step switched ON, the **count** is what a parent sees before verifying; the names come after.
 */
export const parentChildrenNames = (names: string[], lang: Lang): string =>
  names.length > 0 ? t("verify_parent_children_names", lang, { names: names.join(", ") }) : "";
