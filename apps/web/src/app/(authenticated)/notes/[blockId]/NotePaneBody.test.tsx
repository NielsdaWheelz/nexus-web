import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchInputPath,
  jsonResponse,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import type { PanePrimaryChromePublicationUpdate } from "@/lib/panes/panePublications";
import NotePaneBody from "./NotePaneBody";

const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_REF = `note_block:${NOTE_ID}`;

function noteItem() {
  return {
    ref: NOTE_REF,
    scheme: "note_block",
    id: NOTE_ID,
    label: "Source note",
    summary: "",
    route: `/notes/${NOTE_ID}`,
    activation: {
      resource_ref: NOTE_REF,
      kind: "route",
      href: `/notes/${NOTE_ID}`,
      unresolved_reason: null,
    },
    missing: false,
    capabilities: {
      user_relation: {
        user_link_source: false,
        user_link_target: "none",
        note_reference_target: false,
      },
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
    version_by_lane: { body: 1, outgoing_edges: 1 },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("NotePaneBody", () => {
  it("loads the source body and publishes Connections only through Companion", async () => {
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    stubFetch(async (input) => {
      const path = fetchInputPath(input);
      if (path === `/api/resource-items/${encodeURIComponent(NOTE_REF)}/surface`) {
        return jsonResponse({
          data: {
            source: {
              item: noteItem(),
              content: {
                kind: "note_body",
                body_pm_json: {
                  type: "paragraph",
                  content: [{ type: "text", text: "Source note" }],
                },
                body_text: "Source note",
              },
            },
            ordered_items: [],
          },
        });
      }
      if (path === "/api/resource-graph/connections/query") {
        return jsonResponse({ data: { items: [], next_cursor: null } });
      }
      if (path.startsWith("/api/synapse/scans")) {
        return jsonResponse({ data: { status: "idle" } });
      }
      return jsonResponse({ data: [] });
    });

    const view = renderHydratedPane({
      href: `/notes/${NOTE_ID}`,
      resources: {},
      children: (
        <PanePrimaryChromeProvider publish={publish}>
          <NotePaneBody />
        </PanePrimaryChromeProvider>
      ),
    });

    expect(await screen.findByLabelText("Note content")).toHaveTextContent(
      "Source note",
    );
    expect(
      screen.getByRole("region", { name: "Ordered resources" }),
    ).toBeVisible();
    expect(screen.queryByRole("region", { name: "Connections" })).toBeNull();

    await waitFor(() => expect(view.onSetPaneSecondary).toHaveBeenCalled());
    const secondary = view.onSetPaneSecondary.mock.calls.at(-1)?.[0];
    expect(secondary).toMatchObject({
      groupId: "resource-inspector",
      defaultSurfaceId: "resource-dossier",
    });
    expect(
      secondary.surfaces.map((surface: { id: string }) => surface.id),
    ).toEqual(["resource-connections", "resource-dossier"]);

    await waitFor(() => {
      const publications = publish.mock.calls
        .map(([update]) => update.publication)
        .filter((publication) => publication !== null);
      expect(
        publications.some(
          (publication) =>
            publication?.menu?.kind === "ResourceMenu" &&
            publication.actions?.some(
              (action) => action.id === "resource-inspector-companion",
            ),
        ),
      ).toBe(true);
    });
  });
});
