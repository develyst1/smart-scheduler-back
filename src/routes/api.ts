import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/scheduler.service";
import * as badge from "../services/badge.service";
import * as checkin from "../services/checkin.service";
import * as parent from "../services/parent.service";
import { crmLevelLadder } from "../lib/crm";

// Chained so `typeof api` carries every route for Hono's RPC client (hc<AppType>).
export const api = new Hono()
  .get("/calendar", zValidator("query", v.calendarQuery), async (c) =>
    c.json(await svc.getCalendar(c.req.valid("query"))),
  )
  // Booking dropdown source — searchable by name / nickname / parent phone.
  .get("/students", zValidator("query", v.studentsQuery), async (c) => {
    const { q, limit } = c.req.valid("query");
    return c.json(await parent.searchStudents(q, limit));
  })
  // Staff student creation — under an existing parent or a phone (find-or-create).
  .post("/students", zValidator("json", v.createStudent), async (c) =>
    c.json(await parent.createStudent(c.req.valid("json")), 201),
  )
  // CRM ladder — ระดับ + เกณฑ์แต้ม + สิทธิประโยชน์ (UC-020)
  .get("/crm/levels", (c) => c.json(crmLevelLadder()))
  .get("/teachers", zValidator("query", v.teachersQuery), async (c) =>
    c.json(await svc.getTeachers({ archived: c.req.valid("query").archived })),
  )
  .post("/teachers", zValidator("json", v.createTeacher), async (c) =>
    c.json(await svc.createTeacher(c.req.valid("json")), 201),
  )
  .patch("/teachers/:id", zValidator("json", v.updateTeacher), async (c) =>
    c.json(await svc.updateTeacher(c.req.param("id"), c.req.valid("json"))),
  )
  .post("/teachers/:id/archive", async (c) => c.json(await svc.archiveTeacher(c.req.param("id"))))
  .post("/teachers/:id/reactivate", async (c) =>
    c.json(await svc.reactivateTeacher(c.req.param("id"))),
  )
  .get("/teachers/type-order", async (c) => c.json(await svc.getTeacherTypeOrder()))
  .get("/teachers/reconcile", async (c) => c.json(await svc.reconcileTeachers()))
  .patch("/teachers/type-order", zValidator("json", v.setTeacherTypeOrder), async (c) =>
    c.json(await svc.setTeacherTypeOrder(c.req.valid("json").order)),
  )
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
  .patch("/bookings/:id/status", zValidator("json", v.updateStatus), async (c) => {
    const { action, reason, override } = c.req.valid("json");
    return c.json(await svc.updateBookingStatus(c.req.param("id"), action, reason, override));
  })
  .patch("/bookings/:id", zValidator("json", v.moveBooking), async (c) =>
    c.json(await svc.moveBooking(c.req.param("id"), c.req.valid("json"))),
  )
  .patch("/teachers/availability", zValidator("json", v.setAvailability), async (c) =>
    c.json(await svc.setAvailability(c.req.valid("json"))),
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
