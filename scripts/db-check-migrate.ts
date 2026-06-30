// Check + apply missing schema (0004 work_days, 0005 checkin/CRM/LINE sessions).
//   bun run scripts/db-check-migrate.ts

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");

const sql = postgres(url);

async function hasColumn(table: string, column: string) {
  const [row] = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `;
  return !!row;
}

async function hasTable(name: string) {
  const [row] = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${name}
  `;
  return !!row;
}

async function migrationRecorded(tag: string) {
  const [{ count }] = await sql`
    SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash = ${tag}
  `;
  return count > 0;
}

async function recordMigration(tag: string) {
  if (await migrationRecorded(tag)) return;
  await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${tag}, ${Date.now()})`;
  console.log("recorded:", tag);
}

async function runFile(relative: string) {
  const file = readFileSync(resolve(import.meta.dir, "..", relative), "utf8");
  const stmts = file.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const stmt of stmts) await sql.unsafe(stmt);
}

const need0004 = !(await hasColumn("teachers", "work_days"));
const need0005 =
  !(await hasColumn("bookings", "checkin_token")) ||
  !(await hasColumn("students", "crm_points")) ||
  !(await hasTable("line_link_sessions"));

console.log({ need0004, need0005 });

if (need0004) {
  console.log("applying drizzle/0004_teacher_work_days.sql ...");
  await runFile("drizzle/0004_teacher_work_days.sql");
}
if (need0005) {
  console.log("applying drizzle/0005_line_crm_checkin.sql ...");
  await runFile("drizzle/0005_line_crm_checkin.sql");
}

if (!need0004) await recordMigration("0004_teacher_work_days");
if (!need0005) await recordMigration("0005_line_crm_checkin");
if (need0004) await recordMigration("0004_teacher_work_days");
if (need0005) await recordMigration("0005_line_crm_checkin");

console.log("verify:", {
  work_days: await hasColumn("teachers", "work_days"),
  checkin_token: await hasColumn("bookings", "checkin_token"),
  crm_points: await hasColumn("students", "crm_points"),
  line_link_sessions: await hasTable("line_link_sessions"),
});

await sql.end();
