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

/**
 * 🔴 TASK-310 (REQ-079 §17c) — **THE CUSTOMER'S REGISTRATION COPY, VERBATIM.** Their words are the spec:
 * *"ลูกค้าส่งมาให้ทำตามเลย"*. 🚫 Nothing here is paraphrased, shortened or "improved".
 *
 * ## 🔑 Why these are a table of their own, and not ordinary `TH` / `EN` entries
 * Every other string in this file is *"the Thai one **or** the English one"*, and `both()` stacks a whole
 * Thai body above a whole English one. **The customer's screens are not shaped like that — they alternate
 * LINE BY LINE**: a Thai sentence, its English sentence, the next pair, and on screen 4 a `TH / EN: value`
 * line in the middle of them. ⇒ **there is no pair of `TH`/`EN` values `both()` could join to produce their
 * screen.** Each of these is ONE block that is the same in either language.
 * ⚠️ **So they must never be wrapped in `both()` / `tb()`** — that prints the block twice. `tb()` refuses,
 * by construction rather than by convention (see its definition below).
 * 📌 This is what `TASK-310 §1` means by *"the registration screens are BILINGUAL"*: the STRING is, so the
 * call site keeps `t(key, lang)` and every site renders the identical screen. **`both()` is for a reader
 * whose language is not yet known; during registration it is not known, and the customer already wrote the
 * answer into the copy.**
 *
 * 🚫 **NONE of §17c's eight numbered headings appears here** — `§17f`: *"they are a table of contents, not
 * copy"*, and screen 2's *"เลือกบทบาท / Select Your Role"* would tell a parent both that roles exist and
 * that they were not offered a choice — **the exact thing `REQ-085 §5` removes.**
 */
export const REGISTRATION_COPY = {
  /** §17c screen 1 — the entry keyword is `สมัคร` / `register`, and it is the whole message. */
  welcome: 'กรุณาพิมพ์ "สมัคร" เพื่อลงทะเบียนค่ะ\nPlease type "register" to start.',
  /**
   * §17c screen 2 — 🔴 **`REQ-085 §5` lives in this string.** It offers ONE path: type `Next`, and `Next` is
   * a PARENT. 🚫 No role list, no role words, no buttons — a teacher or an admin types their own word
   * without being told to. ⚠️ The words `ครู` / `แอดมิน` are still ACCEPTED (`parseRoleChoice`); they are
   * simply never advertised, which is what §5 asks for (`§17e`: the owner accepted knowingly that a parent
   * CAN guess `ครู`). 🚫 `CEO` is skipped entirely — it stays a word in the REQ and is no code path.
   */
  role_prompt: 'กรุณาพิมพ์ "Next" เพื่อเข้าใช้งานค่ะ\nPlease type "Next" to continue.',
  /** §17c screen 3. 🚫 `code_teacher` / `code_admin` are NOT §17c screens — no parent ever reads them. */
  code_customer: "กรุณาระบุเบอร์โทรศัพท์ค่ะ\nPlease enter your phone number.",
  /**
   * §17c screen 4, first half. ⚠️ Their `082-503-1502` is `{phone}` — `§17d-4`, ruled by the owner: the
   * screen shows **the number the person just typed**, so a literal would have shipped their example.
   * (`formatPhoneForDisplay` renders it in their shape; the stored value stays digits.)
   */
  verify_parent_ok_new: "ลงทะเบียนผู้ปกครองสำเร็จแล้วค่ะ ✅\nRegistration completed ✅\nเบอร์โทรศัพท์ / Phone: {phone}",
  /**
   * §17c screen 4, second half — asked as one body with the line above it.
   * 🔻 **Their sentence carries neither the `{max}` cap nor the `ข้าม` escape our wording had.** The cap is
   * still enforced (`assertCanAddStudent`) and `ข้าม` is still ACCEPTED — but `REQ-085 §6` refuses a skip at
   * the FIRST child, so this screen was advertising a way out the flow now declines to take. **Reported.**
   */
  add_student_prompt: 'กรุณาระบุชื่อนักเรียน เช่น "ส้ม"\nPlease enter the student\'s name, e.g. "Emily".',
  /** The same question, asked again — one string, so the re-ask and the first ask cannot drift (TASK-307 §3). */
  add_student_name_prompt: 'กรุณาระบุชื่อนักเรียน เช่น "ส้ม"\nPlease enter the student\'s name, e.g. "Emily".',
  /** §17c screen 5. ⚠️ `(วัน-เดือน-ปีค.ศ. )` is their spacing, kept — Gregorian, day-first, the owner's ruling. */
  add_birthdate_prompt: "กรุณาระบุวันเกิดของนักเรียนค่ะ\n(วัน-เดือน-ปีค.ศ. )\nPlease enter the date of birth in (DD-MM-YYYY)",
  /**
   * §17c screen 6. 🚫 **The FIELD does not change** (`§17e`'s correction): the prompt names District /
   * Sub-district / Province as GUIDANCE and the answer is, and stays, one free-text value.
   * ⚠️ Their English block is wrapped in a `"` … `"` pair in the source document. **Not reproduced** — a
   * quotation mark opening one line and closing another reads as a typo on a phone, and by `§17f`'s own
   * reasoning it is document punctuation rather than copy. **Reported; it is the only byte I changed.**
   */
  add_province_prompt:
    "กรุณาระบุ เขต แขวง จังหวัด เช่น พระโขนงเหนือ วัฒนา กทม\nPlease enter your address: District, Sub-district, Province\nEg. Prakanueng Nuea, Wattana, BKK",
  /** §17c screen 7, head. */
  add_summary_head: "กรุณาตรวจสอบข้อมูลก่อนบันทึกค่ะ\nPlease check your information before saving.",
  /**
   * §17c screen 7, foot. 🚫 Their last two lines — *"พิมพ์ ยกเลิก เพื่อออกจากการลงทะเบียน / Type "Cancel" to
   * exit."* — are NOT here: `withExit` (TASK-245) already appends the exit to every question, and putting
   * them back inside this string prints the exit TWICE on the one step that used to carry it inline.
   * **TASK-278 §4.1 ruled this and the ruling is unchanged.**
   */
  add_summary_confirm: 'ข้อมูลถูกต้องหรือไม่คะ?\nIs this information correct?\nกรุณาพิมพ์ "ยืนยัน" เพื่อบันทึก\nPlease Type "Confirm" to save.',
  /** §17c screen 7's three labels. 🚫 `ที่อยู่ / Address` is a LABEL change only — the column is still `province`. */
  add_l_name: "ชื่อ / Name",
  add_l_birthdate: "วันเดือนปีเกิด / Date of Birth",
  add_l_province: "ที่อยู่ / Address",
  add_l_none: "ไม่ระบุ / not given",
  /** §17c screen 8. Their `"Nong DC"` is the example child in a copy document, so it is `{name}`. */
  added_done: 'เพิ่ม "{name}" สำเร็จแล้วค่ะ ✅\n"{name}" has been added successfully. ✅{note}',
  /**
   * §17c screen 8's tail. ⚠️ A separate key because it is CONDITIONAL: a household at `MAX_STUDENTS_PER_PARENT`
   * must not be invited to add another. **Their words, not new copy** — the condition is ours, the sentence
   * is theirs.
   */
  add_another_hint:
    'หากต้องการเพิ่มนักเรียนเข้าระบบ\nกรุณาพิมพ์ "เพิ่มนักเรียน" ค่ะ\nIf you would like to add another student,\nplease type "Add Student".',
} as const;

