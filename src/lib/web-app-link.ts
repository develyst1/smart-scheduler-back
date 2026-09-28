// 🔴 TASK-536 (owner ruling 09-28: "ส่งลิ้งไป ให้ครูล็อกอินเอง แล้วเข้าไปใช้เว็บ แบบบนมือถือ แค่นั้น") — the web app's address, as a LINE
// chat sends it. 🔑 ONE address, ONE rule: the SAME key (`PUBLIC_ADMIN_BASE_URL`) and the SAME builder as the admin menu's cell
// (TASK-530) — https only, no `?`/`#` in the base, and LINE's `openExternalBrowser=1`, because LINE's in-app browser cannot see
// the phone browser's cookies (a session the person already has would be useless inside LINE; documented LINE behaviour).
// Returns null when the key is unset or bad: the caller must say so, never send a broken link.
import { ADMIN_URL_ENV, adminMenuUrl } from "./line-rich-menu";

export function webAppLink(base: string | undefined = process.env[ADMIN_URL_ENV]): string | null {
  try {
    return adminMenuUrl(base);
  } catch {
    return null;
  }
}
