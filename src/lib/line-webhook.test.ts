import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  eventPostbackData,
  normalizePhone,
  parsePostback,
  parseRoleChoice,
  verifyLineSignature,
} from "./line-webhook";

describe("line-webhook (C.4)", () => {
  test("parseRoleChoice", () => {
    expect(parseRoleChoice("1")).toBe("customer");
    expect(parseRoleChoice("ครู")).toBe("teacher");
    expect(parseRoleChoice("แอดมิน")).toBe("admin");
    expect(parseRoleChoice("xyz")).toBeNull();
  });

  test("normalizePhone strips non-digits", () => {
    expect(normalizePhone("081-234-5678")).toBe("0812345678");
  });

  test("verifyLineSignature", () => {
    const body = '{"events":[]}';
    const secret = "test-secret";
    const sig = createHmac("sha256", secret).update(body).digest("base64");
    expect(verifyLineSignature(body, sig, secret)).toBe(true);
    expect(verifyLineSignature(body, "bad", secret)).toBe(false);
  });
});

describe("postback parsing (REQ-015 / TASK-038)", () => {
  test("parsePostback splits action + params", () => {
    expect(parsePostback("action=checkin")).toEqual({ action: "checkin", params: { action: "checkin" } });
    expect(parsePostback("action=leave&bookingId=abc-123")).toEqual({
      action: "leave",
      params: { action: "leave", bookingId: "abc-123" },
    });
  });
  test("parsePostback with no action → empty action string", () => {
    expect(parsePostback("foo=bar").action).toBe("");
  });
  test("parsePostback carries range for the schedule toggle (TASK-043)", () => {
    expect(parsePostback("action=schedule&range=week")).toEqual({
      action: "schedule",
      params: { action: "schedule", range: "week" },
    });
  });
  test("eventPostbackData reads postback events only", () => {
    expect(eventPostbackData({ type: "postback", postback: { data: "action=menu" } })).toBe("action=menu");
    expect(eventPostbackData({ type: "message", message: { type: "text", id: "1", text: "hi" } })).toBeNull();
  });
});
