# ตั้ง Scheduled Tasks บน Windows Server — **3 ตัว**

> สำหรับ: ผู้ดูแลระบบ (คุณฟีน) · จัดทำโดย Porter (PM)
> **เขียนใหม่ทั้งฉบับ 2026-08-01** — ตรวจจาก `smart-scheduler-back/src/routes/internal.ts` ของจริง
>
> ⚠️ **ฉบับก่อนหน้า (20 ก.ค.) ผิด — ห้ามใช้** มันบอกว่ามี 2 งาน และให้ยิงงานรีเซ็ตงบไปที่
> **ops `:4010`** ซึ่ง**เลิกใช้ไปแล้ว** (ย้ายเข้า scheduling ตั้งแต่ REQ-004 · ops ถูกปิดที่ REQ-006)
> ถ้าทำตามฉบับเก่า งานรีเซ็ตงบจะ**ยิงไปที่ที่ไม่มีอะไรรับ** ตอนนี้ทั้ง 3 งานอยู่ที่ **`:4006` เหมือนกันหมด**

---

## สรุป: 3 งาน ปลายทางเดียวกัน กุญแจดอกเดียวกัน

ทุกงานยิงไป **`:4006`** ใส่ header **`x-internal-secret`** = ค่า **`INTERNAL_JOB_SECRET`**
(อยู่ในไฟล์ `.env` ของ `smart-scheduler-back`)

| งาน | ปลายทาง | เวลา | ถ้าไม่ตั้ง จะเกิดอะไร |
|---|---|---|---|
| **A. สรุปสิ้นวัน** | `/internal/jobs/end-of-day` | ทุกคืน **23:30** | คาบที่ไม่มาไม่ถูกตัดเป็น NO_SHOW · รายได้ของวันไม่ถูกลงบัญชี |
| **B. รีเซ็ตงบเดือนใหม่** | `/internal/jobs/month-reset` | วันที่ 1 เวลา **00:05** | **งบครู freelance ไม่รีเซ็ต** — เพดานเดือนที่แล้วค้างต่อไปเรื่อย ๆ |
| **C. สรุปเช้าเข้า LINE** 🆕 | `/internal/jobs/daily-digest` | ทุกวัน **08:00** | แอดมินไม่ได้รับสรุปเลย — ฟีเจอร์ REQ-023 ทั้งอันเงียบสนิท |

> **A กับ B ค้างมาหลายสัปดาห์แล้ว** ลงทีเดียวทั้ง 3 ตัวเลยครับ
>
> ทั้ง 3 งาน **รันซ้ำได้ปลอดภัย** (idempotent) — ไม่ตัดซ้ำ ไม่ส่งซ้ำ

---

## 🔴 ขั้นที่ 0 — ทำก่อนตั้ง task (มีครั้งเดียว ทำแล้วทำซ้ำไม่ได้)

เปิดหน้านี้ **ก่อน**ที่งาน C จะรันครั้งแรก:

```
https://som.develyst.online/scheduler/attention
```

**ต้องเห็นเตือนสีแดงว่า "ไดเจสต์ยังไม่เคยรัน"**

นี่คือทั้งเหตุผลที่หน้าจอนี้ถูกสร้าง — ที่ผ่านมามี 2 งานที่ไม่ได้ตั้ง แล้ว**ไม่มีใครรู้เป็นสัปดาห์** เพราะ
"เงียบเพราะไม่มีอะไรต้องแจ้ง" กับ "เงียบเพราะตายไปแล้ว" หน้าตาเหมือนกันเป๊ะ ระบบเลยเขียนบันทึกทุกครั้ง
ที่รัน **ถึงจะไม่ได้ส่งอะไรก็ตาม** เพื่อให้แยกสองอย่างนี้ออก — ถ้าตั้ง task ไปก่อน เราจะไม่เหลือโอกาสพิสูจน์

---

## ขั้นที่ 1 — สร้างไฟล์ script

สร้างโฟลเดอร์ `C:\sm-jobs\` แล้วสร้าง 3 ไฟล์ (แทน `<ใส่ค่า INTERNAL_JOB_SECRET>` ด้วยค่าจริงจาก `.env`)

**`C:\sm-jobs\end-of-day.ps1`**
```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4006/internal/jobs/end-of-day" `
  -Headers @{ "x-internal-secret" = "<ใส่ค่า INTERNAL_JOB_SECRET>" } `
  -ContentType "application/json" -Body "{}"
```

**`C:\sm-jobs\month-reset.ps1`**
```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4006/internal/jobs/month-reset" `
  -Headers @{ "x-internal-secret" = "<ใส่ค่า INTERNAL_JOB_SECRET>" } `
  -ContentType "application/json" -Body "{}"
```

**`C:\sm-jobs\daily-digest.ps1`**
```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4006/internal/jobs/daily-digest" `
  -Headers @{ "x-internal-secret" = "<ใส่ค่า INTERNAL_JOB_SECRET>" } `
  -ContentType "application/json" -Body "{}"
```

