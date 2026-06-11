import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  setPendingNoteActivation,
  consumePendingNoteActivation,
} from "@/lib/reader/pendingNoteActivation";
import {
  setPendingNoteFocus,
  consumePendingNoteFocus,
} from "@/lib/notes/pendingNoteFocus";
import type { NotePulseTarget } from "@/lib/reader/pulseEvent";
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
} from "@/lib/notes/pageDocumentPersistence";
import type { StoredNoteEditorDraft } from "@/lib/notes/useNoteEditorSession";
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
      "original-parent"
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
      ])
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
        pageId: "page-1",
        parentBlockId: null,
        orderKey: "0000000001",
        blockKind: "code",
        bodyPmJson: {
          type: "code_block",
          content: [{ type: "text", text: "const answer = 42;" }],
        },
        bodyMarkdown: "const answer = 42;",
        bodyText: "const answer = 42;",
        collapsed: false,
        children: [],
      },
    ]);

    const [draft] = readDraftBlocksForPersistence(doc);

    expect(draft).toMatchObject({
      id: "code-note",
      blockKind: "code",
      bodyPmJson: { type: "code_block", content: [{ type: "text", text: "const answer = 42;" }] },
    });
  });

  it("defaults invalid editor block kinds to bullet", () => {
    const doc = outlineSchema.nodes.outline_doc!.create(null, [
      outlineSchema.nodes.outline_block!.create(
        { id: "block-1", kind: "not-a-note-kind", collapsed: false },
        [paragraphFromText("one")]
      ),
    ]);

    expect(readDraftBlocksForPersistence(doc)[0]?.blockKind).toBe("bullet");
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
        ])
      )
    ).toEqual(["parent"]);
  });
});

describe("pageDraftMetadataFromStorage", () => {
  it("accepts exact current draft metadata", () => {
    expect(pageDraftMetadataFromStorage(currentDraftMetadata())).toEqual(currentDraftMetadata());
  });

  it("rejects legacy revision metadata", () => {
    expect(
      pageDraftMetadataFromStorage({
        ...currentDraftMetadata(),
        pageRevision: 3,
      })
    ).toBeNull();
    expect(
      pageDraftMetadataFromStorage({
        ...currentDraftMetadata(),
        blockRevisions: { "block-1": 2 },
      })
    ).toBeNull();
  });

  it("rejects legacy revision fields on draft blocks", () => {
    const metadata = currentDraftMetadata();
    expect(
      pageDraftMetadataFromStorage({
        ...metadata,
        knownBlocks: [{ ...metadata.knownBlocks[0], revision: 2 }],
      })
    ).toBeNull();
  });
});

