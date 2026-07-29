// Resolve the LINE bot language for a user from their teacher/parent link record (REQ-015 / TASK-039).
// Shared by the webhook service (reply language) and the outbox worker (push language). Default TH.
import { db } from "../db";
import type { Lang } from "./line-i18n";

export async function resolveBotLang(lineUserId: string | null | undefined): Promise<Lang> {
  if (!lineUserId) return "TH";
  const [te, pa] = await Promise.all([
    db.query.teachers.findFirst({
      where: (x, { eq }) => eq(x.lineUserId, lineUserId),
      columns: { lineLang: true },
    }),
    db.query.parents.findFirst({
      where: (x, { eq }) => eq(x.lineUserId, lineUserId),
      columns: { lineLang: true },
    }),
  ]);
  return (te?.lineLang ?? pa?.lineLang) === "EN" ? "EN" : "TH";
}
