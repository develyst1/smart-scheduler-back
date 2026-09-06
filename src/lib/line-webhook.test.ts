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
    // TASK-251 (REQ-079 section 16): this line used to read `parseRoleChoice("1")` -> "customer". The bare
    // number is retired because it collided with the numbered replies the customer's own OA already owns, so
    // the fixture is CORRECTED to the new truth rather than deleted. The exhaustive role-word matrix lives in
    // `line-role-buttons.test.ts`; what this C.4 fixture keeps is the one assertion that must never regress.
    expect(parseRoleChoice("1")).toBeNull();
    expect(parseRoleChoice("ผู้ปกครอง")).toBe("customer");
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
