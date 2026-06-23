// Time/date helpers. Backend has no dayjs; dates are plain `YYYY-MM-DD` strings
// (local calendar, Asia/Bangkok) and times are `HH:mm`.

export const TIME_SLOTS = [
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

/** Week containing `iso`, Sunday→Saturday (matches the FE calendar). */
export const weekRange = (iso: string) => {
  const dow = new Date(`${iso}T00:00:00`).getDay(); // 0 = Sunday
  const start = addDays(iso, -dow);
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
