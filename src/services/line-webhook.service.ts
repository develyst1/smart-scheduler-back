// LINE OA webhook handler — role verification (C.4) + parent self-service.
// Parent flow: พิมพ์ "สมัคร" → เลือกบทบาท → ใส่เบอร์ → (ผูก/สร้างผู้ปกครอง) →
// เพิ่มนักเรียน (ลูก) ได้สูงสุด 5 คนต่อเบอร์. เบอร์เดียวมีนักเรียนได้หลายคน และ
// คำสั่งเช็คอิน/ลา/qr ทำงานกับนักเรียนทุกคนของเบอร์นั้น.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { lineLinkSessions, teachers } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { replyMessage, type LineTextMessage } from "../lib/line-client";
import {
  eventText,
  eventUserId,
  parseRoleChoice,
  type LineWebhookEvent,
} from "../lib/line-webhook";
import { addAdminLineUserId, getAdminLineUserIds } from "../lib/line-admin";
import {
  MAX_STUDENTS_PER_PARENT,
  createStudentForParent,
  findOrCreateParentByPhone,
  findParentByLineUserId,
  findParentByPhone,
  linkParentLine,
  listStudentsOfParent,
  normalizePhone,
} from "./parent.service";
import { hhmm } from "../lib/time";
import { checkinByToken, findTodayBookingsForParent, getCheckinQr } from "./checkin.service";
import { updateBookingStatus } from "./scheduler.service";

const WELCOME =
  "สวัสดีค่ะ ยินดีต้อนรับสู่ Smart Scheduler\n\n" +
  "พิมพ์ สมัคร เพื่อผูกบัญชี LINE\n" +
  "หลังผูกแล้ว (ผู้ปกครอง): เพิ่มนักเรียน · เช็คอิน · ลา · qr";

const ROLE_PROMPT =
  "เลือกบทบาทของคุณ:\n" +
  "1 = ลูกค้า/ผู้ปกครอง\n" +
  "2 = ครู\n" +
  "3 = แอดมิน";

const CODE_PROMPT: Record<string, string> = {
  customer: "กรุณาพิมพ์เบอร์โทรของผู้ปกครอง (เช่น 0812345678)",
  teacher: "กรุณาพิมพ์ชื่อเล่นครูตามที่ลงทะเบียนในระบบ",
  admin: "กรุณาพิมพ์รหัสแอดมิน (เช่น 229)",
};

const ADD_STUDENT_PROMPT =
  `ต้องการเพิ่มนักเรียน (ลูก) ไหมคะ?\n` +
  `พิมพ์ชื่อนักเรียน เช่น "น้องพีพี" (เพิ่มได้สูงสุด ${MAX_STUDENTS_PER_PARENT} คนต่อเบอร์)\n` +
  `หรือพิมพ์ "ข้าม" หากยังไม่เพิ่มตอนนี้`;

const LINKED_PARENT_MENU =
  "คำสั่งที่ใช้ได้:\n" +
  "· เพิ่มนักเรียน — เพิ่มลูกเข้าระบบ (สูงสุด 5 คน)\n" +
  "· นักเรียน — ดูรายชื่อลูกของคุณ\n" +
  "· เช็คอิน — เช็คอินคาบวันนี้\n" +
  "· ลา — แจ้งลาคาบวันนี้\n" +
  "· qr — รับลิงก์เช็คอิน\n" +
  "· เมนู — แสดงคำสั่งนี้อีกครั้ง";

const SKIP_WORDS = ["ข้าม", "ไม่", "ไม่เพิ่ม", "เสร็จ", "จบ", "skip", "no", "done"];

type LinkRole = "customer" | "teacher" | "admin";
type VerifyResult = { ok: boolean; message: string };

async function reply(replyToken: string, text: string) {
  const msg: LineTextMessage = { type: "text", text };
  await replyMessage(replyToken, [msg]);
}

async function getSession(lineUserId: string) {
  return db.query.lineLinkSessions.findFirst({
    where: (s, { eq: e }) => e(s.lineUserId, lineUserId),
  });
}

async function setStep(lineUserId: string, step: string, pendingRole: string | null = null) {
  await db
    .insert(lineLinkSessions)
    .values({ lineUserId, step, pendingRole })
    .onConflictDoUpdate({
      target: lineLinkSessions.lineUserId,
      set: { step, pendingRole, updatedAt: new Date() },
    });
}

async function clearSession(lineUserId: string) {
  await db.delete(lineLinkSessions).where(eq(lineLinkSessions.lineUserId, lineUserId));
}

