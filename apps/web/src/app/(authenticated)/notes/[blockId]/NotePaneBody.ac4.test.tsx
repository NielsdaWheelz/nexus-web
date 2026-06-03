import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { BootstrapHydrationProvider } from "@/lib/api/hydrationCache";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import NotePaneBody from "./NotePaneBody";

// AC-4 hydration-hit guard: when the bootstrap seeds the derived note-block resource
// under the cacheKey NotePaneBody reads (`note-block:<blockId>`), the pane must resolve
// the page id straight from that seed — never fetching `/api/notes/blocks/<blockId>`
// for its own resource — and propagate that page id into the composed PagePaneBody.
// The observable effect of the resolved page id is the page editor's own first fetch
// to `/api/notes/pages/<pageId>` (PagePaneBody is not prefetched; its cacheKey embeds
// the editor saveScope). This pins the seeded shape in paneServerLoaders.note
// ({ blockId, pageId }) against what NotePaneBody consumes — if either side drifts the
// pane would fall back to fetching the block and the page fetch would never carry the
// seeded page id, failing this test.

describe("NotePaneBody (AC-4 hydration hit)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves pageId from the seed and never fetches /api/notes/blocks/<blockId>", async () => {
    const blockId = "seeded-block-1";
    const pageId = "seeded-page-9";

    // A never-resolving fetch keeps the downstream PagePaneBody editor in its loading
    // state, so this test observes only the network the panes initiate, not a full
    // ProseMirror mount. PagePaneBody awaits the page fetch before the focused-block
    // fetch, so with this stub `/api/notes/blocks/<blockId>` is only ever requested if
    // NotePaneBody itself missed the seed.
    const fetchSpy = vi.fn(
      () => new Promise<Response>(() => {}),
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <FeedbackProvider>
        <BootstrapHydrationProvider
          value={{ [`note-block:${blockId}`]: { blockId, pageId } }}
        >
          {notePane(blockId)}
        </BootstrapHydrationProvider>
      </FeedbackProvider>,
    );

    // (a) Observable effect of the resolved page id: the composed page editor fetches
    // its page by the seeded pageId. This only happens if NotePaneBody consumed the
    // seed and passed pageId down to PagePaneBody.
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([input]) =>
            pathOf(input as RequestInfo | URL) === `/api/notes/pages/${pageId}`,
        ),
      ).toBe(true);
    });

    // While that page fetch is pending, the pane shows the loading state rather than an
    // error — the seed never produced a feedback notice.
    expect(screen.getByRole("status")).toBeInTheDocument();

    // (b) No client fetch to the note-block endpoint — the seed was the source for the
    // block-to-page resolution (hydration hit).
    const fetchedBlock = fetchSpy.mock.calls.some(
      ([input]) =>
        pathOf(input as RequestInfo | URL) === `/api/notes/blocks/${blockId}`,
    );
    expect(fetchedBlock).toBe(false);
  });
});

function notePane(blockId: string) {
  const href = `/notes/${blockId}`;
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      href={href}
      routeId="note"
      resourceRef={`note_block:${blockId}`}
      resourceKey={resolvePaneRouteIdentity(href).resourceKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      pathParams={{ blockId }}
      onNavigatePane={() => {}}
      onReplacePane={() => {}}
      onOpenInNewPane={() => {}}
    >
      <NotePaneBody />
    </PaneRuntimeProvider>
  );
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url, "http://localhost").pathname;
  return new URL(String(input), "http://localhost").pathname;
}
