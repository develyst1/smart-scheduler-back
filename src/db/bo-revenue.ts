// SPEC-099 §2.1 / TASK-864 — the revenue ledger tables, DECLARED here so the scheduling back can write them.
//
// 🔴 BB OWNS THESE TABLES AND THEIR MIGRATION (backoffice-back `0008_bo_revenue_ledger`, SPEC-098 §2). This file is a
// read/write DECLARATION only: it is deliberately NOT listed in `drizzle.config.ts` (`schema: "./src/db/schema.ts"`), so
// `drizzle-kit generate` in this repo never sees it and SB can never emit a second migration for the same tables.
// 🚫 Do not add it to `drizzle.config.ts`; do not edit `schema.ts`. A column change is a BB migration first, then here.
//
// Columns are exactly SPEC-098 §2. The CHECKs and indexes live in BB's migration and are not repeated: the database
// enforces them, and repeating them here would be a second copy that can drift.
import { boolean, date, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bo } from "./schema"; // the one `bo` pgSchema object — no second `pgSchema("bo")`

export const boRevenueCategory = bo.table("revenue_category", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // COURSE | TRIAL | VOUCHER | ECA | SALES | FNB | RENT | OTHER (never REFUND)
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const boRevenueLine = bo.table("revenue_line", {
  id: uuid("id").primaryKey().defaultRandom(),
  occurredOn: date("occurred_on", { mode: "string" }).notNull(), // Asia/Bangkok calendar date it COUNTS on (R2.2)
  branch: text("branch").notNull(), // 'BRAVO' | 'OTHER'
  type: text("type").notNull(), // 8 types + 'REFUND'
  categoryId: uuid("category_id").references(() => boRevenueCategory.id), // NULL only for REFUND
  productName: text("product_name").notNull(),
  amountMinor: integer("amount_minor").notNull(), // signed satang; REFUND < 0, every other type > 0
  method: text("method").notNull(), // 'TRANSFER' | 'CASH' | 'CARD'
  remark: text("remark"),
  source: text("source").notNull(), // 'BOOKING' | 'VOUCHER' | 'COURSE' | 'RENTAL' … ('MANUAL' is BB's)
  refType: text("ref_type"),
  refId: text("ref_id"),
  idempotencyKey: text("idempotency_key"),
  actor: text("actor"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// SPEC-099 §8 / TASK-874 / TASK-875 — the F2 payment record. Same rule as above: BB owns the table and its migration
// (`0012_bo_payment`); this is the declaration SB writes through. The CHECKs and the unique index `(ref_type, ref_id, n)`
// live in BB's migration; the database enforces them.
export const boPayment = bo.table("payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  refType: text("ref_type").notNull(), // 'COURSE' | 'VOUCHER' (slice 2a)
  refId: uuid("ref_id").notNull(), // course_packages.id / vouchers.id — no FK
  n: integer("n").notNull(), // 1 = the sale's own payment; 2.. = installments
  paidOn: date("paid_on", { mode: "string" }).notNull(), // Asia/Bangkok date the money came in
  amountMinor: integer("amount_minor").notNull(), // satang, > 0
  method: text("method").notNull(), // 'TRANSFER' | 'CASH' | 'CARD'
  actor: text("actor"), // who last set it; NULL for the auto row
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
