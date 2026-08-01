// One LINE user ⇒ one active ROSTER link (TASK-046).
//
// Extracted from `line-webhook.service.ts` in TASK-075 so the **approval** path can reuse it. It could not
// simply be exported from there: `line-webhook.service` now imports `teacher-link.service`, so importing back
// would be a cycle. One definition, in a place both sides can reach.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { parents, teachers } from "../db/schema";
import { otherRosterTable } from "./line-routing";

/**
 * Linking as a teacher clears any parent link and vice-versa, so a role change **moves** the link instead of
 * accumulating one — `detectLinkedRole` checks teacher before parent, so a leftover link would silently hide
 * the other surface.
 *
 * The **admin notification list is deliberately left alone**: it is a subscription in `app_settings`, not a
 * roster identity, and `detectLinkedRole` checks it *last* — so it can never shadow a parent/teacher surface.
 * Silently unsubscribing someone from leave alerts because they registered a child would be a surprising,
 * hard-to-reverse side effect.
 */
export async function moveRosterLink(lineUserId: string, newRole: "customer" | "teacher") {
  if (otherRosterTable(newRole) === "parents") {
    await db.update(parents).set({ lineUserId: null }).where(eq(parents.lineUserId, lineUserId));
  } else {
    await db.update(teachers).set({ lineUserId: null }).where(eq(teachers.lineUserId, lineUserId));
  }
}
