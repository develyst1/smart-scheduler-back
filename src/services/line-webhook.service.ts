// LINE OA webhook handler — role verification (C.4) + parent commands (C.1/C.5).

import { eq } from "drizzle-orm";
import { db } from "../db";
import { lineLinkSessions, students, teachers } from "../db/schema";
import { bangkokNow } from "../lib/bangkok-time";
import { replyMessage, type LineTextMessage } from "../lib/line-client";
import {
  eventText,
  eventUserId,
  normalizePhone,
  parseRoleChoice,
  type LineWebhookEvent,
} from "../lib/line-webhook";
import { addAdminLineUserId, getAdminLineUserIds } from "../lib/line-admin";
import { hhmm } from "../lib/time";
import { checkinByToken, findTodayBookingsForParent, getCheckinQr } from "./checkin.service";
import { updateBookingStatus } from "./scheduler.service";

const WELCOME =
  "สวัสดีค่ะ ยินดีต้อนรับสู่ Smart Scheduler\n\n" +
  "พิมพ์ สมัคร เพื่อผูกบัญชี LINE\n" +
  "หลังผูกแล้ว: เช็คอิน · ลา · qr (รับลิงก์เช็คอิน)";

const ROLE_PROMPT =
  "เลือกบทบาทของคุณ:\n" +
  "1 = ลูกค้า/ผู้ปกครอง\n" +
  "2 = ครู\n" +
  "3 = แอดมิน";

const CODE_PROMPT: Record<string, string> = {
  customer: "กรุณาพิมพ์เบอร์โทรที่ลงทะเบียนไว้ (เช่น 0812345678)",
  teacher: "กรุณาพิมพ์ชื่อเล่นครูตามที่ลงทะเบียนในระบบ",
  admin: "กรุณาพิมพ์รหัสแอดมิน (เช่น 229)",
};

const LINKED_PARENT_MENU =
  "คำสั่งที่ใช้ได้:\n" +
  "· เช็คอิน — เช็คอินคาบวันนี้\n" +
  "· ลา — แจ้งลาคาบวันนี้\n" +
  "· qr — รับลิงก์เช็คอิน\n" +
  "· เมนู — แสดงคำสั่งนี้อีกครั้ง";

type LinkRole = "customer" | "teacher" | "admin";

async function reply(replyToken: string, text: string) {
  const msg: LineTextMessage = { type: "text", text };
  await replyMessage(replyToken, [msg]);
}

async function detectLinkedRole(lineUserId: string): Promise<LinkRole | null> {
  const [teacher, student, admins] = await Promise.all([
    db.query.teachers.findFirst({ where: (t, { eq: e }) => e(t.lineUserId, lineUserId) }),
    db.query.students.findFirst({ where: (s, { eq: e }) => e(s.parentLineUserId, lineUserId) }),
    getAdminLineUserIds(),
  ]);
  if (teacher) return "teacher";
  if (student) return "customer";
  if (admins.includes(lineUserId)) return "admin";
  return null;
}

async function startLinkSession(lineUserId: string) {
  await db
    .insert(lineLinkSessions)
    .values({ lineUserId, step: "CHOOSE_ROLE", pendingRole: null })
    .onConflictDoUpdate({
      target: lineLinkSessions.lineUserId,
      set: { step: "CHOOSE_ROLE", pendingRole: null, updatedAt: new Date() },
    });
}

