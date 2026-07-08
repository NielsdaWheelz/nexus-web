import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  setPendingNoteFocus,
  consumePendingNoteFocus,
} from "@/lib/notes/pendingNoteFocus";
import { dispatchNotePulse, type NotePulseTarget } from "@/lib/reader/pulseEvent";
import type { NotePage } from "@/lib/notes/api";
import {
  noteBlocksToOutlineDoc,
  outlineSchema,
  paragraphFromText,
} from "@/lib/notes/prosemirror/schema";
import {
  deletedRootBlockIdsForPersistence,
  pageDraftMetadataFromStorage,
  readDraftBlocksForPersistence,
} from "@/lib/notes/resourceSurfacePersistence";
import type { StoredNoteEditorDraft } from "@/lib/notes/useNoteEditorSession";
import {
  PaneChromeOverrideContext,
  type PaneChromeOverrides,
} from "@/components/workspace/PaneShell";
import PagePaneBody from "./PagePaneBody";

describe("readDraftBlocksForPersistence", () => {
  it("keeps focused nested note siblings under the focused block's original parent", () => {
    const drafts = readDraftBlocksForPersistence(
      outlineDoc([
        {
          id: "focused-block",
          text: "focused",
          children: [{ id: "child-block", text: "child", children: [] }],
        },
        { id: "new-sibling", text: "new sibling", children: [] },
      ]),
      "original-parent",
    );

    expect(drafts.map((draft) => [draft.id, draft.parentBlockId])).toEqual([
      ["focused-block", "original-parent"],
      ["child-block", "focused-block"],
      ["new-sibling", "original-parent"],
    ]);
    expect(drafts.find((draft) => draft.id === "new-sibling")).toMatchObject({
      sourceOrderKey: "0000000002",
    });
  });

  it("emits one source order key per sibling", () => {
    const drafts = readDraftBlocksForPersistence(
      outlineDoc([
        { id: "block-1", text: "one", children: [] },
        { id: "block-2", text: "two", children: [] },
        { id: "block-3", text: "three", children: [] },
      ]),
    );

    expect(drafts.map((draft) => draft.sourceOrderKey)).toEqual([
      "0000000001",
      "0000000002",
      "0000000003",
    ]);
  });

  it("loads and persists code-block note bodies without converting them to paragraphs", () => {
    const doc = noteBlocksToOutlineDoc([
      {
        id: "code-note",
        parentBlockId: null,
        orderKey: "0000000001",
        bodyPmJson: {
          type: "code_block",
          content: [{ type: "text", text: "const answer = 42;" }],
        },
        bodyText: "const answer = 42;",
        collapsed: false,
        children: [],
      },
    ]);

    const [draft] = readDraftBlocksForPersistence(doc);

    expect(draft).toMatchObject({
      id: "code-note",
      bodyPmJson: {
        type: "code_block",
        content: [{ type: "text", text: "const answer = 42;" }],
      },
    });
  });

  it("ignores editor-only block kinds during persistence", () => {
    const doc = outlineSchema.nodes.outline_doc!.create(null, [
      outlineSchema.nodes.outline_block!.create(
        { id: "block-1", kind: "not-a-note-kind", collapsed: false },
        [paragraphFromText("one")],
      ),
    ]);

    expect(readDraftBlocksForPersistence(doc)[0]?.id).toBe("block-1");
  });

  it("deletes only removed roots when removed descendants are cascaded by the backend", () => {
    expect(
      deletedRootBlockIdsForPersistence(
        new Set(["parent", "child", "kept"]),
        new Set(["kept"]),
        new Map([
          ["parent", null],
          ["child", "parent"],
          ["kept", null],
        ]),
      ),
    ).toEqual(["parent"]);
  });
});

describe("pageDraftMetadataFromStorage", () => {
  it("accepts exact current draft metadata", () => {
    expect(pageDraftMetadataFromStorage(currentDraftMetadata())).toEqual(
      currentDraftMetadata(),
    );
  });

  it("rejects legacy revision metadata", () => {
    expect(
      pageDraftMetadataFromStorage({
        ...currentDraftMetadata(),
        pageRevision: 3,
      }),
    ).toBeNull();
    expect(
      pageDraftMetadataFromStorage({
        ...currentDraftMetadata(),
        blockRevisions: { "block-1": 2 },
      }),
    ).toBeNull();
  });

  it("rejects legacy revision fields on draft blocks", () => {
    const metadata = currentDraftMetadata();
    expect(
      pageDraftMetadataFromStorage({
        ...metadata,
        knownBlocks: [{ ...metadata.knownBlocks[0], revision: 2 }],
      }),
    ).toBeNull();
  });
});

