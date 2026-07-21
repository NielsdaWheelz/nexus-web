import { FileText } from "lucide-react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { CollectionRowView } from "@/lib/collections/types";
import type { ContributorCredit } from "@/lib/contributors/types";
import { useMediaRelated } from "@/lib/collections/useMediaRelated";
import type { ConnectionEndpointOut } from "@/lib/resourceGraph/connections";
import CollectionView from "./CollectionView";

vi.mock("@/lib/collections/useMediaRelated", () => ({
  useMediaRelated: vi.fn(() => ({ data: null, loading: false, error: null })),
}));

// Icon-only leads (no `remoteUrl`) so the gallery card and row thumb render an
// inline Lucide icon tile instead of next/image — keeps these browser tests
// off the image-optimizer codepath.
function row(id: string, text: string, href: string): CollectionRowView {
  return {
    id,
    kind: "media",
    primary: { kind: "link", href },
    lead: { icon: FileText },
    headline: { text },
    signals: [],
  };
}

function contributor(index: number): ContributorCredit {
  return {
    contributor_handle: `contributor-${index}`,
    contributor_display_name: `Contributor ${index}`,
    credited_name: `Contributor ${index}`,
    role: "author",
    href: `/authors/contributor-${index}`,
  };
}

const ROWS: CollectionRowView[] = [
  row("a", "First document", "/media/a"),
  row("b", "Second document", "/media/b"),
  row("c", "Third document", "/media/c"),
];

const relatedPeer: ConnectionEndpointOut = {
  ref: "media:peer-1",
  scheme: "media",
  id: "peer-1",
  label: "Related document",
  description: null,
  activation: {
    resourceRef: "media:peer-1",
    kind: "route",
    href: "/media/peer-1",
    unresolvedReason: null,
  },
  href: "/media/peer-1",
  missing: false,
};

const useMediaRelatedMock = vi.mocked(useMediaRelated);

const originalStartViewTransition = (
  document as Document & { startViewTransition?: unknown }
).startViewTransition;

function installViewTransitions() {
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: vi.fn((callback: () => void | Promise<void>) => {
      const result = callback();
      const done = Promise.resolve(result);
      return {
        ready: done,
        updateCallbackDone: done,
        finished: done,
        skipTransition: vi.fn(),
      };
    }),
  });
}

function renderView(props: Partial<Parameters<typeof CollectionView>[0]> = {}) {
  return render(
    withRenderEnvironment(
      <CollectionView
        rows={ROWS}
        view="list"
        density="comfortable"
        status="ready"
        ariaLabel="Documents"
        {...props}
      />,
    ),
  );
}