async function detectLinkedRole(lineUserId: string): Promise<LinkRole | null> {
  const [teacher, parent, admins] = await Promise.all([
    db.query.teachers.findFirst({ where: (t, { eq: e }) => e(t.lineUserId, lineUserId) }),
    findParentByLineUserId(lineUserId),
    getAdminLineUserIds(),
  ]);
  if (teacher) return "teacher";
  if (parent) return "customer";
  if (admins.includes(lineUserId)) return "admin";
  return null;
}

async function verifyAndLink(
  lineUserId: string,
  role: LinkRole,
  code: string,
): Promise<VerifyResult> {
  if (role === "admin") {
    const expected = process.env.LINE_ADMIN_VERIFY_CODE ?? "229";
    if (code.trim() !== expected) return { ok: false, message: "รหัสแอดมินไม่ถูกต้อง ลองใหม่อีกครั้ง" };
    await addAdminLineUserId(lineUserId);
    return { ok: true, message: "ผูกบัญชีแอดมินสำเร็จ ✅ จะได้รับแจ้งเตือนเมื่อมีการแจ้งลา" };
  }

  if (role === "teacher") {
    const nick = code.trim();
    const rows = await db.select().from(teachers);
    const teacher = rows.find((t) => t.nickname.toLowerCase() === nick.toLowerCase());
    if (!teacher) return { ok: false, message: `ไม่พบครูชื่อเล่น "${nick}" — ตรวจสอบอีกครั้ง` };
    if (teacher.lineUserId && teacher.lineUserId !== lineUserId) {
      return { ok: false, message: "ครูคนนี้ผูก LINE กับบัญชีอื่นแล้ว ติดต่อแอดมิน" };
    }
    await db.update(teachers).set({ lineUserId }).where(eq(teachers.id, teacher.id));
    return {
      ok: true,
      message: `ผูกบัญชีครูสำเร็จ ✅ (${teacher.nickname}) จะได้รับแจ้งเตือนเมื่อมีการยืนยันตาราง`,
    };
  }

  // customer / parent — keyed by phone. One phone = one parent (many children).
  const phone = normalizePhone(code);
  if (phone.length < 9) {
    return { ok: false, message: "เบอร์โทรไม่ถูกต้อง กรุณาพิมพ์เบอร์ที่ลงทะเบียน (เช่น 0812345678)" };
  }
  const existing = await findParentByPhone(phone);
  if (existing) {
    if (existing.lineUserId && existing.lineUserId !== lineUserId) {
      return { ok: false, message: "เบอร์นี้ผูกกับ LINE อื่นแล้ว ติดต่อแอดมิน" };
    }
    await linkParentLine(existing.id, lineUserId);
    const kids = await listStudentsOfParent(existing.id);
    const list = kids.length ? `\nนักเรียนในระบบ: ${kids.map((k) => k.name).join(", ")}` : "";
    return { ok: true, message: `ผูกบัญชีผู้ปกครองสำเร็จ ✅ (เบอร์ ${phone})${list}` };
  }
  await findOrCreateParentByPhone(phone, { lineUserId });
  return { ok: true, message: `ลงทะเบียนผู้ปกครองสำเร็จ ✅ (เบอร์ ${phone})` };
}

/** Create one student under the linked parent and craft the right reply. */
async function addStudentAndReply(
  lineUserId: string,
  name: string,
  replyToken: string,
  opts: { continueSession: boolean },
) {
  const parent = await findParentByLineUserId(lineUserId);
  if (!parent) {
    await clearSession(lineUserId);
    return reply(replyToken, "ไม่พบบัญชีผู้ปกครอง พิมพ์ สมัคร เพื่อเริ่มใหม่");
  }
  try {
    const { student, count } = await createStudentForParent(parent.id, { name });
    const atMax = count >= MAX_STUDENTS_PER_PARENT;
    if (opts.continueSession && !atMax) {
      return reply(
        replyToken,
        `เพิ่ม "${student.name}" สำเร็จ ✅ (ตอนนี้มี ${count} คน)\n` +
          `พิมพ์ชื่อคนถัดไป หรือพิมพ์ "ข้าม" เพื่อจบ`,
      );
    }
    await clearSession(lineUserId);
    const note = atMax ? ` (ครบ ${MAX_STUDENTS_PER_PARENT} คนแล้ว)` : "";
    return reply(replyToken, `เพิ่ม "${student.name}" สำเร็จ ✅${note}\n\n${LINKED_PARENT_MENU}`);
  } catch (e: any) {
    const msg = e?.message ?? "ไม่สามารถเพิ่มนักเรียนได้";
    if (msg.includes("สูงสุด")) {
      await clearSession(lineUserId);
      return reply(replyToken, `${msg}\n\n${LINKED_PARENT_MENU}`);
    }
    return reply(replyToken, msg); // keep the session so they can retry the name
  }
}

