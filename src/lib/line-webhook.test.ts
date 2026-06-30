import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  normalizePhone,
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
