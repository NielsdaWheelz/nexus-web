import { describe, it, expect, afterEach, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps, RefObject } from "react";
import AnchoredSecondaryPane from "@/components/AnchoredSecondaryPane";
import { FeedbackProvider } from "@/components/feedback/Feedback";

const scrollHosts: HTMLDivElement[] = [];
const scrollHostByContentRoot = new WeakMap<HTMLElement, HTMLDivElement>();
const anchoredSecondaryPaneBaseProps = {
  isEditingBounds: false,
  canSendToChat: true,
  onSendToChat: vi.fn(),
  onColorChange: vi.fn(async () => undefined),
  onDelete: vi.fn(async () => undefined),
  onStartEditBounds: vi.fn(),
  onCancelEditBounds: vi.fn(),
  onNoteSave: vi.fn(async () => undefined),
  onNoteDelete: vi.fn(async () => undefined),
  onOpenConversation: vi.fn(),
} as const;

function getRowButtons(): HTMLButtonElement[] {
  return screen
    .queryAllByRole("button")
    .filter(
      (el) => el.getAttribute("aria-pressed") !== null,
    ) as HTMLButtonElement[];
}

function createScrollableContent(innerHtml: string): {
  host: HTMLDivElement;
  contentRoot: HTMLDivElement;
  contentRef: RefObject<HTMLElement | null>;
} {
  const host = document.createElement("div");
  host.style.height = "320px";
  host.style.overflowY = "auto";
  host.style.position = "relative";
  Object.defineProperty(host, "clientHeight", {
    configurable: true,
    value: 320,
  });
  Object.defineProperty(host, "scrollTop", {
    configurable: true,
    writable: true,
    value: 0,
  });

  const contentRoot = document.createElement("div");
  contentRoot.innerHTML = innerHtml;
  host.appendChild(contentRoot);
  document.body.appendChild(host);
  scrollHosts.push(host);
  scrollHostByContentRoot.set(contentRoot, host);

  const contentRef = { current: contentRoot } as RefObject<HTMLElement | null>;
  return { host, contentRoot, contentRef };
}

function mockViewportTargets(
  host: HTMLDivElement,
  contentRoot: HTMLDivElement,
  targets: Record<string, { absoluteTop: number; height?: number }>,
  viewportTop = 100,
  viewportHeight = 320,
) {
  vi.spyOn(host, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, viewportTop, 400, viewportHeight),
  );

  for (const [testId, { absoluteTop, height = 16 }] of Object.entries(
    targets,
  )) {
    const target = within(contentRoot).getByTestId(testId);
    vi.spyOn(target, "getBoundingClientRect").mockImplementation(
      () =>
        new DOMRect(0, viewportTop + absoluteTop - host.scrollTop, 80, height),
    );
  }
}

function renderAnchoredSecondaryPane(
  props: ComponentProps<typeof AnchoredSecondaryPane>,
) {
  const contentRoot = props.contentRef.current;
  const host = contentRoot ? scrollHostByContentRoot.get(contentRoot) : null;
  if (contentRoot && host) {
    if (!vi.isMockFunction(host.getBoundingClientRect)) {
      vi.spyOn(host, "getBoundingClientRect").mockImplementation(
        () => new DOMRect(0, 100, 400, host.clientHeight),
      );
    }

    for (const target of contentRoot.querySelectorAll<HTMLElement>(
      "[data-active-highlight-ids]",
    )) {
      if (!vi.isMockFunction(target.getBoundingClientRect)) {
        vi.spyOn(target, "getBoundingClientRect").mockImplementation(
          () => new DOMRect(0, 140 - host.scrollTop, 80, 16),
        );
      }
    }
  }

  return render(
    <FeedbackProvider>
      <AnchoredSecondaryPane {...props} />
    </FeedbackProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  while (scrollHosts.length > 0) {
    scrollHosts.pop()?.remove();
  }
});

