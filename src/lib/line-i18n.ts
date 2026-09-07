// LINE bot i18n (REQ-015 / TASK-039). Every user-facing string lives here keyed TH/EN; `t(key, lang, vars)`
// renders one. Missing EN falls back to TH (never a raw key). `{var}` placeholders are interpolated. This is
// the single source of bot copy — no user-visible literal should remain in the service / reply / message layer.

import type { BookingStatus } from "../types/contract";
import type { AttentionKey } from "./attention";

export type Lang = "TH" | "EN";
export const isLang = (v: unknown): v is Lang => v === "TH" || v === "EN";

interface Entry {
  TH: string;
  EN?: string;
}

/**
 * 🔴 TASK-271 — every booking status a teacher can be shown, and the COMPILER keeps it total.
 *
 * ## The defect this closes
 * There were **six** `status_*` keys against a database enum of **nine**, and `t()` returns the KEY on a
 * miss (*"defensive — an unknown key never crashes a reply"*, and it is right to). ⇒ a paused session
 * rendered on a coach's phone as the literal string **`status_PAUSED`**. ⚠️ `PENDING_RESCHEDULE` had the
 * same gap for far longer and nobody found it — a coach reading `status_PENDING_RESCHEDULE` would assume
 * it was our jargon rather than a bug.
 *
 * ## 🔑 Why a Record and not another test
 * `Record<BookingStatus, Entry>` makes the next `ALTER TYPE … ADD VALUE` **fail the build** until a word
 * exists. A test would be a second copy of the list; the type is the list.
 * 📌 **And this only became possible yesterday:** TASK-270 made `BookingStatus` derive from
 * `bookingStatus.enumValues`. Before that, an exhaustive map over the DTO type would have been exhaustive
 * over the WRONG list — the very list that was missing `PAUSED`. **One fix made the next one cheap.**
 *
 * ⚠️ `t()`'s fall-through stays exactly as it is: it is correct for genuinely dynamic keys. The point is
 * that a status is no longer one of them.
 */
const STATUS_LABELS: Record<BookingStatus, Entry> = {
  PENDING: { TH: "รอยืนยัน", EN: "Pending" },
  CONFIRMED: { TH: "ยืนยันแล้ว", EN: "Confirmed" },
  ATTENDED: { TH: "เข้าเรียนแล้ว", EN: "Attended" },
  SICK_LEAVE: { TH: "ลา", EN: "Leave" },
  EXTENDED: { TH: "คาบขยาย", EN: "Extended" },
  NO_SHOW: { TH: "ไม่มา", EN: "No-show" },
  // REQ-076's own word, and the tray already uses it — not a new one invented here.
  PAUSED: { TH: "พัก", EN: "Paused" },
  // 🔴 TASK-271 §5 — PLACEHOLDER, @Porter is asking the customer. This is NOT a ratified string; it is
  // plain Thai standing in front of a raw key while the question is answered. Do not treat it as agreed.
  // 📌 The row stays VISIBLE on purpose: a `PENDING_RESCHEDULE` session is one whose move the parent has
  // not accepted, so the coach is still rostered for the ORIGINAL slot. Hiding it would remove a class
  // that may well happen.
  PENDING_RESCHEDULE: { TH: "รอย้ายคาบ", EN: "Awaiting move" },
  // Never rendered today — a cancelled row is filtered before it reaches a schedule — but the map must be
  // TOTAL, and a label that exists costs nothing next to a raw key that ships.
  CANCELLED: { TH: "ยกเลิก", EN: "Cancelled" },
};

/** `PAUSED` → `status_PAUSED`, so the existing `t(`status_${…}`)` call sites are unchanged. */
const STATUS_LABEL_ENTRIES = Object.fromEntries(
  Object.entries(STATUS_LABELS).map(([status, entry]) => [`status_${status}`, entry]),
) as Record<string, Entry>;
/**
 * 🔴 TASK-273 — every attention card's heading, and the COMPILER keeps the set complete.
 *
 * ## Why this exists while nothing is broken
 * `attention.ts` renders `t(`att_${c.key}`, lang)`, and `t()` returns the KEY on a miss — correctly, for
 * genuinely dynamic keys. Ten cards, ten headings: complete today, and **nothing was holding it that way**.
 * ⇒ the eleventh card would have shipped **`att_my_new_card` as a heading on the dashboard.**
 *
 * 📌 Third instance of one class in a day — `status_*` (broken, found by a tester), `ics.ts`'s raw `STATUS:`
 * (broken, found by reading), and this one. **Two of the three were found only because somebody looked.**
 * This is the one where the control costs a line and there is no defect to argue about first.
 *
 * 🔑 `AttentionKey` is DERIVED from `ATTENTION_CHECKS` itself, so the type and the array cannot drift either.
 * ⚠️ Type-only import: this file gains no runtime dependency on `attention.ts`, which imports `t` from here.
 */
const ATTENTION_LABELS: Record<AttentionKey, Entry> = {
  unconfirmed_bookings: { TH: "คาบที่ยังไม่ยืนยัน (วันนี้/พรุ่งนี้)", EN: "Unconfirmed classes (today/tomorrow)" },
  teachers_without_line: { TH: "ครูที่ยังไม่ผูก LINE", EN: "Teachers without LINE linked" },
  expiring_entitlements: { TH: "คอร์ส/วอยเชอร์ที่ใกล้หมดอายุ", EN: "Courses/vouchers expiring soon" },
  nearly_finished_courses: { TH: "คอร์สที่ใกล้ใช้ครบ", EN: "Courses nearly finished" },
  freelance_near_cap: { TH: "ครูฟรีแลนซ์ที่งบใกล้เต็ม", EN: "Freelance budgets near their cap" },
  incomplete_students: { TH: "นักเรียนที่ข้อมูลไม่ครบ", EN: "Students with incomplete details" },
  pending_teacher_links: {
    TH: "คำขอผูกบัญชีครูที่รออนุมัติ",
    EN: "Teacher link requests awaiting approval",
  },
  sales_not_posted: {
    TH: "การขายที่ยังไม่ลงบัญชี",
    EN: "Sales not posted to backoffice",
  },
  // SPEC-059 / TASK-163 — a discount the admin promised that the day-end sale did not apply.
  discount_not_applied: {
    TH: "ส่วนลดที่ไม่ได้ถูกใช้ (ขายเต็มราคา)",
    EN: "Discounts not applied (charged full price)",
  },
  orphaned_sessions: {
    TH: "คาบในอนาคตที่ครูไม่พร้อม (ปิดใช้งาน/ไม่สอนวันนั้น)",
    EN: "Future sessions with an unavailable teacher (archived / off that weekday)",
  },
};

