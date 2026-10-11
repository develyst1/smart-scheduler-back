// TASK-725 — the ONE-TIME CODE that ties a LINE account to a WEB USER. A web admin asks for it (`POST /me/line-link-code`) and types it in the OA chat
// (`verifyAndLink`, admin branch). Pure: no DB, no LINE. The rules, each pinned in `admin-line-link-task725.test.ts`:
// 1. 8 characters from an UNAMBIGUOUS uppercase alphabet (no `0 O 1 I L`), drawn from a CSPRNG (`crypto.randomInt`, rejection-free, unbiased).
//    It is typed on a phone by a human; the miss limiter (5 per hour per LINE account) is what makes walking it pointless, the alphabet is what keeps it typeable.
// 2. Stored HASHED (SHA-256 of the NORMALISED code): a read of the table never yields a working code. SHA-256 is right here, not a password hash — the input is
//    random, short-lived (10 min) and single-use, and the lookup must be by hash.
// 3. TEN MINUTES, single use. A new code replaces the previous one (one live code per user, by construction: it is a column).
// 4. Typing is forgiving, the code is not: case, spaces and hyphens are ignored (`k7m2-qx9p` = `K7M2QX9P`); anything else of the wrong shape is simply not a code.
import { createHash, randomInt } from "node:crypto";

/** No `0 O 1 I L`: the characters a phone keyboard and a human most often confuse. 31 symbols ⇒ 31^8 ≈ 8.5 × 10^11 codes. */
export const LINK_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const LINK_CODE_LENGTH = 8;
export const LINK_CODE_TTL_MS = 10 * 60_000;

/** A fresh code. `randomInt` is unbiased, so every symbol is equally likely (no modulo skew). */
export function generateLinkCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  return out;
}

/** What was typed, reduced to the code's own shape: upper-cased, spaces and hyphens removed. NOT validated here. */
export const normalizeLinkCode = (typed: string): string => (typed ?? "").toUpperCase().replace(/[\s-]+/g, "");

/** Is this (already normalised) text even shaped like a code? Anything else is a miss without a database read. */
export const looksLikeLinkCode = (normalized: string): boolean =>
  normalized.length === LINK_CODE_LENGTH && [...normalized].every((ch) => LINK_CODE_ALPHABET.includes(ch));

/** The at-rest form. Always hash the NORMALISED code. */
export const hashLinkCode = (normalized: string): string => createHash("sha256").update(normalized, "utf8").digest("hex");

export const linkCodeExpiry = (now: number = Date.now()): Date => new Date(now + LINK_CODE_TTL_MS);
