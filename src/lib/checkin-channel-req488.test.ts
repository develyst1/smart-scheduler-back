// TASK-488 — the provenance split: a CHANNEL (closed) and an ACTOR (free text). Pinned: the closed type (a sixth channel does not
// COMPILE), the migration's SQL lists EQUAL to it, the backfill's rule by value, every production writer by SCAN (no person in the
// channel, no channel in the actor), and the report the owner runs, by value.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHECKIN_CHANNELS, classifyLegacySource, isCheckinChannel, legacySourceOf, type CheckinChannel } from "./checkin-channel";
import { formatProvenanceReport } from "./checkin-provenance-report";
import { SCHEDULING_WITNESSES } from "./migration-witness";

const root = resolve(import.meta.dir, "..", "..");
const SQL = readFileSync(resolve(root, "drizzle/0057_checkin_channel_actor.sql"), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

describe("🔑 the channel is a CLOSED type", () => {
  test("the set, by value — `staff` added so a staff mark has a channel as well as a person", () => {
    expect([...CHECKIN_CHANNELS]).toEqual(["checkin-qr", "line", "shopfront-qr", "staff", "end-of-day"]);
  });
  test("a sixth channel — or a username — does not COMPILE as a channel (tsc checks the directive below)", () => {
    // @ts-expect-error — a person is not a channel
    const bad: CheckinChannel = "admin-dong";
    expect(isCheckinChannel(bad)).toBe(false);
    expect(isCheckinChannel("shopfront-qr")).toBe(true);
    expect(isCheckinChannel(undefined)).toBe(false);
  });
});

describe("✅ the backfill's rule, by value (`classifyLegacySource`, mirrored by 0057's SQL)", () => {
  test("a channel ⇒ that channel · a username ⇒ an ACTOR via `staff` · null ⇒ nothing", () => {
    for (const c of CHECKIN_CHANNELS) expect(classifyLegacySource(c)).toEqual({ channel: c, actor: null });
    expect(classifyLegacySource("admin-dong")).toEqual({ channel: "staff", actor: "admin-dong" });
    expect(classifyLegacySource(null)).toEqual({ channel: null, actor: null });
  });
  test("the old column is still written as before until the drop: the person when there is one, else the channel", () => {
    expect(legacySourceOf({ channel: "staff", actor: "admin-dong" })).toBe("admin-dong");
    expect(legacySourceOf({ channel: "shopfront-qr" })).toBe("shopfront-qr");
    expect(legacySourceOf(null)).toBeNull();
  });
});

describe("🔴 migration 0057 — the SQL mirrors the type; the old columns are KEPT; the witness is the LAST created object", () => {
  test("🔨 the names: bookings `checkin_channel` / `checkin_actor`; camp_days `mark_channel` / `mark_actor` (it holds EVERY mark, not only check-ins)", () => {
    const adds = [...SQL.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN IF NOT EXISTS "(\w+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(adds).toEqual(["bookings.checkin_channel", "bookings.checkin_actor", "camp_days.mark_channel", "camp_days.mark_actor"]);
    // every CAMP statement names only camp's pair — no booking-named column on the camp side
    const campStmts = SQL.split("--> statement-breakpoint").map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim()).filter((s) => s.includes('"camp_days"'));
    expect(campStmts.length).toBe(7);
    for (const st of campStmts) expect({ st, bookingNamed: /checkin_channel|checkin_actor/.test(st) }).toEqual({ st, bookingNamed: false });
  });
  test("every IN-list in the file (4 backfill filters + 2 CHECKs) is EXACTLY the closed set", () => {
    const lists = [...SQL.matchAll(/IN \(([^)]*)\)/g)].map((m) => m[1]!.split(",").map((x) => x.trim().replace(/'/g, "")).sort());
    expect(lists.length).toBe(6);
    for (const l of lists) expect(l).toEqual([...CHECKIN_CHANNELS].sort());
  });
  test("🚫 nothing is DROPPED except a CHECK before its re-creation (the old columns survive; a DROP proves nothing on a re-run)", () => {
    const sqlOnly = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sqlOnly).not.toMatch(/DROP COLUMN|DROP TABLE/i);
    expect([...sqlOnly.matchAll(/DROP CONSTRAINT IF EXISTS "(\w+)"/g)].map((m) => m[1])).toEqual(["bookings_checkin_channel_chk", "camp_days_mark_channel_chk"]);
  });
  test("the witness is the camp CHECK's definition, and that CHECK is the file's LAST statement (after both backfills)", () => {
    expect(SCHEDULING_WITNESSES.find((w) => w.tag === "0057_checkin_channel_actor")?.probe).toEqual({ kind: "constraint-def", constraint: "camp_days_mark_channel_chk", contains: "shopfront-qr" });
    const stmts = SQL.split("--> statement-breakpoint").map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim()).filter(Boolean);
    expect(stmts.at(-1)).toBe(`ALTER TABLE "camp_days" VALIDATE CONSTRAINT "camp_days_mark_channel_chk";`);
    expect(stmts.findIndex((s) => s.startsWith(`UPDATE "camp_days"`))).toBeLessThan(stmts.findIndex((s) => s.includes(`ADD CONSTRAINT "camp_days_mark_channel_chk"`)));
  });
});

describe("🔑 every production WRITER, by scan — no person in the channel, no channel in the actor", () => {
  const writes: Array<{ f: string; field: string; value: string }> = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".ts") && !f.endsWith(".test.ts")) {
        for (const m of code(readFileSync(p, "utf8")).matchAll(/\b(checkinChannel|checkinActor|markChannel|markActor):\s*([^,}\n]+)/g)) writes.push({ f: p.slice(root.length + 1).replace(/\\/g, "/"), field: m[1]!, value: m[2]!.trim() });
      }
    }
  };
  walk(resolve(root, "src"));
  test("the scan is not vacuous: it sees the writers and the reads", () => {
    expect(writes.length).toBeGreaterThanOrEqual(10);
  });
  test("🔴 a string LITERAL in `checkinChannel` is always a known channel", () => {
    for (const w of writes.filter((x) => x.field === "checkinChannel" || x.field === "markChannel")) {
      const lit = w.value.match(/^"([^"]*)"$/)?.[1];
      if (lit !== undefined) expect({ w, known: isCheckinChannel(lit) }).toEqual({ w, known: true });
    }
  });
  test("🔴 `checkinActor` is NEVER set to a string literal (an actor is a person someone typed — never a channel we wrote in)", () => {
    for (const w of writes.filter((x) => x.field === "checkinActor" || x.field === "markActor")) expect({ w, literal: /^["'`]/.test(w.value) }).toEqual({ w, literal: false });
  });
});

describe("✅ the report the owner runs, by value (read-only; the engineers never query a database)", () => {
  test("each old value, its count, and where it goes — a non-channel value is MARKED as a person", () => {
    expect(formatProvenanceReport("bookings.checkin_source", [{ value: "checkin-qr", count: 40 }, { value: null, count: 900 }, { value: "admin-dong", count: 3 }])).toEqual([
      "bookings.checkin_source — 943 row(s), 3 distinct value(s):",
      "  NULL                         900  → (both NULL)",
      "  checkin-qr                    40  → channel checkin-qr",
      '  admin-dong                     3  → channel staff + ACTOR "admin-dong"  ⚠️ not a channel — check it is a person',
      "  (known channels: checkin-qr, line, shopfront-qr, staff, end-of-day)",
    ]);
  });
  test("the script only SELECTs (a report, not a fix)", () => {
    const S = code(readFileSync(resolve(root, "scripts/checkin-provenance-report.ts"), "utf8"));
    expect(S).not.toMatch(/\b(update|insert|delete|alter|drop)\b/i);
    // the "after" query reads each table's OWN pair (camp's is `mark_*`)
    expect(S).toContain('{ t: "bookings", channel: "checkin_channel", actor: "checkin_actor" }');
    expect(S).toContain('{ t: "camp_days", channel: "mark_channel", actor: "mark_actor" }');
    expect(readFileSync(resolve(root, "package.json"), "utf8")).toContain('"db:provenance-report": "bun run scripts/checkin-provenance-report.ts"');
  });
});
