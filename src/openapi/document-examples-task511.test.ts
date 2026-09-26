// TASK-511 — the PUBLIC docs page (TASK-509) must not name a real account: its login example is an obvious placeholder, in a
// shape the real rules accept (so the example never teaches a login that would be rejected).
import { describe, expect, test } from "bun:test";
import { openApiDocument } from "./document";
import { PASSWORD_MIN, USERNAME_RE } from "../services/user.service";

describe("🔑 TASK-511 — the public login example is a placeholder, not an account", () => {
  const props = (openApiDocument as any).components.schemas.LoginRequest.properties;
  test("by value: `your.username` / `your-password-here` — never the bootstrap `admin`", () => {
    expect([props.username.example, props.password.example]).toEqual(["your.username", "your-password-here"]);
    expect(props.username.example).not.toBe("admin");
  });
  test("…and both are shapes the real rules accept", () => {
    expect(USERNAME_RE.test(props.username.example)).toBe(true);
    expect(props.password.example.length).toBeGreaterThanOrEqual(PASSWORD_MIN);
  });
});
