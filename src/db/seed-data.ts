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
  { name: "Ek", nickname: "Ek", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "Bank", nickname: "Bank", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "Haris", nickname: "Haris", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "Kowjoe", nickname: "Kowjoe", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "Camp", nickname: "Camp", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "Lewis", nickname: "Lewis", type: "FULL_TIME", active: true, subjects: allSubjects },
  { name: "Print", nickname: "Print", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "Karn", nickname: "Karn", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "Seed", nickname: "Seed", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "Jay", nickname: "Jay", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "Kid", nickname: "Kid", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "New", nickname: "New", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "Toth", nickname: "Toth", type: "PART_TIME", active: true, subjects: wheelAndTrial },
  { name: "Mark", nickname: "Mark", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "Joe", nickname: "Joe", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "Keng", nickname: "Keng", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "Tarb", nickname: "Tarb", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "Mu", nickname: "Mu", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "Ji", nickname: "Ji", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "Nay", nickname: "Nay", type: "FREELANCE", active: true, subjects: wheelAndTrial },
  { name: "Gof", nickname: "Gof", type: "FREELANCE", active: false, subjects: wheelAndTrial },
];
