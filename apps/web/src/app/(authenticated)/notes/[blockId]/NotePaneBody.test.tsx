import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchInputPath,
  jsonResponse,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import type { PanePrimaryChromePublicationUpdate } from "@/lib/panes/panePublications";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import NotePaneBody from "./NotePaneBody";

const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_REF = `note_block:${NOTE_ID}`;

function noteItem(noteId = NOTE_ID) {
  const noteRef = `note_block:${noteId}`;
  return {
    ref: noteRef,
    scheme: "note_block",
    id: noteId,
    label: "Source note",
    summary: "",
    route: `/notes/${noteId}`,
    activation: {
      resourceRef: noteRef,
      kind: "route",
      href: `/notes/${noteId}`,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: false,
        userLinkTarget: "none",
        noteReferenceTarget: false,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chatSubject: "none",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: { body: 1, outgoing_edges: 1 },
  };
}

function App({
  publish,
  noteId = NOTE_ID,
}: {
  publish: (update: PanePrimaryChromePublicationUpdate) => void;
  noteId?: string;
}) {
  return (
    <PaneReturnMementoProvider>
      <PaneReturnVisitScope visitId={"visit" as never} routeKey="note">
        <PaneRuntimeProvider
          paneId="pane"
          visitId={"visit" as never}
          isActive
          href={`/notes/${noteId}`}
          routeId="note"
          pathParams={{ blockId: noteId }}
          canGoBack={false}
          canGoForward={false}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onActivateWorkspaceTarget={vi.fn(() => ({
            kind: "ActivatedExisting" as const,
            paneId: "pane",
          }))}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
        >
          <PanePrimaryChromeProvider publish={publish}>
            <NotePaneBody />
          </PanePrimaryChromeProvider>
        </PaneRuntimeProvider>
      </PaneReturnVisitScope>
    </PaneReturnMementoProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("NotePaneBody", () => {
  it("does not restore stale filter rows after an A to B to A source replacement", async () => {
    const noteBId = "33333333-3333-4333-8333-333333333333";
    let noteAReads = 0;
    let resolveSecondNoteA!: (response: Response) => void;
    let resolveNoteB!: (response: Response) => void;
    stubFetch(async (input) => {
      const path = decodeURIComponent(fetchInputPath(input));
      if (path.includes(`note_block:${noteBId}`)) {
        return await new Promise<Response>((resolve) => {
          resolveNoteB = resolve;
        });
      }
      if (path.includes(NOTE_REF)) {
        noteAReads += 1;
        if (noteAReads === 1) {
          return jsonResponse({
            data: {
              source: {
                item: noteItem(),
                content: {
                  kind: "note_body",
                  body_pm_json: { type: "paragraph" },
                  body_text: "Note A",
                },
              },
              ordered_items: [],
            },
          });
        }
        return await new Promise<Response>((resolve) => {
          resolveSecondNoteA = resolve;
        });
      }
      return jsonResponse({ data: [] });
    });
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    const view = render(<App publish={publish} />);
    const latestSearch = () =>
      publish.mock.calls
        .map(([update]) => update.publication?.search)
        .findLast((search) => search?.kind === "FilterRows");

    await waitFor(() =>
      expect(latestSearch()?.rowStatus.kind).toBe("Complete"),
    );
    view.rerender(<App publish={publish} noteId={noteBId} />);
    await waitFor(() => {
      const search = latestSearch();
      expect(search?.rowStatus).toMatchObject({
        kind: "Partial",
        visibleCount: 0,
        loadedCount: 0,
      });
    });

    const publicationsBeforeReturn = publish.mock.calls.length;
    view.rerender(<App publish={publish} />);
    await waitFor(() => {
      expect(publish.mock.calls.length).toBeGreaterThan(
        publicationsBeforeReturn,
      );
      const search = latestSearch();
      expect(search?.query).toBe("");
      expect(search?.rowStatus).toMatchObject({
        kind: "Partial",
        visibleCount: 0,
        loadedCount: 0,
      });
    });

    await act(async () => {
      resolveSecondNoteA(
        jsonResponse({
          data: {
            source: {
              item: noteItem(),
              content: {
                kind: "note_body",
                body_pm_json: { type: "paragraph" },
                body_text: "Note A refreshed",
              },
            },
            ordered_items: [],
          },
        }),
      );
    });
    await waitFor(() =>
      expect(latestSearch()?.rowStatus.kind).toBe("Complete"),
    );
    await act(async () => {
      resolveNoteB(
        jsonResponse({
          data: {
            source: {
              item: noteItem(noteBId),
              content: {
                kind: "note_body",
                body_pm_json: { type: "paragraph" },
                body_text: "Stale Note B",
              },
            },
            ordered_items: [],
          },
        }),
      );
    });
    expect(screen.queryByText("Stale Note B")).not.toBeInTheDocument();
  });

  it("announces a Partial no-match before the surface commits", async () => {
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    let resolveSurface!: (response: Response) => void;
    stubFetch(async (input) => {
      const path = fetchInputPath(input);
      if (
        path === `/api/resource-items/${encodeURIComponent(NOTE_REF)}/surface`
      ) {
        return await new Promise<Response>((resolve) => {
          resolveSurface = resolve;
        });
      }
      return jsonResponse({ data: [] });
    });
    renderHydratedPane({
      href: `/notes/${NOTE_ID}`,
      resources: {},
      children: (
        <PanePrimaryChromeProvider publish={publish}>
          <NotePaneBody />
        </PanePrimaryChromeProvider>
      ),
    });
    await waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.search)
          .findLast((search) => search?.kind === "FilterRows"),
      ).toBeDefined(),
    );
    const search = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((candidate) => candidate?.kind === "FilterRows");
    if (search?.kind !== "FilterRows") {
      throw new Error("Expected NotePaneBody to publish FilterRows.");
    }
    act(() => search.onQueryChange("missing"));
    expect(
      await screen.findByText("No matching item found so far."),
    ).toHaveAttribute("role", "status");
    await act(async () => {
      resolveSurface(
        jsonResponse({
          data: {
            source: {
              item: noteItem(),
              content: {
                kind: "note_body",
                body_pm_json: { type: "paragraph" },
                body_text: "Source note",
              },
            },
            ordered_items: [],
          },
        }),
      );
    });
    await screen.findByLabelText("Note content");
  });

  it("loads the source body and publishes Connections only through Companion", async () => {
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    stubFetch(async (input) => {
      const path = fetchInputPath(input);
      if (
        path === `/api/resource-items/${encodeURIComponent(NOTE_REF)}/surface`
      ) {
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

    const noteSearch = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((search) => search !== undefined);
    if (noteSearch?.kind !== "FilterRows") {
      throw new Error("Expected NotePaneBody to publish FilterRows.");
    }
    expect(noteSearch).toMatchObject({
      kind: "FilterRows",
      query: "",
      inputLabel: "Filter note items",
      placeholder: "Filter items",
    });
    expect(noteSearch).not.toHaveProperty("matchCase");
    expect(noteSearch).not.toHaveProperty("wholeWord");
    expect(noteSearch).not.toHaveProperty("onStep");
    expect(noteSearch).not.toHaveProperty("onShowResults");

    act(() => noteSearch?.onQueryChange("missing"));
    expect(
      await screen.findByText("No items match this filter."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Filtered view is inspection only — clear Filter to edit.",
      ),
    ).toHaveAttribute("role", "status");
    expect(screen.getByLabelText("Note content")).toHaveAttribute(
      "contenteditable",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Add a note" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add item" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.search)
          .findLast((search) => search?.query === "missing"),
      ).toBeDefined(),
    );
      const updatedSearch = publish.mock.calls
        .map(([update]) => update.publication?.search)
      .findLast((search) => search?.query === "missing");
    if (updatedSearch?.kind !== "FilterRows") {
      throw new Error("Expected NotePaneBody to retain FilterRows.");
    }
    expect(updatedSearch.rowStatus).toMatchObject({
      kind: "Complete",
      visibleCount: 0,
      unit: { singular: "item", plural: "items" },
    });
    expect(updatedSearch.rowStatus).toHaveProperty(
      "totalCount",
      noteSearch.rowStatus.kind === "Complete"
        ? noteSearch.rowStatus.totalCount
        : undefined,
    );
  });
});
