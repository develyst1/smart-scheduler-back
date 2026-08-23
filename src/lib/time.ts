// Time/date helpers. Backend has no dayjs; dates are plain `YYYY-MM-DD` strings
// (local calendar, Asia/Bangkok) and times are `HH:mm`.

// Operating hours 09:00–18:00 (nine one-hour slots), per requirement.md.
export const TIME_SLOTS = [
  "09:00",
  "10:00",
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
  "17:00",
] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** "10:00:00" (Postgres time) → "10:00". */
export const hhmm = (t: string) => t.slice(0, 5);

/** "10:00" → "11:00" (one-hour slot). */
export const addHour = (t: string) => {
  const [h, m] = hhmm(t).split(":").map(Number);
  return `${pad(h + 1)}:${pad(m)}`;
};

export const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
};

/**
 * The week containing `iso`, **Monday→Sunday** — the Thai week, and the one the FE calendar has always drawn
 * (`CalendarContent.tsx:27`).
 *
 * 🔴 REQ-069 / TASK-175: this used to be Sunday→Saturday. The grid was drawn for one week and filled with
 * another, so **the Sunday column was always empty** — on the customer's busiest day — and staff had been
 * looking at a calendar that hid real bookings. It was fixed here rather than in the calendar because the other
 * direction would have made the Thai week wrong everywhere else instead.
 *
 * On a **Sunday** this returns the week that Sunday *ends* (the Monday before → that Sunday), which is what
 * someone looking at "this week" on a Sunday evening means.
 */
export const weekRange = (iso: string) => {
  const dow = new Date(`${iso}T00:00:00`).getDay(); // 0 = Sunday … 6 = Saturday
  const start = addDays(iso, -((dow + 6) % 7)); // Mon→0, Tue→1, … Sun→6
  return { start, end: addDays(start, 6) };
};

export const datesBetween = (start: string, end: string) => {
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
};
