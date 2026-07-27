import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandResourceSurface,
  fetchResourceSurface,
  updateResourceSurfaceNoteBody,
} from "./api";

const PAGE_REF = "page:11111111-1111-4111-8111-111111111111";
const NOTE_REF = "note_block:22222222-2222-4222-8222-222222222222";

function item(ref: string, scheme: string, id: string) {
  return {
    ref,
    scheme,
    id,
    label: "",
    summary: "",
    route: null,
    activation: { resource_ref: ref, kind: "none", href: null, unresolved_reason: null },
    missing: false,
    capabilities: {
      user_relation: { user_link_source: false, user_link_target: "none", note_reference_target: false },
      sharing: "None",
      library_placement: "None",
      attachable: false,
      chat_subject: "none",
      readable: "none",
      inspectable: "none",
      citable_result_type: null,
      citation_output_source: false,
      app_search_scope: false,
      conversation_search_scope: false,
      prompt_render: "none",
      expansion_policy: "none",
      expandable: false,
      adjacency_source: true,
      adjacency_target: true,
    },
    version_by_lane: { title: 3, body: 4, outgoing_edges: 5 },
  };
}

function surface() {
  return {
    source: { item: item(PAGE_REF, "page", PAGE_REF.slice(5)), content: { kind: "page_title", title: "Today" } },
    ordered_items: [{
      occurrence_id: "edge-1",
      target: {
        item: item(NOTE_REF, "note_block", NOTE_REF.slice(11)),
        content: {
          kind: "note_body",
          body_pm_json: {
            type: "paragraph",
            content: [{ type: "text", text: "A note" }],
          },
          body_text: "A note",
        },
      },
    }],
  };
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("resource surface API", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("decodes the sole surface query from canonical snake_case", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(surface()));
    const result = await fetchResourceSurface(PAGE_REF);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.source.content).toEqual({ kind: "page_title", title: "Today" });
    expect(result.orderedItems[0]).toMatchObject({ occurrenceId: "edge-1", target: { content: { kind: "note_body", bodyText: "A note" } } });
  });

  it("sends one atomic structural command with snake_case fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ client_mutation_id: "m-1", surface: surface() }));
    await commandResourceSurface({
      sourceRef: PAGE_REF,
      clientMutationId: "m-1",
      baseVersions: [{ ref: PAGE_REF, lane: "outgoing_edges", version: 5 }],
      command: { type: "move_occurrence", occurrenceId: "edge-1", position: { kind: "start" } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/resource-items/${encodeURIComponent(PAGE_REF)}/surface/commands`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_mutation_id: "m-1",
          base_versions: [{ ref: PAGE_REF, lane: "outgoing_edges", version: 5 }],
          command: { type: "move_occurrence", occurrence_id: "edge-1", position: { kind: "start" } },
        }),
      }),
    );
  });

  it("decodes the existing intrinsic body mutation contract without aliases", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        item: item(NOTE_REF, "note_block", NOTE_REF.slice(11)),
        bodyPmJson: {
          type: "paragraph",
          content: [{ type: "text", text: "Saved" }],
        },
        bodyText: "Saved",
      }),
    );

    const result = await updateResourceSurfaceNoteBody({
      noteRef: NOTE_REF,
      clientMutationId: "m-body",
      baseVersion: 4,
      bodyPmJson: {
        type: "paragraph",
        content: [{ type: "text", text: "Saved" }],
      },
    });

    expect(result.bodyText).toBe("Saved");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/resource-items/${encodeURIComponent(NOTE_REF)}/body`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          client_mutation_id: "m-body",
          base_versions: [{ ref: NOTE_REF, lane: "body", version: 4 }],
          body_pm_json: {
            type: "paragraph",
            content: [{ type: "text", text: "Saved" }],
          },
        }),
      }),
    );
  });
});