/** `sales_not_posted` → `att_sales_not_posted`, so the existing `t(`att_${…}`)` call site is unchanged. */
const ATTENTION_LABEL_ENTRIES = Object.fromEntries(
  Object.entries(ATTENTION_LABELS).map(([key, entry]) => [`att_${key}`, entry]),
) as Record<string, Entry>;
const TABLE: Record<string, Entry> = {
  welcome: {
    TH: "สวัสดีค่ะ ยินดีต้อนรับสู่ Smart Scheduler\n\nพิมพ์ สมัคร เพื่อผูกบัญชี LINE\nหลังผูกแล้ว (ผู้ปกครอง): เพิ่มนักเรียน · เช็คอิน · ลา · qr",
    // 🔴 TASK-275 (REQ-079 §17) — the register sentence is the CUSTOMER'S, verbatim: "Please type 'register'
    // to start." Their words for their customers. ⚠️ It is the ONLY English string of theirs that exists in
    // the repo — §17 is @Porter's ANALYSIS of their 8 screens, not a transcript — so the greeting and the
    // command hints on this line are still OURS, and so is every other key. Listed in the TASK-275 report.
    EN: "Welcome to Smart Scheduler 👋\n\nPlease type 'register' to start.\nOnce linked (parent): add child · check-in · leave · qr",
  },
  // SPEC-071 / TASK-231 — AC-18: two unexpected replies inside a flow and the bot stops trying. The apology
  // matters: the parent has just failed twice and the next voice they hear should be a person.
  // 🔴 TASK-246 / AC-24 — the message that MUTES the chat is the message that must name the way back in. A way
  // out nobody was told about is not a way out, and this is the one screen a muted parent is guaranteed to have
  // read. (LINE on PC has no rich menu at all, so "tap something" is not an answer for them.)
  handover_to_admin: {
    TH: "ขอโทษค่ะ ขอส่งให้แอดมินช่วยดูนะคะ 🙏\n(ถ้าต้องการใช้บอทอีกครั้ง พิมพ์ เปิดเมนู ค่ะ)",
    EN: "Sorry about that — I am passing this to an admin to help you. 🙏\n(To use the bot again, type: reopen)",
  },
  // 🔴 TASK-251 (REQ-079 §16) — **no digits.** `1 / 2 / 3` collided with numbered replies the customer's own OA
  // owns, on a live account. The buttons carry the choices now, so the text stops listing them as a numbered
  // menu; the three words below are also what a PC user can still TYPE, which is why they are named in the
  // prompt rather than left only on the buttons.
  role_prompt: {
    TH: "คุณเป็นใครคะ? แตะปุ่มด้านล่าง หรือพิมพ์ ผู้ปกครอง · ครู · แอดมิน",
    EN: "Who are you? Tap a button below, or type: parent · teacher · admin",
  },
  // The button labels — short, because LINE clamps a quick-reply label at 20 characters.
  role_btn_customer: { TH: "ผู้ปกครอง", EN: "Parent" },
  role_btn_teacher: { TH: "ครู", EN: "Teacher" },
  role_btn_admin: { TH: "แอดมิน", EN: "Admin" },
  // 🔴 TASK-278 (REQ-079 §17b screen 3) — the customer's English, verbatim. The TH keeps its example; their
  // sentence has none and we are not removing a hint they simply did not write.
  code_customer: { TH: "กรุณาพิมพ์เบอร์โทรของผู้ปกครอง (เช่น 0812345678)", EN: "Please enter your phone number to continue." },
  code_teacher: { TH: "กรุณาพิมพ์ชื่อเล่นครูตามที่ลงทะเบียนในระบบ", EN: "Please type the teacher nickname as registered" },
  code_admin: { TH: "กรุณาพิมพ์รหัสแอดมิน (เช่น 229)", EN: "Please type the admin code (e.g. 229)" },

  // 🔴 TASK-278 (§17b screen 4) — their two sentences, in their order: the name prompt then the cap.
  // ⚠️ `{max}` stays a VARIABLE. Their copy hardcodes 5; the cap is `MAX_STUDENTS_PER_PARENT` and a literal
  // here would be a second place to change it — and the one nobody would remember.
  // ⚠️ `skip` stays: their copy has no escape from this step and ours must keep one.
  add_student_prompt: {
    TH: 'ต้องการเพิ่มนักเรียน (ลูก) ไหมคะ?\nพิมพ์ชื่อนักเรียน เช่น "น้องพีพี" (เพิ่มได้สูงสุด {max} คนต่อเบอร์)\nหรือพิมพ์ "ข้าม" หากยังไม่เพิ่มตอนนี้',
    EN: 'Please enter the student\'s name, e.g. "Emily".\nYou can add up to {max} students per phone number.\nOr type "skip" to do it later.',
  },
  add_student_name_prompt: { TH: "พิมพ์ชื่อนักเรียนที่ต้องการเพิ่ม (สูงสุด {max} คนต่อเบอร์)", EN: 'Please enter the student\'s name, e.g. "Emily". You can add up to {max} students per phone number.' },

  menu_title: { TH: "เมนูหลัก — แตะเพื่อใช้งาน", EN: "Main menu — tap to use" },
  // 🔴 TASK-245 "Face 2" — the last line is the half of AC-16's trade that was missing from the live product.
  // The bot went silent by default, but nothing told the person in front of it that a HUMAN still reads the
  // chat. The command list is the right home because the person reading it is, by definition, the lost one.
  // 🚫 Deliberately NOT a new rich-menu cell: that needs an image the owner has not asked for (task scope).
  menu_body: {
    TH: "คำสั่งที่ใช้ได้:\n· เพิ่มนักเรียน — เพิ่มลูกเข้าระบบ (สูงสุด 5 คน)\n· นักเรียน — ดูรายชื่อลูกของคุณ\n· เช็คอิน — เช็คอินคาบวันนี้\n· ลา — แจ้งลาคาบวันนี้\n· qr — รับลิงก์เช็คอิน\n· เมนู — แสดงคำสั่งนี้อีกครั้ง\n\nหรือพิมพ์คำถามเข้ามาได้เลยค่ะ เดี๋ยวแอดมินมาตอบนะคะ 🙏",
    EN: "Available commands:\n· add child — register a child (up to 5)\n· children — list your children\n· check-in — check in today's class\n· leave — report sick leave today\n· qr — get a check-in link\n· menu — show this again\n\nOr just type your question — an admin will read it and reply. 🙏",
  },

  btn_checkin: { TH: "เช็คอิน", EN: "Check-in" },
  btn_leave: { TH: "แจ้งลา", EN: "Leave" },
  btn_children: { TH: "นักเรียนของฉัน", EN: "My children" },
  btn_register: { TH: "เพิ่มนักเรียน", EN: "Add child" },
  btn_langhelp: { TH: "ภาษา/ช่วยเหลือ", EN: "Language/Help" },
  btn_back: { TH: "‹ เมนู", EN: "‹ Menu" },

  pick_checkin: { TH: "เลือกคาบที่จะเช็คอิน 👇", EN: "Pick a class to check in 👇" },
  pick_leave: { TH: "เลือกคาบที่จะแจ้งลา 👇", EN: "Pick a class to report leave 👇" },
  empty_checkin: { TH: "วันนี้ไม่มีคาบที่พร้อมเช็คอิน", EN: "No class to check in today" },
  // TASK-135 (REQ-046) / TASK-145 (REQ-050): leave AND check-in are per SESSION — the pickers say which one.
  pick_leave_child: { TH: "ลาให้ใครคะ 👇", EN: "Which child? 👇" },
  session_row: { TH: "{time} · ครู{teacher} · {program}", EN: "{time} · {teacher} · {program}" },
  empty_leave: { TH: "วันนี้ไม่มีคาบที่แจ้งลาได้", EN: "No class eligible for leave today" },

  // SPEC-071 / TASK-234 (AC-15) — the parent-facing course view. Five fields, in the customer template.
  course_title: { TH: "คอร์สของคุณ", EN: "Your courses" },
  course_none: { TH: "ยังไม่มีคอร์สที่ใช้งานอยู่ค่ะ", EN: "No active courses." },
  course_row: {
    TH: "· {course} · ครู{teacher} · เหลือ {remaining}/{total} · สิทธิ์ลาเหลือ {leave} · หมดอายุ {expiry}",
    EN: "· {course} · {teacher} · {remaining}/{total} left · {leave} leave left · expires {expiry}",
  },
  // Flow 7 — the way to a human. On BOTH menus, and never removed by any flow.
  // TASK-246 / AC-24 — the second message that mutes a chat. Same rule as the handover: it names the word,
  // because a parent who taps this is choosing silence and must be told how to end it.
  admin_called: {
    TH: "แจ้งแอดมินให้แล้วนะคะ รอสักครู่ เดี๋ยวมีเจ้าหน้าที่มาคุยด้วยค่ะ 🙏\n(ถ้าต้องการใช้บอทอีกครั้ง พิมพ์ เปิดเมนู ค่ะ)",
    EN: "I have told an admin — someone will reply here shortly. 🙏\n(To use the bot again, type: reopen)",
  },
  // เข้าใช้ระบบ on the unknown menu. Flow 2 is deleted (§15) and amendment #2 made the entry the PHONE ALONE,
  // so this asks for the phone — and points at a person only for someone who has never registered.
  // 🔴 TASK-248/DEF-9: renamed from `enter_ask_admin`. The old name read as *"tell them to ask an admin"* while
  // the text asked for a phone, and **that mismatch is the likeliest reason nobody wired the step behind it**:
  // the handler did what the KEY said and only replied. A key that argues with its own copy is a defect waiting.
  enter_ask_phone: {
    TH: "กรุณาพิมพ์เบอร์โทรที่ลงทะเบียนไว้ค่ะ หากยังไม่เคยลงทะเบียน กรุณาติดต่อแอดมิน",
    EN: "Please type your registered phone number. If you have never registered, please contact an admin.",
  },
  children_title: { TH: "นักเรียนของคุณ", EN: "Your children" },
  children_none: { TH: 'ยังไม่มีนักเรียน — แตะ "เพิ่มนักเรียน" เพื่อเพิ่ม', EN: 'No children yet — tap "Add child" to add' },

  verify_admin_bad: { TH: "รหัสแอดมินไม่ถูกต้อง ลองใหม่อีกครั้ง", EN: "Wrong admin code, please try again" },
  verify_admin_ok: { TH: "ผูกบัญชีแอดมินสำเร็จ ✅ จะได้รับแจ้งเตือนเมื่อมีการแจ้งลา", EN: "Admin account linked ✅ You'll be notified of leave requests" },
  verify_teacher_notfound: { TH: 'ไม่พบครูชื่อเล่น "{nick}" — ตรวจสอบอีกครั้ง', EN: 'No teacher with nickname "{nick}" — please check again' },
  // TASK-047: 2+ teachers share this nickname → bind NOBODY (binding the first match could hand one teacher's
  // account to another person). Staff completes the pairing.
  verify_teacher_ambiguous: {
    TH: 'มีครูชื่อเล่น "{nick}" มากกว่า 1 คน — เพื่อความปลอดภัย ระบบยังไม่ผูกบัญชีให้ กรุณาติดต่อแอดมินเพื่อยืนยันตัวตน',
    EN: 'More than one teacher uses the nickname "{nick}" — for safety nothing was linked. Please ask staff to complete the pairing.',
  },
  verify_teacher_other: { TH: "ครูคนนี้ผูก LINE กับบัญชีอื่นแล้ว ติดต่อแอดมิน", EN: "This teacher is already linked to another LINE — contact admin" },
  // TASK-075. ⚠️ Used for BOTH the single-match and the nickname-collision case, on purpose: the wording must
  // not tell an unauthenticated stranger whether a nickname exists or how many teachers share it.
  // Deliberately does NOT echo {nick} back, for the same reason.
  verify_teacher_pending: {
    TH: "ส่งคำขอผูกบัญชีให้เจ้าหน้าที่แล้ว ✅ รอการอนุมัติ แล้วจะแจ้งให้ทราบอีกครั้ง",
    EN: "Your link request has been sent to staff ✅ You'll be told once it's approved",
  },
  verify_teacher_ok: { TH: "ผูกบัญชีครูสำเร็จ ✅ ({nick}) จะได้รับแจ้งเตือนเมื่อมีการยืนยันตาราง", EN: "Teacher account linked ✅ ({nick}) You'll be notified when a schedule is confirmed" },
  verify_parent_badphone: { TH: "เบอร์โทรไม่ถูกต้อง กรุณาพิมพ์เบอร์ที่ลงทะเบียน (เช่น 0812345678)", EN: "Invalid phone. Please type the registered number (e.g. 0812345678)" },
  verify_parent_other: { TH: "เบอร์นี้ผูกกับ LINE อื่นแล้ว ติดต่อแอดมิน", EN: "This number is already linked to another LINE — contact admin" },
  // 🔴 TASK-278 (§17b screen 4) — their sentence, OUR variables. ⚠️ Their copy has no children line; ours
  // does, and `{list}` is a PRIVACY decision (TASK-047: a count, never names, because anyone can type a
  // phone number). Dropping it to match their text would undo a decision, not a wording.
  // 📌 `{phone}` now renders formatted (`082-503-1502`) — §6, and their own screen 4 shows it that way.
  verify_parent_ok_existing: { TH: "ผูกบัญชีผู้ปกครองสำเร็จ ✅ (เบอร์ {phone}){list}", EN: "Registration completed ✅ (phone {phone}){list}" },
  // TASK-047: a COUNT, never names — anyone can type a phone number, so listing the children would disclose
  // a family's data to a stranger. (Replaces the retired `verify_parent_students`.)
  verify_parent_children_count: { TH: "\nพบนักเรียน {n} คนในบัญชีนี้", EN: "\n{n} children on file" },
  // SPEC-071 Amendment #2 / TASK-232 — REQ-079 §2's own wording: the phone alone returns the children BY NAME.
  // 🔴 The count above is NOT retired — it is what the 2FA-on path shows before verification. Two paths, two
  // rules, both deliberate (`lib/line-pairing.ts`).
  verify_parent_children_names: {
    TH: "\nพบข้อมูลของคุณแล้วค่ะ — {names}",
    EN: "\nFound your family — {names}",
  },
  // This chat is already bound to a DIFFERENT family. Says so plainly and offers a human — the one thing it
  // must never do is quietly re-point the account, which would show a parent another family's children.
  verify_parent_other_family: {
    TH: "บัญชี LINE นี้ผูกกับอีกครอบครัวไว้แล้วค่ะ หากไม่ถูกต้องกรุณาติดต่อแอดมิน",
    EN: "This LINE account is already linked to another family. Please contact an admin if that is wrong.",
  },
  // TASK-232 — the 2FA step, shipped OFF. The copy lives here from day one so switching the setting on needs
  // no copy work either: turning it on must be a setting, never a rebuild.
  // SPEC-071 / TASK-233 (REQ-079 §5 Flow 3) — the registration wizard. The summary step is not decoration:
  // this roster has no delete for anything with history, so the parent reads back what will be written.
  add_dup_detail: {
    TH: "มีน้องชื่อนี้อยู่แล้ว รบกวนใส่นามสกุลหรือชื่อเล่นเพิ่ม เพื่อไม่ให้สลับกันนะคะ",
    EN: "There is already a child with that name. Please add a surname or nickname so they are not mixed up.",
  },
  // 🔴 TASK-277 (REQ-079 §17) — the OWNER'S sentences, verbatim, with `หรือพิมพ์ ข้าม` kept on the end.
  // ⚠️ His sentences do not mention the escape; ours did. **Dropping the way out of a wizard step is not a
  // wording change**, so it stays — added after his words, not woven through them.
  // 📌 The EN side is OURS for now; TASK-278 replaces it with the customer's, plus the format their copy omits.
  add_birthdate_prompt: {
    TH: "กรุณาพิมพ์วันเกิดของนักเรียนค่ะ (วัน-เดือน-ปี เช่น 02-12-2024) หรือพิมพ์ ข้าม",
    // §17b screen 5 is *"Please enter the date of birth."* — their sentence, PLUS the format and the skip,
    // which their copy omits. ⚠️ TASK-277's format is an owner RULING; a copy pass does not get to drop it.
    EN: "Please enter the date of birth. (DD-MM-YYYY, e.g. 02-12-2024), or type skip.",
  },
  add_birthdate_bad: {
    TH: "รูปแบบวันเกิดไม่ถูกต้องค่ะ กรุณาพิมพ์เป็น วัน-เดือน-ปี เช่น 02-12-2024 หรือพิมพ์ ข้าม",
    EN: "That date format is not valid. Please use DD-MM-YYYY, e.g. 02-12-2024, or type skip.",
  },
  add_province_prompt: { TH: "จังหวัดที่อยู่ หรือพิมพ์ ข้าม ค่ะ", EN: "Please enter your current province, or type skip." },
  add_summary_head: { TH: "ตรวจสอบข้อมูลก่อนบันทึกนะคะ", EN: "Please check your information before saving." },
  // The trailing "หรือ ยกเลิก" moved OUT of this string in TASK-245: the exit is now appended to every question
  // by `withExit`, and leaving it here too would print it twice on the one step that already had it.
  // 🔴 TASK-278 §4.1 — their screen 7 has THREE lines and only two of them belong here. The third,
  // *"Type "Cancel" to exit."*, is NOT applied: `withExit` already appends the exit to every question
  // (TASK-245), so putting it back inside this string prints it TWICE — on the one step that used to have
  // it inline, which is the exact bug TASK-245's comment above records.
  add_summary_confirm: { TH: "ถูกต้องไหมคะ? พิมพ์ ยืนยัน เพื่อบันทึก", EN: 'Is this information correct? Please type "Confirm" to save.' },
  // 🔴 TASK-245 — the exit, appended to EVERY question the wizard asks. One string, one append site, because
  // "the flow has an exit" is only true if it is true at every step: the owner's trap was three questions that
  // each looked like the only thing he was allowed to answer.
  add_exit_hint: { TH: " · หรือพิมพ์ ยกเลิก เพื่อออก", EN: " · or type cancel to exit" },
  // 🔴 TASK-245 — a word the bot advertises is never stored as data. The refusal NAMES the word and names the
  // way round it: the rare child genuinely called `เมนู` must not be left at a door that simply will not open.
  add_name_reserved: {
    TH: "「{word}」 เป็นคำสั่งของระบบค่ะ ถ้าเป็นชื่อน้องจริง ๆ รบกวนแจ้งแอดมินนะคะ",
    EN: "「{word}」 is a system command. If that really is the child's name, please tell an admin and they will add them.",
  },
  add_l_name: { TH: "ชื่อ", EN: "Name" },
  add_l_birthdate: { TH: "วันเกิด", EN: "Date of birth" },
  add_l_province: { TH: "จังหวัด", EN: "Province" },
  add_l_none: { TH: "ไม่ระบุ", EN: "not given" },
  // TASK-245 — now reachable from EVERY step, not only the summary, so it says what happened to the answers
  // already given: they are gone. The one thing a parent must not be left wondering is whether half of it was
  // saved anyway — an unknown half-record in a roster with no delete.
  add_cancelled: {
    TH: "ยกเลิกแล้วค่ะ ข้อมูลที่กรอกไว้ถูกลบทิ้งแล้ว ยังไม่ได้บันทึกอะไรลงระบบนะคะ",
    EN: "Cancelled. What you typed has been discarded — nothing was saved.",
  },
  // TASK-246 — `ยกเลิก` with nothing in progress. A separate string because `add_cancelled` claims a draft was
  // discarded, and claiming a deletion that never happened is the same class of lie as hiding one.
  cancel_nothing: {
    TH: "ไม่มีรายการที่ค้างอยู่นะคะ ยกเลิกให้เรียบร้อยค่ะ",
    EN: "There was nothing in progress — all clear.",
  },
  twofa_prompt: {
    TH: "กรุณาพิมพ์รหัส 6 หลักเพื่อยืนยันตัวตนค่ะ",
    EN: "Please type the 6-digit code to verify your identity.",
  },
  twofa_bad: {
    TH: "รหัสไม่ถูกต้องค่ะ กรุณาลองใหม่อีกครั้ง",
    EN: "That code is not correct. Please try again.",
  },
  // §17b screen 4, same sentence — this is the new-parent branch of the same moment.
  verify_parent_ok_new: { TH: "ลงทะเบียนผู้ปกครองสำเร็จ ✅ (เบอร์ {phone})", EN: "Registration completed ✅ (phone {phone})" },

  added_more: { TH: 'เพิ่ม "{name}" สำเร็จ ✅ (ตอนนี้มี {count} คน)\nพิมพ์ชื่อคนถัดไป หรือพิมพ์ "ข้าม" เพื่อจบ', EN: 'Added "{name}" ✅ (now {count})\nType the next name, or "skip" to finish' },
  // §17b screen 8 — their sentence with OUR `{name}`. Their literal `"Nong DC"` is the example child in a
  // copy document, not a string we send.
  added_done: { TH: 'เพิ่ม "{name}" สำเร็จ ✅{note}', EN: '"{name}" has been added successfully. ✅{note}' },
  added_atmax_note: { TH: " (ครบ {max} คนแล้ว)", EN: " (reached {max})" },
  add_no_parent: { TH: "ไม่พบบัญชีผู้ปกครอง พิมพ์ สมัคร เพื่อเริ่มใหม่", EN: "No parent account found. Type 'register' to start over" },
  add_generic_err: { TH: "ไม่สามารถเพิ่มนักเรียนได้", EN: "Couldn't add the student" },
  skip_done: { TH: "เรียบร้อยค่ะ ✅", EN: "All set ✅" },

  // TASK-145 (REQ-050 AC-3): the confirmation names the session — child · time · teacher · program.
  checkin_ok: {
    TH: "เช็คอินสำเร็จ ✅\n{name} · {time} น. · ครู{teacher} · {program}",
    EN: "Checked in ✅\n{name} · {time} · {teacher} · {program}",
  },
  checkin_already: {
    TH: "เช็คอินแล้วก่อนหน้านี้\n{name} · {time} น. · ครู{teacher} · {program}",
    EN: "Already checked in\n{name} · {time} · {teacher} · {program}",
  },
  checkin_notfound: { TH: "ไม่พบคาบที่เลือก", EN: "Class not found" },
  checkin_err: { TH: "ไม่สามารถเช็คอินได้ในขณะนี้", EN: "Can't check in right now" },
  // TASK-146: fallback when the leave refusal has no server message (mirrors `checkin_err`).
  leave_err: { TH: "ไม่สามารถแจ้งลาได้ในขณะนี้", EN: "Can't record leave right now" },

  leave_ok: { TH: "แจ้งลาสำเร็จ ✅ ({name}){extended}{locked}", EN: "Leave recorded ✅ ({name}){extended}{locked}" },
  // TASK-135 (REQ-046) AC-1/AC-3: name the session that was cancelled, not just the student. Wording is the
  // REQ's; `{extended}`/`{locked}` keep the existing make-up + quota lines.
  // `{name}` is back on Porter's ruling (TASK-135 Q2, 2026-08-16): a parent with two children must not have to
  // guess which child's session was cancelled — that is the point of REQ-046.
  leave_ok_session: {
    TH: "แจ้งลาแล้ว: {name} — {date} {time} น. ครู{teacher} — คาบนี้จะถูกเลื่อนไปต่อท้ายคอร์ส{extended}{locked}",
    EN: "Leave recorded: {name} — {date} {time} with {teacher} — this session moves to the end of the course.{extended}{locked}",
  },
  leave_extline: { TH: "\nคาบขยาย: {date} {time}", EN: "\nMake-up class: {date} {time}" },
  leave_lockline: { TH: "\n⚠️ โควตาลาครบแล้ว — ต้องปลดล็อกโดยแอดมิน", EN: "\n⚠️ Leave quota used up — needs admin unlock" },
  num_notfound: { TH: "ไม่พบคาบตามหมายเลขที่เลือก", EN: "No class for that number" },

  teacher_linked: { TH: "บัญชีครูผูกแล้ว — รอรับแจ้งเตือนตารางจากระบบ", EN: "Teacher account linked — you'll get schedule notifications" },
  teacher_linked_menu: { TH: "บัญชีครูผูกแล้ว ✅ จะได้รับแจ้งเตือนเมื่อมีการยืนยันตาราง", EN: "Teacher account linked ✅ You'll be notified when a schedule is confirmed" },
  // Teacher "my schedule" (REQ-016 / TASK-043).
  tsched_title_today: { TH: "🗓️ ตารางวันนี้", EN: "🗓️ Today's schedule" },
  tsched_title_week: { TH: "🗓️ ตารางสัปดาห์นี้", EN: "🗓️ This week's schedule" },
  tsched_empty: { TH: "ไม่มีคาบสอนในช่วงนี้", EN: "No classes in this range" },
  tsched_more: { TH: "…และอีก {count} คาบ", EN: "…and {count} more" },
  btn_week: { TH: "สัปดาห์นี้", EN: "This week" },
  btn_today: { TH: "วันนี้", EN: "Today" },
  // Teacher calendar subscription (REQ-017 / TASK-044).
  btn_calendar: { TH: "ปฏิทินของฉัน", EN: "My calendar" },
  cal_link: {
    TH: "📅 สมัครรับตารางสอนเข้าปฏิทินในมือถือ (อัปเดตอัตโนมัติ):\n{url}\n\nแตะลิงก์แล้วเลือก \"เพิ่ม/ติดตามปฏิทิน\" — ลิงก์นี้เป็นของคุณคนเดียว อย่าส่งต่อ",
    EN: "📅 Subscribe to your teaching schedule in your phone calendar (updates automatically):\n{url}\n\nTap the link and choose \"Add/Subscribe\" — this link is private to you, don't share it.",
  },
  cal_not_teacher: { TH: "ฟีเจอร์นี้สำหรับครูที่ผูกบัญชีแล้วเท่านั้น", EN: "This feature is for linked teachers only" },
  // Daily admin digest (REQ-023 / TASK-053) — check titles + message frame.
  // 🔴 TASK-273 — the ten card headings moved into `ATTENTION_LABELS` below, a `Record<AttentionKey, Entry>`.
  // The TEXT is unchanged; what changed is that the compiler now refuses an eleventh card without a heading.
  ...ATTENTION_LABEL_ENTRIES,
  // REQ-070 / TASK-180: `att_yesterday_no_shows` deleted with its check — the day-end job no longer writes
  // NO_SHOW, so the line could only ever say "0".
  digest_header: { TH: "📋 สรุปสิ่งที่ต้องดูแลวันนี้", EN: "📋 Today's attention summary" },
  digest_footer: { TH: "ดูรายละเอียดทั้งหมดในเว็บแอป", EN: "See full details in the web app" },
  digest_more: { TH: "+ อีก {n} รายการ — ดูในเว็บแอป", EN: "+{n} more — see the web app" },
  digest_check_failed: { TH: "ตรวจสอบไม่สำเร็จ", EN: "check failed" },

  // REQ-019 / TASK-048: a suspended household gets a short refusal and NO data.
  suspended_notice: {
    TH: "บัญชีถูกระงับ — ติดต่อเจ้าหน้าที่",
    EN: "This account is suspended — please contact staff",
  },
  // 🔴 TASK-271 §2 — the six `status_*` keys that used to sit here are now built from `STATUS_LABELS`
  // below, which is a `Record<BookingStatus, Entry>`. See its comment: this is the one place a status
  // label may be written, and the COMPILER now refuses a new enum value until somebody writes the word a
  // teacher will read.
  ...STATUS_LABEL_ENTRIES,
  admin_linked: { TH: "บัญชีแอดมิน — รอรับแจ้งเตือนจากระบบ", EN: "Admin account — you'll get notifications" },
  admin_linked_menu: { TH: "บัญชีแอดมินผูกแล้ว ✅ จะได้รับแจ้งเตือนเมื่อมีการแจ้งลา", EN: "Admin account linked ✅ You'll be notified of leave requests" },

  lang_switched: { TH: "เปลี่ยนเป็นภาษาไทยแล้ว ✅", EN: "Switched to English ✅" },

  qr_line: { TH: "ลิงก์เช็คอิน {name} {time} น.\n{url}\n{window}", EN: "Check-in link for {name} {time}\n{url}\n{window}" },
  qr_none: { TH: "วันนี้ไม่มีคาบที่ยืนยันแล้ว", EN: "No confirmed class today" },
  pick_qr: { TH: "รับลิงก์เช็คอินของคาบไหนคะ 👇", EN: "Which class do you want the check-in link for? 👇" },

  // Outbox push notifications (to teacher/admin) — formatOutboxMessage.
  ob_confirmed_title: { TH: "📅 ยืนยันตารางสอน", EN: "📅 Schedule confirmed" },
  ob_l_student: { TH: "นักเรียน", EN: "Student" },
  ob_l_subject: { TH: "วิชา", EN: "Subject" },
  ob_l_time: { TH: "เวลา", EN: "Time" },
  // SPEC-066 / TASK-201 (REQ-072) — ONE message for a whole course, not one per session.
  // 🔴 TASK-257 §1 — the customer's own heading, the one `COURSE DEDUCTION` and `TODAY'S SCHEDULE` already use.
  // The emoji stays: they put `⏱️` and `💡` on their own two, so it is their convention, not ours.
  ob_course_title: { TH: "📅CONFIRMED SCHEDULE:", EN: "📅CONFIRMED SCHEDULE:" },
  ob_l_start: { TH: "เริ่ม", EN: "Starts" },
  ob_l_schedule: { TH: "ตารางเรียน", EN: "Schedule" },
  ob_l_sessions: { TH: "จำนวนคาบที่ยืนยัน", EN: "Sessions confirmed" },
  // TASK-206: the label names DAYS, because the value is now a list of dates rather than a tally.
  ob_l_planned_leave: { TH: "แจ้งลาล่วงหน้าไว้ (วันที่)", EN: "Leave already booked (dates)" },
  ob_l_note: { TH: "หมายเหตุ", EN: "Note" },
  // ── SPEC-072 / TASK-253 (REQ-077) — the customer's own template labels ────────────────────────────────────
  // ⚠️ These are **English in both languages, on purpose**: the customer wrote the templates that way
  // (`Student : {ชื่อนักเรียน}`) — English label, Thai value — and a message the owner has approved on paper is
  // not the place to improve on his wording. They live here rather than in the renderer because that is where
  // every user-visible string in this repo lives; if the customer ever asks for Thai labels, it is this block.
  // 🔑 The separator is ` : `, also theirs, and it is why these are separate keys from the `ob_l_*` above —
  // those render five LIVE messages whose text must not shift by a byte in this task.
  ob_f_student: { TH: "Student", EN: "Student" },
  ob_f_program: { TH: "Program", EN: "Program" },
  ob_f_date: { TH: "Date", EN: "Date" },
  ob_f_time: { TH: "Time", EN: "Time" },
  ob_f_start: { TH: "Start", EN: "Start" },
  ob_f_coach: { TH: "Coach", EN: "Coach" },
  ob_f_remaining: { TH: "Remaining", EN: "Remaining" },
  ob_f_expiry: { TH: "*Expiry date", EN: "*Expiry date" },
  ob_f_advance_leave: { TH: "**Advance Leave Notice", EN: "**Advance Leave Notice" },
  // 🔴 The one value that must PRINT rather than vanish — see `line-message.ts`. A parent may be reading the
  // message to check exactly this, and silence cannot be told from a missing feature.
  ob_f_none: { TH: "ไม่มี", EN: "None" },
  // TASK-254 (REQ-077 Parent 3) — the customer's own heading, emoji included.
  ob_deduct_title: { TH: "💡COURSE DEDUCTION", EN: "💡COURSE DEDUCTION" },
  // TASK-256 (REQ-077 Parent 2) — likewise theirs, emoji and colon included.
  ob_today_title: { TH: "⏱️TODAY'S SCHEDULE:", EN: "⏱️TODAY'S SCHEDULE:" },
  // SPEC-075 / TASK-260 (REQ-076) — the two teacher messages, @Porter's copy VERBATIM from the REQ.
  // 📌 *"ยังไม่มีกำหนดใหม่"* is the whole point of the pause message: a hold with no new date is exactly what a
  // coach needs to know, and inventing one would be the reschedule this feature deliberately is not.
  ob_paused: {
    TH: "คาบนี้ถูกพักไว้ชั่วคราวค่ะ — {student} · {date} {time} · ยังไม่มีกำหนดใหม่",
    EN: "This class has been put on hold — {student} · {date} {time} · no new date yet",
  },
  ob_resumed: {
    TH: "คาบที่พักไว้ กลับมาลงตารางแล้วค่ะ — {student} · {date} {time}",
    EN: "The paused class is back on the schedule — {student} · {date} {time}",
  },
  // 🔴 TASK-257 §3 — the two lines kept BELOW the customer's block need labels in the customer's convention,
  // and they cannot reuse `ob_l_*`: those are bilingual, and `ob_l_note` also renders `booking_confirmed`,
  // whose text is owner-verified and byte-frozen. **The same key cannot serve two labelling conventions**, so
  // the fix is new keys rather than an edit — that is the whole of §3's cause, in one line.
  ob_f_sessions: { TH: "Sessions", EN: "Sessions" },
  ob_f_note: { TH: "Remark", EN: "Remark" },
  ob_dow_0: { TH: "อาทิตย์", EN: "Sunday" },
  ob_dow_1: { TH: "จันทร์", EN: "Monday" },
  ob_dow_2: { TH: "อังคาร", EN: "Tuesday" },
  ob_dow_3: { TH: "พุธ", EN: "Wednesday" },
  ob_dow_4: { TH: "พฤหัสบดี", EN: "Thursday" },
  ob_dow_5: { TH: "ศุกร์", EN: "Friday" },
  ob_dow_6: { TH: "เสาร์", EN: "Saturday" },
  ob_reschedule_title: { TH: "🔔 แจ้งขอย้ายคาบเรียน (มีการจองทับ)", EN: "🔔 Reschedule requested (slot clash)" },
  ob_l_oldslot: { TH: "คาบเดิม", EN: "Original" },
  ob_l_target: { TH: "ปลายทางที่เสนอ", EN: "Proposed" },
  ob_reschedule_foot: { TH: "กรุณาติดต่อกลับเพื่อยืนยันการย้าย", EN: "Please reply to confirm the move" },
  ob_sick_title: { TH: "🤒 แจ้งลา", EN: "🤒 Sick leave" },
  // REQ-049 / TASK-136 — one line each, per recipient language (AC-7). Admin keeps the 🤒 title above it.
  ob_leave_admin: {
    TH: "แจ้งลา: {student} · {date} {time} น. · ครู{teacher} · {program} — แจ้งโดย {by}",
    EN: "Leave: {student} · {date} {time} · {teacher} · {program} — reported by {by}",
  },
  ob_leave_teacher: {
    TH: "{student} ลาคาบ {date} {time} น. ({program}) — ช่วงเวลานี้ว่างแล้วค่ะ",
    EN: "{student} has cancelled {date} {time} ({program}) — that slot is now free.",
  },
  ob_l_class: { TH: "คาบ", EN: "Class" },
  ob_l_channel: { TH: "ช่องทาง", EN: "Channel" },
  ob_ch_line: { TH: "LINE", EN: "LINE" },
  ob_ch_system: { TH: "ระบบ", EN: "System" },
  ob_default: { TH: "🔔 แจ้งเตือนจากระบบตารางเรียน", EN: "🔔 Notification from the scheduler" },
  // TASK-094: a per-session teacher swap notifies BOTH teachers — the one it leaves and the one it lands on.
  ob_teacher_assigned_title: { TH: "👩‍🏫 คุณได้รับมอบหมายคาบสอนใหม่", EN: "👩‍🏫 A class has been assigned to you" },
  ob_teacher_unassigned_title: { TH: "📤 คาบสอนนี้ถูกย้ายออกจากตารางของคุณแล้ว", EN: "📤 A class has been removed from your schedule" },
};

