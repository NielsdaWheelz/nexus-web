import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchInputPath,
  jsonResponse,
  stubFetch,
  wasFetchPathCalled,
} from "@/__tests__/helpers/fetch";
import { ResolvedPaneBodyMarker } from "@/lib/panes/paneRenderRegistry";
import NotePaneBody from "./NotePaneBody";

describe("NotePaneBody resource identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the note body directly without resolving a parent page", async () => {
    const blockId = "55555555-5555-4555-8555-555555555555";
    const fetchSpy = stubFetch(async (input) => {
      const path = fetchInputPath(input);
      if (path === `/api/notes/blocks/${blockId}`) {
        return jsonResponse({
          data: {
            id: blockId,
            bodyPmJson: {
              type: "paragraph",
              content: [{ type: "text", text: "Standalone note" }],
            },
            bodyText: "Standalone note",
            collapsed: false,
            children: [],
            versionByLane: { body: 3, outgoing_edges: 1 },
          },
        });
      }
      return new Promise<Response>(() => {});
    });

    renderHydratedPane({
      href: `/notes/${blockId}`,
      resources: {},
      children: (
        <ResolvedPaneBodyMarker>
          <NotePaneBody />
        </ResolvedPaneBodyMarker>
      ),
    });

    await waitFor(() => {
      expect(wasFetchPathCalled(fetchSpy, `/api/notes/blocks/${blockId}`)).toBe(true);
    });
    const editor = await screen.findByRole("textbox", { name: "Note body" });
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: pane-return scope is a DOM data contract with no semantic query
    const returnScope = editor.closest<HTMLElement>(
      "[data-pane-return-scope]",
    );
    expect(returnScope).toHaveAttribute(
      "data-pane-return-scope",
      "Notes.EditorBlocks",
    );
    expect(screen.getByRole("listitem")).toHaveAttribute(
      "data-note-block-id",
      blockId,
    );
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the route editor shell has no semantic role; its overflow ownership is the contract under test
    const routeEditorShell = returnScope?.parentElement;
    expect(["auto", "scroll"]).not.toContain(
      getComputedStyle(routeEditorShell as HTMLElement).overflowY,
    );
    expect(fetchSpy.mock.calls.some(([input]) => fetchInputPath(input).startsWith("/api/notes/pages/"))).toBe(false);
  });
});

describe("NotePaneBody Resource Inspector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves Connections out of the primary body and into Companion", async () => {
    const blockId = "66666666-6666-4666-8666-666666666666";
    // Only the network boundary is mocked: the note body loads, and the
    // connections apparatus answers its resource-graph + synapse probes empty.
    stubFetch(async (input) => {
      const path = fetchInputPath(input);
      if (path === `/api/notes/blocks/${blockId}`) {
        return jsonResponse({
          data: {
            id: blockId,
            bodyPmJson: {
              type: "paragraph",
              content: [{ type: "text", text: "Footnoted note" }],
            },
            bodyText: "Footnoted note",
            collapsed: false,
            children: [],
            versionByLane: { body: 1, outgoing_edges: 1 },
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
      href: `/notes/${blockId}`,
      resources: {},
      children: <NotePaneBody />,
    });

    await screen.findByRole("textbox", { name: "Note body" });
    expect(screen.queryByRole("region", { name: "Connections" })).toBeNull();
    await waitFor(() => {
      expect(view.onSetPaneSecondary).toHaveBeenCalled();
    });
    const latestPublication = view.onSetPaneSecondary.mock.calls.at(-1)?.[0];
    expect(latestPublication).toMatchObject({
      groupId: "resource-inspector",
      defaultSurfaceId: "resource-dossier",
    });
    expect(
      latestPublication.surfaces.map((surface: { id: string }) => surface.id),
    ).toEqual(["resource-connections", "resource-dossier"]);
  });
});
