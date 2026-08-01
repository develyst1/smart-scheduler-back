import { describe, expect, test } from "bun:test";
import {
  ATTENTION_CHECKS,
  DIGEST_LIST_LIMIT,
  buildDigestMessage,
  decideDigest,
  isCourseExpiringSoon,
  isFreelanceNearCap,
  isNearlyFinishedCourse,
  isStudentIncomplete,
  isUnconfirmedSoon,
  isSaleUnposted,
  isVoucherExpiringSoon,
  isYesterdayNoShow,
  teacherNeedsLine,
} from "./attention";
import { t } from "./line-i18n";

const TODAY = "2026-08-01";
const TOMORROW = "2026-08-02";
const YESTERDAY = "2026-07-31";
const CUTOFF = "2026-08-15"; // today + 14

describe("check 1 — unconfirmed_bookings", () => {
  test("PENDING today or tomorrow counts; other dates/statuses don't", () => {
    expect(isUnconfirmedSoon({ status: "PENDING", date: TODAY }, TODAY, TOMORROW)).toBe(true);
    expect(isUnconfirmedSoon({ status: "PENDING", date: TOMORROW }, TODAY, TOMORROW)).toBe(true);
    expect(isUnconfirmedSoon({ status: "PENDING", date: "2026-08-05" }, TODAY, TOMORROW)).toBe(false);
    expect(isUnconfirmedSoon({ status: "CONFIRMED", date: TODAY }, TODAY, TOMORROW)).toBe(false);
  });
});

describe("check 2 — teachers_without_line", () => {
  test("active, non-archived, no LINE → flagged; anything else → not", () => {
    expect(teacherNeedsLine({ lineUserId: null, active: true, archived: false })).toBe(true);
    expect(teacherNeedsLine({ lineUserId: "U1", active: true, archived: false })).toBe(false);
    expect(teacherNeedsLine({ lineUserId: null, active: false, archived: false })).toBe(false);
    expect(teacherNeedsLine({ lineUserId: null, active: true, archived: true })).toBe(false);
  });
});

describe("check 3 — expiring_entitlements (delegates to the eligibility rules)", () => {
  test("active course expiring inside the window counts", () => {
    expect(isCourseExpiringSoon({ size: 10, usedSessions: 2, expiryDate: "2026-08-10" }, TODAY, CUTOFF)).toBe(true);
  });
  test("expiring beyond the window, already expired, or fully used → no", () => {
    expect(isCourseExpiringSoon({ size: 10, usedSessions: 2, expiryDate: "2026-09-30" }, TODAY, CUTOFF)).toBe(false);
    expect(isCourseExpiringSoon({ size: 10, usedSessions: 2, expiryDate: "2026-07-30" }, TODAY, CUTOFF)).toBe(false);
    expect(isCourseExpiringSoon({ size: 10, usedSessions: 10, expiryDate: "2026-08-10" }, TODAY, CUTOFF)).toBe(false);
  });
  test("vouchers follow the same shape", () => {
    expect(isVoucherExpiringSoon({ totalHours: 10, usedHours: 3, expiryDate: "2026-08-05" }, TODAY, CUTOFF)).toBe(true);
    expect(isVoucherExpiringSoon({ totalHours: 10, usedHours: 10, expiryDate: "2026-08-05" }, TODAY, CUTOFF)).toBe(false);
  });
});

describe("check 4 — nearly_finished_courses", () => {
  test("active course with ≤2 sessions left counts; a spent or expired one doesn't", () => {
    expect(isNearlyFinishedCourse({ size: 10, usedSessions: 8, expiryDate: "2026-12-01" }, TODAY)).toBe(true);
    expect(isNearlyFinishedCourse({ size: 10, usedSessions: 5, expiryDate: "2026-12-01" }, TODAY)).toBe(false);
    expect(isNearlyFinishedCourse({ size: 10, usedSessions: 10, expiryDate: "2026-12-01" }, TODAY)).toBe(false);
    expect(isNearlyFinishedCourse({ size: 10, usedSessions: 9, expiryDate: "2026-07-01" }, TODAY)).toBe(false);
  });
});

