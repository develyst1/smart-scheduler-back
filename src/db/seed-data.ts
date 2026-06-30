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
}

const allSubjects = SUBJECT_NAMES;
const wheelAndTrial = WHEEL_SUBJECTS;

export const TEACHER_SEED: TeacherSeed[] = [
  { name: "ครูเอก (Ek)", nickname: "เอก", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "ครูแบงค์ (Bank)", nickname: "แบงค์", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "ครูฮาริส (Haris)", nickname: "ฮาริส", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "ครูข้าวจ้าว (Kowjoe)", nickname: "ข้าวจ้าว", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "ครูแคมป์ (Camp)", nickname: "แคมป์", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "ครูเลวิส (Lewis)", nickname: "เลวิส", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "ครูปริ้นท์ (Print)", nickname: "ปริ้นท์", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "ครูกานต์ (Karn)", nickname: "กานต์", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "ครูซีด (Seed)", nickname: "ซีด", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "ครูเจย์ (Jay)", nickname: "เจย์", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "ครูคิด (Kid)", nickname: "คิด", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "ครูนิว (New)", nickname: "นิว", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "ครูโต๊ด (Toth)", nickname: "โต๊ด", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "ครูมาร์ค (Mark)", nickname: "มาร์ค", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "ครูโจ้ (Joe)", nickname: "โจ้", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "ครูเก่ง (Keng)", nickname: "เก่ง", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "ครูต๊าบ (Tarb)", nickname: "ต๊าบ", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "ครูมุ (Mu)", nickname: "มุ", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "ครูจิ (Ji)", nickname: "จิ", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "ครูเนย์ (Nay)", nickname: "เนย์", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "ครูกอล์ฟ (Gof)", nickname: "กอล์ฟ", type: "FREELANCE", active: false, subjects: wheelAndTrial },
];
