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
- [x] ✅ ออก check-in token ต่อคาบเมื่อ confirm + `GET /bookings/:id/checkin`
- [x] ✅ `POST /api/checkin` (public, token) → ATTENDED + CRM แต้ม
- [x] ✅ LINE bot: เช็คอิน / ลา / qr สำหรับผู้ปกครองที่ผูกแล้ว

### C.2 — CRM แต้ม + Level
- [x] ✅ Schema `crm_points` / `crm_level` บน students + กติกาแต้ม ([lib/crm.ts](src/lib/crm.ts))
- [x] ✅ ให้แต้มเมื่อเช็คอินตรงเวลา / แจ้งลาตามระบบ · แสดงใน StudentRef DTO
- [ ] 🟡 ใช้ level จัดลำดับความสำคัญตอนจอง (อนาคต)

### C.3 — Cron ตัดโควตาสิ้นวัน
- [ ] ❌ **ข้ามไว้ก่อน** (ตามแผน) — Job 18:00 ตัดโควตาอัตโนมัติ

### C.4 — LINE OA webhook
- [x] ✅ `POST /webhooks/line` (verify `X-Line-Signature`)
- [x] ✅ Bot flow บทบาท 1/2/3 + รหัส → ผูก `userId` ↔ teacher / parent / admin
- [ ] 🟡 ต้องตั้ง **Webhook URL สาธารณะ** ใน LINE Developers Console

### C.5 — แจ้งลา → push LINE แอดมิน
- [x] ✅ sick-leave (staff + LINE) → enqueue หา admin userIds ใน `app_settings.line_admin_user_ids`

### Integration กับ backoffice (D.1)
- [ ] ❌ ดึง **เรทครู + income limit** จาก `smart-scheduler-backoffice-back` API → แทน mock ฝั่ง scheduling FE

### Master data ธุรกิจจริง (2026-06-30)
- [x] ✅ แทน seed: `subjects` = โปรแกรมจาก rate card (9 โปรแกรม) — [src/db/seed-data.ts](src/db/seed-data.ts)
- [x] ✅ แทน seed: `teachers` = ครู 21 คนจากลูกค้า (6 FT + 7 PT + 8 FL)
- [x] ✅ **`teachers.work_days`** — ซ่อนในปฏิทินตามวันที่ตั้ง · `PATCH /teachers/:id/work-days` · หน้าคุณครู

### Optional / hardening
- [ ] ⬜ B.6 ขยาย `GET /reports/daily` ให้ตรง FE (ตอนนี้ FE enrich ชั่วคราว — ข้ามได้)
- [ ] ⬜ Users table + role-based guard (`requireRole` มีแล้ว ยังไม่ wire ต่อ endpoint)
- [ ] ⬜ Lock CORS เป็น origin ของ frontoffice (ตอน prod)

---

## ลำดับแนะนำ
1. ~~**C.4**~~ ✅ webhook + userId capture — **ตั้ง URL ใน LINE Console**
2. ~~**C.1 / C.2 / C.5**~~ ✅ (C.3 cron ข้ามไว้)
3. **D.1** เชื่อม backoffice rate/limit
