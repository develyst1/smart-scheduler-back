// Current calendar date/time in Asia/Bangkok — used for check-in windows (C.1).

import { hhmm } from "./time";

export interface BangkokNow {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  /** minutes since midnight for easy range checks */
  minutes: number;
}

const tz = "Asia/Bangkok";

function part(parts: Intl.DateTimeFormatPart[], type: string) {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** Wall-clock "now" in Bangkok (not UTC). */
export function bangkokNow(): BangkokNow {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const dd = part(parts, "day");
  const mm = part(parts, "month");
  const yyyy = part(parts, "year");
  const hour = part(parts, "hour");
  const minute = part(parts, "minute");
  const time = `${hour}:${minute}`;
  const h = Number(hour);
  const m = Number(minute);
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: hhmm(time),
    minutes: h * 60 + m,
  };
}

export function timeToMinutes(t: string): number {
  const [h, m] = hhmm(t).split(":").map(Number);
  return h * 60 + m;
}

/** Booking date + HH:mm → minutes since midnight (for same-day window checks). */
export function bookingSlotMinutes(date: string, startTime: string, endTime: string) {
  return { start: timeToMinutes(startTime), end: timeToMinutes(endTime), date };
}
