import { describe, expect, it } from "vitest";

import {
  decideCreatedLibraryPlacement,
  decodeLibraryPlacements,
} from "@/lib/libraries/libraryPlacement";

const DIRECT_LIBRARY_ID = "11111111-1111-4111-8111-111111111111";
const INHERITED_LIBRARY_ID = "22222222-2222-4222-8222-222222222222";
const PROVENANCE_LIBRARY_ID = "33333333-3333-4333-8333-333333333333";

function identity(id: string, name: string, color: string | null = null) {
  return { id, name, color };
}

function canonicalEnvelope(): unknown {
  return {
    data: [
      {
        destination: { kind: "SavedInNexus" },
        relation: { kind: "Direct" },
        availability: { kind: "Available" },
      },
      {
        destination: {
          kind: "Library",
          library: identity(DIRECT_LIBRARY_ID, "Research", "#5566aa"),
        },
        relation: { kind: "Direct" },
        availability: { kind: "Available" },
      },
      {
        destination: {
          kind: "Library",
          library: identity(INHERITED_LIBRARY_ID, "System Inbox"),
        },
        relation: {
          kind: "Inherited",
          provenance: [
            identity(PROVENANCE_LIBRARY_ID, "Following Acme", "#abcdef"),
          ],
        },
        availability: { kind: "Blocked", reason: "Inherited" },
      },
    ],
  };
}

describe("decodeLibraryPlacements", () => {
  it("strictly decodes destinations, relation provenance, and availability", () => {
    expect(decodeLibraryPlacements(canonicalEnvelope())).toEqual([
      {
        destination: { kind: "SavedInNexus" },
        relation: { kind: "Direct" },
        availability: { kind: "Available" },
      },
      {
        destination: {
          kind: "Library",
          library: identity(DIRECT_LIBRARY_ID, "Research", "#5566aa"),
        },
        relation: { kind: "Direct" },
        availability: { kind: "Available" },
      },
      {
        destination: {
          kind: "Library",
          library: identity(INHERITED_LIBRARY_ID, "System Inbox"),
        },
        relation: {
          kind: "Inherited",
          provenance: [
            identity(PROVENANCE_LIBRARY_ID, "Following Acme", "#abcdef"),
          ],
        },
        availability: { kind: "Blocked", reason: "Inherited" },
      },
    ]);
  });

  it("rejects unknown placement shapes and every extra key", () => {
    expect(() =>
      decodeLibraryPlacements({
        data: [
          {
            destination: { kind: "Unknown" },
            relation: { kind: "Absent" },
            availability: { kind: "Available" },
          },
        ],
      }),
    ).toThrow();

    const envelope = canonicalEnvelope() as { data: Record<string, unknown>[] };
    envelope.data[0]!.legacy = true;
    expect(() => decodeLibraryPlacements(envelope)).toThrow();
  });

  it("rejects duplicate destinations and malformed inherited provenance", () => {
    const duplicateSaved = canonicalEnvelope() as { data: unknown[] };
    duplicateSaved.data.push({
      destination: { kind: "SavedInNexus" },
      relation: { kind: "Direct" },
      availability: { kind: "Available" },
    });
    expect(() => decodeLibraryPlacements(duplicateSaved)).toThrow();

    const emptyProvenance = canonicalEnvelope() as {
      data: Array<{
        relation: { kind: string; provenance?: unknown[] };
      }>;
    };
    emptyProvenance.data[2]!.relation.provenance = [];
    expect(() => decodeLibraryPlacements(emptyProvenance)).toThrow();
  });

  it("rejects an inherited or blocked SavedInNexus destination", () => {
    expect(() =>
      decodeLibraryPlacements({
        data: [
          {
            destination: { kind: "SavedInNexus" },
            relation: { kind: "Direct" },
            availability: { kind: "Blocked", reason: "SystemManaged" },
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    "RequiresAdmin",
    "RequiresSubscription",
    "SystemManaged",
    "Inherited",
  ] as const)("accepts the closed blocked reason %s", (reason) => {
    expect(
      decodeLibraryPlacements({
        data: [
          {
            destination: {
              kind: "Library",
              library: identity(DIRECT_LIBRARY_ID, "Visible"),
            },
            relation:
              reason === "Inherited"
                ? {
                    kind: "Inherited",
                    provenance: [
                      identity(PROVENANCE_LIBRARY_ID, "Source"),
                    ],
                  }
                : { kind: "Absent" },
            availability: { kind: "Blocked", reason },
          },
        ],
      }),
    ).toHaveLength(1);
  });

  it("does not let Create-and-add bypass Podcast RequiresSubscription", () => {
    const destination = {
      kind: "Library" as const,
      library: identity(DIRECT_LIBRARY_ID, "Created while unsubscribed"),
    };
    expect(
      decideCreatedLibraryPlacement({
        placements: [
          {
            destination,
            relation: { kind: "Absent" },
            availability: {
              kind: "Blocked",
              reason: "RequiresSubscription",
            },
          },
        ],
        libraryId: DIRECT_LIBRARY_ID,
      }),
    ).toEqual({ kind: "DoNotAdd" });
  });
});