async function verifyAndLink(lineUserId: string, role: LinkRole, code: string): Promise<string> {
  if (role === "admin") {
    const expected = process.env.LINE_ADMIN_VERIFY_CODE ?? "229";
    if (code.trim() !== expected) return "รหัสแอดมินไม่ถูกต้อง ลองใหม่อีกครั้ง";
    await addAdminLineUserId(lineUserId);
    return "ผูกบัญชีแอดมินสำเร็จ ✅ จะได้รับแจ้งเตือนเมื่อมีการแจ้งลา";
  }

  if (role === "teacher") {
    const nick = code.trim();
    const rows = await db.select().from(teachers);
    const teacher = rows.find((t) => t.nickname.toLowerCase() === nick.toLowerCase());
    if (!teacher) return `ไม่พบครูชื่อเล่น "${nick}" — ตรวจสอบอีกครั้ง`;
    if (teacher.lineUserId && teacher.lineUserId !== lineUserId) {
      return "ครูคนนี้ผูก LINE กับบัญชีอื่นแล้ว ติดต่อแอดมิน";
    }
    await db.update(teachers).set({ lineUserId }).where(eq(teachers.id, teacher.id));
    return `ผูกบัญชีครูสำเร็จ ✅ (${teacher.nickname}) จะได้รับแจ้งเตือนเมื่อมีการยืนยันตาราง`;
  }

  // customer / parent — match phone on student
  const phone = normalizePhone(code);
  if (phone.length < 9) return "เบอร์โทรไม่ถูกต้อง กรุณาพิมพ์เบอร์ที่ลงทะเบียน";
  const rows = await db.select().from(students);
  const student = rows.find((s) => normalizePhone(s.phone ?? "") === phone);
  if (!student) return "ไม่พบนักเรียนที่ตรงกับเบอร์นี้ — ติดต่อแอดมิน";
  if (student.parentLineUserId && student.parentLineUserId !== lineUserId) {
    return "เบอร์นี้ผูกกับ LINE อื่นแล้ว ติดต่อแอดมิน";
  }
  await db.update(students).set({ parentLineUserId: lineUserId }).where(eq(students.id, student.id));
  return `ผูกบัญชีผู้ปกครองสำเร็จ ✅ (${student.name})`;
}

async function handleParentCommand(lineUserId: string, text: string, replyToken: string) {
  const cmd = text.trim().toLowerCase();
  const { date } = bangkokNow();

  if (["เมนู", "menu", "help", "ช่วยเหลือ"].includes(cmd)) {
    return reply(replyToken, LINKED_PARENT_MENU);
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
  if (["สมัคร", "register", "ลงทะเบียน", "เริ่มต้น"].includes(lower)) {
    await startLinkSession(lineUserId);
    return reply(replyToken, ROLE_PROMPT);
  }

  const linked = await detectLinkedRole(lineUserId);
  if (linked === "customer") {
    return handleParentCommand(lineUserId, text, replyToken);
  }
  if (linked === "teacher") {
    if (["เมนู", "menu"].includes(lower)) {
      return reply(replyToken, "บัญชีครูผูกแล้ว ✅ จะได้รับแจ้งเตือนเมื่อมีการยืนยันตาราง");
    }
    return reply(replyToken, "บัญชีครูผูกแล้ว — รอรับแจ้งเตือนตารางจากระบบ");
  }
  if (linked === "admin") {
    if (["เมนู", "menu"].includes(lower)) {
      return reply(replyToken, "บัญชีแอดมินผูกแล้ว ✅ จะได้รับแจ้งเตือนเมื่อมีการแจ้งลา");
    }
    return reply(replyToken, "บัญชีแอดมิน — รอรับแจ้งเตือนจากระบบ");
  }

  const session = await db.query.lineLinkSessions.findFirst({
    where: (s, { eq: e }) => e(s.lineUserId, lineUserId),
  });

  if (!session) {
    return reply(replyToken, WELCOME);
  }

  if (session.step === "CHOOSE_ROLE") {
    const role = parseRoleChoice(text);
    if (!role) return reply(replyToken, ROLE_PROMPT);
    await db
      .update(lineLinkSessions)
      .set({ step: "AWAIT_CODE", pendingRole: role, updatedAt: new Date() })
      .where(eq(lineLinkSessions.lineUserId, lineUserId));
    return reply(replyToken, CODE_PROMPT[role]!);
  }

  if (session.step === "AWAIT_CODE" && session.pendingRole) {
    const role = session.pendingRole as LinkRole;
    const msg = await verifyAndLink(lineUserId, role, text);
    if (msg.includes("ไม่ถูกต้อง") || msg.includes("ไม่พบ") || msg.includes("ผูก LINE")) {
      return reply(replyToken, msg);
    }
    await db.delete(lineLinkSessions).where(eq(lineLinkSessions.lineUserId, lineUserId));
    return reply(replyToken, msg);
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
