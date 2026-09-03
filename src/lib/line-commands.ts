// SPEC-071 / TASK-245 — **the words the bot advertises, in ONE place.**
//
// 🔴 The defect this exists to close: the owner typed `เมนู` at the "child's name" step and it became the
// child's NAME. Then he typed `เมนู` again to escape and it was rejected as a bad date. He finished the
// registration **because he could not leave it** — writing a student record that can never be deleted.
//
// @Porter offered two fixes: *"a word the bot advertises behaves the same everywhere"* or *"ask before treating
// it as data"*. The SA took the first, and the reason is the important part: **the contradiction is what must
// go. A confirm dialog only manages it** — and adds a turn to a flow we are shortening, and is a second thing
// to get wrong.
//
// ⇒ These lists are the router's vocabulary **and** the reserved set, because they must be the same words.
// A second copy is how "the bot said `เมนู` is a command" and "the bot stored `เมนู` as a name" both become
// true at once.
//
// Pure — no DB, no i18n, no clock.

/** Restart registration. Works from any state, which is why it is checked before the route is computed. */
export const CMD_REGISTER = ["สมัคร", "register", "ลงทะเบียน", "เริ่มต้น"] as const;
export const CMD_MENU = ["เมนู", "menu", "help", "ช่วยเหลือ"] as const;
export const CMD_COURSES = ["คอร์ส", "คอร์สของฉัน", "courses", "mycourses"] as const;
export const CMD_ADMIN = ["แอดมิน", "คุยกับแอดมิน", "admin"] as const;
export const CMD_CHILDREN = ["นักเรียน", "ลูก", "รายชื่อ", "children", "students"] as const;
export const CMD_QR = ["qr", "คิวอาร์"] as const;
export const CMD_CHECKIN = ["เช็คอิน", "checkin", "check-in"] as const;
export const CMD_LEAVE = ["ลา", "แจ้งลา", "sick", "leave"] as const;
export const CMD_SCHEDULE = ["ตาราง", "ตารางสอน", "schedule"] as const;
export const CMD_CALENDAR = ["ปฏิทิน", "calendar"] as const;

/** TASK-245 — the exit, available at every step of every flow. */
export const CMD_CANCEL = ["ยกเลิก", "cancel"] as const;

/**
 * 🔴 TASK-246 (AC-23 / AC-26) — the way back IN, for a chat the bot has muted.
 *
 * A different word from `เมนู` on purpose, and @Porter's reasoning is the whole of it: while muted, `เมนู` is
 * **deliberately** ignored, so if it un-muted, a parent idly reaching for a familiar command would drop the bot
 * back into a live conversation with an admin. ⇒ **the un-mute must be a thing you choose, not a thing you
 * reach for** — which only holds if the word is one the bot had to tell them (AC-24).
 */
export const CMD_REOPEN = ["เปิดเมนู", "reopen", "open menu"] as const;

/** "I do not want to answer this one." Pre-existing vocabulary, listed here so it is reserved too. */
export const CMD_SKIP = ["ข้าม", "ไม่", "ไม่เพิ่ม", "เสร็จ", "จบ", "skip", "no", "done"] as const;

/**
 * 🔴 Every word above, flattened. **A word on this list can never be stored as data** — not as a child's name,
 * not as anything else — because the bot tells people these words do something, and a system that advertises a
 * word and then swallows it is lying to the person who believed it.
 */
export const RESERVED_WORDS: readonly string[] = [
  ...CMD_REGISTER,
  ...CMD_MENU,
  ...CMD_COURSES,
  ...CMD_ADMIN,
  ...CMD_CHILDREN,
  ...CMD_QR,
  ...CMD_CHECKIN,
  ...CMD_LEAVE,
  ...CMD_SCHEDULE,
  ...CMD_CALENDAR,
  ...CMD_CANCEL,
  ...CMD_REOPEN,
  ...CMD_SKIP,
];

/** Case- and space-insensitive, matching how the router already compares (`text.trim().toLowerCase()`). */
export const isReservedWord = (text: string): boolean =>
  RESERVED_WORDS.includes(text.trim().toLowerCase());

export const isCancelWord = (text: string): boolean =>
  (CMD_CANCEL as readonly string[]).includes(text.trim().toLowerCase());

/** TASK-246 — "let me back in". Distinct from `isCancelWord`: two intents, two effects. */
export const isReopenWord = (text: string): boolean =>
  (CMD_REOPEN as readonly string[]).includes(text.trim().toLowerCase());