describe("check 5 — freelance_near_cap (reuses the calendar's over-cap rule)", () => {
  test("at/below the threshold — and already-negative — count", () => {
    expect(isFreelanceNearCap(2)).toBe(true);
    expect(isFreelanceNearCap(0)).toBe(true);
    expect(isFreelanceNearCap(-3)).toBe(true); // already over cap
    expect(isFreelanceNearCap(9)).toBe(false);
  });
});

describe("check 6 — incomplete_students (LEFT-join semantics)", () => {
  const complete = { gender: "female", birthDate: "2018-01-01", nationality: "TH" };

  test("missing any demographic counts", () => {
    expect(isStudentIncomplete({ ...complete, gender: null }, { province: "กรุงเทพมหานคร" })).toBe(true);
    expect(isStudentIncomplete({ ...complete, birthDate: null }, { province: "x" })).toBe(true);
    expect(isStudentIncomplete({ ...complete, nationality: null }, { province: "x" })).toBe(true);
  });

  test("complete student whose PARENT lacks a province counts", () => {
    expect(isStudentIncomplete(complete, { province: null })).toBe(true);
  });

  test("🔑 a walk-in student with NO parent is judged on their own fields — never silently dropped", () => {
    // complete + parentless → not flagged (no household record to fill in)
    expect(isStudentIncomplete(complete, null)).toBe(false);
    // incomplete + parentless → STILL counted (the inner-join failure mode would have lost this row)
    expect(isStudentIncomplete({ ...complete, gender: null }, null)).toBe(true);
  });

  test("fully complete with a province → not flagged", () => {
    expect(isStudentIncomplete(complete, { province: "เชียงใหม่" })).toBe(false);
  });
});

describe("check 7 — yesterday_no_shows", () => {
  test("NO_SHOW on yesterday only", () => {
    expect(isYesterdayNoShow({ status: "NO_SHOW", date: YESTERDAY }, YESTERDAY)).toBe(true);
    expect(isYesterdayNoShow({ status: "NO_SHOW", date: TODAY }, YESTERDAY)).toBe(false);
    expect(isYesterdayNoShow({ status: "ATTENDED", date: YESTERDAY }, YESTERDAY)).toBe(false);
  });
});

describe("isSaleUnposted (TASK-067) — absence of a SALE movement is the whole signal", () => {
  const posted = new Set(["course-1", "voucher-1"]);

  test("🔑 a sale with no SALE movement is counted", () => {
    expect(isSaleUnposted({ id: "course-2" }, posted)).toBe(true);
  });
  test("a sale that DID reach the books is not counted", () => {
    expect(isSaleUnposted({ id: "course-1" }, posted)).toBe(false);
  });
  test("nothing posted at all → every sale is flagged (the exact state that went unnoticed for days)", () => {
    const none = new Set<string>();
    expect(["c1", "v1", "b1"].filter((id) => isSaleUnposted({ id }, none))).toHaveLength(3);
  });
  test("a healthy pipeline reports zero — that is what a working detector looks like", () => {
    const all = new Set(["c1", "v1"]);
    expect(["c1", "v1"].filter((id) => isSaleUnposted({ id }, all))).toHaveLength(0);
  });
});

describe("registry — extensibility is one array entry", () => {
  test("all nine checks are registered, with unique keys", () => {
    // 8th = sales_not_posted (TASK-067), 9th = pending_teacher_links (TASK-075). This count moving by
    // exactly one per task, with nothing else in this describe block changing, IS the running evidence for
    // SPEC-018's extensibility claim.
    expect(ATTENTION_CHECKS).toHaveLength(9);
    expect(new Set(ATTENTION_CHECKS.map((c) => c.key)).size).toBe(9);
  });
  test("every check has an i18n title key — a new check can't ship label-less", () => {
    for (const c of ATTENTION_CHECKS) {
      expect(c.titleKey).toBe(`att_${c.key}`);
      expect(t(c.titleKey, "EN")).not.toBe(c.titleKey); // t() returns the key when it's missing
      expect(t(c.titleKey, "TH")).not.toBe(c.titleKey);
    }
  });
  test("🔐 exactly two checks may name people in the digest (REQ-020 privacy)", () => {
    const named = ATTENTION_CHECKS.filter((c) => c.namesPeopleInDigest).map((c) => c.key);
    expect(named.sort()).toEqual(["teachers_without_line", "unconfirmed_bookings"]);
  });
});

