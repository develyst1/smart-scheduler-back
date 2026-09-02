// SPEC-071 / TASK-234 (REQ-079 §5 Flows 4–6, AC-13/14/15/19/21) — the two menu sets, and the flows behind them.
//
// 🔴 This is the REUSE task, so most of what matters here is a proof of ABSENCE: that แจ้งลา / เช็คอิน were
// wired rather than rebuilt, and that the paths teachers and unbound chats use are byte-identical. A test that
// only checked the new button would pass while the old flows quietly forked.
import { describe, expect, test } from "bun:test";
import { readSrc } from "../lib/read-src";
import {
  KNOWN_RICH_MENU,
  KNOWN_RICH_MENU_EN,
  PARENT_RICH_MENU,
  TEACHER_RICH_MENU,
  UNKNOWN_RICH_MENU,
  UNKNOWN_RICH_MENU_EN,
  menuHasAdminButton,
} from "../lib/line-rich-menu";
import { courseLine, nextSessionTeacher, renderMyCourses } from "../lib/line-course-view";
import { needsChildStep } from "../lib/line-leave";
import { t } from "../lib/line-i18n";

const SVC = readSrc(await Bun.file(new URL("./line-webhook.service.ts", import.meta.url)).text());
const MENU = readSrc(await Bun.file(new URL("../lib/line-rich-menu.ts", import.meta.url)).text());
const VIEW = readSrc(await Bun.file(new URL("../lib/line-course-view.ts", import.meta.url)).text());
/** Comments stripped — the repo convention for source assertions (Sober, 2026-09-02). */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const actions = (m: typeof KNOWN_RICH_MENU) => m.areas.map((a) => a.action.data);

describe("🔴 `คุยกับแอดมิน` is on BOTH menus, and no flow may remove it", () => {
  test("both new menus carry it, in both languages", () => {
    // It is the promise that a person is reachable — the only thing that makes a bot acceptable to a parent.
    for (const m of [UNKNOWN_RICH_MENU, KNOWN_RICH_MENU, UNKNOWN_RICH_MENU_EN, KNOWN_RICH_MENU_EN]) {
      expect(menuHasAdminButton(m)).toBe(true);
    }
  });

  test("🔑 the button works for an UNRECOGNISED chat — it is handled before every role check", () => {
    // Gating it behind `detectLinkedRole` would make the one button that must never fail available only to
    // people who do not need it. A lockout or a handover must never be a dead end.
    const post = code(SVC).slice(code(SVC).indexOf("const { action, params } = parsePostback(data)"));
    expect(post.indexOf('action === "admin"')).toBeLessThan(post.indexOf("detectLinkedRole"));
    expect(post.indexOf('action === "enter"')).toBeLessThan(post.indexOf("detectLinkedRole"));
  });

  test("pressing it tells the admins AND gets the bot out of the way", () => {
    const fn = code(SVC).slice(code(SVC).indexOf("async function doCallAdmin"));
    expect(fn).toContain("notifyAdmins(");
    // The SAME mute helper the two-strikes handover uses — one definition of "how long the bot stays out".
    expect(fn).toContain("muteUntilFrom()");
  });
});

describe("the two menu sets — unknown is the DEFAULT, known is the per-user link", () => {
  test("unknown = เข้าใช้ระบบ · คุยกับแอดมิน, and it is the one marked default", () => {
    expect(actions(UNKNOWN_RICH_MENU)).toEqual(["action=enter", "action=admin"]);
    expect(UNKNOWN_RICH_MENU.selected).toBe(true);
  });

  test("known = แจ้งลา · เช็คอิน · คอร์สของฉัน · เพิ่มนักเรียน · คุยกับแอดมิน", () => {
    expect(actions(KNOWN_RICH_MENU)).toEqual([
      "action=leave",
      "action=checkin",
      "action=mycourses",
      "action=register",
      "action=admin",
    ]);
  });

  test("🔑 there is NO unlink — 'unknown' is where a chat lands, not a state anyone must set", () => {
    // That is the whole reason unknown is the default: a brand-new follower gets the right menu with no code
    // running at all, and a removed link falls back correctly by itself.
    expect(MENU).toContain("export async function linkKnownRichMenu");
    expect(code(MENU)).not.toContain("unlinkRichMenu");
  });

  test("a bound family chat gets the known menu", () => {
    expect(SVC).toContain('if (role === "customer") await linkKnownRichMenu(lineUserId, seed)');
  });

  test("every tap action the menus fire is a KNOWN postback action", () => {
    // A menu button whose action nothing handles is a dead button that logs UNHANDLED (TASK-045) — and the
    // person tapping it just gets silence.
    for (const m of [UNKNOWN_RICH_MENU, KNOWN_RICH_MENU]) {
      for (const a of actions(m)) {
        expect(SVC).toContain(`"${a.replace("action=", "")}",`);
      }
    }
  });

  test("🚫 the shipped parent/teacher menus are untouched", () => {
    // REQ-042's menus are in production and owner-verified. This task adds data beside them; it does not edit
    // them, so a rollback of REQ-079 cannot disturb what teachers already use.
    expect(actions(PARENT_RICH_MENU)).toEqual([
      "action=checkin",
      "action=leave",
      "action=children",
      "action=register",
      "action=lang",
      "action=help",
    ]);
    expect(actions(TEACHER_RICH_MENU)).toEqual(["action=schedule", "action=lang"]);
  });
});

