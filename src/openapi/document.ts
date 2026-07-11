// OpenAPI 3.0 — Scheduling API (frontoffice). Hand-maintained; keep in sync with routes/api.ts.

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Smart Scheduler API",
    description:
      "Scheduling API (frontoffice) — ปฏิทิน, จอง, เช็คอิน, ครู, รายงาน.\n\n" +
      "**Auth:** `POST /api/auth/login` → ใส่ `Bearer <token>` ใน Authorize (ยกเว้น public endpoints).\n\n" +
      "Contract types: `src/types/contract.ts`",
    version: "0.1.0",
  },
  servers: [{ url: "/", description: "current host" }],
  tags: [
    { name: "auth", description: "เข้าสู่ระบบ staff" },
    { name: "calendar", description: "ปฏิทิน" },
    { name: "teachers", description: "ครู" },
    { name: "bookings", description: "การจอง" },
    { name: "courses", description: "คอร์สรายสัปดาห์" },
    { name: "vouchers", description: "วอยเชอร์" },
    { name: "reports", description: "รายงาน" },
    { name: "checkin", description: "เช็คอิน QR/LINE (C.1)" },
    { name: "webhooks", description: "LINE OA (C.4)" },
    { name: "system", description: "health" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "จาก POST /api/auth/login → field `token`",
      },
    },
    schemas: {
      ApiError: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              details: {},
            },
          },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string", example: "admin" },
          password: { type: "string", example: "admin" },
        },
      },
      LoginResponse: {
        type: "object",
        properties: {
          token: { type: "string" },
          user: {
            type: "object",
            properties: {
              username: { type: "string" },
              role: { type: "string", enum: ["admin"] },
            },
          },
        },
      },
      BookingStatus: {
        type: "string",
        enum: [
          "PENDING",
          "CONFIRMED",
          "ATTENDED",
          "SICK_LEAVE",
          "EXTENDED",
          "PENDING_RESCHEDULE",
          "CANCELLED",
        ],
      },
      BookingType: {
        type: "string",
        enum: ["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"],
      },
      UpdateStatusRequest: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["confirm", "attend", "sick-leave", "cancel"] },
          reason: { type: "string" },
        },
      },
      CheckinRequest: {
        type: "object",
        required: ["token"],
        properties: { token: { type: "string", description: "checkin_token จาก confirm หรือ GET .../checkin" } },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["system"],
        summary: "Health check",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, db: { type: "boolean" } } } } },
          },
        },
      },
    },
    "/api/auth/login": {
      post: {
        tags: ["auth"],
        summary: "Staff login → JWT",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } },
        },
        responses: {
          "200": { description: "token", content: { "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } } } },
          "401": { description: "รหัสผ่านผิด", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } },
        },
      },
    },
    "/api/calendar": {
      get: {
        tags: ["calendar"],
        summary: "ปฏิทินรวม (aggregate สำหรับหน้า grid)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "date", in: "query", required: true, schema: { type: "string", format: "date", example: "2026-06-30" } },
          { name: "view", in: "query", schema: { type: "string", enum: ["day", "week"], default: "day" } },
        ],
        responses: { "200": { description: "CalendarResponse" } },
      },
    },
    "/api/teachers": {
      get: {
        tags: ["teachers"],
        summary: "รายการครู + วิชา",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "TeacherDTO[]" } },
      },
    },
    "/api/teachers/type-order": {
      get: {
        tags: ["teachers"],
        summary: "ลำดับประเภทครู (FT/PT/FL)",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "{ order: TeacherType[] }" } },
      },
      patch: {
        tags: ["teachers"],
        summary: "บันทึกลำดับประเภทครู",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  order: {
                    type: "array",
                    items: { type: "string", enum: ["FULL_TIME", "PART_TIME", "FREELANCE"] },
                    minItems: 3,
                    maxItems: 3,
                  },
                },
              },
            },
          },
        },
        responses: { "200": { description: "updated order" } },
      },
    },
    "/api/teachers/availability": {
      patch: {
        tags: ["teachers"],
        summary: "เปิด/ปิดรับงาน (รายคนหรือทั้งประเภท)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["active"],
                properties: {
                  teacherId: { type: "string", format: "uuid" },
                  type: { type: "string", enum: ["FULL_TIME", "PART_TIME", "FREELANCE"] },
                  active: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/api/teachers/{id}/work-days": {
      patch: {
        tags: ["teachers"],
        summary: "ตั้งวันที่ครูมาสอน (0=อา … 6=ส)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { workDays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } } },
              },
            },
          },
        },
        responses: { "200": { description: "TeacherDTO" } },
      },
    },
    "/api/courses": {
      get: {
        tags: ["courses"],
        summary: "คอร์สทั้งหมด + quota",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "CourseSummary[]" } },
      },
      post: {
        tags: ["courses"],
        summary: "สมัครคอร์ส recurring (4/6/10 คาบ)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["student", "teacherId", "subjectId", "size", "startDate", "startTime"],
                properties: {
                  student: { oneOf: [{ type: "object", properties: { id: { type: "string", format: "uuid" } } }, { type: "object", properties: { name: { type: "string" }, phone: { type: "string" } } }] },
                  teacherId: { type: "string", format: "uuid" },
                  subjectId: { type: "string", format: "uuid" },
                  size: { type: "integer", enum: [4, 6, 10] },
                  startDate: { type: "string", format: "date" },
                  startTime: { type: "string", example: "09:00" },
                  note: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "course + bookings" } },
      },
    },
    "/api/courses/{id}": {
      patch: {
        tags: ["courses"],
        summary: "ปลดล็อกโควตาลา (admin)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { adminUnlocked: { type: "boolean" } } } } },
        },
        responses: { "200": { description: "CourseSummary" } },
      },
    },
    "/api/vouchers": {
      post: {
        tags: ["vouchers"],
        summary: "ออก voucher (5/10/15 ชม.)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["student", "totalHours"],
                properties: {
                  student: { type: "object" },
                  totalHours: { type: "integer", enum: [5, 10, 15] },
                },
              },
            },
          },
        },
        responses: { "201": { description: "VoucherDTO" } },
      },
    },
    "/api/bookings": {
      get: {
        tags: ["bookings"],
        summary: "รายการจอง (filter + pagination)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "from", in: "query", schema: { type: "string", format: "date" } },
          { name: "to", in: "query", schema: { type: "string", format: "date" } },
          { name: "type", in: "query", schema: { $ref: "#/components/schemas/BookingType" } },
          { name: "status", in: "query", schema: { $ref: "#/components/schemas/BookingStatus" } },
          { name: "teacherId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
        ],
        responses: { "200": { description: "paginated BookingDTO[]" } },
      },
      post: {
        tags: ["bookings"],
        summary: "สร้างการจอง",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["student", "teacherId", "subjectId", "date", "startTime", "bookingType"],
                properties: {
                  student: { type: "object" },
                  teacherId: { type: "string", format: "uuid" },
                  subjectId: { type: "string", format: "uuid" },
                  date: { type: "string", format: "date" },
                  startTime: { type: "string", example: "10:00" },
                  bookingType: { $ref: "#/components/schemas/BookingType" },
                  courseId: { type: "string", format: "uuid" },
                  voucherId: { type: "string", format: "uuid" },
                  note: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "BookingDTO" }, "409": { description: "SLOT_TAKEN" } },
      },
    },
    "/api/bookings/{id}/status": {
      patch: {
        tags: ["bookings"],
        summary: "confirm / attend / sick-leave / cancel",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateStatusRequest" } } },
        },
        responses: { "200": { description: "UpdateStatusResponse (+ notification, extended)" } },
      },
    },
    "/api/bookings/{id}": {
      patch: {
        tags: ["bookings"],
        summary: "ย้ายคาบ (manual move)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "BookingDTO" } },
      },
    },
    "/api/bookings/{id}/checkin": {
      get: {
        tags: ["checkin"],
        summary: "QR / ลิงก์เช็คอิน (staff)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "{ token, url, expiresAt, window }" } },
      },
    },
    "/api/checkin": {
      post: {
        tags: ["checkin"],
        summary: "เช็คอินด้วย token (public)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CheckinRequest" } } },
        },
        responses: { "200": { description: "ATTENDED + CRM points" } },
      },
    },
    "/api/reports/daily": {
      get: {
        tags: ["reports"],
        summary: "รายงานสรุปรายวัน",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "date", in: "query", required: true, schema: { type: "string", format: "date" } }],
        responses: { "200": { description: "DailyReport" } },
      },
    },
    "/api/webhooks/line": {
      post: {
        tags: ["webhooks"],
        summary: "LINE Messaging API webhook (C.4)",
        description: "LINE ยิงมา — ตรวจ `X-Line-Signature` ด้วย Channel secret. ไม่ใช้ JWT.",
        parameters: [
          { name: "X-Line-Signature", in: "header", required: true, schema: { type: "string" } },
        ],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { events: { type: "array", items: { type: "object" } } } } } } },
        responses: { "200": { description: "{ ok: true }" }, "401": { description: "invalid signature" } },
      },
    },
  },
} as const;
