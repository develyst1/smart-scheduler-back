# สิ่งที่ต้องทำเองบน Windows Server — ตั้ง Scheduled Tasks 2 ตัว

> สำหรับ: ผู้ดูแลระบบ (คุณฟีน/ทีม) · จัดทำโดย Porter (PM) 2026-07-20
> endpoint/header ตรวจจากโค้ดจริงแล้ว (`smart-scheduler-back/src/routes/internal.ts`,
> `smart-scheduler-backoffice-back/src/routes/recurring.ts`)

ระบบ build เสร็จ + deploy แล้ว **ใช้งานแบบกดเองได้หมด** แต่ยังเหลือ **2 งานอัตโนมัติ**
ที่ต้องตั้งบน server เอง (ทีม dev แตะ server จริงไม่ได้) ถ้าไม่ตั้ง ระบบจะไม่ทำ 2 อย่างนี้ให้เอง

| งาน | ทำอะไร | ยิงไปที่ | ตั้งเวลา |
|-----|--------|---------|----------|
| **A. End-of-day** | ตัดคาบที่ไม่มา (NO_SHOW) + สรุป**รายได้**ของวัน | scheduling `:4006` | ทุกคืน (แนะนำ 23:30) |
| **B. Month-start** | **reset งบ freelance** + **ลงเงินเดือน FT/PT** ของเดือนใหม่ | ops `:4010` | ทุกวันที่ 1 (แนะนำ 00:05) |

---

## 0. เตรียมข้อมูลก่อน
ต้องรู้ค่า 2 ตัวนี้ (ค่าที่คุณตั้งไว้ตอน deploy ในไฟล์ `.env`):
- **`INTERNAL_JOB_SECRET`** — อยู่ใน env ของ `smart-scheduler-back` (:4006) → ใช้กับงาน A
- **`SERVICE_TOKEN`** — อยู่ใน env ของ `smart-scheduler-backoffice-back` (:4010) → ใช้กับงาน B

> ถ้า Task Scheduler รันบนเครื่องเดียวกับที่แอปรันอยู่ → ใช้ `localhost` ได้เลย
> ถ้าคนละเครื่อง → เปลี่ยน `localhost` เป็น IP/host ภายในของแต่ละแอป

---

## 1. สร้างไฟล์ script 2 อัน
สร้างโฟลเดอร์ เช่น `C:\sm-jobs\` แล้วสร้าง 2 ไฟล์นี้

**`C:\sm-jobs\end-of-day.ps1`**
```powershell
# งาน A — ตัดสิ้นวัน + สรุปรายได้ (scheduling :4006)
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4006/internal/jobs/end-of-day" `
  -Headers @{ "x-internal-secret" = "<ใส่ค่า INTERNAL_JOB_SECRET>" } `
  -ContentType "application/json" -Body "{}"
```

**`C:\sm-jobs\month-start.ps1`**
```powershell
# งาน B — reset งบ + ลงเงินเดือน (ops :4010) · คำนวณเดือนปัจจุบันให้อัตโนมัติ
$m = Get-Date -Format "yyyy-MM"
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4010/api/v1/internal/jobs/month-start" `
  -Headers @{ "X-Service-Token" = "<ใส่ค่า SERVICE_TOKEN>" } `
  -ContentType "application/json" -Body "{`"month`":`"$m`"}"
