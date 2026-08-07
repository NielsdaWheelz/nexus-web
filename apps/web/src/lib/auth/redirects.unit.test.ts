import { describe, expect, it } from "vitest";
import {
  buildAuthSessionRecoveryUrl,
  parseAuthReturnTarget,
} from "./redirects";

describe("auth session recovery redirects", () => {
  it("builds the canonical recovery URL without accepting an external target", () => {
    const target = parseAuthReturnTarget("/extension/connect/start?state=1");

    expect(buildAuthSessionRecoveryUrl("https://nexus.example", target).toString()).toBe(
      "https://nexus.example/auth/session/recover?next=%2Fextension%2Fconnect%2Fstart%3Fstate%3D1",
    );
  });

  it("uses the authenticated home when the requested target is unsafe", () => {
    const target = parseAuthReturnTarget("https://attacker.example/capture");

    expect(buildAuthSessionRecoveryUrl("https://nexus.example", target).toString()).toBe(
      "https://nexus.example/auth/session/recover",
    );
  });
});
