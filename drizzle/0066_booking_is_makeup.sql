-- TASK-702 (REQ-115, owner-ruled T1) — `bookings.is_makeup`: the make-up MARKER. A make-up is now born CONFIRMED (an ordinary class), so its STATUS can no longer
-- say "this class grew from a leave"; the marker does. The plan engine's TRIM reads it (born CONFIRMED, a status-based trim would never remove a make-up again), and
-- so does the front's «ขยายคาบ» badge (Khwan kept it as a REQUIREMENT).
--
-- 🔴 THIS MIGRATION BACKFILLS AND VERIFIES ITSELF — one transaction, no half state. If the backfill misses a row, that make-up becomes an ordinary class in the system's
-- eyes and the engine can never trim it again: silent, permanent, per row, on the customer's live system. So after the backfill it CHECKS, and it REFUSES TO FINISH:
--   1. `missed`  — rows in the union whose marker is NOT set              ⇒ must be 0
--   2. `extra`   — rows marked but in NO population                        ⇒ must be 0
--   3. `marked`  — rows with the marker set                                ⇒ must EQUAL the size of the union, counted in the same transaction
--   4. `suspect` — a course row whose note mentions `ขยาย` and is in NO population (a note an older version wrote, or a person typed — exactly what reading the code
--                  cannot see) ⇒ must be 0. 🔻 An addition to the SPEC's three, and the only one of the four that looks at data the backfill itself does not match.
-- Any check failing ⇒ `RAISE EXCEPTION` with the numbers ⇒ the whole migration ROLLS BACK ⇒ no column, no marks ⇒ `db:verify` is RED ⇒ the new code is NOT started. The old
-- code never reads the column, so the customer is unharmed. 🚫 Never "fix it by hand" on the box; never re-run with a looser check — send the numbers to @Sober.
--
-- The POPULATIONS (all over `booking_type = 'COURSE_PACKAGE'`, ANY status — a delivered or cancelled make-up keeps its badge in history):
--   P1 `status = 'EXTENDED'` · P2 `extended_from_id IS NOT NULL` · P3 the two notes a make-up is BORN with · P4 CANCELLED + the two notes the trim / the Undo overwrite it with.
-- They are generated from ONE list in code (`src/lib/makeup-marker.ts`), and a test pins THIS text equal to it.
--
-- 🔑 FORWARD-ONLY: it marks existing make-ups and changes NO status (a status flip cannot issue tokens, holds or notices). Locks: `ADD COLUMN … NOT NULL DEFAULT false`
-- is a catalog change on PG11+ (no rewrite); the UPDATE row-locks only the make-up rows. Rerunnable: NO — once the new code runs, a marked row whose note an admin
-- overwrote is rightly marked but in no population, which the `extra` check would refuse; the witness (the column) is therefore "applied" for good.
-- Numbering: counted at the moment of writing — `drizzle/*.sql` = 66 (0000–0065), journal tags = 66, newest `0065` ⇒ this is `0066`, the 67th file.

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "is_makeup" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

UPDATE "bookings" SET "is_makeup" = true
WHERE "booking_type" = 'COURSE_PACKAGE' AND ("status" = 'EXTENDED' OR "extended_from_id" IS NOT NULL OR "note" IN ('คาบขยายอัตโนมัติจากการปรับแผนคอร์ส', 'คาบขยายอัตโนมัติจากการลา') OR ("status" = 'CANCELLED' AND "note" IN ('ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)', 'ยกเลิกคาบขยาย — ย้อนกลับการลา')));
--> statement-breakpoint

DO $$
DECLARE
  missed bigint;
  extra bigint;
  marked bigint;
  expected bigint;
  suspect bigint;
BEGIN
  SELECT count(*) INTO missed FROM "bookings"
    WHERE "booking_type" = 'COURSE_PACKAGE' AND ("status" = 'EXTENDED' OR "extended_from_id" IS NOT NULL OR "note" IN ('คาบขยายอัตโนมัติจากการปรับแผนคอร์ส', 'คาบขยายอัตโนมัติจากการลา') OR ("status" = 'CANCELLED' AND "note" IN ('ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)', 'ยกเลิกคาบขยาย — ย้อนกลับการลา'))) AND NOT "is_makeup";
  SELECT count(*) INTO extra FROM "bookings"
    WHERE "is_makeup" AND NOT ("booking_type" = 'COURSE_PACKAGE' AND ("status" = 'EXTENDED' OR "extended_from_id" IS NOT NULL OR "note" IN ('คาบขยายอัตโนมัติจากการปรับแผนคอร์ส', 'คาบขยายอัตโนมัติจากการลา') OR ("status" = 'CANCELLED' AND "note" IN ('ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)', 'ยกเลิกคาบขยาย — ย้อนกลับการลา'))));
  SELECT count(*) INTO marked FROM "bookings" WHERE "is_makeup";
  SELECT count(*) INTO expected FROM "bookings"
    WHERE "booking_type" = 'COURSE_PACKAGE' AND ("status" = 'EXTENDED' OR "extended_from_id" IS NOT NULL OR "note" IN ('คาบขยายอัตโนมัติจากการปรับแผนคอร์ส', 'คาบขยายอัตโนมัติจากการลา') OR ("status" = 'CANCELLED' AND "note" IN ('ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)', 'ยกเลิกคาบขยาย — ย้อนกลับการลา')));
  SELECT count(*) INTO suspect FROM "bookings"
    WHERE "booking_type" = 'COURSE_PACKAGE' AND "note" LIKE '%ขยาย%' AND NOT ("status" = 'EXTENDED' OR "extended_from_id" IS NOT NULL OR "note" IN ('คาบขยายอัตโนมัติจากการปรับแผนคอร์ส', 'คาบขยายอัตโนมัติจากการลา') OR ("status" = 'CANCELLED' AND "note" IN ('ยกเลิกคาบขยายอัตโนมัติ (ปรับแผนคอร์ส)', 'ยกเลิกคาบขยาย — ย้อนกลับการลา')));
  IF missed <> 0 OR extra <> 0 OR marked <> expected OR suspect <> 0 THEN
    RAISE EXCEPTION 'is_makeup backfill REFUSED — missed=% extra=% marked=% expected=% suspect=% (all must agree: missed 0, extra 0, marked = expected, suspect 0). Nothing was written (rolled back). Send these numbers to @Sober; do NOT fix by hand.', missed, extra, marked, expected, suspect;
  END IF;
END $$;
