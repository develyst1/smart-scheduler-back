// RFC 5545 (iCalendar) serialization for the per-teacher subscription feed (REQ-017 / TASK-044). Pure — no DB,
// no IO — so the fiddly parts (escaping, folding, timezone, stable UID) are unit-testable. A malformed feed
// fails *silently* in calendar apps, so these details are the whole job.
//
// Timezone: emitted as **UTC** (`…Z`). Thailand is UTC+7 all year with no DST, so the conversion is exact and
// needs no `VTIMEZONE` block — which is the usual source of broken feeds. Never floating times.

const CRLF = "\r\n";
const ENC = new TextEncoder();

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines are special. */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Fold to ≤75 **octets** per line (RFC 5545), continuation lines starting with one space.
 * Counts UTF-8 bytes and never splits a code point — Thai characters are 3 bytes each, so char-based folding
 * would emit over-long lines that stricter clients reject.
 */
export function foldIcsLine(line: string): string {
  if (ENC.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = ENC.encode(ch).length;
    if (bytes + b > 75) {
      out.push(cur);
      cur = ` ${ch}`; // the leading space counts toward the next line's 75
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  out.push(cur);
  return out.join(CRLF);
}

/** Bangkok wall-clock (date + HH:MM[:SS]) → an iCalendar UTC stamp, e.g. `20260731T020000Z`. */
export function toIcsUtc(date: string, time: string): string {
  const hhmmss = time.length === 5 ? `${time}:00` : time;
  const d = new Date(`${date}T${hhmmss}+07:00`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface IcsBooking {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  studentName?: string | null;
  subjectName?: string | null;
  status: string;
  updatedAt?: Date | string | null;
}

/** App status → the three RFC 5545 VEVENT statuses. CANCELLED is what makes a subscriber *remove* the event. */
function veventStatus(status: string): "CONFIRMED" | "TENTATIVE" | "CANCELLED" {
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "PENDING") return "TENTATIVE";
  return "CONFIRMED";
}

/** Stable per booking → an edit UPDATES the existing event instead of creating a duplicate. */
export const icsUid = (bookingId: string) => `booking-${bookingId}@smart-scheduler`;

/** Monotonic revision from `updatedAt` (epoch seconds), so clients accept the newer copy. 0 when unknown. */
function sequenceOf(updatedAt: IcsBooking["updatedAt"]): number {
  if (!updatedAt) return 0;
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

export function buildVevent(b: IcsBooking, nowStamp: string): string[] {
  const summary = [b.studentName, b.subjectName].filter(Boolean).join(" · ") || "Class";
  const lastMod = b.updatedAt
    ? new Date(b.updatedAt instanceof Date ? b.updatedAt : new Date(b.updatedAt))
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z")
    : nowStamp;
  return [
    "BEGIN:VEVENT",
    `UID:${icsUid(b.id)}`,
    `DTSTAMP:${nowStamp}`,
    `DTSTART:${toIcsUtc(b.date, b.startTime)}`,
    `DTEND:${toIcsUtc(b.date, b.endTime)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(`Status: ${b.status}`)}`,
    `STATUS:${veventStatus(b.status)}`,
    `SEQUENCE:${sequenceOf(b.updatedAt)}`,
    `LAST-MODIFIED:${lastMod}`,
    "END:VEVENT",
  ];
}

/** Full VCALENDAR document, CRLF-terminated and folded. `now` is injectable so tests are deterministic. */
export function buildCalendar(
  bookings: IcsBooking[],
  opts: { now?: Date; calendarName?: string } = {},
): string {
  const now = opts.now ?? new Date();
  const nowStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Smart Scheduler//Teacher Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(opts.calendarName ?? "Smart Scheduler")}`,
    "X-WR-TIMEZONE:Asia/Bangkok",
    ...bookings.flatMap((b) => buildVevent(b, nowStamp)),
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