describe("CollectionView", () => {
  beforeEach(() => {
    installViewTransitions();
    useMediaRelatedMock.mockReturnValue({ data: null, loading: false, error: null });
  });

  afterEach(() => {
    if (originalStartViewTransition === undefined) {
      Reflect.deleteProperty(document, "startViewTransition");
      return;
    }
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: originalStartViewTransition,
    });
  });

  it("shows the loading placeholder while status is loading", () => {
    renderView({ status: "loading", rows: [] });

    // PaneLoadingState exposes an sr-only label inside a polite live region.
    expect(screen.getByText("Loading Documents…")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders the supplied error node when status is error", () => {
    renderView({
      status: "error",
      rows: [],
      error: <p>Could not load documents</p>,
    });

    expect(screen.getByText("Could not load documents")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders the empty node when ready with no rows", () => {
    renderView({
      status: "ready",
      rows: [],
      empty: <p>No documents yet</p>,
    });

    expect(screen.getByText("No documents yet")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders each ready row's headline as a link to its primary href (list view)", () => {
    renderView();

    const first = screen.getByRole("link", { name: /First document/ });
    expect(first).toHaveAttribute("href", "/media/a");
    expect(screen.getByRole("link", { name: /Second document/ })).toHaveAttribute(
      "href",
      "/media/b",
    );
    expect(screen.getByRole("link", { name: /Third document/ })).toHaveAttribute(
      "href",
      "/media/c",
    );
  });

  it("shows unread consumption state at rest", () => {
    renderView({ rows: [{ ...ROWS[0], consumption: { status: "unread" } }] });

    expect(screen.getByText("Unread")).toBeInTheDocument();
  });

  it("labels listening state, progress, and recency semantically", () => {
    renderView({
      rows: [
        {
          ...ROWS[0],
          kind: "podcast_episode",
          consumption: { status: "in_progress" },
          recency: { at: "2026-05-25T12:00:00Z" },
        },
        {
          ...ROWS[1],
          kind: "podcast_episode",
          consumption: { status: "in_progress", fraction: 0.42 },
        },
      ],
    });

    expect(screen.getByText("Listening")).toBeInTheDocument();
    expect(screen.getByRole("time")).toHaveAttribute("datetime", "2026-05-25T12:00:00Z");
    expect(
      screen.getByRole("progressbar", { name: "Listening progress for Second document" }),
    ).toHaveAttribute("aria-valuenow", "42");
  });

  it("keeps compact collection rows inside a 320px mobile width", async () => {
    const onAction = vi.fn();
    render(
      withRenderEnvironment(
        <div
          data-testid="mobile-collection-host"
          style={{ width: "320px", maxWidth: "320px" }}
        >
          <CollectionView
            rows={[
              {
                ...ROWS[0],
                headline: {
                  text: "A compact collection row with a very long title that should clamp on mobile",
                },
                signals: [
                  { value: "Very Long Publisher Name" },
                  { value: "2026" },
                  { value: "Long secondary signal" },
                ],
                contributors: {
                  credits: [contributor(1), contributor(2), contributor(3)],
                  maxVisible: 3,
                },
                actions: [
                  {
                    kind: "command",
                    id: "archive",
                    label: "Archive",
                    onSelect: onAction,
                  },
                ],
                status: {
                  tone: "neutral",
                  label: "Extremely Long Status Label",
                },
              },
            ]}
            view="list"
            density="compact"
            status="ready"
            ariaLabel="Documents"
            rowControls={{
              a: <button type="button">Pin</button>,
            }}
          />
        </div>,
      ),
    );

    const host = await screen.findByTestId("mobile-collection-host");
    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
    expect(screen.getAllByRole("link", { name: /Contributor/ })).toHaveLength(2);
    expect(screen.getByText(", +1 more")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /compact collection row/ })).toHaveStyle({
      width: "32px",
      height: "32px",
    });

    const primary = screen.getByRole("link", { name: /compact collection row/ });
    primary.focus();
    expect(primary).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Related" })).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("link", { name: "Contributor 1" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Contributor 1" })).toHaveStyle({
      outlineOffset: "2px",
    });

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("link", { name: "Contributor 2" })).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Pin" })).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("link", { name: "Contributor 2" })).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Pin" })).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitem", { name: "Archive" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Actions for A compact collection row with a very long title that should clamp on mobile",
        }),
      ).toHaveFocus(),
    );
  });

  it("keeps gallery fallback icons inside the narrowest grid card", async () => {
    render(
      withRenderEnvironment(
        <div
          data-testid="narrow-gallery-host"
          style={{ width: "168px", maxWidth: "168px" }}
        >
          <CollectionView
            rows={ROWS.slice(0, 1)}
            view="gallery"
            density="comfortable"
            status="ready"
            ariaLabel="Documents"
          />
        </div>,
      ),
    );

    const host = await screen.findByTestId("narrow-gallery-host");
    const iconTile = screen.getByRole("img", { name: "First document" });
    const iconTileStyle = getComputedStyle(iconTile);

    expect(host.clientWidth).toBe(168);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(iconTileStyle.getPropertyValue("--resource-thumb-icon-size").trim()).toBe(
      "min(50%, 8rem)",
    );
    expect(horizontallyScrollableElements(host)).toEqual([]);
  });

  it("keeps compact sortable rows inside a 320px mobile width", async () => {
    const onReorder = vi.fn();
    render(
      withRenderEnvironment(
        <div
          data-testid="mobile-sortable-host"
          style={{ width: "320px", maxWidth: "320px" }}
        >
          <CollectionView
            rows={[
              {
                ...ROWS[0],
                headline: {
                  text: "A sortable compact row with enough text to prove the div row path",
                },
                signals: [{ value: "Manual order" }, { value: "Long collection metadata" }],
                contributors: {
                  credits: [contributor(1), contributor(2), contributor(3)],
                  maxVisible: 3,
                },
              },
            ]}
            view="list"
            density="compact"
            status="ready"
            ariaLabel="Documents"
            sortable={{
              onReorder,
              renderControls: (_row, { handleProps }) => (
                <button
                  type="button"
                  aria-label="Drag row"
                  {...handleProps.attributes}
                  {...handleProps.listeners}
                >
                  Drag
                </button>
              ),
            }}
          />
        </div>,
      ),
    );

    const host = await screen.findByTestId("mobile-sortable-host");
    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
    expect(screen.getByRole("button", { name: "Drag row" })).toBeInTheDocument();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("reorders sortable rows from the keyboard handle", async () => {
    const onReorder = vi.fn();

    function SortableCollectionHarness() {
      const [rows, setRows] = useState(ROWS);
      return (
        <CollectionView
          rows={rows}
          view="list"
          density="comfortable"
          status="ready"
          ariaLabel="Documents"
          sortable={{
            onReorder: (nextRows) => {
              onReorder(nextRows);
              setRows(nextRows);
            },
            renderControls: (row, { handleProps }) => (
              <button
                type="button"
                aria-label={`Reorder ${row.headline.text}`}
                {...handleProps.attributes}
                {...handleProps.listeners}
              >
                Drag
              </button>
            ),
          }}
        />
      );
    }

    render(withRenderEnvironment(<SortableCollectionHarness />));

    screen.getByRole("button", { name: "Reorder First document" }).focus();
    await userEvent.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(onReorder).toHaveBeenCalledWith([ROWS[1], ROWS[0], ROWS[2]]);
    });
    expect(
      screen.getAllByRole("link").map((link) => link.textContent),
    ).toEqual(["Second document", "First document", "Third document"]);
  });

  it("moves focus from the first row to the second on ArrowDown", async () => {
    renderView();

    const first = screen.getByRole("link", { name: /First document/ });
    const second = screen.getByRole("link", { name: /Second document/ });

    first.focus();
    expect(first).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");

    expect(second).toHaveFocus();
  });

  it("normalizes the list to one tabbable row primary", async () => {
    renderView();

    const first = screen.getByRole("link", { name: /First document/ });
    const second = screen.getByRole("link", { name: /Second document/ });
    const third = screen.getByRole("link", { name: /Third document/ });

    await waitFor(() => expect(first).toHaveAttribute("tabindex", "0"));
    expect(second).toHaveAttribute("tabindex", "-1");
    expect(third).toHaveAttribute("tabindex", "-1");
  });

  it("moves by Home, End, and type-ahead inside the roving list", async () => {
    renderView();

    const first = screen.getByRole("link", { name: /First document/ });
    const second = screen.getByRole("link", { name: /Second document/ });
    const third = screen.getByRole("link", { name: /Third document/ });

    first.focus();
    await userEvent.keyboard("{End}");
    expect(third).toHaveFocus();

    await userEvent.keyboard("{Home}");
    expect(first).toHaveFocus();

    await userEvent.keyboard("s");
    expect(second).toHaveFocus();
  });

  it("keeps row controls out of Tab order but reachable from the focused row", async () => {
    const onAction = vi.fn();
    renderView({
      rows: [
        {
          ...ROWS[0],
          actions: [
            {
              kind: "command",
              id: "archive",
              label: "Archive",
              onSelect: onAction,
            },
          ],
        },
        ROWS[1],
      ],
    });

    const first = screen.getByRole("link", { name: /First document/ });
    first.focus();

    const firstRow = within(screen.getAllByRole("listitem")[0]);
    const trigger = screen.getByRole("button", { name: "Actions for First document" });
    const related = firstRow.getByRole("button", { name: "Related" });
    await waitFor(() => expect(trigger).toHaveAttribute("tabindex", "-1"));
    expect(related).toHaveAttribute("tabindex", "-1");

    await userEvent.keyboard("{ArrowRight}");
    expect(related).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(first).toHaveFocus();

    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    expect(await screen.findByRole("menuitem", { name: "Archive" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps row control keyboard access when View Transitions are unavailable", async () => {
    Reflect.deleteProperty(document, "startViewTransition");
    renderView({
      rows: [
        {
          ...ROWS[0],
          actions: [
            {
              kind: "command",
              id: "archive",
              label: "Archive",
              onSelect: vi.fn(),
            },
          ],
        },
      ],
    });

    const first = screen.getByRole("link", { name: /First document/ });
    first.focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Related" })).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(first).toHaveFocus();

    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    expect(await screen.findByRole("menuitem", { name: "Archive" })).toHaveFocus();
  });

  it("renders headlines as links in gallery view", () => {
    renderView({ view: "gallery" });

    expect(screen.getByRole("link", { name: /First document/ })).toHaveAttribute(
      "href",
      "/media/a",
    );
    expect(screen.getByRole("link", { name: /Second document/ })).toHaveAttribute(
      "href",
      "/media/b",
    );
  });

  it("keeps gallery activation on the shared row contract", () => {
    renderView({
      view: "gallery",
      rows: [
        {
          ...ROWS[0],
          primary: {
            kind: "link",
            href: "/media/a",
            target: "_blank",
            rel: "noopener noreferrer",
          },
        },
      ],
    });

    const link = screen.getByRole("link", { name: /First document/ });
    expect(link).toHaveAttribute("href", "/media/a");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders gallery button rows with busy disabled semantics", () => {
    const onActivate = vi.fn();
    renderView({
      view: "gallery",
      rows: [
        {
          ...ROWS[0],
          primary: {
            kind: "button",
            label: "Open first document",
            busy: true,
            onActivate,
          },
        },
      ],
    });

    const button = screen.getByRole("button", { name: "Open first document" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("keeps the connection toggle outside the primary link", async () => {
    renderView({
      rows: [
        {
          ...ROWS[0],
          connections: {
            total: 1,
            dominantKind: "context",
            topPeers: [relatedPeer],
          },
        },
      ],
    });

    const rowLink = screen.getByRole("link", { name: /First document/ });
    const toggle = screen.getByRole("button", { name: /1 connected/ });
    expect(rowLink).not.toContainElement(toggle);

    await userEvent.click(toggle);
    expect(screen.getByRole("link", { name: /Related document/ })).toHaveAttribute(
      "href",
      "/media/peer-1",
    );
  });

  it("exposes related peers even when a media row has no provenance connections", async () => {
    useMediaRelatedMock.mockReturnValue({
      data: [relatedPeer],
      loading: false,
      error: null,
    });
    renderView({ rows: [ROWS[0]] });

    await userEvent.click(screen.getByRole("button", { name: "Related" }));

    expect(useMediaRelatedMock).toHaveBeenCalledWith("a");
    expect(screen.getByRole("link", { name: /Related document/ })).toHaveAttribute(
      "href",
      "/media/peer-1",
    );
  });

  it("uses relatedMediaId for media-backed rows with entry-scoped row ids", async () => {
    useMediaRelatedMock.mockReturnValue({
      data: [relatedPeer],
      loading: false,
      error: null,
    });
    renderView({ rows: [{ ...ROWS[0], id: "entry-a", relatedMediaId: "a" }] });

    await userEvent.click(screen.getByRole("button", { name: "Related" }));

    expect(useMediaRelatedMock).toHaveBeenCalledWith("a");
  });

  it("exposes scoped row transition names without media-reader names at rest", async () => {
    renderView();

    const rowItem = screen.getAllByRole("listitem")[0];
    const row = within(rowItem);
    const thumb = row.getByRole("img", { name: /First document/ });
    const title = row.getByText("First document");

    expect(rowItem).toHaveAttribute("data-collection-row-id", "a");
    await waitFor(() =>
      expect(rowItem.style.viewTransitionName).toContain("nexus-collection-row"),
    );
    expect(thumb.style.viewTransitionName).toBe("");
    expect(title.style.viewTransitionName).toBe("");
  });

  it("keeps gallery cards on the same transition contract", async () => {
    renderView({ view: "gallery" });

    const rowItem = screen.getAllByRole("listitem")[0];
    const row = within(rowItem);

    expect(rowItem).toHaveAttribute("data-collection-row-id", "a");
    await waitFor(() =>
      expect(rowItem.style.viewTransitionName).toContain("nexus-collection-row"),
    );
    expect(row.getByRole("img", { name: /First document/ })).toHaveAttribute(
      "data-view-transition-part",
      "thumb",
    );
    expect(row.getByText("First document")).toHaveAttribute(
      "data-view-transition-part",
      "title",
    );
  });

  it("wraps ready row-order replacements in a view transition", async () => {
    const view = renderView();
    const startViewTransition = (document as Document & {
      startViewTransition: ReturnType<typeof vi.fn>;
    }).startViewTransition;

    await waitFor(() =>
      expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
        "data-collection-row-id",
        "a",
      ),
    );

    view.rerender(
      withRenderEnvironment(
        <CollectionView
          rows={[ROWS[2], ROWS[1], ROWS[0]]}
          view="list"
          density="comfortable"
          status="ready"
          ariaLabel="Documents"
        />,
      ),
    );

    await waitFor(() => expect(startViewTransition).toHaveBeenCalled());
    expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
      "data-collection-row-id",
      "c",
    );
  });
});
