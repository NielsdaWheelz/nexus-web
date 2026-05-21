import { describe, expect, it } from "vitest";
import {
  getConnectableProviders,
  mayRemovePassword,
  mayUnlinkIdentity,
  normalizeLinkedIdentities,
  type LinkedIdentity,
} from "./identities";

describe("auth identity helpers", () => {
  it("normalizes identity payloads from Supabase", () => {
    const identities = normalizeLinkedIdentities({
      identities: [
        {
          identity_id: "github-id",
          provider: "github",
          created_at: "2026-03-21T00:00:00Z",
          identity_data: { email: "owner+github@example.com" },
        },
        {
          identity_id: "google-id",
          provider: "google",
          created_at: "2026-03-22T00:00:00Z",
          identity_data: { email: "owner+google@example.com" },
        },
      ],
    });

    expect(identities).toEqual([
      {
        id: "github-id",
        provider: "github",
        email: "owner+github@example.com",
        createdAt: "2026-03-21T00:00:00Z",
      },
      {
        id: "google-id",
        provider: "google",
        email: "owner+google@example.com",
        createdAt: "2026-03-22T00:00:00Z",
      },
    ]);
  });

  it("returns remaining OAuth providers available to link", () => {
    expect(
      getConnectableProviders([
        {
          id: "github-id",
          provider: "github",
          email: "owner+github@example.com",
          createdAt: "2026-03-21T00:00:00Z",
        },
      ])
    ).toEqual(["google"]);

    expect(
      getConnectableProviders([
        {
          id: "github-id",
          provider: "github",
          email: "owner+github@example.com",
          createdAt: "2026-03-21T00:00:00Z",
        },
        {
          id: "google-id",
          provider: "google",
          email: "owner+google@example.com",
          createdAt: "2026-03-22T00:00:00Z",
        },
      ])
    ).toEqual([]);
  });

  it("only allows unlink when another identity remains", () => {
    const identities = [
      {
        id: "github-id",
        provider: "github",
        email: "owner+github@example.com",
        createdAt: "2026-03-21T00:00:00Z",
      },
      {
        id: "google-id",
        provider: "google",
        email: "owner+google@example.com",
        createdAt: "2026-03-22T00:00:00Z",
      },
    ] as const;

    expect(mayUnlinkIdentity(identities, "github-id")).toBe(true);
    expect(mayUnlinkIdentity(identities.slice(0, 1), "github-id")).toBe(
      false
    );
    expect(mayUnlinkIdentity(identities, "missing-id")).toBe(false);
  });
});

describe("mayRemovePassword truth table", () => {
  const emailIdentity: LinkedIdentity = {
    id: "email-id",
    provider: "email",
    email: "owner@example.com",
    createdAt: "2026-04-01T00:00:00Z",
  };
  const googleIdentity: LinkedIdentity = {
    id: "google-id",
    provider: "google",
    email: "owner+google@example.com",
    createdAt: "2026-04-02T00:00:00Z",
  };
  const githubIdentity: LinkedIdentity = {
    id: "github-id",
    provider: "github",
    email: "owner+github@example.com",
    createdAt: "2026-04-03T00:00:00Z",
  };

  it("returns false for an empty identity list", () => {
    expect(mayRemovePassword([])).toBe(false);
  });

  it("returns false when only google is linked", () => {
    expect(mayRemovePassword([googleIdentity])).toBe(false);
  });

  it("returns false when only email is linked", () => {
    expect(mayRemovePassword([emailIdentity])).toBe(false);
  });

  it("returns true when email and google are linked", () => {
    expect(mayRemovePassword([emailIdentity, googleIdentity])).toBe(true);
  });

  it("returns true when email, google, and github are all linked", () => {
    expect(
      mayRemovePassword([emailIdentity, googleIdentity, githubIdentity])
    ).toBe(true);
  });
});

describe("mayUnlinkIdentity truth table", () => {
  const emailIdentity: LinkedIdentity = {
    id: "email-id",
    provider: "email",
    email: "owner@example.com",
    createdAt: "2026-04-01T00:00:00Z",
  };
  const googleIdentity: LinkedIdentity = {
    id: "google-id",
    provider: "google",
    email: "owner+google@example.com",
    createdAt: "2026-04-02T00:00:00Z",
  };
  const githubIdentity: LinkedIdentity = {
    id: "github-id",
    provider: "github",
    email: "owner+github@example.com",
    createdAt: "2026-04-03T00:00:00Z",
  };

  it("returns false when the identity id is not in the list", () => {
    expect(
      mayUnlinkIdentity([emailIdentity, googleIdentity], "missing-id")
    ).toBe(false);
  });

  it("returns false when the list has fewer than two identities", () => {
    expect(mayUnlinkIdentity([emailIdentity], "email-id")).toBe(false);
  });

  it("returns true for the email identity when length >= 2", () => {
    expect(
      mayUnlinkIdentity([emailIdentity, googleIdentity], "email-id")
    ).toBe(true);
  });

  it("returns true for the google identity when length >= 2", () => {
    expect(
      mayUnlinkIdentity([emailIdentity, googleIdentity], "google-id")
    ).toBe(true);
  });

  it("returns true for the github identity when length >= 2", () => {
    expect(
      mayUnlinkIdentity(
        [emailIdentity, googleIdentity, githubIdentity],
        "github-id"
      )
    ).toBe(true);
  });
});
