// LINE bot i18n (REQ-015 / TASK-039). Every user-facing string lives here keyed TH/EN; `t(key, lang, vars)`
// renders one. Missing EN falls back to TH (never a raw key). `{var}` placeholders are interpolated. This is
// the single source of bot copy — no user-visible literal should remain in the service / reply / message layer.

export type Lang = "TH" | "EN";
export const isLang = (v: unknown): v is Lang => v === "TH" || v === "EN";

interface Entry {
  TH: string;
  EN?: string;
}

const TABLE: Record<string, Entry> = {
  welcome: {
    TH: "สวัสดีค่ะ ยินดีต้อนรับสู่ Smart Scheduler\n\nพิมพ์ สมัคร เพื่อผูกบัญชี LINE\nหลังผูกแล้ว (ผู้ปกครอง): เพิ่มนักเรียน · เช็คอิน · ลา · qr",
    EN: "Welcome to Smart Scheduler 👋\n\nType 'register' to link your LINE account.\nOnce linked (parent): add child · check-in · leave · qr",
  },
  // SPEC-071 / TASK-231 — AC-18: two unexpected replies inside a flow and the bot stops trying. The apology
  // matters: the parent has just failed twice and the next voice they hear should be a person.
  handover_to_admin: {
    TH: "ขอโทษค่ะ ขอส่งให้แอดมินช่วยดูนะคะ 🙏",
    EN: "Sorry about that — I am passing this to an admin to help you. 🙏",
  },
  role_prompt: {
    TH: "เลือกบทบาทของคุณ:\n1 = ลูกค้า/ผู้ปกครอง\n2 = ครู\n3 = แอดมิน",
    EN: "Choose your role:\n1 = Customer/Parent\n2 = Teacher\n3 = Admin",
  },
  code_customer: { TH: "กรุณาพิมพ์เบอร์โทรของผู้ปกครอง (เช่น 0812345678)", EN: "Please type the parent's phone number (e.g. 0812345678)" },
  code_teacher: { TH: "กรุณาพิมพ์ชื่อเล่นครูตามที่ลงทะเบียนในระบบ", EN: "Please type the teacher nickname as registered" },
  code_admin: { TH: "กรุณาพิมพ์รหัสแอดมิน (เช่น 229)", EN: "Please type the admin code (e.g. 229)" },

  add_student_prompt: {
    TH: 'ต้องการเพิ่มนักเรียน (ลูก) ไหมคะ?\nพิมพ์ชื่อนักเรียน เช่น "น้องพีพี" (เพิ่มได้สูงสุด {max} คนต่อเบอร์)\nหรือพิมพ์ "ข้าม" หากยังไม่เพิ่มตอนนี้',
    EN: 'Would you like to add a child?\nType the student name (e.g. "PP") — up to {max} per phone.\nOr type "skip" to do it later.',
  },
  add_student_name_prompt: { TH: "พิมพ์ชื่อนักเรียนที่ต้องการเพิ่ม (สูงสุด {max} คนต่อเบอร์)", EN: "Type the student name to add (up to {max} per phone)" },

  menu_title: { TH: "เมนูหลัก — แตะเพื่อใช้งาน", EN: "Main menu — tap to use" },
  menu_body: {
    TH: "คำสั่งที่ใช้ได้:\n· เพิ่มนักเรียน — เพิ่มลูกเข้าระบบ (สูงสุด 5 คน)\n· นักเรียน — ดูรายชื่อลูกของคุณ\n· เช็คอิน — เช็คอินคาบวันนี้\n· ลา — แจ้งลาคาบวันนี้\n· qr — รับลิงก์เช็คอิน\n· เมนู — แสดงคำสั่งนี้อีกครั้ง",
    EN: "Available commands:\n· add child — register a child (up to 5)\n· children — list your children\n· check-in — check in today's class\n· leave — report sick leave today\n· qr — get a check-in link\n· menu — show this again",
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
  verify_parent_ok_existing: { TH: "ผูกบัญชีผู้ปกครองสำเร็จ ✅ (เบอร์ {phone}){list}", EN: "Parent account linked ✅ (phone {phone}){list}" },
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
  twofa_prompt: {
    TH: "กรุณาพิมพ์รหัส 6 หลักเพื่อยืนยันตัวตนค่ะ",
    EN: "Please type the 6-digit code to verify your identity.",
  },
  twofa_bad: {
    TH: "รหัสไม่ถูกต้องค่ะ กรุณาลองใหม่อีกครั้ง",
    EN: "That code is not correct. Please try again.",
  },
  verify_parent_ok_new: { TH: "ลงทะเบียนผู้ปกครองสำเร็จ ✅ (เบอร์ {phone})", EN: "Parent registered ✅ (phone {phone})" },

  added_more: { TH: 'เพิ่ม "{name}" สำเร็จ ✅ (ตอนนี้มี {count} คน)\nพิมพ์ชื่อคนถัดไป หรือพิมพ์ "ข้าม" เพื่อจบ', EN: 'Added "{name}" ✅ (now {count})\nType the next name, or "skip" to finish' },
  added_done: { TH: 'เพิ่ม "{name}" สำเร็จ ✅{note}', EN: 'Added "{name}" ✅{note}' },
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
  att_unconfirmed_bookings: { TH: "คาบที่ยังไม่ยืนยัน (วันนี้/พรุ่งนี้)", EN: "Unconfirmed classes (today/tomorrow)" },
  att_teachers_without_line: { TH: "ครูที่ยังไม่ผูก LINE", EN: "Teachers without LINE linked" },
  att_expiring_entitlements: { TH: "คอร์ส/วอยเชอร์ที่ใกล้หมดอายุ", EN: "Courses/vouchers expiring soon" },
  att_nearly_finished_courses: { TH: "คอร์สที่ใกล้ใช้ครบ", EN: "Courses nearly finished" },
  att_freelance_near_cap: { TH: "ครูฟรีแลนซ์ที่งบใกล้เต็ม", EN: "Freelance budgets near their cap" },
  att_incomplete_students: { TH: "นักเรียนที่ข้อมูลไม่ครบ", EN: "Students with incomplete details" },
  // REQ-070 / TASK-180: `att_yesterday_no_shows` deleted with its check — the day-end job no longer writes
  // NO_SHOW, so the line could only ever say "0".
  att_pending_teacher_links: {
    TH: "คำขอผูกบัญชีครูที่รออนุมัติ",
    EN: "Teacher link requests awaiting approval",
  },
  att_sales_not_posted: {
    TH: "การขายที่ยังไม่ลงบัญชี",
    EN: "Sales not posted to backoffice",
  },
  // SPEC-059 / TASK-163 — a discount the admin promised that the day-end sale did not apply.
  att_discount_not_applied: {
    TH: "ส่วนลดที่ไม่ได้ถูกใช้ (ขายเต็มราคา)",
    EN: "Discounts not applied (charged full price)",
  },
  att_orphaned_sessions: {
    TH: "คาบในอนาคตที่ครูไม่พร้อม (ปิดใช้งาน/ไม่สอนวันนั้น)",
    EN: "Future sessions with an unavailable teacher (archived / off that weekday)",
  },
  digest_header: { TH: "📋 สรุปสิ่งที่ต้องดูแลวันนี้", EN: "📋 Today's attention summary" },
  digest_footer: { TH: "ดูรายละเอียดทั้งหมดในเว็บแอป", EN: "See full details in the web app" },
  digest_more: { TH: "+ อีก {n} รายการ — ดูในเว็บแอป", EN: "+{n} more — see the web app" },
  digest_check_failed: { TH: "ตรวจสอบไม่สำเร็จ", EN: "check failed" },

  // REQ-019 / TASK-048: a suspended household gets a short refusal and NO data.
  suspended_notice: {
    TH: "บัญชีถูกระงับ — ติดต่อเจ้าหน้าที่",
    EN: "This account is suspended — please contact staff",
  },
  status_PENDING: { TH: "รอยืนยัน", EN: "Pending" },
  status_CONFIRMED: { TH: "ยืนยันแล้ว", EN: "Confirmed" },
  status_ATTENDED: { TH: "เข้าเรียนแล้ว", EN: "Attended" },
  status_SICK_LEAVE: { TH: "ลา", EN: "Leave" },
  status_EXTENDED: { TH: "คาบขยาย", EN: "Extended" },
  status_NO_SHOW: { TH: "ไม่มา", EN: "No-show" },
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
  ob_course_title: { TH: "📅 ยืนยันคอร์สแล้ว", EN: "📅 Course schedule confirmed" },
  ob_l_start: { TH: "เริ่ม", EN: "Starts" },
  ob_l_schedule: { TH: "ตารางเรียน", EN: "Schedule" },
  ob_l_sessions: { TH: "จำนวนคาบที่ยืนยัน", EN: "Sessions confirmed" },
  // TASK-206: the label names DAYS, because the value is now a list of dates rather than a tally.
  ob_l_planned_leave: { TH: "แจ้งลาล่วงหน้าไว้ (วันที่)", EN: "Leave already booked (dates)" },
  ob_l_note: { TH: "หมายเหตุ", EN: "Note" },
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

/** Seed a language from a LINE profile locale string (e.g. "en", "th-TH"). Non-EN → TH. */
export const langFromLocale = (locale: string | null | undefined): Lang =>
  typeof locale === "string" && locale.toLowerCase().startsWith("en") ? "EN" : "TH";
