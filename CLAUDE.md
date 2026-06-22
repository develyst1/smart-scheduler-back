# CLAUDE.md — smart-scheduler-back (Scheduling API)

Guides Claude Code (and other agents) in this repo. For the cross-repo map see the
workspace root `../CLAUDE.md`. This repo is **greenfield**.

## What this is

The **frontoffice backend** — the **Scheduling API** that powers `smart-scheduler-front`. It is the
**source of truth** for teachers, bookings, attendance, and the leave/extension rules. **Phase 1.**

> Spec (Thai): [req2.md](../smart-scheduler-front/req2.md) (current; wins) and
> [Requirement.md](../smart-scheduler-front/Requirement.md). The frontend already encodes the domain
> rules as a reference — **port them here and make them authoritative** (the client is never trusted).

## Stack

- **Bun** runtime + **Hono** (HTTP framework) + **Drizzle ORM** + **PostgreSQL** (the **shared** DB)
- TypeScript (strict). Tests with `bun test`.

```bash
bun install
bun run dev                 # bun --watch src/index.ts
bunx drizzle-kit generate   # create migration from schema
bunx drizzle-kit migrate    # apply migrations
bun test
```

## Suggested layout

```
src/
  index.ts                 # Hono app, middleware, mount routes, export `AppType` for FE RPC
  routes/<domain>.ts       # Hono routers (teachers, bookings, attendance, reports)
  services/<domain>.ts     # business logic — the source of truth (quota/extension/auto-recurring)
  db/
    schema.ts              # Drizzle schema for THIS app's tables (see ownership rule)
    index.ts               # drizzle client (postgres connection)
  lib/
    line.ts                # LINE Messaging API push client (+ outbox/retry)
    validation.ts          # zod schemas for request bodies
  middleware/              # auth (staff/admin role), error handler, request logging
drizzle.config.ts
```

Conventions:
- **Validate input** at the route boundary (zod) → call a `services/*` function → return JSON.
- Keep domain rules in `services/` as **pure, tested functions**; routes stay thin.
- **Export `AppType`** from `index.ts` so the frontend can use Hono's typed client `hc<AppType>`.
- **CORS** allow-list the Next.js frontoffice origin.

## Shared DB — this app's ownership

Both backends share **one PostgreSQL**. **This repo OWNS and migrates** the scheduling tables:
`teachers`, `bookings`, `course_packages`, `attendance`, `leave`. The backoffice (Finance API)
**reads** `attendance` to deduct hours / compute payroll — it must **not** migrate these tables.
Never let two apps migrate the same table.

## Domain rules to enforce server-side (authoritative)

- **Teacher priority** in any auto-assignment: **Full-time / Part-time first**, then **Freelance**.
- **Auto-recurring booking:** registering a Course Package (e.g. 10×, Sun 10:00) locks the slot
  forward for the quota window (~13 weeks for a 10-session course).
- **Leave + extension under the Policy Lock:** quota by package size — 4→**1** (extend ≤ week 5),
  6→**2**, 10→**3** (extend ≤ week 13). On leave: cancel that session, **auto-append** one in a later
  week. **Over quota → lock** further rescheduling until an **admin** unlocks (special cases only).
- **Statuses:** `PENDING → CONFIRMED → ATTENDED / SICK_LEAVE → EXTENDED / CANCELLED`.
- **Voucher** bookings have **no fixed slot** and **cannot pick a teacher** (assign by availability).
- ⚠️ The 6-session extension ceiling ("week 8" in the FE) is an assumption — confirm the real rule.

## Notifications — LINE (this app: notify the teacher)

- On **Confirm schedule**, push a LINE summary to the **teacher** via **LINE Messaging API**
  (push message from the LINE Official Account). **Immediately on confirm**, not 1h before class.
- ⚠️ **LINE Notify is discontinued (2025-03-31)** — use the Messaging API only.
- Requires the teacher's LINE **`userId`** (capture via OA follow webhook / LIFF linking / one-time
  registration). Store it on the teacher record.
- Use an **outbox table + retry + audit log**; make confirm/notify **idempotent** (no double-send).
- Secrets (`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`) live **only** here, in env — never
  shipped to the browser.

## Env

`DATABASE_URL`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `JWT_SECRET`. Timezone
`Asia/Bangkok`; store dates explicitly. Money/hours as **integer minor units** inside transactions.