describe("🔴 AC-15 — คอร์สของฉัน shows all five fields", () => {
  const row = {
    subjectName: "Surfskate",
    teacherNickname: "หนึ่ง",
    size: 10,
    usedSessions: 4,
    leaveRemaining: 2,
    expiryDate: "2026-12-31",
  };

  test("course · teacher · เหลือ n/N · สิทธิ์ลาเหลือ · วันหมดอายุ", () => {
    const line = courseLine(row, "TH");
    expect(line).toContain("Surfskate");
    expect(line).toContain("ครูหนึ่ง");
    expect(line).toContain("เหลือ 6/10"); // 10 purchased − 4 used
    expect(line).toContain("สิทธิ์ลาเหลือ 2");
    expect(line).toContain("2026-12-31");
  });

  test("🔴 'เหลือ' is REMAINING, not used — the inversion a family only notices when they run out early", () => {
    expect(courseLine({ ...row, usedSessions: 9 }, "TH")).toContain("เหลือ 1/10");
    expect(courseLine({ ...row, usedSessions: 0 }, "TH")).toContain("เหลือ 10/10");
  });

  test("an over-attended course reads 0 left, never a negative", () => {
    // Reachable after an import correction; a negative on a money-adjacent line reads as a system fault.
    expect(courseLine({ ...row, usedSessions: 12 }, "TH")).toContain("เหลือ 0/10");
  });

  test("a missing program or teacher renders `-`, not an omitted field", () => {
    // An absent field on a money document reads as "the system knows and is not saying".
    const line = courseLine({ ...row, subjectName: null, teacherNickname: null }, "TH");
    expect(line).toContain("· - ·");
    expect(line).not.toContain("null");
    expect(line).not.toContain("undefined");
  });

  test("no courses says so plainly", () => {
    expect(renderMyCourses([], "TH")).toBe(t("course_none", "TH"));
    expect(renderMyCourses([row], "TH")).toContain(t("course_title", "TH"));
  });

  test("🔑 the numbers come from `toCourseSummary` — the SAME builder every staff screen uses", () => {
    // A second derivation of "sessions remaining" is how a parent and an admin end up quoting different
    // figures at each other. The view is handed a summary; it does not compute one.
    const fn = code(SVC).slice(code(SVC).indexOf("async function doMyCourses"));
    expect(fn).toContain("toCourseSummary(c)");
    expect(fn).not.toContain("leaveQuota -");
    expect(fn).not.toContain("LEAVE_QUOTA_BY_SIZE");
  });

  // ═══ 🔴 The SA fix: a re-teachered course names who is teaching it NOW ═══
  //
  // A course has no teacher column — TASK-140 left the teacher on the bookings **because a course is
  // re-teacherable**. So a split course is not an oddity, it is the normal result of a re-teacher: old sessions
  // with A, future ones with B. A parent reading คอร์สของฉัน is asking "who is teaching my child", present
  // tense, so the FIRST session answers a question nobody asked — and is wrong in exactly the case the split
  // exists to represent.
  describe("🔴 the teacher is the NEXT upcoming session's, not the first ever", () => {
    const S = (date: string, nickname: string | null, status = "CONFIRMED") => ({
      date,
      status,
      teacher: nickname ? { nickname } : null,
    });

    test("a re-teachered course names the NEW teacher, not the old one", () => {
      const split = [S("2026-08-01", "หนึ่ง"), S("2026-08-08", "หนึ่ง"), S("2026-09-05", "สอง")];
      expect(nextSessionTeacher(split, "2026-09-02")).toBe("สอง");
    });

    test("…and it is the EARLIEST upcoming one, not just any future session", () => {
      const out = [S("2026-12-01", "สาม"), S("2026-09-05", "สอง"), S("2026-10-01", "สี่")];
      expect(nextSessionTeacher(out, "2026-09-02")).toBe("สอง");
    });

    test("a session TODAY counts as upcoming — it has not happened yet", () => {
      expect(nextSessionTeacher([S("2026-09-02", "สอง"), S("2026-08-01", "หนึ่ง")], "2026-09-02")).toBe("สอง");
    });

    test("a finished course still names who taught it, rather than going blank", () => {
      // The day the last session is attended, the parent should not suddenly see `-`.
      const past = [S("2026-08-01", "หนึ่ง"), S("2026-08-20", "สอง")];
      expect(nextSessionTeacher(past, "2026-09-02")).toBe("สอง"); // the most RECENT past one
    });

    test("🚫 a CANCELLED session is not evidence of who teaches", () => {
      const withCancel = [S("2026-09-03", "สอง", "CANCELLED"), S("2026-09-10", "สาม")];
      expect(nextSessionTeacher(withCancel, "2026-09-02")).toBe("สาม");
    });

    test("no sessions, or none with a teacher, is `null` — and renders as `-`", () => {
      expect(nextSessionTeacher([], "2026-09-02")).toBeNull();
      expect(nextSessionTeacher([S("2026-09-05", null)], "2026-09-02")).toBeNull();
    });

    test("the service passes the Bangkok business date, not a raw clock", () => {
      const fn = code(SVC).slice(code(SVC).indexOf("async function doMyCourses"));
      expect(fn).toContain("nextSessionTeacher(c.bookings ?? [], bangkokNow().date)");
      // 🚫 and it no longer takes whichever booking happened to come back first.
      expect(fn).not.toContain("bookings?.find(");
    });
  });

  test("only ACTIVE courses are listed", () => {
    // An ended or expired course is not something a family is still owed, and listing it invites
    // "why does it say I have sessions left?".
    const fn = code(SVC).slice(code(SVC).indexOf("async function doMyCourses"));
    expect(fn).toContain('s.status === "ACTIVE"');
  });
});

