import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { stubFetch, wasFetchPathCalled } from "@/__tests__/helpers/fetch";
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
    const fetchSpy = stubFetch(
      () => new Promise<Response>(() => {}),
    );

    renderHydratedPane({
      href: `/notes/${blockId}`,
      resources: { [`note-block:${blockId}`]: { blockId, pageId } },
      children: <NotePaneBody />,
    });

    // (a) Observable effect of the resolved page id: the composed page editor fetches
    // its page by the seeded pageId. This only happens if NotePaneBody consumed the
    // seed and passed pageId down to PagePaneBody.
    await waitFor(() => {
      expect(
        wasFetchPathCalled(
          fetchSpy,
          `/api/notes/pages/${pageId}`,
        ),
      ).toBe(true);
    });

    // While that page fetch is pending, the pane shows the loading state rather than an
    // error — the seed never produced a feedback notice.
    expect(screen.getByRole("status")).toBeInTheDocument();

    // (b) No client fetch to the note-block endpoint — the seed was the source for the
    // block-to-page resolution (hydration hit).
    const fetchedBlock = wasFetchPathCalled(
      fetchSpy,
      `/api/notes/blocks/${blockId}`,
    );
    expect(fetchedBlock).toBe(false);
  });
});
