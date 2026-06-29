# CLAUDE.md — smart-scheduler-back (Scheduling API)

Guides Claude Code (and other agents) in this repo. For the cross-repo map see the
workspace root `../CLAUDE.md`. **Status: implemented** — DB live + migrated + seeded, 10 endpoints,
`bun test` + `scripts/smoke.ts` pass. (Remaining: auth/roles, LINE outbox worker.)

## What this is

The **frontoffice backend** — the **Scheduling API** that powers `smart-scheduler-front`. It is the
**source of truth** for teachers, bookings, attendance, and the leave/extension rules. **Phase 1.**

> Spec (Thai): **[docs/requirement-timeline.md](docs/requirement-timeline.md)** (living spec,
> newest entry wins; synced from workspace root `docs/`). The domain rules are **authoritative
> here** — the client is never trusted.

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
  index.ts                       # Hono app + CORS + onError; mounts /api; exports AppType
  routes/api.ts                  # all 10 endpoints, chained for hc<AppType> RPC
  services/scheduler.service.ts  # business logic — source of truth (quota/extend/move/idempotency)
  validation.ts                  # zod request/query schemas
  types/contract.ts              # request/response DTOs (shared shape with the FE)
  db/
    schema.ts                    # Drizzle schema (this app's tables) + relations
    index.ts                     # drizzle client (postgres-js)
    mappers.ts                   # rows → ready-to-use DTOs
    seed.ts                      # `bun run db:seed`
  lib/
    leave.ts (+ .test.ts)        # leave quota/extension rules (pure, tested)
    voucher.ts                   # voucher validity (3/6/9 months by size)
    time.ts                      # TIME_SLOTS 09:00–18:00 + date helpers
    line.ts                      # LINE outbox enqueue (push worker = TODO)
    http.ts                      # ApiException + pgErrorCode
scripts/smoke.ts                 # manual e2e check against a running server
drizzle.config.ts
```

Conventions:
- **Validate input** at the route boundary (zod) → call a `services/*` function → return JSON.
- Keep domain rules in `services/` as **pure, tested functions**; routes stay thin.
- **Export `AppType`** from `index.ts` so the frontend can use Hono's typed client `hc<AppType>`.
- **CORS** allow-list the Next.js frontoffice origin.

## Shared DB — this app's ownership

Both backends share **one PostgreSQL**. **This repo OWNS and migrates** the scheduling tables:
`students`, `teachers`, `subjects`, `teacher_subjects`, `course_packages`, `vouchers`, `bookings`,
`notification_outbox`. The backoffice (Finance API) **reads** `bookings` (attendance = status
`ATTENDED`) to deduct hours / compute payroll — it must **not** migrate these tables.
Never let two apps migrate the same table.

## Domain rules to enforce server-side (authoritative)

- **Hours:** calendar runs **09:00–18:00** (nine one-hour slots; `TIME_SLOTS` in [lib/time.ts](src/lib/time.ts)).
- **Teacher priority** in any auto-assignment: **Full-time / Part-time first**, then **Freelance**.
- **Auto-recurring booking:** registering a Course Package (e.g. 10×, Sun 09:00) locks the slot
  forward for the quota window (~13 weeks for a 10-session course).
- **Leave + extension under the Policy Lock:** quota by package size — 4→**1** (extend ≤ week 5),
  6→**2**, 10→**3** (extend ≤ week 13). On leave: cancel that session, **auto-append** one in a later
  week. **Over quota → lock** further rescheduling until an **admin** unlocks (special cases only).
- **Manual Move/Add:** staff may move (teacher/date/time) or add a session by hand for special
  cases — `PATCH /api/bookings/:id` (move) and `POST /api/bookings` (add).
- **Voucher** (5 / 10 / 15h): **no fixed slot**, **cannot pick a teacher**; validity **3 / 6 / 9
  months** from the first booking ([lib/voucher.ts](src/lib/voucher.ts)).
- **Statuses:** `PENDING → CONFIRMED → ATTENDED / SICK_LEAVE → EXTENDED / CANCELLED`.
- ⚠️ The 6-session extension ceiling ("week 8") is an assumption — requirement.md doesn't fix it.

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
