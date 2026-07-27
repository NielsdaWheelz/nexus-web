import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchOpenableResources } from "./openableResources";

const ID = "11111111-1111-4111-8111-111111111111";
const REF = `page:${ID}`;
const ROUTE = `/pages/${ID}`;

function resourceItem() {
  return {
    ref: REF,
    scheme: "page",
    id: ID,
    label: "Project",
    summary: "",
    route: ROUTE,
    activation: {
      resourceRef: REF,
      kind: "route",
      href: ROUTE,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: true,
        userLinkTarget: "direct",
        noteReferenceTarget: true,
      },
      sharing: "ResourceGrants",
      libraryPlacement: "None",
      attachable: true,
      chatSubject: "readable",
      readable: "body",
      inspectable: "none",
      citableResultType: "note_block",
      citationOutputSource: false,
      appSearchScope: true,
      conversationSearchScope: true,
      promptRender: "inline_body",
      expansionPolicy: "page_note_blocks",
      expandable: true,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: { title: 1, outgoing_edges: 1 },
  };
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("searchOpenableResources", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends the strict Presence filter and decodes canonical ResourceItems", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ items: [resourceItem()] }));
    const result = await searchOpenableResources({
      q: "p",
      schemes: { kind: "Present", value: ["page"] },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ ref: REF, route: ROUTE });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/resource-items/openables/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          q: "p",
          schemes: { kind: "Present", value: ["page"] },
        }),
      }),
    );
  });

  it("sends owned absence instead of omitting or nulling schemes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ items: [] }));
    await searchOpenableResources({
      q: "all",
      schemes: { kind: "Absent" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/resource-items/openables/search",
      expect.objectContaining({
        body: JSON.stringify({ q: "all", schemes: { kind: "Absent" } }),
      }),
    );
  });

  it("rejects response and nested ResourceItem casing drift", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response({ items: [], extra: true }),
    );
    await expect(
      searchOpenableResources({ q: "p", schemes: { kind: "Absent" } }),
    ).rejects.toThrow();

    const item = resourceItem();
    const { versionByLane: _removed, ...alternate } = item;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response({ items: [{ ...alternate, version_by_lane: {} }] }),
    );
    await expect(
      searchOpenableResources({ q: "p", schemes: { kind: "Absent" } }),
    ).rejects.toThrow();
  });
});
