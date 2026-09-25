// TASK-474 (REQ-107 §7 K5) — `checkin_late_minutes`: check in for a while AFTER the class ends. Default 0 = today.
//
// 🔑 Through the REAL `getSetting` / `getNumberSetting` — no spy on the setting (TASK-465's lesson: two suites spied a setting
// to a bare number and hid a production-wide defect). Only the DB row is faked, and the fake HONOURS the key it is asked
// for (the `where` callback is run), so a read of the wrong key finds nothing — as it would in production.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../db";
import * as schedulerSvc from "./scheduler.service";
import * as lineAdmin from "../lib/line-admin";
import { checkinByToken } from "./checkin.service";
import { checkinWindowMessage, isWithinCheckinWindow, lateWindowEnd } from "../lib/checkin";
import { tokenExpiryIso } from "../lib/checkin-token";
import { campScanOutcome } from "../lib/camp";
import { SETTINGS } from "../lib/settings";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";
const root = resolve(import.meta.dir, "..", "..");
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); });

/** Bangkok wall clock → a real instant (UTC+7), so `bangkokNow()` inside the code reads exactly this. */
const at = (date: string, hm: string) => setSystemTime(new Date(`${date}T${hm}:00+07:00`));

/** The app_settings table, faked at the DB — the stored jsonb value per key, as production stores it. */
const settingsTable = (rows: Record<string, unknown>) => {
  spies.push(spyOn(db.query.appSettings, "findFirst").mockImplementation((async (q: any) => {
    const asked = q.where({ key: "key" }, { eq: (_c: unknown, v: string) => v }); // run the real `where`: which key?
    return asked in rows ? { key: asked, value: rows[asked] } : undefined;
  }) as any));
};

const ROW = { id: "b1", date: "2026-09-25", startTime: "16:00:00", endTime: "17:00:00", status: "CONFIRMED", checkinToken: "tok", checkinTokenExpiresAt: new Date("2026-09-25T17:00:59+07:00"), studentId: "s1", coStudentId: null, voucherId: null };
const scan = (row: Record<string, unknown>) => {
  const attended: string[] = [];
  spies.push(spyOn(db.query.bookings, "findFirst").mockImplementation((async () => ({ ...ROW, ...row })) as any));
  spies.push(spyOn(schedulerSvc, "updateBookingStatus").mockImplementation((async (id: string) => { attended.push(id); return { booking: { id } }; }) as any));
  spies.push(spyOn(lineAdmin, "awardCrmPoints").mockImplementation((async () => {}) as any));
  return attended;
};
const refused = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return String(e?.message ?? e); } };

describe("🔑 the setting — beside `checkin_early_minutes`, default 0, 0–180", () => {
  test("spec by value", () => {
    const s = SETTINGS.checkin_late_minutes;
    expect({ key: s.key, type: s.type, default: s.default, unit: s.unit, label: s.label }).toEqual({
      key: "checkin_late_minutes", type: "number", default: 0, unit: "minutes", label: "เช็คอินได้หลังจบคลาส (นาที)",
    });
    expect([s.parse(0), s.parse(180), s.parse(181), s.parse(-1)]).toEqual([0, 180, null, null]);
  });
});

describe("✅ default 0 ⇒ today's window, byte for byte (no row stored)", () => {
  test("a scan at the class end is accepted; one minute later is refused with the OLD message", async () => {
    settingsTable({});
    scan({});
    at("2026-09-25", "17:00");
    expect(await refused(checkinByToken("tok").then(() => {}))).toBeNull();
    for (const s of spies.splice(0)) s.mockRestore();
    settingsTable({});
    const attended = scan({});
    at("2026-09-25", "17:01");
    expect(await refused(checkinByToken("tok"))).toBe("โทเคนเช็คอินหมดอายุแล้ว"); // the stored stamp expired at 17:00:59 — as today
    expect(attended).toEqual([]);
    expect(checkinWindowMessage("2026-09-25", "16:00", "17:00", 30)).toBe("เช็คอินได้ 2026-09-25 เวลา 15:30–17:00 น.");
  });
});

