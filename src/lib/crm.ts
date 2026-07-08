// CRM points + customer levels (C.2). Pure rules — persistence in students table.

export const CRM_POINT_RULES = {
  /** เช็คอินตรงเวลา (ภายในช่วงที่เปิดรับ) */
  ON_TIME_CHECKIN: 10,
  /** แจ้งลาผ่านระบบ (LINE / staff) ตามกฎ */
  PROPER_SICK_LEAVE: 5,
} as const;

export interface CrmLevel {
  level: number;
  name: string;
  minPoints: number;
}

/** ระดับลูกค้า "ที่น่ารัก" — ยิ่งสูงยิ่งได้สิทธิพิเศษ (จองก่อน ฯลฯ ในอนาคต) */
export const CRM_LEVELS: CrmLevel[] = [
  { level: 1, name: "น้องใหม่", minPoints: 0 },
  { level: 2, name: "น่ารัก", minPoints: 30 },
  { level: 3, name: "น่ารักมาก", minPoints: 80 },
  { level: 4, name: "VIP น่ารัก", minPoints: 150 },
  { level: 5, name: "ซูเปอร์สตาร์", minPoints: 300 },
];

export function levelFromPoints(points: number): CrmLevel {
  let current = CRM_LEVELS[0]!;
  for (const lvl of CRM_LEVELS) {
    if (points >= lvl.minPoints) current = lvl;
  }
  return current;
}

export function applyPoints(current: number, delta: number): { points: number; level: CrmLevel } {
  const points = Math.max(0, current + delta);
  return { points, level: levelFromPoints(points) };
}

export function levelName(level: number): string {
  return CRM_LEVELS.find((l) => l.level === level)?.name ?? `Level ${level}`;
}

// ── สิทธิประโยชน์ตามระดับ (UC-020) ──────────────────────────────────────────
// "ลูกค้าระดับสูงจะได้รับสิทธิประโยชน์ โปรโมชั่น หรือการจัดลำดับความสำคัญก่อนใคร"
// การจัดตารางเป็น manual (staff เป็นคนตัดสิน) → `priorityBooking` เป็น "คำแนะนำ"
// ที่ยิงให้ FE/staff เห็นว่าควรให้คิวก่อนเมื่อคาบชนกัน ไม่ได้ override เอง
// ⚠️ ข้อความ perks/มูลค่าโปรโมชั่นเป็น placeholder — รอลูกค้ายืนยันเงื่อนไขจริง
export interface CrmPerks {
  /** advisory: ควรให้คิวจองก่อนเมื่อแย่งคาบ (level สูงชนะ) */
  priorityBooking: boolean;
  /** ป้ายสิทธิประโยชน์ภาษาไทยสำหรับแสดงผล */
  perks: string[];
}

export const CRM_LEVEL_PERKS: Record<number, CrmPerks> = {
  1: { priorityBooking: false, perks: [] },
  2: { priorityBooking: false, perks: ["ทักทาย/ดูแลพิเศษจากแอดมิน"] },
  3: { priorityBooking: true, perks: ["จองก่อนใครเมื่อคาบชนกัน"] },
  4: { priorityBooking: true, perks: ["จองก่อนใครเมื่อคาบชนกัน", "สิทธิ์รับโปรโมชั่นพิเศษ"] },
  5: {
    priorityBooking: true,
    perks: ["จองก่อนใครเมื่อคาบชนกัน", "สิทธิ์รับโปรโมชั่นพิเศษ", "ของรางวัลประจำปี"],
  },
};

export function perksForLevel(level: number): CrmPerks {
  return CRM_LEVEL_PERKS[level] ?? CRM_LEVEL_PERKS[1]!;
}

/** ระดับ + เกณฑ์แต้ม + สิทธิประโยชน์ — สำหรับหน้าจอ "ระดับลูกค้า" / API */
export function crmLevelLadder(): (CrmLevel & CrmPerks)[] {
  return CRM_LEVELS.map((l) => ({ ...l, ...perksForLevel(l.level) }));
}