describe("decideDigest — send / stay silent / skip", () => {
  const clear = [{ count: 0 }, { count: 0 }];

  test("everything clear → record-only (write the row, send nothing)", () => {
    expect(decideDigest(clear, false)).toBe("record-only");
  });
  test("anything outstanding → send", () => {
    expect(decideDigest([{ count: 0 }, { count: 3 }], false)).toBe("send");
  });
  test("🔑 a BROKEN check still sends — silence would hide it", () => {
    expect(decideDigest([{ count: 0 }, { count: null }], false)).toBe("send");
  });
  test("already sent today → skip (a second run must not re-send)", () => {
    expect(decideDigest([{ count: 5 }], true)).toBe("skip-already-sent");
    expect(decideDigest(clear, true)).toBe("skip-already-sent");
  });
});

describe("outbox payload strips names the message never prints (TASK-053 item 2)", () => {
  // The job enqueues `items` only for checks flagged `namesPeopleInDigest`. This asserts the RULE the job
  // applies, so the privacy claim doesn't rest on the renderer staying correct forever (the TASK-047 lesson:
  // data that travels where it isn't needed is what leaks).
  const namesAllowed = new Set(
    ATTENTION_CHECKS.filter((c) => c.namesPeopleInDigest).map((c) => c.key),
  );
  const enqueued = (key: string, items: Array<{ id: string; label: string }>) =>
    namesAllowed.has(key) ? items : [];

  test("🔐 a non-permitted check carries NO items into the outbox row", () => {
    expect(enqueued("incomplete_students", [{ id: "s1", label: "น้องเอ" }])).toEqual([]);
    expect(enqueued("yesterday_no_shows", [{ id: "b1", label: "10:00 · น้องดี" }])).toEqual([]);
    expect(enqueued("expiring_entitlements", [{ id: "c1", label: "course" }])).toEqual([]);
  });

  test("the two permitted checks still carry theirs (the digest needs them)", () => {
    const items = [{ id: "b1", label: "09:00 · เอ · ครูเอ" }];
    expect(enqueued("unconfirmed_bookings", items)).toEqual(items);
    expect(enqueued("teachers_without_line", items)).toEqual(items);
  });
});

describe("buildDigestMessage — one message, privacy-respecting", () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `x${i}`, label: `NAME_${i}` }));

  test("clear checks are omitted; counts shown for the rest", () => {
    const msg = buildDigestMessage([
      { key: "yesterday_no_shows", count: 0, items: [] },
      { key: "incomplete_students", count: 4, items: items(4) },
    ]);
    expect(msg).not.toContain("ไม่มาเรียนเมื่อวาน");
    expect(msg).toContain("นักเรียนที่ข้อมูลไม่ครบ: 4");
  });

  test("🔐 a non-permitted check shows a COUNT ONLY — no names leak", () => {
    const msg = buildDigestMessage([{ key: "incomplete_students", count: 3, items: items(3) }]);
    expect(msg).not.toContain("NAME_0"); // names stay behind login
  });

  test("a permitted check lists people, truncated at the limit", () => {
    const msg = buildDigestMessage([{ key: "unconfirmed_bookings", count: 8, items: items(8) }]);
    expect(msg).toContain("NAME_0");
    expect(msg).toContain(`NAME_${DIGEST_LIST_LIMIT - 1}`);
    expect(msg).not.toContain(`NAME_${DIGEST_LIST_LIMIT}`); // truncated
    expect(msg).toContain("3"); // "+3 more"
  });

  test("a degraded check is reported, not hidden; and EN renders too", () => {
    const th = buildDigestMessage([{ key: "freelance_near_cap", count: null, items: [], error: "boom" }]);
    expect(th).toContain("ตรวจสอบไม่สำเร็จ");
    const en = buildDigestMessage([{ key: "freelance_near_cap", count: null, items: [] }], "EN");
    expect(en).toContain("check failed");
    expect(en).toContain("Freelance budgets near their cap");
  });
});
