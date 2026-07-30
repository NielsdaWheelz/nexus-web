import { afterEach, describe, expect, it, vi } from "vitest";
import { searchResourceTargets } from "./resourceTargets";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_REF =
  "content_chunk:22222222-2222-4222-8222-222222222222";

function resourceItem() {
  const ref = `media:${MEDIA_ID}`;
  return {
    ref,
    scheme: "media",
    id: MEDIA_ID,
    label: "The Dispossessed",
    summary: "",
    route: `/media/${MEDIA_ID}`,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/media/${MEDIA_ID}`,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: true,
        userLinkTarget: "materialize_passage",
        noteReferenceTarget: true,
      },
      sharing: "ResourceGrants",
      libraryPlacement: "ManageEntries",
      attachable: true,
      chatSubject: "label",
      readable: "body",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: false,
      adjacencyTarget: true,
    },
    versionByLane: {},
  };
}

function passageTarget(activation: unknown) {
  return {
    kind: "passage",
    candidateRef: CANDIDATE_REF,
    source: resourceItem(),
    label: "Chapter 3",
    excerpt: "the ansible hummed",
    activation,
    existingLinkId: null,
  };
}

function responseFor(target: unknown): Response {
  return Response.json({
    data: {
      targets: [target],
      nextCursor: null,
    },
  });
}

describe("resource target search wire contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes the canonical camel-case passage activation", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      responseFor(
        passageTarget({
          resourceRef: CANDIDATE_REF,
          kind: "none",
          href: null,
          unresolvedReason: null,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchResourceTargets({
        q: "ansible",
        purpose: "link",
        sourceRef: `note_block:${MEDIA_ID}`,
      }),
    ).resolves.toEqual({
      targets: [
        {
          kind: "passage",
          candidateRef: CANDIDATE_REF,
          source: resourceItem(),
          label: "Chapter 3",
          excerpt: "the ansible hummed",
          activation: {
            resourceRef: CANDIDATE_REF,
            kind: "none",
            href: null,
            unresolvedReason: null,
          },
          existingLinkId: null,
        },
      ],
      nextCursor: null,
    });

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("/api/resource-items/targets/search");
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      q: "ansible",
      purpose: "link",
      source_ref: `note_block:${MEDIA_ID}`,
    });
  });

  it("rejects the superseded snake-case passage activation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFor(
          passageTarget({
            resource_ref: CANDIDATE_REF,
            kind: "none",
            href: null,
            unresolved_reason: null,
          }),
        ),
      ),
    );

    await expect(
      searchResourceTargets({ q: "ansible", purpose: "link" }),
    ).rejects.toThrow(/resource activation must contain exactly/);
  });

  it("rejects the superseded snake-case target envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            targets: [
              {
                kind: "resource",
                item: resourceItem(),
                existing_link_id: null,
              },
            ],
            next_cursor: null,
          },
        }),
      ),
    );

    await expect(
      searchResourceTargets({ q: "ansible", purpose: "link" }),
    ).rejects.toThrow(
      /resource target search response\.data must contain exactly/,
    );
  });

  it("rejects an activation whose identity differs from the candidate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFor(
          passageTarget({
            resourceRef: `content_chunk:${MEDIA_ID}`,
            kind: "none",
            href: null,
            unresolvedReason: null,
          }),
        ),
      ),
    );

    await expect(
      searchResourceTargets({ q: "ansible", purpose: "link" }),
    ).rejects.toThrow(/resource activation\.resourceRef must match/);
  });
});
