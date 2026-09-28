// 🚫 RETIRED — TASK-556 (Sober's ruling 2026-09-29). This was FIX-007 / TASK-195's one-off expiry repair; it ran with `--commit`
// on both boxes on 2026-08-28 and did its job. It is kept as a REFUSING stub on purpose: a script that vanishes gets rewritten
// from memory by whoever needed it; one that refuses and explains does not.
//
// 🔴 WHY IT MUST NOT RUN AGAIN: it reset every native course's expiry to `courseExpiry(start, size)`. Since then the expiry is
// born at `courseBornCeiling` (≥ that value) and is moved by recorded stretches, admin edits and resumes. A re-run would move
// expiries EARLIER — ending paid-for courses early — discard every one of those moves, and record nothing
// (`course_expiry_changes` would not know). Its old header said "idempotent"; that stopped being true when the rule changed.
//
// Need to correct one course's expiry? Use the admin's expiry edit (it records who and why). Anything wider is a new TASK.
console.error(
  "course:repair-expiry ถูกปลดระวางแล้ว (TASK-556) — ไม่เขียนอะไร\n" +
    "  สคริปต์นี้จะรีเซ็ตวันหมดอายุคอร์สให้เร็วขึ้น และลบการเลื่อนที่บันทึกไว้ทั้งหมดโดยไม่มีบันทึก จึงห้ามรันอีก\n" +
    "  ต้องแก้วันหมดอายุคอร์สเดียว: ใช้หน้าแก้วันหมดอายุของคอร์ส (มีบันทึกการเลื่อน) · มากกว่านั้น: เปิด TASK ใหม่",
);
process.exit(1);