describe("🔴 AC-13 / AC-14 — the leave flow was WIRED, not rebuilt", () => {
  test("the child step is skipped with one child and shown with two — the EXISTING rule", () => {
    // `needsChildStep` is REQ-046's, untouched. Asserted here because AC-14 is about this exact boundary.
    // The real rows carry the student —  names each child from it.
    const s = (studentId: string) =>
      ({ id: "b" + studentId, studentId, startTime: "10:00:00", student: { id: studentId, name: "น้อง" + studentId } }) as any;
    expect(needsChildStep([s("a")])).toBe(false);
    expect(needsChildStep([s("a"), s("a")])).toBe(false); // two SESSIONS, one child → still no child step
    expect(needsChildStep([s("a"), s("b")])).toBe(true);
  });

  test("🚫 nothing here re-implements leave or check-in — the handlers are the shipped ones", () => {
    // The menu points at `doLeave` / `doCheckin`; this task added no second implementation of either.
    expect(SVC).toContain("doLeave(lineUserId, replyToken, date, lang, params.studentId)");
    expect(SVC).toContain("doCheckin(lineUserId, replyToken, date, lang)");
    expect(code(SVC).match(/async function doLeave\(/g)).toHaveLength(1);
    expect(code(SVC).match(/async function doCheckin\(/g)).toHaveLength(1);
  });

  test("the session is never inferred — a bookingId still routes to the per-session handler", () => {
    expect(SVC).toContain("params.bookingId");
    expect(SVC).toContain("doLeaveBooking(lineUserId, params.bookingId, replyToken, date, lang)");
  });
});

describe("🔴 AC-19 — every choice takes a typed answer too (LINE on PC cannot tap)", () => {
  test("the new buttons have typed twins", () => {
    expect(SVC).toContain('["คอร์ส", "คอร์สของฉัน", "courses", "mycourses"].includes(cmd)');
    expect(SVC).toContain('["แอดมิน", "คุยกับแอดมิน", "admin"].includes(cmd)');
  });

  test("…and they call the SAME handlers the postbacks call", () => {
    // Asserted rather than built: postbacks and keywords have shared handlers since TASK-038.
    expect(code(SVC).match(/doMyCourses\(lineUserId, replyToken, lang\)/g)!.length).toBeGreaterThanOrEqual(2);
    expect(code(SVC).match(/doCallAdmin\(lineUserId, replyToken, lang\)/g)!.length).toBeGreaterThanOrEqual(2);
  });

  test("the role picker still accepts a typed 1 / 2 / 3", () => {
    expect(SVC).toContain("parseRoleChoice(text)");
  });
});

describe("🔴 AC-21 — unchanged for teachers and for anyone not in a bound chat", () => {
  test("the teacher branch is untouched", () => {
    expect(SVC).toContain('if (action === "schedule")');
    expect(SVC).toContain("doTeacherSchedule(lineUserId, replyToken, lang");
    expect(SVC).toContain("doTeacherCalendar(lineUserId, replyToken, lang)");
  });

  test("`เข้าใช้ระบบ` points at the phone and at a person — NOT the retired code prompt", () => {
    // Flow 2 was deleted in §15; a button that reopened it would resurrect a mechanism the owner removed.
    expect(SVC).toContain('t("enter_ask_admin", lang)');
    expect(t("enter_ask_admin", "TH")).toContain("เบอร์โทร");
    expect(t("enter_ask_admin", "TH")).toContain("แอดมิน");
  });

  test("a suspended household is still refused every postback", () => {
    expect(SVC).toContain("isSuspendedLineParent(lineUserId)");
  });

  test("🚫 AC-20 — no money path is reachable from the new modules", () => {
    for (const m of ["recordSale", "postBookingSale", "boMovement", "applyHoldMove", "discountKind"]) {
      expect(SVC).not.toContain(m);
      expect(MENU).not.toContain(m);
      expect(VIEW).not.toContain(m);
    }
  });
});