async function handleParentCommand(lineUserId: string, text: string, replyToken: string) {
  const raw = text.trim();
  const cmd = raw.toLowerCase();
  const { date } = bangkokNow();

  if (["เมนู", "menu", "help", "ช่วยเหลือ"].includes(cmd)) {
    return reply(replyToken, LINKED_PARENT_MENU);
  }

  // Add a student — inline ("เพิ่มนักเรียน น้องเอ") or start a name prompt.
  const addMatch = raw.match(/^(?:เพิ่มนักเรียน|เพิ่มลูก|add)\s*(.*)$/i);
  if (addMatch) {
    const name = (addMatch[1] ?? "").trim();
    if (name) return addStudentAndReply(lineUserId, name, replyToken, { continueSession: false });
    await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");
    return reply(replyToken, `พิมพ์ชื่อนักเรียนที่ต้องการเพิ่ม (สูงสุด ${MAX_STUDENTS_PER_PARENT} คนต่อเบอร์)`);
  }

  if (["นักเรียน", "ลูก", "รายชื่อ", "children", "students"].includes(cmd)) {
    const parent = await findParentByLineUserId(lineUserId);
    const kids = parent ? await listStudentsOfParent(parent.id) : [];
    if (!kids.length) return reply(replyToken, 'ยังไม่มีนักเรียน — พิมพ์ "เพิ่มนักเรียน" เพื่อเพิ่ม');
    const list = kids.map((k, i) => `${i + 1}. ${k.name}`).join("\n");
    return reply(replyToken, `นักเรียนของคุณ (${kids.length}/${MAX_STUDENTS_PER_PARENT}):\n${list}`);
  }

  if (["qr", "คิวอาร์"].includes(cmd)) {
    const today = await findTodayBookingsForParent(lineUserId, date);
    if (!today.length) return reply(replyToken, "วันนี้ไม่มีคาบที่ยืนยันแล้ว");
    const b = today[0]!;
    const qr = await getCheckinQr(b.id);
    return reply(
      replyToken,
      `ลิงก์เช็คอิน ${b.student.name} ${hhmm(b.startTime)} น.\n${qr.url}\n${qr.window}`,
    );
  }

  if (["เช็คอิน", "checkin", "check-in"].includes(cmd)) {
    const today = await findTodayBookingsForParent(lineUserId, date);
    if (!today.length) return reply(replyToken, "วันนี้ไม่มีคาบที่พร้อมเช็คอิน");
    if (today.length > 1) {
      const list = today
        .map((b, i) => `${i + 1}. ${b.student.name} ${hhmm(b.startTime)} ${b.subject.name}`)
        .join("\n");
      return reply(replyToken, `มีหลายคาบวันนี้ — พิมพ์ เช็คอิน 1 หรือ 2 ...\n${list}`);
    }
    const b = today[0]!;
    const qr = await getCheckinQr(b.id);
    try {
      const result = await checkinByToken(qr.token);
      const status = result.already ? "เช็คอินแล้วก่อนหน้านี้" : "เช็คอินสำเร็จ ✅";
      return reply(replyToken, `${status}\n${b.student.name} ${hhmm(b.startTime)} น.`);
    } catch (e: any) {
      return reply(replyToken, e?.message ?? "ไม่สามารถเช็คอินได้ในขณะนี้");
    }
  }

  const checkinMatch = cmd.match(/^เช็คอิน\s*(\d+)$/);
  if (checkinMatch) {
    const today = await findTodayBookingsForParent(lineUserId, date);
    const idx = Number(checkinMatch[1]) - 1;
    const b = today[idx];
    if (!b) return reply(replyToken, "ไม่พบคาบตามหมายเลขที่เลือก");
    const qr = await getCheckinQr(b.id);
    try {
      await checkinByToken(qr.token);
      return reply(replyToken, `เช็คอินสำเร็จ ✅\n${b.student.name} ${hhmm(b.startTime)} น.`);
    } catch (e: any) {
      return reply(replyToken, e?.message ?? "ไม่สามารถเช็คอินได้");
    }
  }

  if (["ลา", "แจ้งลา", "sick", "leave"].includes(cmd)) {
    const today = await findTodayBookingsForParent(lineUserId, date);
    const eligible = today.filter((b) => b.status === "CONFIRMED");
    if (!eligible.length) return reply(replyToken, "วันนี้ไม่มีคาบที่แจ้งลาได้");
    if (eligible.length > 1) {
      const list = eligible
        .map((b, i) => `${i + 1}. ${b.student.name} ${hhmm(b.startTime)}`)
        .join("\n");
      return reply(replyToken, `พิมพ์ ลา 1 หรือ ลา 2 ...\n${list}`);
    }
    return processSickLeave(eligible[0]!.id, replyToken, eligible[0]!.student.name);
  }

  const leaveMatch = cmd.match(/^ลา\s*(\d+)$/);
  if (leaveMatch) {
    const today = await findTodayBookingsForParent(lineUserId, date);
    const eligible = today.filter((b) => b.status === "CONFIRMED");
    const idx = Number(leaveMatch[1]) - 1;
    const b = eligible[idx];
    if (!b) return reply(replyToken, "ไม่พบคาบตามหมายเลข");
    return processSickLeave(b.id, replyToken, b.student.name);
  }

  return reply(replyToken, LINKED_PARENT_MENU);
}

