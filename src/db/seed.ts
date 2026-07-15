// Seed the shared DB with real master data (programs + 23 teachers) and demo bookings.
// Run: `bun run db:seed`  (idempotent — truncates first).

import { sql } from "drizzle-orm";
import { db, queryClient } from "./index";
import { SUBJECT_NAMES, TEACHER_SEED } from "./seed-data";
import {
  bookings,
  coursePackages,
  parents,
  students,
  subjects,
  teacherSubjects,
  teachers,
  vouchers,
} from "./schema";

// ── local date helpers (no dayjs in the backend) ──
const fmt = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const base = new Date();
const addDays = (n: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
};
const today = fmt(base);
const tomorrow = fmt(addDays(1));
const weeks = (n: number) => fmt(addDays(n * 7));
const plus1h = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

async function main() {
  console.log("Truncating…");
  await db.execute(
    sql`TRUNCATE bookings, course_packages, vouchers, teacher_subjects, students, parents, teachers, subjects, notification_outbox RESTART IDENTITY CASCADE`,
  );

  const subjRows = await db
    .insert(subjects)
    .values(SUBJECT_NAMES.map((name) => ({ name })))
    .returning({ id: subjects.id, name: subjects.name });
  const subjId = new Map(subjRows.map((r) => [r.name, r.id]));

  const teacherRows = await db
    .insert(teachers)
    .values(
      TEACHER_SEED.map((t) => ({
        name: t.name,
        nickname: t.nickname,
        type: t.type,
        active: t.active,
      })),
    )
    .returning({ id: teachers.id, nickname: teachers.nickname });
  const teacherId = new Map(teacherRows.map((r) => [r.nickname, r.id]));
  await db.insert(teacherSubjects).values(
    TEACHER_SEED.flatMap((t) =>
      t.subjects.map((s) => ({
        teacherId: teacherId.get(t.nickname)!,
        subjectId: subjId.get(s)!,
      })),
    ),
  );

  // Parents (guardians) keyed by phone — one phone can own several children.
  const parentSeed = [
    { phone: "0810000001", name: "ผู้ปกครองพีพี/เจมส์", students: ["น้องพีพี", "น้องเจมส์"] },
    { phone: "0810000002", name: "ผู้ปกครองมายด์", students: ["น้องมายด์"] },
    { phone: "0810000003", name: "ผู้ปกครองโอ๊ค/เบล", students: ["น้องโอ๊ค", "น้องเบล"] },
    { phone: "0810000004", name: "ผู้ปกครองมิ้น", students: ["น้องมิ้น"] },
    { phone: "0810000005", name: "ผู้ปกครองแพร/กัน", students: ["น้องแพร", "น้องกัน"] },
  ];
  const parentRows = await db
    .insert(parents)
    .values(parentSeed.map((p) => ({ phone: p.phone, name: p.name })))
    .returning({ id: parents.id, phone: parents.phone });
  const parentIdByPhone = new Map(parentRows.map((r) => [r.phone, r.id]));

  const studentSeed = parentSeed.flatMap((p) =>
    p.students.map((name) => ({ name, parentId: parentIdByPhone.get(p.phone)! })),
  );
  const studentRows = await db
    .insert(students)
    .values(studentSeed.map((s) => ({ name: s.name, nickname: s.name, parentId: s.parentId })))
    .returning({ id: students.id, name: students.name });
  const studentId = new Map(studentRows.map((r) => [r.name, r.id]));
  const sId = (n: string) => studentId.get(n)!;

  const courseSeed = [
    {
      student: "น้องพีพี",
      size: 10,
      usedSessions: 3,
      leaveUsed: 1,
      startDate: weeks(-3),
      weekday: 0,
      startTime: "10:00",
      expiryDate: weeks(10),
    },
    {
      student: "น้องเจมส์",
      size: 4,
      usedSessions: 1,
      leaveUsed: 1,
      startDate: weeks(-1),
      weekday: 2,
      startTime: "14:00",
      expiryDate: weeks(4),
    },
    {
      student: "น้องมายด์",
      size: 6,
      usedSessions: 4,
      leaveUsed: 2,
      startDate: weeks(-4),
      weekday: 5,
      startTime: "16:00",
      expiryDate: weeks(2),
    },
  ];
  const courseRows = await db
    .insert(coursePackages)
    .values(
      courseSeed.map((c) => ({
        studentId: sId(c.student),
        size: c.size,
        usedSessions: c.usedSessions,
        leaveUsed: c.leaveUsed,
        startDate: c.startDate,
        weekday: c.weekday,
        startTime: c.startTime,
        expiryDate: c.expiryDate,
      })),
    )
    .returning({ id: coursePackages.id, studentId: coursePackages.studentId });
  const courseByStudent = new Map(courseRows.map((r) => [r.studentId, r.id]));

  const voucherSeed = [
    { student: "น้องมิ้น", totalHours: 10, usedHours: 2, expiryDate: weeks(20) },
    { student: "น้องกัน", totalHours: 5, usedHours: 1, expiryDate: weeks(16) },
  ];
  const voucherRows = await db
    .insert(vouchers)
    .values(
      voucherSeed.map((v) => ({
        studentId: sId(v.student),
        totalHours: v.totalHours,
        usedHours: v.usedHours,
        expiryDate: v.expiryDate,
      })),
    )
    .returning({ id: vouchers.id, studentId: vouchers.studentId });
  const voucherByStudent = new Map(voucherRows.map((r) => [r.studentId, r.id]));

  const bk = [
    {
      student: "น้องพีพี",
      teacher: "Ek",
      subject: "Bike / Scooter / Balance Cruiser",
      date: today,
      start: "10:00",
      type: "COURSE_PACKAGE",
      status: "CONFIRMED",
      course: true,
    },
    {
      student: "น้องโอ๊ค",
      teacher: "Bank",
      subject: "Surfskate",
      date: today,
      start: "13:00",
      type: "SINGLE_SESSION",
      status: "ATTENDED",
    },
    {
      student: "น้องเบล",
      teacher: "Haris",
      subject: "1st Trial",
      date: today,
      start: "11:00",
      type: "FIRST_TRIAL",
      status: "PENDING",
      note: "ทักมาทาง Line ขอทดลองเรียน",
    },
    {
      student: "น้องมิ้น",
      teacher: "Kowjoe",
      subject: "Skateboard",
      date: today,
      start: "15:00",
      type: "VOUCHER",
      status: "CONFIRMED",
      voucher: true,
    },
    {
      student: "น้องเจมส์",
      teacher: "Camp",
      subject: "Onewheel E-Skate",
      date: today,
      start: "14:00",
      type: "COURSE_PACKAGE",
      status: "SICK_LEAVE",
      course: true,
    },
    {
      student: "น้องแพร",
      teacher: "Print",
      subject: "Freeskate",
      date: today,
      start: "10:00",
      type: "SINGLE_SESSION",
      status: "CONFIRMED",
    },
    {
      student: "น้องกัน",
      teacher: "Mark",
      subject: "Inline Skate",
      date: today,
      start: "16:00",
      type: "VOUCHER",
      status: "CONFIRMED",
      voucher: true,
    },
    {
      student: "น้องมายด์",
      teacher: "Lewis",
      subject: "Balance Play (Private)",
      date: today,
      start: "16:00",
      type: "COURSE_PACKAGE",
      status: "EXTENDED",
      course: true,
      note: "คาบขยายจากการลาสัปดาห์ก่อน",
    },
    {
      student: "น้องพีพี",
      teacher: "Ek",
      subject: "Bike / Scooter / Balance Cruiser",
      date: tomorrow,
      start: "10:00",
      type: "COURSE_PACKAGE",
      status: "CONFIRMED",
      course: true,
    },
  ];
  await db.insert(bookings).values(
    bk.map((b) => ({
      studentId: sId(b.student),
      teacherId: teacherId.get(b.teacher)!,
      subjectId: subjId.get(b.subject)!,
      date: b.date,
      startTime: b.start,
      endTime: plus1h(b.start),
      bookingType: b.type as any,
      status: b.status as any,
      courseId: b.course ? (courseByStudent.get(sId(b.student)) ?? null) : null,
      voucherId: b.voucher ? (voucherByStudent.get(sId(b.student)) ?? null) : null,
      note: b.note ?? null,
      confirmedAt: ["CONFIRMED", "ATTENDED", "EXTENDED"].includes(b.status) ? new Date() : null,
    })),
  );

  const counts = await db.execute(sql`select
    (select count(*) from teachers)        as teachers,
    (select count(*) from subjects)        as subjects,
    (select count(*) from teacher_subjects) as teacher_subjects,
    (select count(*) from parents)         as parents,
    (select count(*) from students)        as students,
    (select count(*) from course_packages) as courses,
    (select count(*) from vouchers)        as vouchers,
    (select count(*) from bookings)        as bookings`);
  console.log("Seeded:", counts[0]);
}

main()
  .then(async () => {
    await queryClient.end();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await queryClient.end();
    process.exit(1);
  });