> - **ต้องส่ง `-Body "{}"` และ `-ContentType "application/json"`** ทั้งสามตัว ไม่ใส่จะโดนปฏิเสธ
> - ถ้า Task Scheduler อยู่คนละเครื่องกับแอป → เปลี่ยน `localhost` เป็น IP/host ภายใน
> - งาน A และ C ใส่วันที่ย้อนหลังได้ถ้าจำเป็น เช่น `-Body '{"date":"2026-07-31"}'` (ไว้กรณี server ล่ม)

---

## ขั้นที่ 2 — ทดสอบด้วยมือก่อน (สำคัญ ทำก่อนตั้งเวลา)

```powershell
powershell -ExecutionPolicy Bypass -File C:\sm-jobs\end-of-day.ps1
powershell -ExecutionPolicy Bypass -File C:\sm-jobs\month-reset.ps1
powershell -ExecutionPolicy Bypass -File C:\sm-jobs\daily-digest.ps1
```

**ต้องได้ JSON ตอบกลับ** ถ้าได้ = ปลายทางถูก + กุญแจถูก

| ได้อะไร | แปลว่า |
|---|---|
| JSON ปกติ | ✅ ผ่าน |
| `401 UNAUTHORIZED` | ค่า secret ในไฟล์ `.ps1` ไม่ตรงกับ `.env` ของแอป |
| `503 NOT_CONFIGURED` | **แอปไม่มี `INTERNAL_JOB_SECRET` ใน env เลย** — ต้องไปใส่ใน `.env` แล้ว restart ก่อน |
| ต่อไม่ติด / timeout | แอปไม่ได้รัน หรือ port ผิด (ต้องเป็น **:4006** ทั้งสามตัว) |

---

## ขั้นที่ 3 — ตั้งเวลา

เปิด **Command Prompt (Run as Administrator)**

```cmd
schtasks /create /tn "sm-end-of-day" /sc DAILY /st 23:30 ^
  /tr "powershell -ExecutionPolicy Bypass -File C:\sm-jobs\end-of-day.ps1"

schtasks /create /tn "sm-month-reset" /sc MONTHLY /d 1 /st 00:05 ^
  /tr "powershell -ExecutionPolicy Bypass -File C:\sm-jobs\month-reset.ps1"

schtasks /create /tn "sm-daily-digest" /sc DAILY /st 08:00 ^
  /tr "powershell -ExecutionPolicy Bypass -File C:\sm-jobs\daily-digest.ps1"
```

> - อยากให้รันแม้ไม่มีคน login → เติม `/ru SYSTEM` ต่อท้าย
> - เวลาใช้ timezone ของ server — **ตรวจว่าเป็น Asia/Bangkok** ไม่งั้น 08:00 จะไม่ใช่ 08:00

**ตรวจว่าลงแล้วครบ:**
```cmd
schtasks /query /tn "sm-end-of-day"
schtasks /query /tn "sm-month-reset"
schtasks /query /tn "sm-daily-digest"
```

---

## ขั้นที่ 4 — ตรวจว่าทำงานจริง

**งาน C (สรุปเช้า) — ตรวจจากหน้าจอ ไม่ใช่จากรายการ task:**
```cmd
schtasks /run /tn "sm-daily-digest"
```
แล้วเปิด `/scheduler/attention` อีกครั้ง → **คำเตือนแดงต้องหายไป กลายเป็นเวลาจริง**
ถ้ามีอะไรค้างจริง แอดมินจะได้ข้อความเข้า LINE ด้วย · **ถ้าไม่มีอะไรค้าง จะไม่ส่ง** แต่หน้าจอยังต้องขึ้นเวลา
(นี่คือความต่างระหว่าง "เงียบ" กับ "ตาย" ที่พูดถึงในขั้นที่ 0)

**งาน A:** ลอง mark คาบเป็น "มาเรียน" → สั่งรัน → ดูหน้า P&L ควรมีรายได้เพิ่ม · คาบที่เลยเวลาแล้วไม่เช็คอิน
ควรกลายเป็น NO_SHOW

**งาน B:** สั่งรัน → งบ freelance กลับไปเป็นยอดตั้งต้นของเดือน
⚠️ **ระวัง** — รันตอนกลางเดือนจะรีเซ็ตงบจริง ทำให้ยอดที่ใช้ไปแล้วของเดือนนี้หายไป
ถ้าจะทดสอบ ให้ดูยอดก่อนรันไว้ก่อน

---

## หมายเหตุ

- ทั้ง 3 งาน**ไม่บล็อกการใช้งานปกติ** — ระบบยังใช้ได้ปกติแม้ยังไม่ตั้ง แค่จะไม่ทำ 3 อย่างนี้ให้เอง
- ทางเลือกอื่น: `smart-scheduler-back` มี `scripts/end-of-day.ts` (compile เป็น exe ได้) แต่วิธี
  PowerShell + HTTP ข้างบนง่ายกว่า ไม่ต้อง build
