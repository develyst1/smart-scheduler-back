// TASK-470 (REQ-107 §3) — the customer's three class-line shapes, byte for byte from her sheet
// (`project-docs/customer-2026-09-25-richmenu/rich-menu-messages.html`, columns D = EN and F = TH).
//
// 🔑 Her EN and TH columns are IDENTICAL for these lines (`Teacher KK`, `FRI`), so the lines take no language: one
// shape per message, and the language only chooses the headings around them (`line-i18n.ts`).
// 🔑 The name that leads a line goes through the ONE name rule (`studentNamesOf`, TASK-425): a DUO row reads both
// children. No name is hand-built here.
// ⚠️ Her DATE and TIME formats are hers, not ours, and they differ from the `DD-MM-YYYY` house rule — check-in `@ 10.00`
// (a DOT), leave `FRI 25/09 @ 16:00` (a COLON), expiry `27.10.26` (DD.MM.YY). Copied exactly and flagged in TASK-470.
import { studentNamesOf } from "../db/mappers";
import { hhmm } from "./time";
import { weekdayOf } from "./recurring";

/** `10:00:00` → `10.00` — her check-in time uses a DOT. */
export const timeDot = (t: string): string => hhmm(t).replace(":", ".");
/** `2026-09-25` → `FRI` — her leave list, in BOTH columns (`weekdayOf` is JS getDay: 0 = Sunday). */
export const DOW3 = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export const dow3 = (iso: string): string => DOW3[weekdayOf(iso)]!;
/** `2026-09-25` → `25/09`. */
export const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
/** `2026-10-27` → `27.10.26` — her expiry. */
export const ddmmyyDot = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`;

const program = (b: any): string => b.subject?.name ?? "-";
const teacher = (b: any): string => `Teacher ${b.teacher?.nickname ?? "-"}`;

/** CHECK-IN line — `Feen: Duo Private BALLET / Teacher KK @ 10.00` (no bullet, as in her sheet). */
export const checkinLine = (b: any): string => `${studentNamesOf(b) ?? "-"}: ${program(b)} / ${teacher(b)} @ ${timeDot(b.startTime)}`;

/** LEAVE line — `FRI 25/09 @ 16:00 : Duo Private BALLET / Teacher KK` (the list adds `· `; the success line does not). */
export const leaveLine = (b: any): string => `${dow3(b.date)} ${ddmm(b.date)} @ ${hhmm(b.startTime)} : ${program(b)} / ${teacher(b)}`;

/** MY COURSE line — `.  Feen: Duo Private BALLET / Teacher KK [Remain: 4/6] *EXPIRE: 27.10.26` (a full stop and TWO spaces). */
export const courseLineV2 = (c: { studentName: string | null; subjectName: string | null; teacherNickname: string | null; size: number; usedSessions: number; expiryDate: string }): string =>
  `.  ${c.studentName ?? "-"}: ${c.subjectName ?? "-"} / Teacher ${c.teacherNickname ?? "-"} [Remain: ${Math.max(0, c.size - c.usedSessions)}/${c.size}] *EXPIRE: ${ddmmyyDot(c.expiryDate)}`;

/** Her note under every list: *"เว้นบรรทัดด้วยนะคะ ถ้ามีหลายคลาส"* — a BLANK LINE between items. */
export const joinItems = (lines: string[]): string => lines.join("\n\n");