describe("PagePaneBody note activation", () => {
  const PAGE_ID = "11111111-1111-4111-8111-111111111111";
  const BLOCK_ID = "22222222-2222-4222-8222-222222222222";

  let scrollIntoViewSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // A genuine same-pane pulse listens on a window event; ensure no persisted
    // draft leaks across tests.
    consumePendingNoteFocus(PAGE_ID);
    window.localStorage.clear();

    scrollIntoViewSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    // Only the network boundary is mocked: the page loads from `initialPage`,
    // and note connections are published to secondary chrome instead of
    // mounting in the writing surface.
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ data: [] }));
  });

  afterEach(() => {
    scrollIntoViewSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it("scrolls to and pulses a cited note already visible on the page", async () => {
    renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));
    await screen.findByRole("listitem");

    dispatchNotePulse(noteActivation(BLOCK_ID));

    await waitFor(() => {
      expect(citedBlock()).toHaveClass("nexus-note-pulse");
    });
    await waitFor(() => {
      expect(citedRange()).toHaveTextContent("Cited");
    });
    expect(citedBlock()).toHaveAttribute("data-note-block-id", BLOCK_ID);
    expect(citedBlock()).toContainElement(citedRange());
    // The pulse also scrolls the cited block into view. Match by note-block id
    // rather than node identity: ProseMirror may reconcile the `li` instance
    // after the scroll, but every scrolled target is the cited block.
    expect(scrolledNoteBlockIds(scrollIntoViewSpy)).toContain(BLOCK_ID);
  });

  it("recovers a stored page draft visibly and saves it only when requested", async () => {
    const draftDoc = outlineDoc([
      { id: BLOCK_ID, text: "Recovered page body", children: [] },
    ]);
    storeNoteDraft(`page:${PAGE_ID}`, {
      doc: draftDoc.toJSON(),
      metadata: {
        knownBlocks: readDraftBlocksForPersistence(draftDoc),
        focusedRootParentBlockId: null,
        titleDraft: "Recovered page title",
      },
      sequence: 8,
      clientMutationId: "page-recovered-cmid",
    });
    const mutationCalls: Array<{
      path: string;
      method: string;
      body: Record<string, unknown>;
    }> = [];
    fetchSpy.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (
          url.pathname.startsWith("/api/resource-items/") &&
          (init?.method === "PATCH" || init?.method === "PUT")
        ) {
          const body = parseJsonBody(init);
          mutationCalls.push({ path: url.pathname, method: init.method, body });
          if (url.pathname.endsWith("/body")) {
            return jsonResponse({
              data: {
                bodyPmJson: paragraphFromText("Recovered page body").toJSON(),
                bodyText: "Recovered page body",
                versions: {},
              },
            });
          }
          if (url.pathname.endsWith("/adjacency")) {
            return jsonResponse({ data: { changedEdgeIds: [] } });
          }
          return jsonResponse({ data: {} });
        }
        if (url.pathname === `/api/notes/pages/${PAGE_ID}`) {
          return jsonResponse({
            data: {
              ...activationPage(PAGE_ID, BLOCK_ID),
              title: "Recovered page title",
              blocks: [
                {
                  ...activationPage(PAGE_ID, BLOCK_ID).blocks[0],
                  body_pm_json: paragraphFromText("Recovered page body").toJSON(),
                  body_text: "Recovered page body",
                },
              ],
            },
          });
        }
        return jsonResponse({ data: [] });
      },
    );

    renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));

    const editor = await screen.findByRole("textbox", {
      name: "Notes outline",
    });
    expect(editor).toHaveTextContent("Recovered page body");
    expect(screen.getByRole("textbox", { name: "Page title" })).toHaveValue(
      "Recovered page title",
    );
    expect(
      await screen.findByText("Recovered unsaved changes"),
    ).toBeInTheDocument();
    expect(mutationCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutationCalls.length).toBeGreaterThanOrEqual(3);
    });
    expect(mutationCalls.map((call) => call.path)).toEqual(
      expect.arrayContaining([
        `/api/resource-items/${encodeURIComponent(`page:${PAGE_ID}`)}/title`,
        `/api/resource-items/${encodeURIComponent(`note_block:${BLOCK_ID}`)}/body`,
        `/api/resource-items/${encodeURIComponent(`page:${PAGE_ID}`)}/adjacency`,
      ]),
    );
    expect(mutationCalls[0]?.body).toMatchObject({
      client_mutation_id: "page-recovered-cmid",
    });
  });

  it("saves title edits through the resource surface autosave path", async () => {
    const mutationCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const legacyPagePatches: string[] = [];
    fetchSpy.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (
          url.pathname === `/api/notes/pages/${PAGE_ID}` &&
          init?.method === "PATCH"
        ) {
          legacyPagePatches.push(url.pathname);
          return jsonResponse({ data: activationPage(PAGE_ID, BLOCK_ID) });
        }
        if (
          url.pathname.startsWith("/api/resource-items/") &&
          (init?.method === "PATCH" || init?.method === "PUT")
        ) {
          const body = parseJsonBody(init);
          mutationCalls.push({ path: url.pathname, body });
          if (url.pathname.endsWith("/body")) {
            return jsonResponse({
              data: {
                bodyPmJson: paragraphFromText("Cited snippet body").toJSON(),
                bodyText: "Cited snippet body",
                versions: {},
              },
            });
          }
          if (url.pathname.endsWith("/adjacency")) {
            return jsonResponse({ data: { changedEdgeIds: [] } });
          }
          return jsonResponse({ data: {} });
        }
        if (url.pathname === `/api/notes/pages/${PAGE_ID}`) {
          return jsonResponse({
            data: { ...activationPage(PAGE_ID, BLOCK_ID), title: "Retitled page" },
          });
        }
        return jsonResponse({ data: [] });
      },
    );

    renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));

    const title = await screen.findByRole("textbox", { name: "Page title" });
    fireEvent.change(title, { target: { value: "Retitled page" } });
    fireEvent.blur(title);

    await waitFor(() => {
      expect(mutationCalls.some((call) => call.path.endsWith("/title"))).toBe(true);
    });
    expect(legacyPagePatches).toEqual([]);
    const titleCall = mutationCalls.find((call) => call.path.endsWith("/title"));
    expect(titleCall?.body).toMatchObject({
      base_versions: [
        { ref: `page:${PAGE_ID}`, lane: "title", version: 1 },
      ],
      title: "Retitled page",
    });
  });

  it("consumes new-page title focus intent once", async () => {
    setPendingNoteFocus({ pageId: PAGE_ID, target: "title" });

    const { unmount } = renderPagePane(
      PAGE_ID,
      activationPage(PAGE_ID, BLOCK_ID),
    );

    const title = await screen.findByRole("textbox", { name: "Page title" });
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
    expect(consumePendingNoteFocus(PAGE_ID)).toBeNull();

    unmount();
    renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));
    const secondTitle = await screen.findByRole("textbox", {
      name: "Page title",
    });
    await Promise.resolve();
    expect(secondTitle).not.toHaveFocus();
  });
});

