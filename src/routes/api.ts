import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/scheduler.service";

// Chained so `typeof api` carries every route for Hono's RPC client (hc<AppType>).
export const api = new Hono()
  .get("/calendar", zValidator("query", v.calendarQuery), async (c) =>
    c.json(await svc.getCalendar(c.req.valid("query"))),
  )
  .get("/teachers", async (c) => c.json(await svc.getTeachers()))
  .get("/teachers/type-order", async (c) => c.json(await svc.getTeacherTypeOrder()))
  .patch("/teachers/type-order", zValidator("json", v.setTeacherTypeOrder), async (c) =>
    c.json(await svc.setTeacherTypeOrder(c.req.valid("json").order)),
  )
  .get("/courses", async (c) => c.json(await svc.getCourses()))
  .post("/courses", zValidator("json", v.createCoursePackage), async (c) =>
    c.json(await svc.createCoursePackage(c.req.valid("json")), 201),
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
  // Conflict resolution (B.1): overbook + move existing, then parent confirm/cancel.
  .post(
    "/bookings/with-reschedule",
    zValidator("json", v.createBookingWithReschedule),
    async (c) => c.json(await svc.createBookingWithReschedule(c.req.valid("json")), 201),
  )
  .patch("/bookings/:id/reschedule/confirm", async (c) =>
    c.json(await svc.confirmReschedule(c.req.param("id"))),
  )
  .patch("/bookings/:id/reschedule/cancel", async (c) =>
    c.json(await svc.cancelReschedule(c.req.param("id"))),
  )
  .patch("/bookings/:id/status", zValidator("json", v.updateStatus), async (c) => {
    const { action, reason } = c.req.valid("json");
    return c.json(await svc.updateBookingStatus(c.req.param("id"), action, reason));
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
  .patch("/courses/:id", zValidator("json", v.updateCourse), async (c) =>
    c.json(await svc.updateCourse(c.req.param("id"), c.req.valid("json"))),
  );
