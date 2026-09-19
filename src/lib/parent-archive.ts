// TASK-411 (REQ-098, SPEC-084) — archive a PARENT: the ONE predicate every working read appends, and the ONE guard
// every by-id WRITE asserts. Its own file so `lib/family-link.ts` (the notice recipients, the inbound LINE family) and
// `services/parent.service.ts` share it without a cycle. No read writes `isNull(parents.archivedAt)` by hand — pinned.
//
// Archived ≠ suspended: suspend is a reversible "off" switch that keeps the family visible (`lib/suspend.ts`); an
// archive hides the household and clears its LINE accounts. The two coexist on a row; the archive term wins on reads.
import { isNull } from "drizzle-orm";
import { parents } from "../db/schema";
import { conflict } from "./http";

/** `parents.archived_at IS NULL` — appended to every working read (list/search/count, phone lookup, notices, nag, SOM, LINE language). */
export const activeParentWhere = () => isNull(parents.archivedAt);

/** The row-level fact, for a row already in hand. */
export const isParentArchived = (p: { archivedAt?: Date | string | null } | null | undefined): boolean => !!p?.archivedAt;

/** The one refusal for a write against an archived parent (edit, suspend, add a student, clear/claim a LINE link, create with its phone). */
export const PARENT_ARCHIVED = () => conflict("PARENT_ARCHIVED", "ผู้ปกครองรายนี้ถูกเก็บแล้ว — คืนสถานะก่อน");

/** The marker a cascaded student carries in `archived_by`; a restore of the parent restores exactly these. */
export const cascadeMarker = (parentId: string) => `parent:${parentId}`;
