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
  .get("/courses", async (c) => c.json(await svc.getCourses()))
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
    const { action, reason } = c.req.valid("json");
    return c.json(await svc.updateBookingStatus(c.req.param("id"), action, reason));
  })
  .patch("/teachers/availability", zValidator("json", v.setAvailability), async (c) =>
    c.json(await svc.setAvailability(c.req.valid("json"))),
  )
  .patch("/courses/:id", zValidator("json", v.updateCourse), async (c) =>
    c.json(await svc.updateCourse(c.req.param("id"), c.req.valid("json"))),
  );
