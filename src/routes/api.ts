import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/scheduler.service";
import * as badge from "../services/badge.service";
import * as checkin from "../services/checkin.service";
import * as parent from "../services/parent.service";
import * as calendar from "../services/calendar.service";
import * as attention from "../services/attention.service";
import { calendarUrls } from "../lib/calendar-link";
import { crmLevelLadder } from "../lib/crm";

// Chained so `typeof api` carries every route for Hono's RPC client (hc<AppType>).
export const api = new Hono()
  .get("/calendar", zValidator("query", v.calendarQuery), async (c) =>
    c.json(await svc.getCalendar(c.req.valid("query"))),
  )
  // ⚠️ Literal `/students/<word>` routes go BEFORE any `/students/:id` param route (the TASK-029 lesson).
  // Who can be booked against an existing course/voucher, with the context staff pick from (REQ-022).
  .get("/students/eligible", zValidator("query", v.eligibleStudentsQuery), async (c) =>
    c.json(await svc.getEligibleStudents(c.req.valid("query").type)),
  )
  // Booking dropdown source — searchable by name / nickname / parent phone.
  .get("/students", zValidator("query", v.studentsQuery), async (c) => {
    const { q, limit, bookable } = c.req.valid("query");
    return c.json(await parent.searchStudents(q, limit, { bookable }));
  })
  // Staff student creation — under an existing parent or a phone (find-or-create).
  .post("/students", zValidator("json", v.createStudent), async (c) =>
    c.json(await parent.createStudent(c.req.valid("json")), 201),
  )
  // ── People management (REQ-019 / TASK-048) — staff only. Nothing is ever deleted; suspend is the off switch.
  .get("/parents", zValidator("query", v.parentsQuery), async (c) => {
    const { q, limit, offset } = c.req.valid("query");
    return c.json(await parent.listParents(q, limit, offset));
  })
  .post("/parents", zValidator("json", v.createParent), async (c) =>
    c.json(await parent.createParent(c.req.valid("json")), 201),
  )
  .get("/parents/:id", async (c) => c.json(await parent.getParent(c.req.param("id"))))
  .patch("/parents/:id", zValidator("json", v.updateParent), async (c) =>
    c.json(await parent.updateParent(c.req.param("id"), c.req.valid("json"))),
  )
  .post("/parents/:id/students", zValidator("json", v.createParentStudent), async (c) => {
    const { student } = await parent.createStudentForParent(c.req.param("id"), c.req.valid("json"));
    return c.json(student, 201);
  })
  .post("/parents/:id/suspend", async (c) =>
    c.json(await parent.setParentSuspended(c.req.param("id"), true)),
  )
  .post("/parents/:id/unsuspend", async (c) =>
    c.json(await parent.setParentSuspended(c.req.param("id"), false)),
  )
  .patch("/students/:id", zValidator("json", v.updateStudent), async (c) =>
    c.json(await parent.updateStudent(c.req.param("id"), c.req.valid("json"))),
  )
  // REQ-023: what needs attention right now + when the digest last ran (same producer as the LINE digest).
  .get("/attention", async (c) => c.json(await attention.getAttention()))
  // CRM ladder — ระดับ + เกณฑ์แต้ม + สิทธิประโยชน์ (UC-020)
  .get("/crm/levels", (c) => c.json(crmLevelLadder()))
  .get("/teachers", zValidator("query", v.teachersQuery), async (c) =>
    c.json(await svc.getTeachers({ archived: c.req.valid("query").archived })),
  )
  .post("/teachers", zValidator("json", v.createTeacher), async (c) =>
    c.json(await svc.createTeacher(c.req.valid("json")), 201),
  )
  // ⚠️ Literal `/teachers/<word>` PATCH routes MUST be registered before the param route
  // `.patch("/teachers/:id")` below — else Hono matches them as id="availability"/"type-order"
  // → updateTeacher(<word>) → Postgres 22P02 invalid uuid → 500 (TASK-029 §3).
  .patch("/teachers/availability", zValidator("json", v.setAvailability), async (c) =>
    c.json(await svc.setAvailability(c.req.valid("json"))),
  )
  .patch("/teachers/type-order", zValidator("json", v.setTeacherTypeOrder), async (c) =>
    c.json(await svc.setTeacherTypeOrder(c.req.valid("json").order)),
  )
  .patch("/teachers/:id", zValidator("json", v.updateTeacher), async (c) =>
    c.json(await svc.updateTeacher(c.req.param("id"), c.req.valid("json"))),
  )
  .put("/teachers/:id/budget", zValidator("json", v.setFreelanceBudget), async (c) =>
    c.json(await svc.setFreelanceBudget(c.req.param("id"), c.req.valid("json"))),
  )
  .post("/teachers/:id/budget/topup", zValidator("json", v.topUpBudget), async (c) =>
    c.json(await svc.topUpFreelanceBudget(c.req.param("id"), c.req.valid("json").amountMinor)),
  )
  // Staff: get-or-create the teacher's calendar-subscription link; `?rotate=true` kills the old one (REQ-017).
  .post("/teachers/:id/calendar-link", async (c) => {
    const rotate = c.req.query("rotate") === "true";
    const { token, rotated } = await calendar.getOrCreateCalendarToken(c.req.param("id"), { rotate });
    return c.json({ ...calendarUrls(token), rotated });
  })
  .post("/teachers/:id/archive", async (c) => c.json(await svc.archiveTeacher(c.req.param("id"))))
  .post("/teachers/:id/reactivate", async (c) =>
    c.json(await svc.reactivateTeacher(c.req.param("id"))),
  )
  .get("/teachers/type-order", async (c) => c.json(await svc.getTeacherTypeOrder()))
  .get("/courses", async (c) => c.json(await svc.getCourses()))
  .post("/courses", zValidator("json", v.createCoursePackage), async (c) =>
    c.json(await svc.createCoursePackage(c.req.valid("json")), 201),
  )
  .get("/vouchers", zValidator("query", v.vouchersQuery), async (c) =>
    c.json(await svc.getVouchers(c.req.valid("query"))),
  )
  .post("/vouchers", zValidator("json", v.createVoucher), async (c) =>
    c.json(await svc.createVoucher(c.req.valid("json")), 201),
  )
  .get("/bookings", zValidator("query", v.bookingsQuery), async (c) =>
    c.json(await svc.getBookings(c.req.valid("query"))),
  )
  .get("/reports/daily", zValidator("query", v.reportQuery), async (c) =>
    c.json(await svc.getDailyReport(c.req.valid("query").date)),
  )
  .post("/bookings", zValidator("json", v.createBooking), async (c) =>
    c.json(await svc.createBooking(c.req.valid("json")), 201),
  )
  .post("/bookings/bulk-confirm", zValidator("json", v.bulkConfirm), async (c) =>
    c.json(await svc.bulkConfirm(c.req.valid("json").ids)),
  )
  .patch("/bookings/:id/status", zValidator("json", v.updateStatus), async (c) => {
    const { action, reason, override } = c.req.valid("json");
    return c.json(await svc.updateBookingStatus(c.req.param("id"), action, reason, override));
  })
  .patch("/bookings/:id", zValidator("json", v.moveBooking), async (c) =>
    c.json(await svc.moveBooking(c.req.param("id"), c.req.valid("json"))),
  )
  .patch("/teachers/:id/work-days", zValidator("json", v.setTeacherWorkDays), async (c) =>
    c.json(await svc.setTeacherWorkDays(c.req.param("id"), c.req.valid("json").workDays)),
  )
  .patch("/teachers/:id/limit-override", zValidator("json", v.setLimitOverride), async (c) =>
    c.json(await svc.setLimitOverride(c.req.param("id"), c.req.valid("json").override)),
  )
  .patch("/courses/:id", zValidator("json", v.updateCourse), async (c) =>
    c.json(await svc.updateCourse(c.req.param("id"), c.req.valid("json"))),
  )
  .get("/bookings/:id/checkin", async (c) =>
    c.json(await checkin.getCheckinQr(c.req.param("id"))),
  )
  // ── Badges (admin-defined tags on bookings) ──
  .get("/badges", zValidator("query", v.badgesQuery), async (c) =>
    c.json(await badge.listBadges(c.req.valid("query").includeInactive)),
  )
  .get("/badges/report", zValidator("query", v.badgeReportQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    return c.json(await badge.getBadgeReport(from, to));
  })
  .post("/badges/types", zValidator("json", v.createBadgeType), async (c) =>
    c.json(await badge.createBadgeType(c.req.valid("json")), 201),
  )
  .patch("/badges/types/:id", zValidator("json", v.updateBadgeType), async (c) =>
    c.json(await badge.updateBadgeType(c.req.param("id"), c.req.valid("json"))),
  )
  .post("/badges/values", zValidator("json", v.createBadgeValue), async (c) =>
    c.json(await badge.createBadgeValue(c.req.valid("json")), 201),
  )
  .patch("/badges/values/:id", zValidator("json", v.updateBadgeValue), async (c) =>
    c.json(await badge.updateBadgeValue(c.req.param("id"), c.req.valid("json"))),
  )
  .patch("/bookings/:id/badges", zValidator("json", v.setBookingBadges), async (c) =>
    c.json(await badge.setBookingBadges(c.req.param("id"), c.req.valid("json").badgeValueIds)),
  );
