import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url);
await sql.unsafe(`
  ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS work_days smallint[] NOT NULL
  DEFAULT ARRAY[0,1,2,3,4,5,6]::smallint[]
`);
await sql.end();
console.log("work_days column ready");
