# TODO — smart-scheduler-back (Scheduling API)

สถานะงานของ repo นี้ เทียบกับ **[docs/requirement-timeline.md](docs/requirement-timeline.md)** (สัญญา **Option C**)
repo นี้ = **source of truth** ของ scheduling + LINE push (frontoffice backend)

> สถานะ: ✅ เสร็จ · 🟡 บางส่วน · ❌ ยังไม่มี · อัปเดต 2026-06-30
> ปัจจุบัน: **17 `/api` endpoints + `/api/auth/login`** · 4 migrations · `bun test` 27 ผ่าน · DB shared (live)

---

## ✅ เสร็จแล้ว

### Baseline scheduling (Option B core)
- [x] ✅ Schema + migrations: teachers/students/subjects/courses/vouchers/bookings/outbox/app_settings
- [x] ✅ `GET /calendar` (09:00–18:00, priority sort), `/teachers`, `/courses`, `/bookings`, `/reports/daily`
- [x] ✅ `POST /bookings` + `PATCH /bookings/:id/status` (confirm/attend/sick-leave/cancel) + `/bookings/:id` (move)
- [x] ✅ กฎลา/ขยายคาบ (4→1, 6→2, 10→3 · auto-extend · Policy Lock) — [lib/leave.ts](src/lib/leave.ts)
- [x] ✅ Seed ([db/seed.ts](src/db/seed.ts))

### B.1 Conflict resolution (จองทับ)
- [x] ✅ `POST /bookings/with-reschedule` + `PATCH /bookings/:id/reschedule/{confirm,cancel}`
- [x] ✅ `PENDING_RESCHEDULE` + unique-slot index exclude · transaction · enqueue LINE ผู้ปกครอง

### B.2 Persist teacher type order
- [x] ✅ `GET/PATCH /teachers/type-order` เก็บใน `app_settings` · เรียง getTeachers/getCalendar ตาม order

### B.3 LINE outbox worker
- [x] ✅ ส่ง Messaging API จริง + retry + SENT/FAILED + audit ([services/outbox.service.ts](src/services/outbox.service.ts))
- [x] ✅ ยืนยัน token ใช้ได้ (bot/info 200) · e2e error-path ผ่าน
- [ ] 🟡 **รอ recipient `userId`** ถึงจะ deliver สำเร็จ (ต้องทำ C.4)

### B.4 / B.5 Course & Voucher
- [x] ✅ `POST /courses` — สมัคร 4/6/10 → gen คาบรายสัปดาห์อัตโนมัติ + expiry ([lib/recurring.ts](src/lib/recurring.ts))
- [x] ✅ `POST /vouchers` (5/10/15h) + enforce ชั่วโมง/วันหมดอายุ + ตัด `usedHours` ตอน attend ([lib/voucher.ts](src/lib/voucher.ts))

### B.7 Auth/JWT
- [x] ✅ JWT middleware ป้องกัน `/api/*` + `POST /api/auth/login` (public) · `SKIP_AUTH` สำหรับ dev
- [ ] 🟡 Phase 1 ใช้ credential เดียวจาก env — ยังไม่มี **users table / หลายบทบาท**

---

## ❌ เหลือทำ (ส่วนใหญ่คือ server-side ของ C.* ใน timeline 2026-06-28)

### C.1 — QR / LINE check-in & แจ้งลา
- [ ] ❌ ออก QR ต่อคาบ (token) + `POST /checkin` (verify QR/เวลา) → set ATTENDED
- [ ] ❌ แจ้งลาผ่าน LINE → เปลี่ยนสถานะ + เข้ากฎลา

### C.2 — CRM แต้ม + Level
- [ ] ❌ Schema แต้ม/level ผูกกับ student + กติกาให้แต้ม (เช็คอินตรงเวลา/แจ้งลาตามระบบ)
- [ ] ❌ ใช้ level จัดลำดับความสำคัญตอนจอง

### C.3 — Cron ตัดโควตาสิ้นวัน
- [ ] ❌ Job 18:00 (Asia/Bangkok): คาบที่ไม่เช็คอิน & ไม่แจ้งลา → ตัดโควตา/เปลี่ยนสถานะอัตโนมัติ
  - ใช้ pattern in-process worker เดียวกับ B.3 (`startOutboxWorker`)

### C.4 — LINE OA webhook (🔑 ปลดล็อก B.1/B.3/C.5 ให้ส่งจริง)
- [ ] ❌ `POST /webhooks/line` (verify signature ด้วย `LINE_CHANNEL_SECRET`)
- [ ] ❌ Bot flow ถามบทบาท (ลูกค้า/ครู/แอดมิน) + ตรวจรหัส → ผูก `userId` ↔ teacher/student/parent
- [ ] ❌ ต้องมี **public URL** ให้ LINE ยิง webhook (deploy/tunnel)

### C.5 — แจ้งลา → push LINE แอดมิน
- [ ] ❌ เมื่อมีคำขอลาจากลูกค้า → enqueue LINE หาแอดมิน (worker ส่งได้แล้ว รอ admin userId จาก C.4)

### Integration กับ backoffice (D.1)
- [ ] ❌ ดึง **เรทครู + income limit** จาก `smart-scheduler-backoffice-back` API → แทน mock ฝั่ง scheduling FE

### Master data ธุรกิจจริง (2026-06-30)
- [x] ✅ แทน seed: `subjects` = โปรแกรมจาก rate card (9 โปรแกรม) — [src/db/seed-data.ts](src/db/seed-data.ts)
- [x] ✅ แทน seed: `teachers` = ครู 21 คนจากลูกค้า (6 FT + 7 PT + 8 FL)
- [x] ✅ **`teachers.work_days`** — ซ่อนครู PT เสาร์–อาทิตย์ในวันธรรมดา (ลูกค้า 2026-06-30) · migration `0004` · [lib/work-days.ts](src/lib/work-days.ts)

### Optional / hardening
- [ ] ⬜ B.6 ขยาย `GET /reports/daily` ให้ตรง FE (ตอนนี้ FE enrich ชั่วคราว — ข้ามได้)
- [ ] ⬜ Users table + role-based guard (`requireRole` มีแล้ว ยังไม่ wire ต่อ endpoint)
- [ ] ⬜ Lock CORS เป็น origin ของ frontoffice (ตอน prod)

---

## ลำดับแนะนำ
1. **C.4** (webhook + userId capture) — ปลดล็อก LINE delivery ที่ B.1/B.3 รออยู่ (ต้องมี public URL)
2. **C.3** (cron สิ้นวัน) — domain logic, ไม่ต้องพึ่ง infra
3. **C.1 / C.2** (QR check-in / CRM)
4. **D.1** เชื่อม backoffice rate/limit
