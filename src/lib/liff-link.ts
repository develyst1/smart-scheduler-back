// TASK-469 (REQ-107 §2) — the Sign-up cell and the Add-Student cell answer with the EXISTING `/register` LIFF link.
//
// 🔴 The LIFF id comes from THIS process's environment (`LIFF_ID`), never a literal. The server that answers a
// postback is the server attached to that OA, and its env file carries both the OA's token and the OA's LIFF id —
// `.env.sid` the demo one, `.env.uat` the real one. A hard-coded id would send a demo parent to the customer's real page.
// 🔑 Read at REPLY time (a postback), not baked into a published menu: nothing about the id lives on the OA, so a
// menu published from the wrong box cannot carry the other OA's id, and the old published menus answer correctly the
// moment this deploys (their cells are still `action=enter` / `action=register`).
// 🔑 No id ⇒ `null` ⇒ the caller keeps today's typed flow. The door never closes because an env line is missing.
import { tb } from "./line-i18n";

export const liffId = (): string | undefined => process.env.LIFF_ID?.trim() || undefined;

export const liffUrl = (): string | undefined => {
  const id = liffId();
  return id ? `https://liff.line.me/${id}` : undefined;
};

/**
 * The customer's sentence (both languages — words are bilingual) and then the link ONCE (data, Sober's ruling f).
 * TASK-473 K0a — each cell has its OWN sentence (Sign Up ≠ Add Student); the link is the same.
 */
export const liffLinkBody = (key: "liff_add_student" | "liff_signup"): string | null => {
  const url = liffUrl();
  return url ? `${tb(key)}\n${url}` : null;
};
