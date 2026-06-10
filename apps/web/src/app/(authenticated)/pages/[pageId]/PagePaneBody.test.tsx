import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  setPendingNoteActivation,
  consumePendingNoteActivation,
} from "@/lib/reader/pendingNoteActivation";
import type { NotePulseTarget } from "@/lib/reader/pulseEvent";
import type { NotePage } from "@/lib/notes/api";
import {
  noteBlocksToOutlineDoc,
  outlineSchema,
  paragraphFromText,
} from "@/lib/notes/prosemirror/schema";
import PagePaneBody, {
  deletedRootBlockIdsForPersistence,
  pageDraftMetadataFromStorage,
  readDraftBlocksForPersistence,
} from "./PagePaneBody";

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
      afterBlockId: "focused-block",
      beforeBlockId: null,
    });
  });

  it("emits one relative order anchor per sibling", () => {
    const drafts = readDraftBlocksForPersistence(
      outlineDoc([
        { id: "block-1", text: "one", children: [] },
        { id: "block-2", text: "two", children: [] },
        { id: "block-3", text: "three", children: [] },
      ])
    );

    expect(drafts.map((draft) => [draft.beforeBlockId, draft.afterBlockId])).toEqual([
      ["block-2", null],
      [null, "block-1"],
      [null, "block-2"],
    ]);
    expect(drafts.every((draft) => !(draft.beforeBlockId && draft.afterBlockId))).toBe(true);
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
    window.localStorage.clear();

    scrollIntoViewSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    // Only the network boundary is mocked: the page loads from `initialPage`,
    // so the sole fetch is NoteBacklinks' resource-graph edges GET.
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
    expect(citedBlock()).toHaveAttribute("data-note-block-id", BLOCK_ID);
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
});

function citedBlock(): HTMLElement {
  return screen.getByRole("listitem");
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
        beforeBlockId: null,
        afterBlockId: null,
        blockKind: "bullet",
        bodyPmJson: { type: "paragraph" },
        collapsed: false,
      },
    ],
    focusedRootParentBlockId: null,
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
