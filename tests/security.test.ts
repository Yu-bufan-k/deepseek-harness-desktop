import { describe, expect, it } from "vitest";
import {
  isSafeExternalUrl,
  redactSensitive,
  sanitizedEnvironment,
} from "../src/shared/security.js";

describe("security helpers", () => {
  it("redacts common credential forms", () => {
    expect(redactSensitive("Authorization: Bearer abc.def.ghi")).toContain(
      "Bearer [REDACTED]",
    );
    expect(redactSensitive("api_key=super-secret")).toBe("api_key=[REDACTED]");
  });

  it("removes sensitive environment entries", () => {
    expect(
      sanitizedEnvironment({
        PATH: "ok",
        DEEPSEEK_API_KEY: "no",
        SESSION_TOKEN: "no",
      }),
    ).toEqual({ PATH: "ok" });
  });

  it("only permits safe external protocols", () => {
    expect(isSafeExternalUrl("https://deepseek.com")).toBe(true);
    expect(isSafeExternalUrl("mailto:test@example.com")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });
});
