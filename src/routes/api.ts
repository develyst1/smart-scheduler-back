import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import { assertMayDiscount } from "../lib/discount-plan";
import * as svc from "../services/scheduler.service";
import * as badge from "../services/badge.service";
import * as checkin from "../services/checkin.service";
import * as parent from "../services/parent.service";
import * as calendar from "../services/calendar.service";
import * as attention from "../services/attention.service";
import * as teacherLink from "../services/teacher-link.service";
import * as som from "../services/som-report.service";
import * as settings from "../services/settings.service";
import * as rental from "../services/rental.service";
import { calendarUrls } from "../lib/calendar-link";
import { crmLevelLadder } from "../lib/crm";
import { isSettingKey } from "../lib/settings";
import { badRequest } from "../lib/http";

// Chained so `typeof api` carries every route for Hono's RPC client (hc<AppType>).
export const api = new Hono()
  .get("/calendar", zValidator("query", v.calendarQuery), async (c) =>
    c.json(await svc.getCalendar(c.req.valid("query"))),
  )
  // ⚠️ Literal `/students/<word>` routes go BEFORE any `/students/:id` param route (the TASK-029 lesson).
  // Who can be booked against an existing course/voucher, with the context staff pick from (REQ-022).
  .get("/students/eligible", zValidator("query", v.eligibleStudentsQuery), async (c) => {
    const { type, q } = c.req.valid("query");
    return c.json(await svc.getEligibleStudents(type, q));
  })
  // Booking dropdown source — searchable by name / nickname / parent phone.
  .get("/students", zValidator("query", v.studentsQuery), async (c) => {
    const { q, limit } = c.req.valid("query");
    return c.json(await parent.searchStudents(q, limit));
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
  // REQ-020 Stage 2 (TASK-075) — teacher LINE link requests. Approval is the ONLY path that grants a link.
  .get("/teacher-link-requests", zValidator("query", v.linkRequestsQuery), async (c) =>
    c.json({ items: await teacherLink.listTeacherLinkRequests(c.req.valid("query").status) }),
  )
  .post(
    "/teacher-link-requests/:id/approve",
    zValidator("json", v.approveLinkRequest),
    async (c) => {
      const { id } = c.req.param();
      return c.json(await teacherLink.approveTeacherLinkRequest(id, c.req.valid("json")));
    },
  )
  .post("/teacher-link-requests/:id/reject", zValidator("json", v.rejectLinkRequest), async (c) => {
    const { id } = c.req.param();
    return c.json(await teacherLink.rejectTeacherLinkRequest(id, c.req.valid("json").decidedBy));
  })
  // CRM ladder — ระดับ + เกณฑ์แต้ม + สิทธิประโยชน์ (UC-020)
  // SPEC-024 — the (program, size, price) combinations that actually exist, so the FE offers only what is
  // offered instead of hard-coding the price card into a dropdown that will drift from it.
  // SPEC-064 / TASK-181 (REQ-036) — end a course early. The preview writes nothing and is what powers the
  // confirm dialog's count (R2): the number a staff member confirms is the number the server will cancel,
  // never one the client worked out for itself.
  .post("/courses/:id/cancel/preview", zValidator("json", v.endCoursePreview), async (c) =>
    c.json(await svc.previewCourseEnd(c.req.param("id"))),
  )
  .post("/courses/:id/cancel", zValidator("json", v.endCourse), async (c) => {
    const body = c.req.valid("json");
    return c.json(
      await svc.endCourse(c.req.param("id"), body, c.get("user")?.sub ?? null),
    );
  })
  // SPEC-066 / TASK-201 (REQ-072) — confirm every PENDING session of a course in one action, with exactly ONE
  // teacher LINE. Distinct from `/bookings/bulk-confirm`, which is per-session and sends one message each.
  .post("/courses/:id/confirm", async (c) => c.json(await svc.confirmCourse(c.req.param("id"))))
  // SPEC-065 / TASK-198 — pause a course (off the calendar, not deleted, still owed) and bring it back on its
  // own slot. Separate verbs from `/cancel`: reversible and terminal must not share a button or a code.
  .post("/courses/:id/drop", zValidator("json", v.dropCourse), async (c) =>
    c.json(await svc.dropCourse(c.req.param("id"), c.req.valid("json"), c.get("user")?.sub ?? null)),
  )
  .post("/courses/:id/resume", zValidator("json", v.resumeCourse), async (c) =>
    c.json(await svc.resumeCourse(c.req.param("id"), c.req.valid("json"), c.get("user")?.sub ?? null)),
  )
  .get("/sellable-packages", async (c) => c.json(await svc.getSellablePackages()))
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
  // TASK-075 — unlink a teacher's LINE account. A departed teacher otherwise keeps receiving schedule
  // pushes forever with no way to stop it. Reversible: they can claim again, which queues a request.
  // (No shadowing risk: `line-link` is the 3rd segment, so it can't be matched as an `:id`.)
  .delete("/teachers/:id/line-link", async (c) => {
    const { id } = c.req.param();
    return c.json(await teacherLink.unlinkTeacherLine(id));
  })
  .post("/teachers/:id/archive", async (c) => c.json(await svc.archiveTeacher(c.req.param("id"))))
  .post("/teachers/:id/reactivate", async (c) =>
    c.json(await svc.reactivateTeacher(c.req.param("id"))),
  )
  .get("/teachers/type-order", async (c) => c.json(await svc.getTeacherTypeOrder()))
  .get("/courses", zValidator("query", v.coursesQuery), async (c) =>
    c.json(await svc.listCoursesPaged(c.req.valid("query"))),
  )
  // 🔴 SPEC-025 — IMPORT is a separate VERB, never a flag on the sale path: a boolean is one forgotten
  // default away from posting a fictional month of revenue. Registered before `/courses` so the literal
  // path can never be read as anything else (the TASK-029 lesson).
  // TASK-095 — purchase-time slot picker + preview. Preview writes nothing; registered before `/courses/:id`.
  .get("/slots/availability", zValidator("query", v.slotAvailabilityQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json(await svc.getSlotAvailability(q.date, q.startTime));
  })
  .post("/courses/preview", zValidator("json", v.previewCourse), async (c) =>
    c.json(await svc.previewCoursePackage(c.req.valid("json"))),
  )
  // SPEC-068 / TASK-213 — what an import WOULD be (expiry default, quota, max week). Read-only: the form shows
  // the computed expiry as an EDITABLE default instead of the old hard-coded "today + 2 months".
  .post("/courses/import/preview", zValidator("json", v.importCoursePreview), async (c) =>
    c.json(svc.previewCourseImport(c.req.valid("json"))),
  )
  .post("/courses/import", zValidator("json", v.importCoursePackage), async (c) =>
    c.json(await svc.importCoursePackage(c.req.valid("json")), 201),
  )
  .post("/vouchers/import", zValidator("json", v.importVoucher), async (c) =>
    c.json(await svc.importVoucher(c.req.valid("json")), 201),
  )
  .post("/courses", zValidator("json", v.createCoursePackage), async (c) => {
    const body = c.req.valid("json");
    // TASK-160: only an admin may discount, and the actor comes from the TOKEN — never from the body, or
    // "who authorised this" would be whatever the caller typed.
    assertMayDiscount(body.discount, c.get("user"));
    return c.json(await svc.createCoursePackage({ ...body, actor: c.get("user")?.sub ?? null }), 201);
  })
  .get("/vouchers", zValidator("query", v.vouchersQuery), async (c) =>
    c.json(await svc.listVouchersPaged(c.req.valid("query"))),
  )
  .post("/vouchers", zValidator("json", v.createVoucher), async (c) => {
    const body = c.req.valid("json");
    assertMayDiscount(body.discount, c.get("user"));
    return c.json(await svc.createVoucher({ ...body, actor: c.get("user")?.sub ?? null }), 201);
  })
  .get("/bookings", zValidator("query", v.bookingsQuery), async (c) =>
    c.json(await svc.getBookings(c.req.valid("query"))),
  )
  .get("/reports/daily", zValidator("query", v.reportQuery), async (c) =>
    c.json(await svc.getDailyReport(c.req.valid("query").date)),
  )
  // REQ-013: the SOM dashboard in ONE snapshot — no params, "today"/"this month" resolved server-side.
  .get("/reports/som", async (c) => c.json(await som.getSomReport()))
  .post("/bookings", zValidator("json", v.createBooking), async (c) => {
    const body = c.req.valid("json");
    // TASK-162: same admin-only rule and same token-sourced actor as the at-sale discounts.
    assertMayDiscount(body.discount, c.get("user"));
    return c.json(await svc.createBooking({ ...body, actor: c.get("user")?.sub ?? null }), 201);
  })
  .post("/bookings/bulk-confirm", zValidator("json", v.bulkConfirm), async (c) =>
    c.json(await svc.bulkConfirm(c.req.valid("json").ids)),
  )
  .patch("/bookings/:id/status", zValidator("json", v.updateStatus), async (c) => {
    const { action, reason, override, reasonCode } = c.req.valid("json");
    return c.json(
      await svc.updateBookingStatus(c.req.param("id"), action, reason, override, reasonCode),
    );
  })
  .patch("/bookings/:id", zValidator("json", v.moveBooking), async (c) =>
    c.json(await svc.moveBooking(c.req.param("id"), c.req.valid("json"))),
  )
  // SPEC-063 / TASK-178 (REQ-068) — the attendee note, on its own route. Deliberately NOT part of
  // `PATCH /bookings/:id`: that one re-times a session and tells the teacher; a note is not a status change and
  // must notify nobody (AC-8).
  .patch("/bookings/:id/note", zValidator("json", v.setAttendeeNote), async (c) =>
    c.json(await svc.setAttendeeNote(c.req.param("id"), c.req.valid("json").attendeeNote)),
  )
  // TASK-100: soft-warning preview — orphan impact of a proposed workDays change, without applying it.
  .get("/teachers/:id/work-days/impact", zValidator("query", v.workDaysImpactQuery), async (c) =>
    c.json(await svc.previewWorkDaysChange(c.req.param("id"), c.req.valid("query").workDays)),
  )
  .patch("/teachers/:id/work-days", zValidator("json", v.setTeacherWorkDays), async (c) =>
    c.json(await svc.setTeacherWorkDays(c.req.param("id"), c.req.valid("json").workDays)),
  )
  .patch("/teachers/:id/limit-override", zValidator("json", v.setLimitOverride), async (c) =>
    c.json(await svc.setLimitOverride(c.req.param("id"), c.req.valid("json").override)),
  )
  .post("/courses/:id/plan", zValidator("json", v.planChange), async (c) =>
    c.json(await svc.applyPlanChange(c.req.param("id"), c.req.valid("json"))),
  )
  // SPEC-028 §12.2 (TASK-114): a dry-run of the SAME applier — full tx, read back the resulting plan, roll back.
  // preview == apply by construction; a refused change returns the same typed reason.
  .post("/courses/:id/plan/preview", zValidator("json", v.planChange), async (c) =>
    c.json(await svc.applyPlanChange(c.req.param("id"), c.req.valid("json"), { dryRun: true })),
  )
  // SPEC-033 §4 (TASK-112): a PAID extra session beside the plan — SINGLE_SESSION soft-linked by courseId, out of
  // quota. Distinct route from /plan so the seam is visible in the API, not just the UI.
  .post("/courses/:id/extra-session", zValidator("json", v.extraSession), async (c) =>
    c.json(await svc.addExtraSession(c.req.param("id"), c.req.valid("json")), 201),
  )
  // SPEC-035 (TASK-119): read-only "ประวัติการตัดคอร์ส" — a timeline reconstructed from existing bookings + the
  // freelance ledger. No migration; who/intermediate-hops are honest gaps (actor:null, current-status-only).
  .get("/courses/:id/history", async (c) => c.json(await svc.getCourseHistory(c.req.param("id"))))
  .get("/entitlements/:id/plan", async (c) =>
    c.json(await svc.getEntitlementPlan(c.req.param("id"))),
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
  )
  // ── Equipment rental as revenue (SPEC-031 / REQ-028) — the post IS the event, so the result is surfaced ──
  .post("/rentals", zValidator("json", v.recordRental), async (c) => {
    const body = c.req.valid("json");
    assertMayDiscount(body.discount, c.get("user"));
    const r = await rental.recordRental({ ...body, actor: c.get("user")?.sub ?? null });
    return c.json(r, r.status === "recorded" ? 201 : 200);
  })
  // ── Configurable business rules (SPEC-029 / REQ-031) ──
  .get("/settings", async (c) => c.json(await settings.listSettings()))
  .put("/settings/:key", zValidator("json", v.putSetting), async (c) => {
    const key = c.req.param("key");
    if (!isSettingKey(key)) throw badRequest(`ไม่รู้จักการตั้งค่า "${key}"`);
    return c.json(await settings.setSetting(key, c.req.valid("json").value));
  })
  // TASK-122: reset-to-default — DELETE drops the override row so the resolver returns the coded default
  // (isOverridden:false). Idempotent (no-op if already default); same isSettingKey guard as PUT.
  .delete("/settings/:key", async (c) => {
    const key = c.req.param("key");
    if (!isSettingKey(key)) throw badRequest(`ไม่รู้จักการตั้งค่า "${key}"`);
    return c.json(await settings.resetSetting(key));
  });