async function processSickLeave(bookingId: string, replyToken: string, studentName: string) {
  const result = await updateBookingStatus(bookingId, "sick-leave", "แจ้งลาผ่าน LINE");
  const locked = result.locked ? "\n⚠️ โควตาลาครบแล้ว — ต้องปลดล็อกโดยแอดมิน" : "";
  const extended = result.extended
    ? `\nคาบขยาย: ${result.extended.date} ${result.extended.startTime}`
    : "";
  return reply(replyToken, `แจ้งลาสำเร็จ ✅ (${studentName})${extended}${locked}`);
}

async function handleMessage(ev: LineWebhookEvent) {
  const replyToken = ev.replyToken;
  const lineUserId = eventUserId(ev);
  const text = eventText(ev);
  if (!replyToken || !lineUserId || !text) return;

  const lower = text.toLowerCase();

  // Registration (re)start — works from any state.
  if (["สมัคร", "register", "ลงทะเบียน", "เริ่มต้น"].includes(lower)) {
    await setStep(lineUserId, "CHOOSE_ROLE", null);
    return reply(replyToken, ROLE_PROMPT);
  }

  const session = await getSession(lineUserId);

  // Multi-turn: adding students (right after linking, or via "เพิ่มนักเรียน").
  if (session?.step === "AWAIT_STUDENT_NAME") {
    if (SKIP_WORDS.includes(lower)) {
      await clearSession(lineUserId);
      return reply(replyToken, `เรียบร้อยค่ะ ✅\n\n${LINKED_PARENT_MENU}`);
    }
    return addStudentAndReply(lineUserId, text.trim(), replyToken, { continueSession: true });
  }

  // Already-linked routing.
  const linked = await detectLinkedRole(lineUserId);
  if (linked === "customer") {
    return handleParentCommand(lineUserId, text, replyToken);
  }
  if (linked === "teacher") {
    return reply(
      replyToken,
      ["เมนู", "menu"].includes(lower)
        ? "บัญชีครูผูกแล้ว ✅ จะได้รับแจ้งเตือนเมื่อมีการยืนยันตาราง"
        : "บัญชีครูผูกแล้ว — รอรับแจ้งเตือนตารางจากระบบ",
    );
  }
  if (linked === "admin") {
    return reply(
      replyToken,
      ["เมนู", "menu"].includes(lower)
        ? "บัญชีแอดมินผูกแล้ว ✅ จะได้รับแจ้งเตือนเมื่อมีการแจ้งลา"
        : "บัญชีแอดมิน — รอรับแจ้งเตือนจากระบบ",
    );
  }

  // Linking conversation.
  if (!session) {
    return reply(replyToken, WELCOME);
  }

  if (session.step === "CHOOSE_ROLE") {
    const role = parseRoleChoice(text);
    if (!role) return reply(replyToken, ROLE_PROMPT);
    await setStep(lineUserId, "AWAIT_CODE", role);
    return reply(replyToken, CODE_PROMPT[role]!);
  }

  if (session.step === "AWAIT_CODE" && session.pendingRole) {
    const role = session.pendingRole as LinkRole;
    const res = await verifyAndLink(lineUserId, role, text);
    if (!res.ok) return reply(replyToken, res.message); // keep session for retry
    if (role === "customer") {
      // Linked — now offer to add children (multi-turn).
      await setStep(lineUserId, "AWAIT_STUDENT_NAME", "customer");
      return reply(replyToken, `${res.message}\n\n${ADD_STUDENT_PROMPT}`);
    }
    await clearSession(lineUserId);
    return reply(replyToken, res.message);
  }

  return reply(replyToken, WELCOME);
}

async function handleFollow(ev: LineWebhookEvent) {
  const replyToken = ev.replyToken;
  if (!replyToken) return;
  return reply(replyToken, WELCOME);
}

/** Process one webhook POST body (already signature-verified). */
export async function handleLineWebhookEvents(events: LineWebhookEvent[]) {
  for (const ev of events) {
    try {
      if (ev.type === "follow") await handleFollow(ev);
      else if (ev.type === "message") await handleMessage(ev);
    } catch (e) {
      console.error("[line-webhook] event error:", e);
    }
  }
}