describe("✅ 30 minutes ⇒ open to end+30, refused at end+31 — through the REAL setting read", () => {
  test("17:30 accepted (the token minted at the class end is honoured inside the late window)", async () => {
    settingsTable({ checkin_late_minutes: 30 });
    const attended = scan({});
    at("2026-09-25", "17:30");
    expect(await refused(checkinByToken("tok"))).toBeNull();
    expect(attended).toEqual(["b1"]);
  });
  test("17:31 refused — and the message quotes the NEW end", async () => {
    settingsTable({ checkin_late_minutes: 30 });
    const attended = scan({ checkinTokenExpiresAt: new Date("2026-09-25T17:30:59+07:00") });
    at("2026-09-25", "17:31");
    expect(await refused(checkinByToken("tok"))).toBe("โทเคนเช็คอินหมดอายุแล้ว");
    expect(attended).toEqual([]);
    expect(checkinWindowMessage("2026-09-25", "16:00", "17:00", 30, 30)).toBe("เช็คอินได้ 2026-09-25 เวลา 15:30–17:30 น.");
  });
  test("a value stored as TEXT (\"30\") resolves the same way — the resolver's parse, not the test's assumption", async () => {
    settingsTable({ checkin_late_minutes: "30" });
    const attended = scan({});
    at("2026-09-25", "17:20");
    expect(await refused(checkinByToken("tok"))).toBeNull();
    expect(attended).toEqual(["b1"]);
  });
  test("the token a confirm mints now lives to the window's end (second 59), clamped to 23:59:59", () => {
    expect(tokenExpiryIso("2026-09-25", "17:00:00").toISOString()).toBe(new Date("2026-09-25T17:00:59+07:00").toISOString());
    expect(tokenExpiryIso("2026-09-25", "17:00:00", 30).toISOString()).toBe(new Date("2026-09-25T17:30:59+07:00").toISOString());
    expect(tokenExpiryIso("2026-09-25", "22:30:00", 180).toISOString()).toBe(new Date("2026-09-25T23:59:59+07:00").toISOString());
  });
});

describe("🔴 ruling 1 — same day only: the window never crosses midnight", () => {
  test("the end clamps to 23:59, and a scan at 00:30 the next day is refused even at the maximum setting", () => {
    expect(lateWindowEnd("22:30", 180)).toBe(23 * 60 + 59);
    expect(lateWindowEnd("17:00", 999)).toBe(17 * 60 + 180); // the code's own ceiling, whatever the setting says
    expect(lateWindowEnd("17:00", -5)).toBe(17 * 60);
    expect(isWithinCheckinWindow("2026-09-25", "22:00", "22:30", { date: "2026-09-25", minutes: 23 * 60 + 59 } as any, 30, 180)).toBe(true);
    expect(isWithinCheckinWindow("2026-09-25", "22:00", "22:30", { date: "2026-09-26", minutes: 30 } as any, 30, 180)).toBe(false);
    expect(checkinWindowMessage("2026-09-25", "22:00", "22:30", 30, 180)).toBe("เช็คอินได้ 2026-09-25 เวลา 21:30–23:59 น.");
  });
});

describe("🔴 ruling 2 — a SETTLED session is never flipped by a late scan", () => {
  test("NO_SHOW inside the late window ⇒ the window's 'too late' answer and NO status change", async () => {
    settingsTable({ checkin_late_minutes: 60 });
    const attended = scan({ status: "NO_SHOW" });
    at("2026-09-25", "17:20");
    expect(await refused(checkinByToken("tok"))).toBe("เช็คอินได้ 2026-09-25 เวลา 15:30–18:00 น.");
    expect(attended).toEqual([]);
  });
  test("ATTENDED (what the day-end leaves a started class as) ⇒ 'already', and NO status change", async () => {
    settingsTable({ checkin_late_minutes: 60 });
    const attended = scan({ status: "ATTENDED", student: { id: "s1", name: "Feen" }, teacher: { id: "t1", name: "KK", nickname: "KK" }, subject: { id: "sub1", name: "BALLET" }, course: null, additionalTeachers: [], rental: null });
    spies.push(spyOn(db.query.vouchers, "findFirst").mockImplementation((async () => undefined) as any));
    at("2026-09-25", "17:40");
    const r: any = await checkinByToken("tok");
    expect(r.already).toBe(true);
    expect(attended).toEqual([]);
  });
});

describe("✅ camp — its scan has NO end-of-class window to widen (a camp day scans all day, TASK-403); unchanged", () => {
  test("a PLANNED camp day is scannable late in its own day with the setting at 0 — nothing for the late window to add", () => {
    expect(campScanOutcome({ status: "PLANNED", date: "2026-09-25", checkinTokenExpiresAt: new Date("2026-09-25T23:59:59+07:00") }, "2026-09-25", new Date("2026-09-25T22:00:00+07:00"))).toBe("attend");
  });
});

describe("🔴 every caller threads the late minutes — a caller that forgets keeps the OLD window silently", () => {
  test("every production call of the four window functions passes a late argument", () => {
    const calls: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith(".ts") && !f.endsWith(".test.ts")) {
          const s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
          for (const m of s.matchAll(/(?<!function )\b(isWithinCheckinWindow|checkinWindowMessage|issueCheckinToken|formatCheckinPayload)\(([\s\S]*?)\);/g)) {
            calls.push(`${p.slice(root.length + 1)} ${m[1]}(${m[2].replace(/\s+/g, " ").trim()})`);
          }
        }
      }
    };
    walk(resolve(root, "src"));
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const c of calls) expect({ call: c, threaded: /late/i.test(c.slice(c.indexOf("("))) }).toEqual({ call: c, threaded: true });
  });
});
