// TASK-075 — the claim/approve rules. Pure, no DB.
//
// The property under test: **a claim never grants anything.** Before this, typing a teacher's nickname bound
// that teacher's account to whoever typed it, immediately.
import { describe, expect, test } from "bun:test";
import { claimQueues, claimReplyKey, decideApproval, decideClaim } from "./teacher-link";

const ME = "U_claimant";
const OTHER = "U_someone_else";
const free = { id: "t1" };
const linkedToOther = { id: "t2", lineUserId: OTHER };
const linkedToMe = { id: "t3", lineUserId: ME };

describe("decideClaim — a claim queues, it never links", () => {
  test("no such nickname → not-found, nothing queued", () => {
    expect(decideClaim([], ME)).toBe("not-found");
    expect(claimQueues("not-found")).toBe(false);
  });

  test("🔑 one free match → PENDING (this used to link the account outright)", () => {
    expect(decideClaim([free], ME)).toBe("pending");
    expect(claimQueues("pending")).toBe(true);
  });

  test("🔑 a collision queues ONE request with no teacher — staff decide who it is", () => {
    expect(decideClaim([free, { id: "t9" }], ME)).toBe("pending-ambiguous");
    expect(claimQueues("pending-ambiguous")).toBe(true);
  });

  test("🔐 claiming an ALREADY-LINKED teacher is refused at request time, not queued", () => {
    // If this became a pending request, approving it would silently move a live teacher account to a
    // stranger — the exact theft this task exists to prevent.
    expect(decideClaim([linkedToOther], ME)).toBe("already-linked");
    expect(claimQueues("already-linked")).toBe(false);
  });

  test("re-claiming your OWN link is fine (idempotent retry, not theft)", () => {
    expect(decideClaim([linkedToMe], ME)).toBe("pending");
  });

  test("an archived teacher is not claimable, and reads as not-found (no roster leak)", () => {
    expect(decideClaim([{ id: "t4", archived: true }], ME)).toBe("not-found");
    // …and an archived duplicate must not turn a real single match into a fake collision.
    expect(decideClaim([free, { id: "t5", archived: true }], ME)).toBe("pending");
  });
});

describe("🔐 the bot must not become an oracle", () => {
  test("🔑 a real match and a collision produce the SAME reply key", () => {
    // Otherwise the wording tells an unauthenticated stranger whether a nickname exists, and how many
    // teachers share it.
    expect(claimReplyKey("pending")).toBe(claimReplyKey("pending-ambiguous"));
  });

  test("not-found and already-linked keep their own (existing) wording", () => {
    expect(claimReplyKey("not-found")).toBe("verify_teacher_notfound");
    expect(claimReplyKey("already-linked")).toBe("verify_teacher_other");
  });
});

describe("decideApproval — re-checked at decision time, never overwrites", () => {
  const pendingFor = (teacherId: string | null) => ({
    status: "PENDING",
    lineUserId: ME,
    teacherId,
  });

  test("a named request approves", () => {
    expect(decideApproval(pendingFor("t1"), undefined, free)).toEqual({ ok: true, teacherId: "t1" });
  });

  test("🔑 a collision request cannot be approved without naming the teacher", () => {
    expect(decideApproval(pendingFor(null), undefined, null)).toEqual({
      ok: false,
      error: "teacher-required",
    });
  });

  test("a collision request approves once staff name someone", () => {
    expect(decideApproval(pendingFor(null), "t1", free)).toEqual({ ok: true, teacherId: "t1" });
  });

  test("🔴 RACE: the teacher got linked to someone else between request and decision → fails cleanly", () => {
    expect(decideApproval(pendingFor("t2"), undefined, linkedToOther)).toEqual({
      ok: false,
      error: "teacher-linked",
    });
  });

  test("🔴 RACE: the teacher was archived between request and decision → fails cleanly", () => {
    expect(decideApproval(pendingFor("t1"), undefined, { id: "t1", archived: true })).toEqual({
      ok: false,
      error: "teacher-archived",
    });
  });

  test("the teacher no longer exists → fails cleanly", () => {
    expect(decideApproval(pendingFor("t1"), undefined, null)).toEqual({
      ok: false,
      error: "teacher-missing",
    });
  });

  test("🔑 approving twice is refused — a double-click must not re-link", () => {
    expect(decideApproval({ ...pendingFor("t1"), status: "APPROVED" }, undefined, free)).toEqual({
      ok: false,
      error: "not-pending",
    });
    expect(decideApproval({ ...pendingFor("t1"), status: "REJECTED" }, undefined, free)).toEqual({
      ok: false,
      error: "not-pending",
    });
  });

  test("approving a request for a teacher already linked to THIS claimant is idempotent, not a race", () => {
    expect(decideApproval(pendingFor("t3"), undefined, linkedToMe)).toEqual({
      ok: true,
      teacherId: "t3",
    });
  });

  test("🔐 every failure returns ok:false — no path returns a teacherId it shouldn't link", () => {
    const bad = [
      decideApproval(pendingFor(null), undefined, null),
      decideApproval(pendingFor("t2"), undefined, linkedToOther),
      decideApproval(pendingFor("t1"), undefined, { id: "t1", archived: true }),
      decideApproval({ ...pendingFor("t1"), status: "APPROVED" }, undefined, free),
    ];
    for (const r of bad) expect(r.ok).toBe(false);
  });
});
