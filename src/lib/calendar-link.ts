// Subscription URLs for the per-teacher `.ics` feed (REQ-017 / TASK-044). Pure, so the shape is unit-testable.
// `webcal://` is what makes a phone offer "subscribe" instead of downloading a one-off file.

/** Where the feed is publicly reachable. Falls back to the check-in base URL, then to a relative path. */
export function calendarUrls(token: string): { https: string; webcal: string } {
  const base = (process.env.PUBLIC_CALENDAR_BASE_URL ?? process.env.PUBLIC_CHECKIN_BASE_URL ?? "").replace(
    /\/$/,
    "",
  );
  const path = `/api/calendar/${token}.ics`;
  const https = base ? `${base}${path}` : path;
  return { https, webcal: https.replace(/^https?:\/\//, "webcal://") };
}

/**
 * 🔴 TASK-519 — the LANDING PAGE's URL, on the SAME host as the feed: `https://<host>/api/calendar/subscribe/<token>`. This is what
 * the LINE reply sends: an ordinary `https` link LINE linkifies whole, so a tap reaches OUR host (it sent `webcal://…`, which LINE
 * turned into the bare root domain — a stranger's site, with the token). The token rides the PATH, never a query string.
 */
export function calendarPageUrl(token: string): string {
  const { https } = calendarUrls(token);
  return https.replace(/\/api\/calendar\/[^/]+\.ics$/, `/api/calendar/subscribe/${token}`);
}

/** `<token>.ics` → the token, or null when the filename isn't a feed request. */
export function tokenFromIcsFilename(file: string): string | null {
  if (!file.endsWith(".ics")) return null;
  const token = file.slice(0, -4);
  return token.length >= 8 ? token : null;
}
