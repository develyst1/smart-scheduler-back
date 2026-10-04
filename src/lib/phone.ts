// TASK-644 — the two PURE phone rules, moved here VERBATIM from `services/parent.service.ts` (which re-exports them, so
// every existing caller is byte-unchanged) so that `validation.ts` can use the same rule without importing the DB module.
// 🚫 No second phone rule: anything that asks "is this a phone" reads THIS file.

/** Digits only — phone is the parent's identity, normalize before lookup/insert. */
export function normalizePhone(input: string): string {
  return (input ?? "").replace(/\D/g, "");
}

/**
 * 🔴 TASK-447 (REQ-105 §7) — is this message A PHONE NUMBER, typed on its own?
 *
 * The silence rule (AC-16) exists so an unlinked chat does not answer chatter; this is the ONE exception the
 * owner's report demands — the OA's own auto-greeting asks for a phone, and nothing in our code was listening.
 * So the test must be **tight**: only separators (space · dash · dot · brackets · a leading `+`) may keep the
 * digits company, and there must be at least nine of them — `linkFamilyByPhone`'s own floor (`phone.length < 9`
 * ⇒ `phone-invalid`) read off the SAME `normalizePhone` above, not a second rule that can drift from it.
 *
 * 🚫 Deliberately NOT "does it contain 9 digits": `สวัสดีค่ะ 0924912848`, a nickname, a date or an address stays
 * silent. A chat that types its number alone is answering a question; a chat that mentions one is talking.
 */
// TASK-660 (F5) — the SAME shape test serves the student search, with its own floor (`PHONE_SEARCH_MIN_DIGITS`): one rule
// for "is this a phone", two floors for two jobs. The chat's floor (9) is the default, so its callers are unchanged.
// TASK-644 — and the NEW-student phone on booking / course / voucher (`validation.ts`), at the default floor of 9.
export function isPhoneShaped(input: string, minDigits = 9): boolean {
  const t = (input ?? "").trim();
  if (!t || !/^\+?[\d\s().-]+$/.test(t)) return false;
  return normalizePhone(t).length >= minDigits;
}