describe("PagePaneBody daily-note chrome options", () => {
  const PAGE_ID = "33333333-3333-4333-8333-333333333333";
  const BLOCK_ID = "44444444-4444-4444-8444-444444444444";

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ data: [] }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    window.localStorage.clear();
  });

  function renderWithChromeCapture(
    pageId: string,
    initialPage: NotePage,
  ): { captured: PaneChromeOverrides[] } {
    const captured: PaneChromeOverrides[] = [];
    const captureFn = (overrides: PaneChromeOverrides) => {
      captured.push(overrides);
    };
    const href = `/pages/${pageId}`;
    const identity = resolvePaneRouteIdentity(href);
    render(
      <FeedbackProvider>
        <PaneRuntimeProvider
          paneId="pane-chrome-test"
          href={href}
          routeId={identity.routeId}
          routeKey={identity.routeKey}
          pathParams={{ pageId }}
          canGoBack={false}
          canGoForward={false}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onOpenInNewPane={vi.fn()}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
        >
          <PaneChromeOverrideContext.Provider value={captureFn}>
            <PagePaneBody pageIdOverride={pageId} initialPage={initialPage} />
          </PaneChromeOverrideContext.Provider>
        </PaneRuntimeProvider>
      </FeedbackProvider>,
    );
    return { captured };
  }

  it("publishes open-yesterday and open-tomorrow options when the page is a daily note", async () => {
    const page: NotePage = {
      ...activationPage(PAGE_ID, BLOCK_ID),
      dailyNote: { localDate: "2026-07-07" },
    };

    const { captured } = renderWithChromeCapture(PAGE_ID, page);

    await waitFor(() => {
      expect(
        captured.flatMap((c) => c.options?.map((o) => o.id) ?? []),
      ).toContain("daily-open-yesterday");
    });
    expect(
      captured.flatMap((c) => c.options?.map((o) => o.id) ?? []),
    ).toContain("daily-open-tomorrow");
  });

  it("omits open-yesterday and open-tomorrow options when the page has no daily note", async () => {
    const page: NotePage = {
      ...activationPage(PAGE_ID, BLOCK_ID),
      dailyNote: null,
    };

    const { captured } = renderWithChromeCapture(PAGE_ID, page);

    await waitFor(() => {
      expect(
        captured.flatMap((c) => c.options?.map((o) => o.id) ?? []),
      ).not.toContain("daily-open-yesterday");
    });
  });
});