```
> ⚠️ งาน B **ต้องส่งเดือน** (`YYYY-MM`) — script คำนวณเดือนปัจจุบันให้อัตโนมัติแล้ว ไม่ต้องแก้ทุกเดือน

---

## 2. ทดสอบด้วยมือก่อน (สำคัญ — ทำก่อนตั้งเวลา)
เปิด PowerShell แล้วรันทีละไฟล์:
```powershell
powershell -ExecutionPolicy Bypass -File C:\sm-jobs\end-of-day.ps1
powershell -ExecutionPolicy Bypass -File C:\sm-jobs\month-start.ps1
```
**ควรได้ JSON ตอบกลับ** (ถ้าได้ = คำสั่ง + secret ถูก):
- งาน A → `{ noShow, coursesCut, vouchersCut, revenuePosted, report }`
- งาน B → `{ month, freelanceReset, salariesPosted }`

ถ้าได้ `401 UNAUTHORIZED` = ค่า secret/token ผิด · ถ้าต่อไม่ติด = port/host ผิด หรือแอปไม่ได้รัน

> รันซ้ำได้ปลอดภัย (idempotent) — ไม่ตัด/ลงเงินซ้ำ

---

## 3. ตั้งเวลาด้วย schtasks
เปิด **Command Prompt (Run as Administrator)** แล้วรัน 2 คำสั่งนี้:
```cmd
schtasks /create /tn "sm-end-of-day" /sc DAILY /st 23:30 ^
  /tr "powershell -ExecutionPolicy Bypass -File C:\sm-jobs\end-of-day.ps1"

schtasks /create /tn "sm-month-start" /sc MONTHLY /d 1 /st 00:05 ^
  /tr "powershell -ExecutionPolicy Bypass -File C:\sm-jobs\month-start.ps1"
```
> - อยากให้รันแม้ไม่มีคน login → เพิ่ม `/ru SYSTEM` (หรือ user ที่มีสิทธิ์) ต่อท้าย
> - เวลาใช้ timezone ของ server — ตรวจว่า server ตั้งเป็น **Asia/Bangkok**

**ตรวจว่าลงทะเบียนแล้ว:**
```cmd
schtasks /query /tn "sm-end-of-day"
schtasks /query /tn "sm-month-start"
```
**สั่งรันทดสอบเดี๋ยวนั้น:**
```cmd
schtasks /run /tn "sm-end-of-day"
```

---

## 4. ตรวจว่าทำงานจริง
- **งาน A:** ลอง mark คาบ Trial/One-time เป็น "มาเรียน" → รันงาน A → ไปดูหน้า **P&L** ควรมีรายได้เพิ่ม
  · คาบที่ผ่านเวลาแล้วไม่เช็คอิน ควรกลายเป็น NO_SHOW
- **งาน B:** รันงาน B → หน้า **P&L** เดือนนั้นควรมีเงินเดือน FT/PT (FIXED_COST) · งบ freelance รีเซ็ตเป็นยอดตั้งต้น

---

## 5. แก้ปัญหาเบื้องต้น
| อาการ | สาเหตุ/วิธีแก้ |
|-------|---------------|
| `401 UNAUTHORIZED` | ค่า `INTERNAL_JOB_SECRET`/`SERVICE_TOKEN` ในไฟล์ .ps1 ไม่ตรงกับ env ของแอป |
| ต่อไม่ติด / timeout | แอปไม่ได้รัน หรือ port/host ผิด (A=:4006, B=:4010) — ถ้าคนละเครื่องเปลี่ยน localhost |
| งาน B error เรื่อง month | ปกติ script คำนวณให้แล้ว — ถ้าแก้ไฟล์เอง ต้องเป็นรูปแบบ `YYYY-MM` |
| Task ไม่รันตามเวลา | เช็ค `/ru`, สิทธิ์ผู้ใช้, และ timezone ของ server |

---

## หมายเหตุ
- ทางเลือก: `smart-scheduler-back` มี `scripts/end-of-day.ts` (compile เป็น exe ได้) เป็น trigger อีกแบบ
  แต่วิธี PowerShell + HTTP ข้างบนง่ายกว่า ไม่ต้อง build
- ทั้ง 2 งาน**ไม่บล็อกการใช้งานปกติ** — ระบบยังใช้ (กดเอง) ได้แม้ยังไม่ตั้ง แค่จะไม่ตัด/รีเซ็ตอัตโนมัติ
