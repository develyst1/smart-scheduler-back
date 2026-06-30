/**
 * Master data — โปรแกรม + ครู 23 คนจากลูกค้า (2026-06-30)
 * อ้างอิง: docs/product-catalog-pricing.md, docs/teacher-roster-payroll.md
 */

export type TeacherTypeSeed = "FULL_TIME" | "PART_TIME" | "FREELANCE";

export const SUBJECT_NAMES = [
  "1st Trial",
  "Bike / Scooter / Balance Cruiser",
  "Surfskate",
  "Freeskate",
  "Skateboard",
  "Inline Skate",
  "Onewheel E-Skate",
  "Balance Play (Private)",
  "Balance Play (Group)",
] as const;

/** โปรแกรมล้อ — FT/PT/FL สอนได้ทั่วไป */
export const WHEEL_SUBJECTS = SUBJECT_NAMES.filter(
  (s) => s !== "Balance Play (Private)" && s !== "Balance Play (Group)",
);

export interface TeacherSeed {
  name: string;
  nickname: string;
  type: TeacherTypeSeed;
  active: boolean;
  subjects: readonly string[];
  /** 0=Sun … 6=Sat */
  workDays: readonly number[];
}

const allSubjects = SUBJECT_NAMES;
const wheelAndTrial = WHEEL_SUBJECTS;
const everyDay = [0, 1, 2, 3, 4, 5, 6] as const;
const satSun = [6, 0] as const;
const sunOnly = [0] as const;
const satOnly = [6] as const;
const weekdays = [1, 2, 3, 4, 5] as const;

export const TEACHER_SEED: TeacherSeed[] = [
  // Full-Time — ทุกวัน
  { name: "ครูเอก (Ek)", nickname: "เอก", type: "FULL_TIME", active: true, subjects: allSubjects, workDays: everyDay },
  { name: "ครูแบงค์ (Bank)", nickname: "แบงค์", type: "FULL_TIME", active: true, subjects: allSubjects, workDays: everyDay },
  { name: "ครูฮาริส (Haris)", nickname: "ฮาริส", type: "FULL_TIME", active: true, subjects: allSubjects, workDays: everyDay },
  { name: "ครูข้าวจ้าว (Kowjoe)", nickname: "ข้าวจ้าว", type: "FULL_TIME", active: true, subjects: allSubjects, workDays: everyDay },
  { name: "ครูแคมป์ (Camp)", nickname: "แคมป์", type: "FULL_TIME", active: true, subjects: allSubjects, workDays: everyDay },
  { name: "ครูเลวิส (Lewis)", nickname: "เลวิส", type: "FULL_TIME", active: true, subjects: allSubjects, workDays: everyDay },
  // Part-Time — ตามที่ลูกค้าแจ้ง 2026-06-30
  { name: "ครูปริ้นท์ (Print)", nickname: "ปริ้นท์", type: "PART_TIME", active: true, subjects: wheelAndTrial, workDays: satSun },
  { name: "ครูกานต์ (Karn)", nickname: "กานต์", type: "PART_TIME", active: true, subjects: wheelAndTrial, workDays: sunOnly },
  { name: "ครูซีด (Seed)", nickname: "ซีด", type: "PART_TIME", active: true, subjects: wheelAndTrial, workDays: sunOnly },
  { name: "ครูเจย์ (Jay)", nickname: "เจย์", type: "PART_TIME", active: true, subjects: wheelAndTrial, workDays: satSun },
  { name: "ครูคิด (Kid)", nickname: "คิด", type: "PART_TIME", active: true, subjects: wheelAndTrial, workDays: satSun },
  { name: "ครูนิว (New)", nickname: "นิว", type: "PART_TIME", active: true, subjects: wheelAndTrial, workDays: satOnly },
  { name: "ครูโต๊ด (Toth)", nickname: "โต๊ด", type: "PART_TIME", active: true, subjects: wheelAndTrial, workDays: weekdays },
  // Freelance — ยืดหยุ่นทุกวัน (รับงานตาม active + income cap)
  { name: "ครูมาร์ค (Mark)", nickname: "มาร์ค", type: "FREELANCE", active: true, subjects: wheelAndTrial, workDays: everyDay },
  { name: "ครูโจ้ (Joe)", nickname: "โจ้", type: "FREELANCE", active: true, subjects: wheelAndTrial, workDays: everyDay },
  { name: "ครูเก่ง (Keng)", nickname: "เก่ง", type: "FREELANCE", active: true, subjects: wheelAndTrial, workDays: everyDay },
  { name: "ครูต๊าบ (Tarb)", nickname: "ต๊าบ", type: "FREELANCE", active: true, subjects: wheelAndTrial, workDays: everyDay },
  { name: "ครูมุ (Mu)", nickname: "มุ", type: "FREELANCE", active: true, subjects: wheelAndTrial, workDays: everyDay },
  { name: "ครูจิ (Ji)", nickname: "จิ", type: "FREELANCE", active: true, subjects: wheelAndTrial, workDays: everyDay },
  { name: "ครูเนย์ (Nay)", nickname: "เนย์", type: "FREELANCE", active: true, subjects: wheelAndTrial, workDays: everyDay },
  { name: "ครูกอล์ฟ (Gof)", nickname: "กอล์ฟ", type: "FREELANCE", active: false, subjects: wheelAndTrial, workDays: everyDay },
];
