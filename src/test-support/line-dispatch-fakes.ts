// TASK-504 — the LINE dispatcher's two UNDECLARED database touches, faked at the boundary ONCE for every test that drives it.
// (Test support, not a test: no `.test.ts` suffix, so bun does not run it; only test files import it.)
//
// Found in TASK-500/504: these tests passed only because sid's database answered two things the dispatcher does on its own:
//  1. a WRITE on every tap — `unmute(lineUserId)`: `UPDATE line_link_sessions … WHERE line_user_id = $1 AND muted_until > $2`;
//  2. a READ — `familyOfLineUser` asks `family_line_links` (a `db.select`) whether the chat is a family.
// 🔑 Boundary, not behaviour: the fakes are TABLES, not answers. The update is evaluated against the sessions the test declares (by
// its REAL rendered WHERE: this chat, muted right now) and recorded; the family read answers from the links the test declares, by
// the REAL `line_user_id` it was asked for — so the real `unmute` and the real `familyOfLineUser` still run. Any OTHER table
// written or selected here THROWS: a new undeclared database touch fails loudly instead of quietly needing a database again.
// Two separate fakes, because a file that already fakes `db.update` itself (and asserts on it) must keep its own.
import { spyOn } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import { familyLineLinks, lineLinkSessions } from "../db/schema";

type Spies = Array<{ mockRestore: () => void }>;
export type SessionRow = { lineUserId: string; mutedUntil?: Date | null; [k: string]: unknown };
export type Unmutes = Array<{ sql: string; params: unknown[] }>;

const dialect = new PgDialect();

/** `db.update` → a `line_link_sessions` TABLE of the declared rows; only the un-mute's exact WHERE is accepted. Returns the log. */
export function fakeUnmute(spies: Spies, sessions: SessionRow[] = []): Unmutes {
  const unmutes: Unmutes = [];
  spies.push(spyOn(db, "update").mockImplementation(((table: any) => {
    if (table !== lineLinkSessions) throw new Error(`unexpected write to ${getTableName(table)} through the LINE dispatcher (declare it, or fake it)`);
    return {
      set: (values: Record<string, unknown>) => ({
        where: async (cond: any) => {
          const q = dialect.sqlToQuery(cond);
          if (q.sql !== '("line_link_sessions"."line_user_id" = $1 and "line_link_sessions"."muted_until" > $2)') throw new Error(`unexpected session update: ${q.sql}`);
          unmutes.push(q);
          const [user, now] = q.params as [string, Date];
          const hit = sessions.filter((s) => s.lineUserId === user && s.mutedUntil != null && s.mutedUntil > now);
          for (const s of hit) Object.assign(s, values);
          return hit.map((s) => ({ lineUserId: s.lineUserId }));
        },
      }),
    };
  }) as any));
  return unmutes;
}

/** `db.select` → a `family_line_links` TABLE: `{ lineUserId: parentId }`, answered by the REAL `line_user_id` asked for. */
export function fakeFamilyLinks(spies: Spies, families: Record<string, string> = {}): void {
  spies.push(spyOn(db, "select").mockImplementation((() => ({
    from: (table: any) => {
      if (table !== familyLineLinks) throw new Error(`unexpected select from ${getTableName(table)} through the LINE dispatcher (declare it, or fake it)`);
      return {
        where: (cond: any) => ({
          limit: async () => {
            const q = dialect.sqlToQuery(cond);
            if (q.sql !== '"family_line_links"."line_user_id" = $1') throw new Error(`unexpected family-link read: ${q.sql}`);
            const parentId = families[q.params[0] as string];
            return parentId ? [{ parentId }] : [];
          },
        }),
      };
    },
  })) as any));
}

/** Both, for a harness that fakes neither itself. */
export function fakeDispatchBoundary(spies: Spies, world: { sessions?: SessionRow[]; families?: Record<string, string> } = {}): { unmutes: Unmutes } {
  const unmutes = fakeUnmute(spies, world.sessions);
  fakeFamilyLinks(spies, world.families);
  return { unmutes };
}
