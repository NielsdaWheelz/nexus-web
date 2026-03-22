import { describe, expect, it } from "vitest";
import {
  getConnectableProviders,
  mayUnlinkIdentity,
  normalizeLinkedIdentities,
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