function citedBlock(): HTMLElement {
  return screen.getByRole("listitem");
}

function citedRange(): HTMLElement {
  return screen.getByText("Cited", {
    selector: "[data-note-pulse-range='true']",
  });
}

function scrolledNoteBlockIds(
  spy: ReturnType<typeof vi.spyOn>,
): (string | null)[] {
  return spy.mock.instances.map((instance: unknown) =>
    instance instanceof Element
      ? (instance
          .closest("li[data-note-block-id]")
          ?.getAttribute("data-note-block-id") ?? null)
      : null,
  );
}

function noteActivation(blockId: string): NotePulseTarget {
  return {
    blockId,
    startOffset: 0,
    endOffset: 5,
    snippet: "Cited",
    highlightBehavior: "pulse",
    focusBehavior: "scroll_into_view",
  };
}

function activationPage(pageId: string, blockId: string): NotePage {
  return {
    id: pageId,
    title: "Cited page",
    surface: null,
    updatedAt: "2026-01-01T00:00:00Z",
    dailyNote: null,
    blocks: [
      {
        id: blockId,
        parentBlockId: null,
        orderKey: "0000000001",
        bodyPmJson: paragraphFromText("Cited snippet body").toJSON() as Record<
          string,
          unknown
        >,
        bodyText: "Cited snippet body",
        collapsed: false,
        children: [],
      },
    ],
  };
}

function renderPagePane(pageId: string, initialPage: NotePage) {
  const href = `/pages/${pageId}`;
  const identity = resolvePaneRouteIdentity(href);
  const { unmount } = render(
    <FeedbackProvider>
      <PaneRuntimeProvider
        paneId="pane-1"
        href={href}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        pathParams={{ pageId }}
        canGoBack={false}
        canGoForward={false}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
        onGoBackPane={vi.fn()}
        onGoForwardPane={vi.fn()}
      >
        <PagePaneBody pageIdOverride={pageId} initialPage={initialPage} />
      </PaneRuntimeProvider>
    </FeedbackProvider>,
  );
  return { unmount };
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function storeNoteDraft(
  resourceKey: string,
  draft: Omit<StoredNoteEditorDraft, "version" | "doc" | "updatedAt"> & {
    doc: unknown;
  },
): void {
  window.localStorage.setItem(
    `nexus.noteDraft:${resourceKey}`,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...draft,
    }),
  );
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface OutlineInput {
  id: string;
  text: string;
  children: OutlineInput[];
}

function currentDraftMetadata() {
  return {
    knownBlocks: [
      {
        id: "block-1",
        parentBlockId: null,
        sourceOrderKey: "0000000001",
        bodyPmJson: { type: "paragraph" },
      },
    ],
    focusedRootParentBlockId: null,
    titleDraft: "Draft title",
  };
}

function outlineDoc(blocks: OutlineInput[]): ProseMirrorNode {
  return outlineSchema.nodes.outline_doc!.create(
    null,
    blocks.map(outlineBlock),
  );
}

function outlineBlock(block: OutlineInput): ProseMirrorNode {
  return outlineSchema.nodes.outline_block!.create(
    { id: block.id, kind: "bullet", collapsed: false },
    [paragraphFromText(block.text), ...block.children.map(outlineBlock)],
  );
}
