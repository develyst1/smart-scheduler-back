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