// AC-5 / finding #10: a note `[N]` citation clicked in chat for a page that is
// NOT already open dispatches the live pulse before the target pane's
// `useNotePulseHighlight` listener has mounted, so the live event is lost. The
// activator therefore also stashes a pending activation keyed by page id; the
// freshly-mounted `PagePaneBody` must consume it and run its own scroll+pulse.
// This guards that the listener-not-yet-mounted race is handled by the pending
// store, and that the pending entry is consumed (a second mount must not pulse).
describe("PagePaneBody cross-pane note activation", () => {
  const PAGE_ID = "11111111-1111-4111-8111-111111111111";
  const BLOCK_ID = "22222222-2222-4222-8222-222222222222";

  let scrollIntoViewSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // A genuine same-pane pulse listens on a window event; ensure no stale
    // pending activation or persisted draft leaks across tests.
    consumePendingNoteActivation(PAGE_ID);
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

  it("scrolls to and pulses the cited block on a fresh cross-pane mount, then clears the pending activation", async () => {
    setPendingNoteActivation(noteActivation(PAGE_ID, BLOCK_ID));

    const { unmount } = renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));

    // The page renders one note block; once it pulses, the cross-pane handoff
    // worked despite the live event firing before this pane's listener mounted.
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

    // The activation must have been consumed: nothing remains for a later mount.
    expect(consumePendingNoteActivation(PAGE_ID)).toBeNull();

    // A second fresh mount (no new pending activation) must NOT re-pulse.
    unmount();
    scrollIntoViewSpy.mockClear();

    renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));
    await screen.findByRole("listitem");
    // Give the (absent) pulse retry loop a chance to run before asserting.
    await Promise.resolve();
    expect(citedBlock()).not.toHaveClass("nexus-note-pulse");
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
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
    const patchBodies: Record<string, unknown>[] = [];
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === `/api/notes/pages/${PAGE_ID}/document` &&
        init?.method === "PATCH"
      ) {
        const body = parseJsonBody(init);
        patchBodies.push(body);
        return jsonResponse({
          data: {
            page: {
              ...activationPage(PAGE_ID, BLOCK_ID),
              title: "Recovered page title",
              documentVersion: 2,
              blocks: [
                {
                  ...activationPage(PAGE_ID, BLOCK_ID).blocks[0],
                  body_pm_json: paragraphFromText("Recovered page body").toJSON(),
                  body_text: "Recovered page body",
                },
              ],
            },
            clientMutationId: body.client_mutation_id,
            documentVersion: 2,
            changedBlockIds: [BLOCK_ID],
            changedEdgeIds: [],
            reindexJobId: null,
          },
        });
      }
      return jsonResponse({ data: [] });
    });

    renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));

    const editor = await screen.findByRole("textbox", { name: "Notes outline" });
    expect(editor).toHaveTextContent("Recovered page body");
    expect(screen.getByRole("textbox", { name: "Page title" })).toHaveValue(
      "Recovered page title"
    );
    expect(await screen.findByText("Recovered unsaved changes")).toBeInTheDocument();
    expect(patchBodies).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(patchBodies).toHaveLength(1);
    });
    expect(patchBodies[0]).toMatchObject({
      client_mutation_id: "page-recovered-cmid",
      base_document_version: 1,
      title: "Recovered page title",
      focus_block_id: null,
      blocks: [
        {
          id: BLOCK_ID,
          block_kind: "bullet",
          body_pm_json: paragraphFromText("Recovered page body").toJSON(),
        },
      ],
    });
  });

  it("saves title edits through the page document autosave path", async () => {
    const patchBodies: Record<string, unknown>[] = [];
    const legacyPagePatches: string[] = [];
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === `/api/notes/pages/${PAGE_ID}` &&
        init?.method === "PATCH"
      ) {
        legacyPagePatches.push(url.pathname);
        return jsonResponse({ data: activationPage(PAGE_ID, BLOCK_ID) });
      }
      if (
        url.pathname === `/api/notes/pages/${PAGE_ID}/document` &&
        init?.method === "PATCH"
      ) {
        const body = parseJsonBody(init);
        patchBodies.push(body);
        return jsonResponse({
          data: {
            page: {
              ...activationPage(PAGE_ID, BLOCK_ID),
              title: "Retitled page",
              documentVersion: 2,
            },
            clientMutationId: body.client_mutation_id,
            documentVersion: 2,
            changedBlockIds: [],
            changedEdgeIds: [],
            reindexJobId: null,
          },
        });
      }
      return jsonResponse({ data: [] });
    });

    renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));

    const title = await screen.findByRole("textbox", { name: "Page title" });
    fireEvent.change(title, { target: { value: "Retitled page" } });
    fireEvent.blur(title);

    await waitFor(() => {
      expect(patchBodies).toHaveLength(1);
    });
    expect(legacyPagePatches).toEqual([]);
    expect(patchBodies[0]).toMatchObject({
      base_document_version: 1,
      title: "Retitled page",
      focus_block_id: null,
      blocks: [
        {
          id: BLOCK_ID,
          block_kind: "bullet",
          body_pm_json: paragraphFromText("Cited snippet body").toJSON(),
        },
      ],
    });
  });

  it("consumes new-page title focus intent once", async () => {
    setPendingNoteFocus({ pageId: PAGE_ID, target: "title" });

    const { unmount } = renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));

    const title = await screen.findByRole("textbox", { name: "Page title" });
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
    expect(consumePendingNoteFocus(PAGE_ID)).toBeNull();

    unmount();
    renderPagePane(PAGE_ID, activationPage(PAGE_ID, BLOCK_ID));
    const secondTitle = await screen.findByRole("textbox", { name: "Page title" });
    await Promise.resolve();
    expect(secondTitle).not.toHaveFocus();
  });
});

function citedBlock(): HTMLElement {
  return screen.getByRole("listitem");
}

function citedRange(): HTMLElement {
  return screen.getByText("Cited", { selector: "[data-note-pulse-range='true']" });
}

function scrolledNoteBlockIds(
  spy: ReturnType<typeof vi.spyOn>,
): (string | null)[] {
  return spy.mock.instances.map((instance: unknown) =>
    instance instanceof Element
      ? instance.closest("li[data-note-block-id]")?.getAttribute(
          "data-note-block-id",
        ) ?? null
      : null,
  );
}

function noteActivation(pageId: string, blockId: string): NotePulseTarget {
  return {
    pageId,
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
    description: null,
    documentVersion: 1,
    updatedAt: "2026-01-01T00:00:00Z",
    blocks: [
      {
        id: blockId,
        pageId,
        parentBlockId: null,
        orderKey: "0000000001",
        blockKind: "bullet",
        bodyPmJson: paragraphFromText("Cited snippet body").toJSON() as Record<
          string,
          unknown
        >,
        bodyMarkdown: "Cited snippet body",
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
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
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
  }
): void {
  window.localStorage.setItem(
    `nexus.noteDraft:${resourceKey}`,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...draft,
    })
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
        blockKind: "bullet",
        bodyPmJson: { type: "paragraph" },
        collapsed: false,
      },
    ],
    focusedRootParentBlockId: null,
    titleDraft: "Draft title",
  };
}

function outlineDoc(blocks: OutlineInput[]): ProseMirrorNode {
  return outlineSchema.nodes.outline_doc!.create(null, blocks.map(outlineBlock));
}

function outlineBlock(block: OutlineInput): ProseMirrorNode {
  return outlineSchema.nodes.outline_block!.create(
    { id: block.id, kind: "bullet", collapsed: false },
    [paragraphFromText(block.text), ...block.children.map(outlineBlock)]
  );
}
