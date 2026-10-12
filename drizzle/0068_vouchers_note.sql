-- TASK-732 (Khwan's Q5 answer; decided under the owner's delegation) — a voucher SALE carries a Remark: `vouchers.note`, optional text. The family's «voucher sold» confirm prints it as
-- `Remark : …` only when it is non-empty. Forward-only, no backfill, no data written: ONE nullable column (a catalog change, no table rewrite).
-- Rerunnable: YES — `ADD COLUMN IF NOT EXISTS`. The column IS the last (only) object, so a half-applied file reads as "not applied" and re-runs (the witness rule).
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "note" text;