describe("AnchoredSecondaryPane", () => {
  it("orders same-line rows by canonical offsets, not random id fallback", async () => {
    const { host, contentRef } = createScrollableContent(
      [
        '<p><span data-active-highlight-ids="a-late"></span>late token ',
        '<span data-active-highlight-ids="z-early"></span>early token</p>',
      ].join(""),
    );
    host.setAttribute("data-test-scroll-host", "true");

    const highlights = [
      {
        id: "a-late",
        exact: "late token",
        color: "yellow" as const,
        linked_note_blocks: [],
        anchor: {
          start_offset: 10,
          end_offset: 19,
        },
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "z-early",
        exact: "early token",
        color: "green" as const,
        linked_note_blocks: [],
        anchor: {
          start_offset: 1,
          end_offset: 10,
        },
        created_at: "2026-01-01T00:00:00Z",
      },
    ] as const;

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: highlights as never,
      contentRef,
      focusedId: null,
      isMobile: false,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(2);
    });

    const rows = getRowButtons();
    expect(rows[0].textContent).toContain("early token");
    expect(rows[1].textContent).toContain("late token");
  });

  it("scrolls to active-highlight segments when anchor marker is absent", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      '<p><span data-active-highlight-ids="pdf-h1" data-testid="active-highlight-segment">pdf target</span></p>',
    );
    host.setAttribute("data-test-scroll-host", "true");
    const segment = within(contentRoot).getByTestId("active-highlight-segment");
    mockViewportTargets(host, contentRoot, {
      "active-highlight-segment": { absoluteTop: 40 },
    });
    vi.spyOn(segment, "getClientRects").mockImplementation(
      () => [] as unknown as DOMRectList,
    );
    const scrollIntoViewSpy = vi
      .spyOn(segment, "scrollIntoView")
      .mockImplementation(() => undefined);

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "pdf-h1",
          exact: "pdf target",
          color: "yellow",
          linked_note_blocks: [],
          anchor: {
            start_offset: 0,
            end_offset: 10,
          },
          created_at: "2026-01-01T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: null,
      isMobile: false,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });
    fireEvent.click(getRowButtons()[0]);
    expect(scrollIntoViewSpy).toHaveBeenCalledOnce();
    scrollIntoViewSpy.mockRestore();
  });

  it("on mobile, renders only in-view rows and shows explicit above/below indicators", async () => {
    const onHighlightClick = vi.fn();
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<p><span data-active-highlight-ids="above-h" data-testid="anchor-above"></span>above excerpt</p>',
        '<p><span data-active-highlight-ids="in-view-h" data-testid="anchor-in-view"></span>current excerpt</p>',
        '<p><span data-active-highlight-ids="below-h" data-testid="anchor-below"></span>below excerpt</p>',
      ].join(""),
    );
    host.scrollTop = 200;
    mockViewportTargets(host, contentRoot, {
      "anchor-above": { absoluteTop: 120 },
      "anchor-in-view": { absoluteTop: 260 },
      "anchor-below": { absoluteTop: 580 },
    });

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "above-h",
          exact: "above excerpt",
          color: "yellow",
          linked_note_blocks: [],
          anchor: {
            start_offset: 0,
            end_offset: 12,
          },
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "in-view-h",
          exact: "current excerpt",
          color: "blue",
          linked_note_blocks: [],
          anchor: {
            start_offset: 20,
            end_offset: 35,
          },
          created_at: "2026-01-02T00:00:00Z",
        },
        {
          id: "below-h",
          exact: "below excerpt",
          color: "blue",
          linked_note_blocks: [],
          anchor: {
            start_offset: 40,
            end_offset: 53,
          },
          created_at: "2026-01-03T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: null,
      isMobile: true,
      onHighlightClick,
    });

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });

    expect(screen.getByTestId("linked-item-row-in-view-h")).toBeInTheDocument();
    expect(
      screen.queryByTestId("linked-item-row-above-h"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("linked-item-row-below-h"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 above" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 below" })).toBeInTheDocument();
    expect(
      screen.queryByText("No highlights in view."),
    ).not.toBeInTheDocument();

    fireEvent.click(getRowButtons()[0]);
    expect(onHighlightClick).toHaveBeenCalledWith("in-view-h");
  });

  it("on desktop, renders only rows whose targets intersect the reader viewport", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<p><span data-active-highlight-ids="above-h" data-testid="desktop-above"></span>above excerpt</p>',
        '<p><span data-active-highlight-ids="mid-h" data-testid="desktop-mid"></span>mid excerpt</p>',
        '<p><span data-active-highlight-ids="lower-h" data-testid="desktop-lower"></span>lower excerpt</p>',
      ].join(""),
    );
    host.scrollTop = 200;
    mockViewportTargets(host, contentRoot, {
      "desktop-above": { absoluteTop: 120 },
      "desktop-mid": { absoluteTop: 260 },
      "desktop-lower": { absoluteTop: 580 },
    });

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "above-h",
          exact: "above excerpt",
          color: "yellow",
          linked_note_blocks: [],
          anchor: { start_offset: 0, end_offset: 12 },
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "mid-h",
          exact: "mid excerpt",
          color: "green",
          linked_note_blocks: [],
          anchor: { start_offset: 20, end_offset: 31 },
          created_at: "2026-01-02T00:00:00Z",
        },
        {
          id: "lower-h",
          exact: "lower excerpt",
          color: "blue",
          linked_note_blocks: [],
          anchor: { start_offset: 40, end_offset: 53 },
          created_at: "2026-01-03T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: null,
      isMobile: false,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("linked-item-row-mid-h")).toBeInTheDocument();
      expect(
        screen.queryByTestId("linked-item-row-above-h"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("linked-item-row-lower-h"),
      ).not.toBeInTheDocument();
    });

    host.scrollTop = 540;
    fireEvent.scroll(host);

    await waitFor(() => {
      expect(screen.getByTestId("linked-item-row-lower-h")).toBeInTheDocument();
      expect(
        screen.queryByTestId("linked-item-row-mid-h"),
      ).not.toBeInTheDocument();
    });
  });

  it("does not project a text highlight from its zero-width anchor alone", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      '<p><span data-highlight-anchor="anchor-only-h" data-testid="anchor-only"></span>anchor only excerpt</p>',
    );
    mockViewportTargets(host, contentRoot, {});

    const anchor = within(contentRoot).getByTestId("anchor-only");
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 140, 0, 16),
    );

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "anchor-only-h",
          exact: "anchor only excerpt",
          color: "yellow",
          linked_note_blocks: [],
          anchor: { start_offset: 0, end_offset: 19 },
          created_at: "2026-01-01T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: null,
      isMobile: false,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(screen.getByText("No highlights in view.")).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("linked-item-row-anchor-only-h"),
    ).not.toBeInTheDocument();
  });

  it("on desktop, projects PDF quads and omits offscreen page targets", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<div class="page" data-page-number="2" data-testid="pdf-page"',
        ' data-nexus-page-scale="1" data-nexus-page-rotation="0"',
        ' data-nexus-page-viewport-width="600" data-nexus-page-viewport-height="800"',
        ' data-nexus-page-dpi-scale="1"></div>',
      ].join(""),
    );
    host.scrollTop = 200;
    mockViewportTargets(host, contentRoot, {});

    const page = within(contentRoot).getByTestId("pdf-page");
    vi.spyOn(page, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 100 - host.scrollTop, 600, 800),
    );

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "pdf-above",
          exact: "above pdf excerpt",
          color: "yellow",
          linked_note_blocks: [],
          page_number: 2,
          quads: [
            {
              x1: 10,
              y1: 120,
              x2: 110,
              y2: 120,
              x3: 110,
              y3: 136,
              x4: 10,
              y4: 136,
            },
          ],
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "pdf-visible",
          exact: "visible pdf excerpt",
          color: "green",
          linked_note_blocks: [],
          page_number: 2,
          quads: [
            {
              x1: 10,
              y1: 260,
              x2: 110,
              y2: 260,
              x3: 110,
              y3: 276,
              x4: 10,
              y4: 276,
            },
          ],
          created_at: "2026-01-02T00:00:00Z",
        },
        {
          id: "pdf-below",
          exact: "below pdf excerpt",
          color: "blue",
          linked_note_blocks: [],
          page_number: 2,
          quads: [
            {
              x1: 10,
              y1: 580,
              x2: 110,
              y2: 580,
              x3: 110,
              y3: 596,
              x4: 10,
              y4: 596,
            },
          ],
          created_at: "2026-01-03T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: null,
      isMobile: false,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("linked-item-row-pdf-visible"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("linked-item-row-pdf-above"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("linked-item-row-pdf-below"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps collapsed rows compact without inline note, chat, or conversation chrome", async () => {
    const { host, contentRef } = createScrollableContent(
      '<p><span data-active-highlight-ids="compact-h1"></span>compact row preview</p>',
    );
    host.setAttribute("data-test-scroll-host", "true");

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "compact-h1",
          exact: "compact row preview",
          color: "yellow",
          linked_note_blocks: [
            {
              note_block_id: "note-1",
              body_text:
                "This note should stay hidden while the row is collapsed.",
            },
          ],
          linked_conversations: [
            {
              conversation_id: "conversation-1",
              title: "Context thread",
            },
          ],
          anchor: {
            start_offset: 0,
            end_offset: 20,
          },
          created_at: "2026-01-01T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: null,
      isMobile: true,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });

    const row = screen.getByTestId("linked-item-row-compact-h1");
    expect(within(row).getByText("compact row preview")).toBeInTheDocument();
    expect(
      within(row).queryByText(
        "This note should stay hidden while the row is collapsed.",
      ),
    ).not.toBeInTheDocument();
    expect(within(row).queryByText("Add a note…")).not.toBeInTheDocument();
    expect(within(row).queryByText("Context thread")).not.toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Send to chat" }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Actions" }),
    ).not.toBeInTheDocument();
  });

  it("hides the expanded ask-in-chat action when quote chat is unavailable", async () => {
    const { host, contentRef } = createScrollableContent(
      '<p><span data-active-highlight-ids="chat-disabled-h"></span>chat gated preview</p>',
    );
    host.setAttribute("data-test-scroll-host", "true");

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      canSendToChat: false,
      highlights: [
        {
          id: "chat-disabled-h",
          exact: "chat gated preview",
          color: "yellow",
          linked_note_blocks: [],
          anchor: {
            start_offset: 0,
            end_offset: 18,
          },
          created_at: "2026-01-01T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: "chat-disabled-h",
      isMobile: false,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });

    const row = screen.getByTestId("linked-item-row-chat-disabled-h");
    expect(
      within(row).queryByRole("button", { name: "Ask in chat" }),
    ).not.toBeInTheDocument();
  });

  it("renders all linked notes on the focused highlight", async () => {
    const { host, contentRef } = createScrollableContent(
      '<p><span data-active-highlight-ids="multi-note-h"></span>linked note preview</p>',
    );
    host.setAttribute("data-test-scroll-host", "true");

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "multi-note-h",
          exact: "linked note preview",
          color: "yellow",
          linked_note_blocks: [
            { note_block_id: "note-1", body_text: "First linked note." },
            { note_block_id: "note-2", body_text: "Second linked note." },
          ],
          anchor: {
            start_offset: 0,
            end_offset: 19,
          },
          created_at: "2026-01-01T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: "multi-note-h",
      isMobile: false,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(screen.getByText("First linked note.")).toBeInTheDocument();
      expect(screen.getByText("Second linked note.")).toBeInTheDocument();
    });
  });

  it("lets shared readers edit their own empty linked notes without highlight actions", async () => {
    const { host, contentRef } = createScrollableContent(
      '<p><span data-active-highlight-ids="empty-note-h"></span>empty note preview</p>',
    );
    host.setAttribute("data-test-scroll-host", "true");

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "empty-note-h",
          exact: "empty note preview",
          color: "yellow",
          is_owner: false,
          linked_note_blocks: [
            {
              note_block_id: "empty-note-1",
              body_text: "   ",
              body_markdown: " ",
              body_pm_json: { type: "paragraph" },
            },
          ],
          anchor: {
            start_offset: 0,
            end_offset: 18,
          },
          created_at: "2026-01-01T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: "empty-note-h",
      isMobile: true,
      onHighlightClick: vi.fn(),
    });

    const row = await screen.findByTestId("linked-item-row-empty-note-h");
    expect(within(row).queryByTitle("Has note")).not.toBeInTheDocument();
    expect(
      await within(row).findByRole("textbox", { name: "Highlight note" }),
    ).toBeVisible();
    expect(
      within(row).queryByRole("button", { name: "Actions" }),
    ).not.toBeInTheDocument();
  });

  it("lets shared readers create their own linked note without highlight actions", async () => {
    const { host, contentRef } = createScrollableContent(
      '<p><span data-active-highlight-ids="shared-new-note-h"></span>shared note preview</p>',
    );
    host.setAttribute("data-test-scroll-host", "true");

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "shared-new-note-h",
          exact: "shared note preview",
          color: "yellow",
          is_owner: false,
          linked_note_blocks: [],
          anchor: {
            start_offset: 0,
            end_offset: 19,
          },
          created_at: "2026-01-01T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: "shared-new-note-h",
      isMobile: true,
      onHighlightClick: vi.fn(),
    });

    const row = await screen.findByTestId("linked-item-row-shared-new-note-h");
    expect(
      await within(row).findByRole("textbox", { name: "Highlight note" }),
    ).toBeVisible();
    expect(
      within(row).queryByRole("button", { name: "Actions" }),
    ).not.toBeInTheDocument();
  });

  it("on mobile, swaps rows as highlights move into and out of the reader viewport", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<p><span data-active-highlight-ids="above-h" data-testid="scroll-anchor-above"></span>above excerpt</p>',
        '<p><span data-active-highlight-ids="mid-h" data-testid="scroll-anchor-mid"></span>mid excerpt</p>',
        '<p><span data-active-highlight-ids="lower-h" data-testid="scroll-anchor-lower"></span>lower excerpt</p>',
      ].join(""),
    );
    host.scrollTop = 200;
    mockViewportTargets(host, contentRoot, {
      "scroll-anchor-above": { absoluteTop: 120 },
      "scroll-anchor-mid": { absoluteTop: 260 },
      "scroll-anchor-lower": { absoluteTop: 580 },
    });

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "above-h",
          exact: "above excerpt",
          color: "yellow",
          linked_note_blocks: [],
          anchor: {
            start_offset: 0,
            end_offset: 12,
          },
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "mid-h",
          exact: "mid excerpt",
          color: "green",
          linked_note_blocks: [],
          anchor: {
            start_offset: 20,
            end_offset: 31,
          },
          created_at: "2026-01-02T00:00:00Z",
        },
        {
          id: "lower-h",
          exact: "lower excerpt",
          color: "blue",
          linked_note_blocks: [],
          anchor: {
            start_offset: 40,
            end_offset: 53,
          },
          created_at: "2026-01-03T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: "mid-h",
      isMobile: true,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("linked-item-row-mid-h")).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("linked-item-row-lower-h"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 above" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 below" })).toBeInTheDocument();

    host.scrollTop = 540;
    fireEvent.scroll(host);

    await waitFor(() => {
      expect(screen.getByTestId("linked-item-row-lower-h")).toBeInTheDocument();
      expect(
        screen.queryByTestId("linked-item-row-mid-h"),
      ).not.toBeInTheDocument();
    });

    expect(
      within(screen.getByTestId("linked-item-row-lower-h")).getByRole(
        "button",
        { pressed: false },
      ),
    ).toHaveTextContent("lower excerpt");
    expect(
      screen.queryByRole("button", { pressed: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 above" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "1 below" }),
    ).not.toBeInTheDocument();
  });

  it("on mobile, shows No highlights in view when the contextual set is entirely offscreen", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<p><span data-active-highlight-ids="far-above-h" data-testid="empty-anchor-above"></span>far above excerpt</p>',
        '<p><span data-active-highlight-ids="far-below-h1" data-testid="empty-anchor-below-1"></span>far below excerpt 1</p>',
        '<p><span data-active-highlight-ids="far-below-h2" data-testid="empty-anchor-below-2"></span>far below excerpt 2</p>',
      ].join(""),
    );
    host.scrollTop = 300;
    mockViewportTargets(host, contentRoot, {
      "empty-anchor-above": { absoluteTop: 120 },
      "empty-anchor-below-1": { absoluteTop: 700 },
      "empty-anchor-below-2": { absoluteTop: 860 },
    });

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "far-above-h",
          exact: "far above excerpt",
          color: "yellow",
          linked_note_blocks: [],
          anchor: {
            start_offset: 0,
            end_offset: 17,
          },
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "far-below-h1",
          exact: "far below excerpt 1",
          color: "green",
          linked_note_blocks: [],
          anchor: {
            start_offset: 20,
            end_offset: 38,
          },
          created_at: "2026-01-02T00:00:00Z",
        },
        {
          id: "far-below-h2",
          exact: "far below excerpt 2",
          color: "blue",
          linked_note_blocks: [],
          anchor: {
            start_offset: 40,
            end_offset: 58,
          },
          created_at: "2026-01-03T00:00:00Z",
        },
      ] as never,
      contentRef,
      focusedId: null,
      isMobile: true,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      expect(screen.getByText("No highlights in view.")).toBeInTheDocument();
    });

    expect(getRowButtons()).toHaveLength(0);
    expect(
      screen.queryByTestId("linked-item-row-far-above-h"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("linked-item-row-far-below-h1"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("linked-item-row-far-below-h2"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 above" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 below" })).toBeInTheDocument();
  });

  it("uses stable_order_key for deterministic mobile row ordering", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<p><span data-active-highlight-ids="h-b" data-testid="stable-anchor-b"></span>row b ',
        '<span data-active-highlight-ids="h-a" data-testid="stable-anchor-a"></span>row a</p>',
      ].join(""),
    );
    host.scrollTop = 0;
    mockViewportTargets(host, contentRoot, {
      "stable-anchor-b": { absoluteTop: 40 },
      "stable-anchor-a": { absoluteTop: 40 },
    });

    renderAnchoredSecondaryPane({
      ...anchoredSecondaryPaneBaseProps,
      highlights: [
        {
          id: "h-b",
          exact: "row b",
          color: "yellow",
          linked_note_blocks: [],
          anchor: {
            start_offset: 100,
            end_offset: 120,
          },
          created_at: "2026-01-01T00:00:00Z",
          stable_order_key:
            "00000001:000000000100.000000:000000000072.000000:2026-01-01T00:00:00Z:h-b",
        },
        {
          id: "h-a",
          exact: "row a",
          color: "yellow",
          linked_note_blocks: [],
          anchor: {
            start_offset: 100,
            end_offset: 120,
          },
          created_at: "2026-01-01T00:00:00Z",
          stable_order_key:
            "00000001:000000000100.000000:000000000072.000000:2026-01-01T00:00:00Z:h-a",
        },
      ] as never,
      contentRef,
      focusedId: null,
      isMobile: true,
      onHighlightClick: vi.fn(),
    });

    await waitFor(() => {
      const rows = getRowButtons();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain("row a");
      expect(rows[1]?.textContent).toContain("row b");
    });
  });
});
