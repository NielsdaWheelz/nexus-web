import { describe, expect, it } from "vitest";
import type { SessionVerification } from "@/lib/auth/dal";
import { parseAuthReturnTarget } from "@/lib/auth/redirects";
import { AuthDependencyError } from "@/lib/auth/session-response";
import { planLoginEntry } from "./login-entry";

const target = parseAuthReturnTarget("/browse?view=recent");

describe("planLoginEntry", () => {
  it.each<{
    verification: SessionVerification;
    expected:
      | { kind: "Render" }
      | { kind: "Target"; target: typeof target }
      | { kind: "Recover"; target: typeof target };
  }>([
    {
      verification: {
        kind: "Verified",
        viewer: { userId: "viewer-1", email: "reader@example.com" },
      },
      expected: { kind: "Target", target },
    },
    {
      verification: { kind: "Anonymous" },
      expected: { kind: "Render" },
    },
    {
      verification: { kind: "RefreshRequired" },
      expected: { kind: "Recover", target },
    },
    {
      verification: {
        kind: "SessionEnded",
        cookieNames: ["sb-project-auth-token"],
      },
      expected: { kind: "Recover", target },
    },
  ])(
    "maps $verification.kind without side effects",
    async ({ verification, expected }) => {
      const plan = await planLoginEntry(target, async () => verification);

      expect(plan).toEqual(expected);
    },
  );

  it("recovers from the owned authentication dependency failure", async () => {
    const plan = await planLoginEntry(target, async () => {
      throw new AuthDependencyError();
    });

    expect(plan).toEqual({ kind: "Recover", target });
  });

  it("preserves an invariant defect for the framework error boundary", async () => {
    const defect = new Error("session verifier contract drift");

    await expect(
      planLoginEntry(target, async () => {
        throw defect;
      }),
    ).rejects.toBe(defect);
  });
});
