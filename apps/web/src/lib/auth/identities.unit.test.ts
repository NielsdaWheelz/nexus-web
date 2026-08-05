import { describe, expect, it } from "vitest";
import { isOAuthProvider, normalizeLinkedIdentities } from "./identities";

describe("OAuth linked-identity projection", () => {
  it("keeps provider=email out of the OAuth-only model", () => {
    expect(
      isOAuthProvider("email"),
      "provider=email reopened password-state inference and password removal",
    ).toBe(false);

    const identities = normalizeLinkedIdentities({
      identities: [
        {
          identity_id: "email-identity",
          provider: "email",
          email: "buddy@example.invalid",
          created_at: "2026-08-05T12:00:00.000Z",
        },
        {
          identity_id: "github-identity",
          provider: "github",
          email: "buddy@example.invalid",
          created_at: "2026-08-05T12:01:00.000Z",
        },
      ],
    });

    expect(
      identities,
      "provider=email leaked password state into the OAuth identity model",
    ).toEqual([
      {
        id: "github-identity",
        provider: "github",
        email: "buddy@example.invalid",
        createdAt: "2026-08-05T12:01:00.000Z",
      },
    ]);
  });
});
