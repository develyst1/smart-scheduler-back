// TASK-381 (REQ-092 RBAC Stage 2) + TASK-385 (Stage 3) — ONE table: every admin route → the SET of menus whose
// pages call it, and (Stage 3) the ACTION a mutate route is.
//
// 🔴 The menus are from the FE's ACTUAL calls (TASK-381 §3: each `components/partials/<Page>` and the components it
// imports were traced to the hook and service functions they call, and those to the API paths in their bodies).
// A read that serves several pages carries several menus — `GET /teachers` is read by five pages; tying it to one
// would break the other four. Three routes have no FE caller today and are placed by area (✱).
//
// 🔴 The action is by the ONE naming rule in `lib/permissions.ts`: a route's key = its act; a preview shares its
// act's key; an act and its undo share one key; create ≠ edit. Every POST/PATCH/PUT/DELETE carries an `action`;
// a read carries none. Two acts gate a BODY field and are not here (the discount, the leave override).
//
// 🔑 One `accessGuard` reads this table for every `/api/*` request (after the auth guard): the menu check, THEN
// the action check with its own sentence. A route with NO entry is refused 403 and logged — an auth guard fails
// CLOSED — and the enumeration test (`rbac-stage2-menu-guard-req092.test.ts` + `rbac-stage3-actions-req092.test.ts`)
// makes an unmapped route unshippable: every route in `routes/api.ts` must have an entry, every entry must name a
// real route, every mutate route must carry an action, and every action key must be used.
//
// 🚫 Not in this table: `/auth/*` (public login), `/users/*` + `/roles/*` (`requireSuperAdmin`), `/me*` and `/permissions` (the
// signed-in user's own routes — the JWT alone; TASK-383 moved `/me` off `/auth` because NextAuth owns that path on
// the FE host).

import type { ActionKey, MenuKey } from "./permissions";

export type RouteAccess = { readonly menus: readonly MenuKey[]; readonly action?: ActionKey };

const CAL_BOOK: MenuKey[] = ["menu:calendar", "menu:bookings"];
const PEOPLE: MenuKey[] = ["menu:people"];
const BOOKINGS: MenuKey[] = ["menu:bookings"];
const TEACHERS: MenuKey[] = ["menu:teachers"];
const LINKS: MenuKey[] = ["menu:link-requests"];
const BADGES: MenuKey[] = ["menu:badges"];
const SETTINGS: MenuKey[] = ["menu:settings"];
const read = (menus: readonly MenuKey[]): RouteAccess => ({ menus });
const act = (menus: readonly MenuKey[], action: ActionKey): RouteAccess => ({ menus, action });

/**
 * TASK-406 (REQ-097) — the routes a LINKED (teacher) account may reach at all, whatever its role grants; the access
 * guard refuses everything else with `403 SCOPE_TEACHER` (fails closed). Taken from the FE's calendar page and its
 * booking modal (TASK-407 keeps the two lists the same): the grid (`GET /calendar`), the month/paused reads
 * (`GET /bookings`), the roster and badge lookups the page renders with, the modal's check-in and posted-sale reads,
 * the check-in action, and the leave. 🚫 Nothing that returns another person's booking rows or people data
 * (`/students*`, `/parents*`, `/courses*`, `/attention`, `/reports*`). `/me` and `/permissions` are outside the table.
 */
export const TEACHER_ALLOWED: ReadonlySet<string> = new Set([
  "GET /calendar",
  "GET /bookings",
  "GET /teachers",
  "GET /badges",
  "GET /bookings/:id/checkin",
  "GET /bookings/:id/posted-sale",
  "PATCH /bookings/:id/status", // `attend` only — the body is checked at the route (`assertScopedStatusAction`)
  "POST /teachers/me/leave",
]);

