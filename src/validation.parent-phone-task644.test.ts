// TASK-644 (piece A) — a NEW student needs a parent phone on the three BOOKING acts; the two IMPORT acts are exempt (owner).
// The server is the authority per ACT. Pure schema tests for all five acts, plus ONE request through the root app showing the
// exact HTTP refusal the front end receives (TASK-662 reads it).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createBooking, createCoursePackage, createVoucher, importCoursePackage, importVoucher, NEW_STUDENT_PHONE_REQUIRED } from "./validation";
import * as sched from "./services/scheduler.service";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test"; // lazy — never connected here
process.env.JWT_SECRET ??= "test-secret";

const STUDENT_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT_ID = "33333333-3333-4333-8333-333333333333";

// A body per act that is VALID apart from `student`, so a verdict is about the student alone.
const ACTS = {
  createBooking: { schema: createBooking, strict: true, body: { teacherId: TEACHER_ID, subjectId: SUBJECT_ID, date: "2026-10-15", startTime: "10:00", bookingType: "SINGLE_SESSION" } },
  createCoursePackage: { schema: createCoursePackage, strict: true, body: { teacherId: TEACHER_ID, subjectId: SUBJECT_ID, size: 6, startDate: "2026-10-15", startTime: "10:00" } },
  createVoucher: { schema: createVoucher, strict: true, body: { totalHours: 10 } },
  importCoursePackage: { schema: importCoursePackage, strict: false, body: { teacherId: TEACHER_ID, subjectId: SUBJECT_ID, size: 6, usedSessions: 1, startDate: "2026-09-01", startTime: "10:00", expiryDate: "2027-01-01" } },
  importVoucher: { schema: importVoucher, strict: false, body: { totalHours: 10, usedHours: 2, expiryDate: "2027-01-01" } },
} as const;
type Act = keyof typeof ACTS;
const parse = (act: Act, student: unknown) => (ACTS[act].schema as any).safeParse({ ...ACTS[act].body, student });
const phoneIssue = (r: any) => (r.success ? undefined : r.error.issues.find((i: any) => i.path.join(".") === "student.phone"));
const STRICT = (Object.keys(ACTS) as Act[]).filter((a) => ACTS[a].strict);
const IMPORT = (Object.keys(ACTS) as Act[]).filter((a) => !ACTS[a].strict);

describe("TASK-644 — the fixtures are valid apart from `student` (so every verdict below is about the student)", () => {
  for (const act of Object.keys(ACTS) as Act[]) test(`${act}: { id } parses`, () => expect(parse(act, { id: STUDENT_ID }).success).toBe(true));
});

describe("🔴 the three BOOKING acts refuse a new student without a usable parent phone", () => {
  for (const act of STRICT) {
    test(`${act}: an inline student with NO phone ⇒ refused, ONE issue at student.phone, the draft sentence`, () => {
      const r = parse(act, { name: "Test Kid" });
      expect(r.success).toBe(false);
      expect(phoneIssue(r)).toMatchObject({ path: ["student", "phone"], message: NEW_STUDENT_PHONE_REQUIRED });
      expect(NEW_STUDENT_PHONE_REQUIRED.length).toBeGreaterThan(0); // pinned by SHAPE — the words are a DRAFT
    });
    for (const junk of ["1", "12345", "0812", "", "   ", "081x2345678"])
      test(`${act}: junk phone ${JSON.stringify(junk)} ⇒ refused at student.phone`, () => {
        const r = parse(act, { name: "Test Kid", phone: junk });
        expect(r.success).toBe(false);
        expect(phoneIssue(r)).toBeDefined();
      });
    for (const ok of ["0812345678", "081-234-5678", "+66 81 234 5678"])
      test(`${act}: valid phone ${JSON.stringify(ok)} ⇒ accepted`, () => expect(parse(act, { name: "Test Kid", phone: ok }).success).toBe(true));
  }
});

describe("⚖️ the two IMPORT acts are exempt (owner's ruling) — an inline student may come without a phone", () => {
  for (const act of IMPORT) {
    test(`${act}: an inline student with NO phone ⇒ accepted`, () => expect(parse(act, { name: "Test Kid" }).success).toBe(true));
    test(`${act}: a short phone is still accepted (today's optional shape, unchanged)`, () => expect(parse(act, { name: "Test Kid", phone: "1" }).success).toBe(true));
  }
});

describe("`{ id }` and the OTHER booking are untouched", () => {
  for (const act of Object.keys(ACTS) as Act[]) test(`${act}: { id } accepted`, () => expect(parse(act, { id: STUDENT_ID }).success).toBe(true));
  test("an OTHER booking with NO student is still accepted", () => {
    const r = createBooking.safeParse({ teacherId: TEACHER_ID, date: "2026-10-15", startTime: "10:00", bookingType: "OTHER", otherTitle: "Event C" });
    expect(r.error?.issues ?? []).toEqual([]);
  });
});

describe("🔑 the HTTP refusal the front end receives — POST /api/bookings through the ROOT app", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); delete process.env.SKIP_AUTH; });
  test("an inline student with no phone ⇒ 400 VALIDATION, the issue at student.phone in `details`, and the service is never called", async () => {
    process.env.SKIP_AUTH = "true";
    const calls: unknown[] = [];
    spies.push(spyOn(sched, "createBooking").mockImplementation((async (...a: unknown[]) => { calls.push(a); return {}; }) as any));
    const app = (await import("./index")).default as { fetch: (r: Request) => Promise<Response> };
    const res = await app.fetch(new Request("http://localhost/api/bookings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ACTS.createBooking.body, student: { name: "Test Kid" } }),
    }));
    const body = (await res.json()) as any;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.details).toEqual([expect.objectContaining({ code: "custom", path: ["student", "phone"], message: NEW_STUDENT_PHONE_REQUIRED })]);
    expect(calls).toEqual([]);
    console.log("TASK-644 HTTP refusal:", res.status, JSON.stringify(body));
  });
});
