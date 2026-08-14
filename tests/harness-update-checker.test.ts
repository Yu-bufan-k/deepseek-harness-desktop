import { describe, expect, it } from "vitest";
import { isNewerHarnessVersion } from "../src/main/harness-update-checker.js";

describe("Harness update comparison", () => {
  it("orders releases and prereleases", () => {
    expect(isNewerHarnessVersion("0.1.0-rc.7", "0.1.0-rc.6")).toBe(true);
    expect(isNewerHarnessVersion("0.1.0", "0.1.0-rc.6")).toBe(true);
    expect(isNewerHarnessVersion("0.1.0-rc.6", "0.1.0-rc.6")).toBe(false);
    expect(isNewerHarnessVersion("0.0.9", "0.1.0-rc.6")).toBe(false);
  });
});