export function t(key: string, lang: Lang = "TH", vars?: Record<string, string | number>): string {
  const e = TABLE[key];
  if (!e) return key; // defensive — an unknown key never crashes a reply
  let s = lang === "EN" && e.EN ? e.EN : e.TH; // missing EN → TH fallback
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/**
 * 🔴 TASK-275 (REQ-079 §18) — a CONVERSATIONAL BODY, in Thai and English together.
 *
 * ## The rule, and the two families it divides
 * §18 splits what was one question yesterday: **the conversation is bilingual; the notifications are not.**
 * The owner ruled the opposite on 09-06 (*"มันจะยาวเกินไป"*) and §18 reverses it **narrowly** — the length
 * objection still holds for the six notifications, so `formatOutboxMessage` is untouched and stays on
 * `t(key, lang)`. 🚫 Do not reach for these helpers there.
 *
 * ## 🔑 Why `both()` takes a BUILDER and not a key
 * A per-key `tb(key)` would be wrong for most of this bot's messages, and the reason is in the copy itself:
 * **several keys are SUFFIX FRAGMENTS that begin with a newline** — `verify_parent_children_count`,
 * `verify_parent_found`, `leave_extline`, `leave_lockline` — and many bodies are composed from two or three
 * keys plus data (`add_cancelled` + `menu_body`, `children_title` + a count, a summary head + rows +
 * a confirm line). Rendering each key as `TH\nEN` and then concatenating gives **TH/EN/TH/EN interleaved
 * down the message**, and on `children_title` it puts the count on the English line only.
 * ⇒ **Compose the WHOLE body once per language, then join once.** That is the only shape that is correct for
 * a composed body, and it is correct for a simple one too.
 *
 * ## The control is still the signature
 * `both()` returns both languages by construction — there is no argument that could make it render one — and
 * label helpers keep `t(key, lang)`, which is what stops a 20-character LINE label quietly becoming 40.
 * (`tb(key)` below is the one-key convenience, defined in terms of this so there is one joining rule.)
 *
 * ⚠️ The separator is a single newline and nothing else: no brackets, no `(EN)` marker — the customer's own
 * copy puts the English plainly under the Thai.
 */
export function both(build: (lang: Lang) => string): string {
  return `${build("TH")}\n${build("EN")}`;
}

/** The one-key body. `both()`'s common case, so the joining rule lives in exactly one place. */
export const tb = (key: string, vars?: Record<string, string | number>): string =>
  both((lang) => t(key, lang, vars));
/** Seed a language from a LINE profile locale string (e.g. "en", "th-TH"). Non-EN → TH. */
export const langFromLocale = (locale: string | null | undefined): Lang =>
  typeof locale === "string" && locale.toLowerCase().startsWith("en") ? "EN" : "TH";
