// TASK-126 — GATE 0 of the customer-prod deploy: a snapshot before any migrate. Reads DATABASE_URL from the
// (bun-loaded) .env, writes a timestamped pg_dump custom-format archive. Fails loud + non-zero; never leaves a
// partial archive that looks like a good backup.
//
//   bun run db:backup
//
// Restore: pg_restore --clean --if-exists -d "$DATABASE_URL" <file>
// Precondition: pg_dump must be on PATH (Postgres client tools).
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — check the backend .env points at the intended DB before backing up.");
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = `sm-prod-backup-${stamp}.dump`;
console.log(`Backing up DATABASE_URL → ${file} (pg_dump -Fc)…`);
const proc = Bun.spawnSync(["pg_dump", "-Fc", url, "-f", file], { stdout: "inherit", stderr: "inherit" });
if (!proc.success) {
  console.error(
    "\npg_dump failed (exit " + proc.exitCode + "). Is pg_dump on PATH and DATABASE_URL reachable? " +
      "No usable backup was written — do NOT proceed past GATE 0.",
  );
  process.exit(proc.exitCode || 1);
}
const size = Bun.file(file).size;
if (size === 0) {
  console.error(`\n${file} is 0 bytes — treat as FAILED, do NOT proceed.`);
  process.exit(1);
}
console.log(`\n✅ Backup written: ${file} (${(size / 1_048_576).toFixed(1)} MB). Restore with:`);
console.log(`   pg_restore --clean --if-exists -d "$DATABASE_URL" ${file}`);
