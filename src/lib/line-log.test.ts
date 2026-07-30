import { describe, expect, test } from "bun:test";
import {
  formatDroppedPostback,
  formatInboundEvent,
  formatUnknownAction,
  userMarker,
} from "./line-log";

const UID = "U1234567890abcdef1234567890abcdef";

describe("line-log inbound observability (TASK-045)", () => {
  test("userMarker is stable, short, and never contains the raw userId", () => {
    const m = userMarker(UID);
    expect(m).toBe(userMarker(UID)); // stable → correlatable across events
    expect(m).not.toContain(UID);
    expect(m).not.toContain("1234567890"); // no raw prefix leak
    expect(m.length).toBeLessThanOrEqual(12);
    expect(userMarker(null)).toBe("u:none");
  });

  test("a postback logs its raw action data — proves the tap reached us", () => {
    const line = formatInboundEvent({
      type: "postback",
      replyToken: "r",
      source: { userId: UID },
      postback: { data: "action=checkin" },
    });
    expect(line).toContain("type=postback");
    expect(line).toContain("data=action=checkin");
    expect(line).not.toContain(UID);
  });

  test("a text message logs its type, not its content", () => {
    const line = formatInboundEvent({
      type: "message",
      source: { userId: UID },
      message: { type: "text", id: "1", text: "เมนู" },
    });
    expect(line).toContain("type=message");
    expect(line).toContain("msgType=text");
  });

  test("dropped postback names exactly which field was missing (was a silent return)", () => {
    const noToken = formatDroppedPostback({
      type: "postback",
      source: { userId: UID },
      postback: { data: "action=menu" },
    });
    expect(noToken).toContain("missing: replyToken");

    const noData = formatDroppedPostback({ type: "postback", replyToken: "r", source: { userId: UID } });
    expect(noData).toContain("missing: data");

    const nothing = formatDroppedPostback({ type: "postback" });
    expect(nothing).toContain("replyToken");
    expect(nothing).toContain("userId");
    expect(nothing).toContain("data");
  });

  test("unhandled action is logged distinctly (not confusable with 'nothing arrived')", () => {
    expect(formatUnknownAction("chekcin", UID)).toContain("UNHANDLED action=chekcin");
    expect(formatUnknownAction("", UID)).toContain("action=(empty)");
  });
});