/** The i18n keys whose value is the customer's own bilingual block. Used by `tb()` and by the §17c tests. */
export const REGISTRATION_KEYS = Object.keys(REGISTRATION_COPY) as Array<keyof typeof REGISTRATION_COPY>;
/** 🔑 One block, two identical language slots — so `t(key, lang)` renders their screen whichever way it is called. */
const REGISTRATION_ENTRIES = Object.fromEntries(
  Object.entries(REGISTRATION_COPY).map(([key, body]) => [key, { TH: body, EN: body }]),
) as Record<string, Entry>;

const TABLE: Record<string, Entry> = {
  ...REGISTRATION_ENTRIES,
  // SPEC-071 / TASK-231 — AC-18: two unexpected replies inside a flow and the bot stops trying. The apology
  // matters: the parent has just failed twice and the next voice they hear should be a person.
  // 🔴 TASK-246 / AC-24 — the message that MUTES the chat is the message that must name the way back in. A way
  // out nobody was told about is not a way out, and this is the one screen a muted parent is guaranteed to have
  // read. (LINE on PC has no rich menu at all, so "tap something" is not an answer for them.)
  handover_to_admin: {
    TH: "ขอโทษค่ะ ขอส่งให้แอดมินช่วยดูนะคะ 🙏\n(ถ้าต้องการใช้บอทอีกครั้ง พิมพ์ เปิดเมนู ค่ะ)",
    EN: "Sorry about that — I am passing this to an admin to help you. 🙏\n(To use the bot again, type: reopen)",
  },
  code_teacher: { TH: "กรุณาพิมพ์ชื่อเล่นครูตามที่ลงทะเบียนในระบบ", EN: "Please type the teacher nickname as registered" },
  code_admin: { TH: "กรุณาพิมพ์รหัสแอดมิน (เช่น 229)", EN: "Please type the admin code (e.g. 229)" },


  menu_title: { TH: "เมนูหลัก — แตะเพื่อใช้งาน", EN: "Main menu — tap to use" },
  // 🔴 TASK-245 "Face 2" — the last line is the half of AC-16's trade that was missing from the live product.
  // The bot went silent by default, but nothing told the person in front of it that a HUMAN still reads the
  // chat. The command list is the right home because the person reading it is, by definition, the lost one.
  // 🚫 Deliberately NOT a new rich-menu cell: that needs an image the owner has not asked for (task scope).
  menu_body: {
    TH: "คำสั่งที่ใช้ได้:\n· เพิ่มนักเรียน — เพิ่มลูกเข้าระบบ (สูงสุด 5 คน)\n· นักเรียน — ดูรายชื่อลูกของคุณ\n· เช็คอิน — เช็คอินคาบวันนี้\n· ลา — แจ้งลาคาบวันนี้\n· qr — รับลิงก์เช็คอิน\n· เมนู — แสดงคำสั่งนี้อีกครั้ง\n\nหรือพิมพ์คำถามเข้ามาได้เลยค่ะ เดี๋ยวแอดมินมาตอบนะคะ 🙏",
    EN: "Available commands:\n· Add Student — register a child (up to 5)\n· children — list your children\n· check-in — check in today's class\n· leave — report sick leave today\n· qr — get a check-in link\n· menu — show this again\n\nOr just type your question — an admin will read it and reply. 🙏",
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
  // 🔴 TASK-316 §4(d) — the message had to become TRUE. `ลา` now looks at every UPCOMING session, so *"today"*
  // was no longer what it had checked. ⚠️ And the two situations are DIFFERENT: nothing to cancel at all, and
  // classes that exist but are all inside the cut-off. **A parent could be TOO EARLY and TOO LATE and read the
  // same sentence.** 📌 The owner's own distinction: *"too late for tomorrow's class, call the school" is help;
  // "no class eligible" is a shrug.* 🚫 The second key names no number — the cut-off is a per-teacher-type
  // setting, and a sentence that hardcoded one would be a second copy of the rule.
  empty_leave: { TH: "ไม่มีคาบที่จะแจ้งลาค่ะ", EN: "You have no upcoming classes to cancel" },
  empty_leave_cutoff: {
    TH: "คาบที่เหลือใกล้ถึงเวลาเรียนแล้ว แจ้งลาผ่านบอทไม่ทันค่ะ กรุณาติดต่อแอดมิน",
    EN: "Your upcoming classes are too close to their start time to cancel here. Please contact the admin.",
  },

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
  add_birthdate_bad: {
    TH: "รูปแบบวันเกิดไม่ถูกต้องค่ะ กรุณาพิมพ์เป็น วัน-เดือน-ปี เช่น 02-12-2024 หรือพิมพ์ ข้าม",
    EN: "That date format is not valid. Please use DD-MM-YYYY, e.g. 02-12-2024, or type skip.",
  },
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

  added_more: { TH: 'เพิ่ม "{name}" สำเร็จ ✅ (ตอนนี้มี {count} คน)\nพิมพ์ชื่อคนถัดไป หรือพิมพ์ "ข้าม" เพื่อจบ', EN: 'Added "{name}" ✅ (now {count})\nType the next name, or "skip" to finish' },
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
  //
  // 🔴 TASK-323 (`REQ-085 §16g`) — the COMMAND headers, restored to the customer's own form. 🔑 **This is not a
  // change to their spec; it is a failure to have matched it:** `§7.2`'s COMMAND example already reads
  // `TODAY'S SCHEDULE:` with the clock, and `ob_today_title` has carried exactly that for the AUTO message all
  // along. **We drifted; we are going back.**
  // 🚫 HEADERS ONLY. The compact COMMAND body is untouched — @Porter's standing instruction that AUTO and
  // COMMAND are different SHAPES by design still stands, and `§16f`'s "unify them" reading was withdrawn.
  //
  // ## ❓ Reuse `ob_today_title`, or its own key? — **its own key, and the coincidence is ASSERTED.**
  // Reuse would make a future edit to their AUTO header move the COMMAND one SILENTLY, which is the thing to
  // avoid. A second copy would let the two drift silently, which is equally bad. ⇒ **separate keys, and a test
  // pins `tsched_title_today` EQUAL to `ob_today_title`** — so the day either moves, a human is told and
  // decides, instead of one of the two failure modes happening quietly. 📌 It also keeps the two COMMAND
  // headers side by side, which is where anyone editing one will look for the other.
  tsched_title_today: { TH: "⏱️TODAY'S SCHEDULE:", EN: "⏱️TODAY'S SCHEDULE:" },
  // 📖 **PLACEHOLDER — @PORTER'S, and the customer has NOT seen it.** Their four messages contain no weekly
  // schedule, so nothing specifies this header; matching the daily one is the only choice that does not invent
  // a third style. ⚠️ **This is NOT a ratified string.** ⇒ its test pins the FORM it must keep (the clock, upper
  // case, the trailing colon, the same shape as its daily twin) and **deliberately does not byte-freeze the
  // words** — the convention `PENDING_RESCHEDULE` already uses, applied the moment we write copy ahead of them.
  tsched_title_week: { TH: "⏱️THIS WEEK'S SCHEDULE:", EN: "⏱️THIS WEEK'S SCHEDULE:" },
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
  // 🔴 REQ-085 §9.1 (TASK-305) — ENGLISH in both languages, by the owner's §9 ruling. 🔻 The Thai `แจ้งลา`
  // in §7.4's earlier block is SUPERSEDED by it.
  // 🔑 REQ-085 §12 (TASK-309 §3) — an ADMIN alert, in the admin-alert convention (Thai, like `ob_leave_admin`
  // beside it) rather than the §7 templates' English: this is our own operational warning, not one of the
  // customer's messages.
  // ⚠️ **The wording is mine and the NUMBER is not.** §3 asked for the FACT reported and the threshold left
  // to @Porter — so the sentence states how far, and decides nothing.
  ob_makeup_far: {
    TH: "⚠️ คาบชดเชยถูกจัดไปไกลกว่าปกติ: {weeks} สัปดาห์หลังคาบที่ลา ({replaces} → {landedOn}) — ตารางครูช่วงนี้เต็ม",
    EN: "⚠️ A make-up landed further out than usual: {weeks} weeks after the session it replaces ({replaces} → {landedOn}) — that coach's slot is fully booked.",
  },
  // 🔴 TASK-318 (`REQ-085 §16e`) — the customer's own header, BILINGUAL. 🔻 This REVERSES the owner's `§9`
  // English-header ruling, which he gave before the customer had asked for anything. **Superseded, not wrong.**
  //
  // 🔑 THE BOUNDARY, and it is why this survives the next reader — @Porter's words:
  //     **`§4` governs values the system GENERATES. It never governed what a message is CALLED.**
  // 📌 `§4` — *"eng ล้วน ไม่ควรไทยเลยแม้แต่ติด"* — was always about OUR OWN words: `Date : อังคาร` → `Tuesday`,
  // `ไม่มี` → `(-)`. ⚠️ Without this sentence beside it, someone "fixes" the header back to English next month
  // by citing `§4` — **which is exactly the shape that let `Date : อังคาร` ship after `REQ-079 §18` had already
  // ruled labels English.** ***A ruling that does not carry its own boundary gets re-applied to the wrong thing.***
  // ✅ And the audience is what makes it hold: this message reaches COACHES and ADMINS, never a parent. **The one
  // notification with a Thai header is the one no parent ever sees.**
  ob_leave_notice_title: { TH: "LEAVE NOTICE / แจ้งลา ‼️", EN: "LEAVE NOTICE / แจ้งลา ‼️" },
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
  const th = build("TH");
  const en = build("EN");
  // 🔴 TASK-310 (REQ-079 §17c) — **`both()` never prints the same text twice.**
  // The customer's registration screens carry Thai and English INTERLEAVED, exactly as they wrote them, so
  // `t(key, "TH")` and `t(key, "EN")` are the identical block. ⚠️ Joining them would send their whole screen
  // TWICE. 🔑 The rule lives HERE, in the joiner, rather than in a list of keys every call site must know:
  // **a body that is the same in both languages is already both languages** — true of any such body, not
  // only theirs. 📌 It is also what keeps §17c's screens safe inside COMPOSED bodies.
  return th === en ? th : `${th}\n${en}`;
}

/**
 * The one-key body. `both()`'s common case, so the joining rule lives in exactly one place.
 *
 * 🔴 TASK-310 (REQ-079 §17c) — **it does not double the customer's own screens**, because `both()` above
 * refuses to. ⚠️ That guard belongs to the JOINER and not here, nor at the call sites: `` tb(`code_${role}`) ``
 * renders a §17c screen for a parent and one of OURS for a teacher **from one expression** — there is no
 * call site that could carry the rule.
 */
export const tb = (key: string, vars?: Record<string, string | number>): string =>
  both((lang) => t(key, lang, vars));
/** Seed a language from a LINE profile locale string (e.g. "en", "th-TH"). Non-EN → TH. */
export const langFromLocale = (locale: string | null | undefined): Lang =>
  typeof locale === "string" && locale.toLowerCase().startsWith("en") ? "EN" : "TH";
