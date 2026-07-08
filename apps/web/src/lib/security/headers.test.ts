import { describe, expect, it } from "vitest";
import { STATIC_SECURITY_HEADERS } from "./headers";

describe("STATIC_SECURITY_HEADERS", () => {
  it("includes a Permissions-Policy header", () => {
    const ppHeader = STATIC_SECURITY_HEADERS.find(
      (h) => h.key === "Permissions-Policy"
    );
    expect(ppHeader).toBeDefined();
  });

  it("Permissions-Policy includes microphone=(self)", () => {
    const ppHeader = STATIC_SECURITY_HEADERS.find(
      (h) => h.key === "Permissions-Policy"
    );
    expect(ppHeader?.value).toContain("microphone=(self)");
  });

  it("Permissions-Policy does not grant microphone to all origins", () => {
    const ppHeader = STATIC_SECURITY_HEADERS.find(
      (h) => h.key === "Permissions-Policy"
    );
    // Should NOT be microphone=() (blocked) or microphone=* (all)
    expect(ppHeader?.value).not.toContain("microphone=()");
    expect(ppHeader?.value).not.toContain("microphone=*");
  });
});