export const ROUTE_ACCESS: Record<string, RouteAccess> = {
  // ── the grid ──
  "GET /calendar": read(["menu:calendar"]),
  // ── the booking modal (both pages open it) ──
  "GET /bookings": read(CAL_BOOK),
  "POST /bookings": act(CAL_BOOK, "action:calendar.book"), // + `action:sales.discount` on its `discount` field (service)
  "PATCH /bookings/:id": act(CAL_BOOK, "action:calendar.booking-edit"),
  "PATCH /bookings/:id/other": act(CAL_BOOK, "action:calendar.booking-edit"), // TASK-394 — an edit, not a move
  "POST /bookings/other-series": act(CAL_BOOK, "action:calendar.other-series"), // TASK-394 — its own act
  "POST /bookings/group-series": act(CAL_BOOK, "action:calendar.group-series"), // TASK-397 — its own act
  "PATCH /bookings/:id/group-teacher": act(CAL_BOOK, "action:calendar.booking-edit"), // TASK-397 — an edit
  "PATCH /bookings/:id/badges": act(CAL_BOOK, "action:calendar.badges"),
  "GET /bookings/:id/checkin": read(CAL_BOOK),
  "PATCH /bookings/:id/note": act(CAL_BOOK, "action:calendar.note"),
  "POST /bookings/:id/pause": act(CAL_BOOK, "action:calendar.pause"),
  "GET /bookings/:id/posted-sale": read(CAL_BOOK),
  "DELETE /bookings/:id/rental": act(CAL_BOOK, "action:calendar.rental"),
  "POST /bookings/:id/rental": act(CAL_BOOK, "action:calendar.rental"),
  "POST /bookings/:id/rental/paid": act(CAL_BOOK, "action:calendar.rental"),
  "POST /bookings/:id/resume": act(CAL_BOOK, "action:calendar.pause"),
  "POST /teachers/me/leave": act(["menu:calendar"], "action:calendar.teacher-leave"), // TASK-406 — a LINKED account only (the route asserts)
  "PATCH /bookings/:id/status": act(CAL_BOOK, "action:calendar.status"), // + `action:calendar.leave-override` on its `override` flag (route)
  "POST /bookings/bulk-confirm": act(BOOKINGS, "action:bookings.bulk-confirm"),
  // ── the booking FORM's reads (opened from both pages) ──
  "POST /rentals": act(CAL_BOOK, "action:calendar.rental-sale"), // + `action:sales.discount` (service)
  "GET /sellable-packages": read(CAL_BOOK),
  "GET /catalog-items": read(CAL_BOOK),
  "GET /slots/availability": read(CAL_BOOK),
  "GET /entitlements/:id/plan": read([...CAL_BOOK, "menu:overview"]),
  "GET /students": read(CAL_BOOK),
  "POST /students": act(CAL_BOOK, "action:people.student-create"), // the booking form creates inline; the ACT is a people act
  "GET /students/eligible": read(CAL_BOOK),
  "GET /crm/levels": read([...PEOPLE, ...CAL_BOOK]), // ✱ no FE caller today — the CRM ladder on a student card
  // ── people ──
  "PATCH /students/:id": act(PEOPLE, "action:people.student-edit"),
  "DELETE /students/:id": act(PEOPLE, "action:people.student-delete"),
  "POST /students/:id/archive": act(PEOPLE, "action:people.student-archive"), // TASK-392
  "POST /students/:id/unarchive": act(PEOPLE, "action:people.student-archive"),
  "GET /parents": read(PEOPLE),
  "POST /parents": act(PEOPLE, "action:people.parent-create"),
  "GET /parents/:id": read(PEOPLE),
  "PATCH /parents/:id": act(PEOPLE, "action:people.parent-edit"),
  "POST /parents/:id/students": act(PEOPLE, "action:people.parent-students"),
  "POST /parents/:id/suspend": act(PEOPLE, "action:people.parent-suspend"),
  "POST /parents/:id/unsuspend": act(PEOPLE, "action:people.parent-suspend"),
  "POST /parents/:id/clear-line-link": act(PEOPLE, "action:people.parent-line-unlink"),
  // ── courses + vouchers (the Bookings page's editor) ──
  "GET /courses": read(BOOKINGS),
  "POST /courses": act(BOOKINGS, "action:bookings.course-create"), // + `action:sales.discount` (service)
  "PATCH /courses/:id": act(BOOKINGS, "action:bookings.course-edit"),
  "POST /courses/preview": act(BOOKINGS, "action:bookings.course-create"),
  "POST /courses/:id/plan": act(BOOKINGS, "action:bookings.course-plan"),
  "POST /courses/:id/plan/preview": act(BOOKINGS, "action:bookings.course-plan"),
  "PATCH /courses/:id/expiry": act(BOOKINGS, "action:bookings.course-expiry"),
  "POST /courses/:id/expiry/preview": act(BOOKINGS, "action:bookings.course-expiry"),
  "GET /courses/:id/expiry-history": read(BOOKINGS), // ✱ no FE caller today
  "POST /courses/:id/extra-session": act(BOOKINGS, "action:bookings.course-extra-session"),
  "GET /courses/:id/history": read(BOOKINGS),
  "POST /courses/:id/confirm": act(BOOKINGS, "action:bookings.course-confirm"),
  "POST /courses/:id/drop": act(BOOKINGS, "action:bookings.course-drop"),
  "POST /courses/:id/resume": act(BOOKINGS, "action:bookings.course-drop"),
  "POST /courses/:id/cancel": act(BOOKINGS, "action:bookings.course-cancel"),
  "POST /courses/:id/cancel/preview": act(BOOKINGS, "action:bookings.course-cancel"),
  "POST /courses/import": act(BOOKINGS, "action:bookings.course-import"),
  "POST /courses/import/preview": act(BOOKINGS, "action:bookings.course-import"),
  "DELETE /courses/:id/rental": act(BOOKINGS, "action:bookings.course-rental"), // TASK-390 — remove from the remaining sessions, no money
  "GET /vouchers": read(BOOKINGS),
  "POST /vouchers": act(BOOKINGS, "action:bookings.voucher-create"), // + `action:sales.discount` (service)
  "POST /vouchers/import": act(BOOKINGS, "action:bookings.voucher-import"),
  // ── teachers (the list is read by FIVE pages) ──
  "GET /teachers": read(["menu:calendar", "menu:bookings", "menu:link-requests", "menu:reports", "menu:teachers"]),
  "POST /teachers": act(TEACHERS, "action:teachers.create"),
  "PATCH /teachers/:id": act(TEACHERS, "action:teachers.edit"),
  "POST /teachers/:id/archive": act(TEACHERS, "action:teachers.archive"),
  "POST /teachers/:id/reactivate": act(TEACHERS, "action:teachers.archive"),
  "PUT /teachers/:id/budget": act(TEACHERS, "action:teachers.budget"),
  "POST /teachers/:id/budget/topup": act(TEACHERS, "action:teachers.budget"),
  "PATCH /teachers/:id/limit-override": act(TEACHERS, "action:teachers.limit-override"),
  "PATCH /teachers/:id/work-days": act(TEACHERS, "action:teachers.work-days"),
  "GET /teachers/:id/work-days/impact": read(TEACHERS),
  "PATCH /teachers/availability": act(TEACHERS, "action:teachers.availability"),
  "GET /teachers/type-order": read(TEACHERS),
  "PATCH /teachers/type-order": act(TEACHERS, "action:teachers.type-order"),
  "POST /teachers/:id/calendar-link": act(TEACHERS, "action:teachers.calendar-link"), // ✱ no FE caller today
  // ── LINE link requests ──
  "DELETE /teachers/:id/line-link": act(LINKS, "action:link-requests.unlink"),
  "GET /teacher-link-requests": read(LINKS),
  "POST /teacher-link-requests/:id/approve": act(LINKS, "action:link-requests.decide"),
  "POST /teacher-link-requests/:id/reject": act(LINKS, "action:link-requests.decide"),
  // ── badges (the list is also the modal's picker) ──
  "GET /badges": read([...BADGES, "menu:calendar"]),
  "POST /badges/types": act(BADGES, "action:badges.type-create"),
  "PATCH /badges/types/:id": act(BADGES, "action:badges.type-edit"),
  "POST /badges/values": act(BADGES, "action:badges.value-create"),
  "PATCH /badges/values/:id": act(BADGES, "action:badges.value-edit"),
  "GET /badges/report": read(["menu:dashboard"]),
  // ── camp (TASK-401) — its own menu; reads on the menu, each write on its act ──
  "GET /camp/prices": read(["menu:camp"]),
  "GET /camp/weeks": read(["menu:camp"]),
  "POST /camp/weeks": act(["menu:camp"], "action:camp.week-open"),
  "PATCH /camp/weeks/:id": act(["menu:camp"], "action:camp.week-open"),
  "GET /camp/weeks/:id/days": read(["menu:camp"]),
  "GET /camp/packages": read(["menu:camp", "menu:people"]), // the student's Camp card reads it from the People page too
  "POST /camp/packages": act(["menu:camp"], "action:camp.sell"),
  "POST /camp/packages/:id/days": act(["menu:camp"], "action:camp.redeem"),
  "PATCH /camp/days/:id": act(["menu:camp"], "action:camp.day-mark"), // TASK-403: the undo (status PLANNED + reason) rides the same act
  "GET /camp/days/:id/checkin": read(["menu:camp"]), // TASK-403: the day's QR (lazy token)
  // ── the single-page reads ──
  "GET /attention": read(["menu:attention"]),
  "GET /reports/daily": read(["menu:reports"]),
  "GET /reports/som": read(["menu:som"]),
  "GET /settings": read(SETTINGS),
  "PUT /settings/:key": act(SETTINGS, "action:settings.edit"),
  "DELETE /settings/:key": act(SETTINGS, "action:settings.edit"), // reset to default — the same act
};

/** The lookup key for a matched Hono route mounted under `/api`. */
export const routeKey = (method: string, apiPath: string): string => `${method.toUpperCase()} ${apiPath.replace(/^\/api/, "")}`;
