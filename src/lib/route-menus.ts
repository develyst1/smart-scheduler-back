// TASK-381 (REQ-092 RBAC Stage 2) — ONE table: every admin route → the SET of menus whose pages call it.
//
// 🔴 The map is from the FE's ACTUAL calls (TASK-381 §3: each `components/partials/<Page>` and the components it
// imports were traced to the hook and service functions they call, and those to the API paths in their bodies).
// A read that serves several pages carries several menus — `GET /teachers` is read by five pages; tying it to one
// would break the other four. Three routes have no FE caller today and are placed by area (✱).
//
// 🔑 One `menuGuard` reads this table for every `/api/*` request (after the auth guard) and applies `requireMenu`.
// A route with NO entry is refused 403 and logged — an auth guard fails CLOSED — and the enumeration test
// (`rbac-stage2-menu-guard-req092.test.ts`) makes an unmapped route unshippable: every route in `routes/api.ts`
// must have an entry, and every entry must name a real route. Stage 3 adds the `action:*` column here.
//
// 🚫 Not in this table: `/auth/*` (public login; `/auth/me*` needs only the JWT) and `/users/*` (`requireSuperAdmin`).

import type { MenuKey } from "./permissions";

const CAL_BOOK: MenuKey[] = ["menu:calendar", "menu:bookings"];
const PEOPLE: MenuKey[] = ["menu:people"];
const BOOKINGS: MenuKey[] = ["menu:bookings"];
const TEACHERS: MenuKey[] = ["menu:teachers"];
const LINKS: MenuKey[] = ["menu:link-requests"];
const BADGES: MenuKey[] = ["menu:badges"];
const SETTINGS: MenuKey[] = ["menu:settings"];

export const ROUTE_MENUS: Record<string, readonly MenuKey[]> = {
  // ── the grid ──
  "GET /calendar": ["menu:calendar"],
  // ── the booking modal (both pages open it) ──
  "GET /bookings": CAL_BOOK,
  "POST /bookings": CAL_BOOK,
  "PATCH /bookings/:id": CAL_BOOK,
  "PATCH /bookings/:id/badges": CAL_BOOK,
  "GET /bookings/:id/checkin": CAL_BOOK,
  "PATCH /bookings/:id/note": CAL_BOOK,
  "POST /bookings/:id/pause": CAL_BOOK,
  "GET /bookings/:id/posted-sale": CAL_BOOK,
  "DELETE /bookings/:id/rental": CAL_BOOK,
  "POST /bookings/:id/rental": CAL_BOOK,
  "POST /bookings/:id/rental/paid": CAL_BOOK,
  "POST /bookings/:id/resume": CAL_BOOK,
  "PATCH /bookings/:id/status": CAL_BOOK,
  "POST /bookings/bulk-confirm": BOOKINGS,
  // ── the booking FORM's reads (opened from both pages) ──
  "POST /rentals": CAL_BOOK,
  "GET /sellable-packages": CAL_BOOK,
  "GET /catalog-items": CAL_BOOK,
  "GET /slots/availability": CAL_BOOK,
  "GET /entitlements/:id/plan": [...CAL_BOOK, "menu:overview"],
  "GET /students": CAL_BOOK,
  "POST /students": CAL_BOOK,
  "GET /students/eligible": CAL_BOOK,
  "GET /crm/levels": [...PEOPLE, ...CAL_BOOK], // ✱ no FE caller today — the CRM ladder on a student card
  // ── people ──
  "PATCH /students/:id": PEOPLE,
  "DELETE /students/:id": PEOPLE,
  "GET /parents": PEOPLE,
  "POST /parents": PEOPLE,
  "GET /parents/:id": PEOPLE,
  "PATCH /parents/:id": PEOPLE,
  "POST /parents/:id/students": PEOPLE,
  "POST /parents/:id/suspend": PEOPLE,
  "POST /parents/:id/unsuspend": PEOPLE,
  "POST /parents/:id/clear-line-link": PEOPLE,
  // ── courses + vouchers (the Bookings page's editor) ──
  "GET /courses": BOOKINGS,
  "POST /courses": BOOKINGS,
  "PATCH /courses/:id": BOOKINGS,
  "POST /courses/preview": BOOKINGS,
  "POST /courses/:id/plan": BOOKINGS,
  "POST /courses/:id/plan/preview": BOOKINGS,
  "PATCH /courses/:id/expiry": BOOKINGS,
  "POST /courses/:id/expiry/preview": BOOKINGS,
  "GET /courses/:id/expiry-history": BOOKINGS, // ✱ no FE caller today
  "POST /courses/:id/extra-session": BOOKINGS,
  "GET /courses/:id/history": BOOKINGS,
  "POST /courses/:id/confirm": BOOKINGS,
  "POST /courses/:id/drop": BOOKINGS,
  "POST /courses/:id/resume": BOOKINGS,
  "POST /courses/:id/cancel": BOOKINGS,
  "POST /courses/:id/cancel/preview": BOOKINGS,
  "POST /courses/import": BOOKINGS,
  "POST /courses/import/preview": BOOKINGS,
  "GET /vouchers": BOOKINGS,
  "POST /vouchers": BOOKINGS,
  "POST /vouchers/import": BOOKINGS,
  // ── teachers (the list is read by FIVE pages) ──
  "GET /teachers": ["menu:calendar", "menu:bookings", "menu:link-requests", "menu:reports", "menu:teachers"],
  "POST /teachers": TEACHERS,
  "PATCH /teachers/:id": TEACHERS,
  "POST /teachers/:id/archive": TEACHERS,
  "POST /teachers/:id/reactivate": TEACHERS,
  "PUT /teachers/:id/budget": TEACHERS,
  "POST /teachers/:id/budget/topup": TEACHERS,
  "PATCH /teachers/:id/limit-override": TEACHERS,
  "PATCH /teachers/:id/work-days": TEACHERS,
  "GET /teachers/:id/work-days/impact": TEACHERS,
  "PATCH /teachers/availability": TEACHERS,
  "GET /teachers/type-order": TEACHERS,
  "PATCH /teachers/type-order": TEACHERS,
  "POST /teachers/:id/calendar-link": TEACHERS, // ✱ no FE caller today
  // ── LINE link requests ──
  "DELETE /teachers/:id/line-link": LINKS,
  "GET /teacher-link-requests": LINKS,
  "POST /teacher-link-requests/:id/approve": LINKS,
  "POST /teacher-link-requests/:id/reject": LINKS,
  // ── badges (the list is also the modal's picker) ──
  "GET /badges": [...BADGES, "menu:calendar"],
  "POST /badges/types": BADGES,
  "PATCH /badges/types/:id": BADGES,
  "POST /badges/values": BADGES,
  "PATCH /badges/values/:id": BADGES,
  "GET /badges/report": ["menu:dashboard"],
  // ── the single-page reads ──
  "GET /attention": ["menu:attention"],
  "GET /reports/daily": ["menu:reports"],
  "GET /reports/som": ["menu:som"],
  "GET /settings": SETTINGS,
  "PUT /settings/:key": SETTINGS,
  "DELETE /settings/:key": SETTINGS,
};

/** The lookup key for a matched Hono route mounted under `/api`. */
export const routeKey = (method: string, apiPath: string): string => `${method.toUpperCase()} ${apiPath.replace(/^\/api/, "")}`;
