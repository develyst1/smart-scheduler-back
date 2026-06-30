# smart-scheduler-back

Scheduling API (Bun + Hono + Drizzle) — frontoffice backend.

## Run

```bash
bun install
bun run dev          # default PORT from .env (e.g. 4006)
bun run db:migrate
bun run db:seed
```

## API docs (Swagger UI)

| URL | ใช้เมื่อ |
|-----|---------|
| `http://localhost:<PORT>/api/docs` | dev (ผ่าน reverse proxy pattern เดียวกับ prod) |
| `https://som.develyst.online/api/docs` | production |

OpenAPI JSON: `/api/openapi.json`

1. เปิด **Authorize** → `POST /api/auth/login` เอา `token` → ใส่ `Bearer <token>`
2. ลองยิง endpoint อื่นได้จาก UI

Spec source: `src/openapi/document.ts` (sync กับ `src/routes/api.ts`)

## Tests

```bash
bun test
bun run scripts/smoke.ts
```
