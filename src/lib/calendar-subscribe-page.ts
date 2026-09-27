// TASK-519 — the coach's calendar LANDING PAGE, on OUR host. Pure: two strings in, one HTML page out.
//
// Why a page at all: the LINE reply used to send `webcal://<host>/api/calendar/<token>.ics`. LINE's linkifier does not know
// `webcal`, so it linkified the bare domain and a tap opened a STRANGER's site — carrying the token, which is the whole
// credential for a coach's calendar (the schedule of NAMED children). A plain `https` `.ics` link would fix the leak but make an
// iPhone IMPORT a snapshot instead of SUBSCRIBING. So LINE now sends an ordinary `https` link to THIS page, and the subscribing
// tap happens here, inside a browser, on a button whose href is the `webcal://` URL. The token never leaves our host.
//
// 🔑 ALLOW-LIST BY SIGNATURE (the `toPublicCheckinBooking` rule for a public door): the page can only print what it is given, and
// it is given exactly two URLs. No coach name, no class, no count — a stale link in a stranger's hands learns nothing but that a
// calendar exists. 🚫 No script, no image, no stylesheet from anywhere (the route's CSP forbids them too).
// 📖 The WORDS are MINE — a placeholder the owner has not seen (TASK-519); pinned by form, not bytes.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderCalendarSubscribePage(urls: { webcal: string; https: string }): string {
  const webcal = esc(urls.webcal);
  const https = esc(urls.https);
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>ปฏิทินสอน · Teaching calendar</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px 20px;max-width:560px;color:#1f2937;line-height:1.5}
h1{font-size:1.25rem;margin:0 0 16px}
a.btn{display:block;text-align:center;background:#2563eb;color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-weight:600;margin:12px 0 20px}
.box{background:#f3f4f6;border-radius:10px;padding:12px 14px;margin:12px 0;font-size:.95rem}
code{word-break:break-all;font-size:.85rem}
.warn{font-size:.9rem;color:#6b7280}
</style>
</head>
<body>
<h1>📅 ปฏิทินสอนของคุณ · Your teaching calendar</h1>
<a class="btn" href="${webcal}">ติดตามปฏิทิน · Subscribe (iPhone)</a>
<div class="box">ถ้ากดปุ่มแล้วไม่มีอะไรเกิดขึ้น: แตะเมนู ⋯ (มุมขวาบน) → เลือก “เปิดในเบราว์เซอร์ / Safari” แล้วกดปุ่มอีกครั้ง<br>
If the button does nothing: tap the ⋯ menu (top right) → “Open in browser / Safari”, then tap the button again.</div>
<div class="box">Android: เปิด Google Calendar บนเว็บ → เพิ่มปฏิทิน → จาก URL → วางลิงก์นี้<br>
Android: open Google Calendar on the web → Add calendar → From URL → paste this link:<br>
<code>${https}</code></div>
<p class="warn">ลิงก์นี้เป็นของคุณคนเดียว อย่าส่งต่อ · This link is private to you — don't share it.</p>
</body>
</html>
`;
}
