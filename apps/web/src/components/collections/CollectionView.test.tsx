import {
  useLayoutEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { absent, present } from "@/lib/api/presence";
import { decodePublicationDate } from "@/lib/dates/publicationDate";
import type { CollectionRowView } from "@/lib/collections/types";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ConnectionEndpointOut } from "@/lib/resourceGraph/connections";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import CollectionView from "./CollectionView";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000011");
const ORIGINAL_START_VIEW_TRANSITION = (
  document as Document & { startViewTransition?: unknown }
).startViewTransition;
const ORIGINAL_MATCH_MEDIA = window.matchMedia;

function installStartViewTransition() {
  const startViewTransition = vi.fn((callback: () => void | Promise<void>) => {
    const done = Promise.resolve().then(callback).then(() => undefined);
    return {
      ready: done,
      updateCallbackDone: done,
      finished: done,
      skipTransition: vi.fn(),
    };
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: startViewTransition,
  });
  return startViewTransition;
}

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

afterEach(() => {
  if (ORIGINAL_START_VIEW_TRANSITION === undefined) {
    Reflect.deleteProperty(document, "startViewTransition");
  } else {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: ORIGINAL_START_VIEW_TRANSITION,
    });
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
});

function PaneReturnTestHarness({ children }: { children: ReactNode }) {
  return (
    <PaneReturnMementoProvider>
      <PaneReturnVisitScope visitId={TEST_VISIT_ID} routeKey="/test">
        {children}
      </PaneReturnVisitScope>
    </PaneReturnMementoProvider>
  );
}

function render(ui: ReactElement) {
  return testingRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <PaneReturnTestHarness>
        <FeedbackProvider>
          <LibraryPlacementControllerProvider>
            <ShareControllerProvider>{children}</ShareControllerProvider>
          </LibraryPlacementControllerProvider>
        </FeedbackProvider>
      </PaneReturnTestHarness>
    ),
  });
}

const TEST_RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TEST_RESOURCE_TARGET = routeResourceActionSubject({
  scheme: "media",
  id: TEST_RESOURCE_ID,
  href: "/media/test",
});

function row(id: string, title: string): CollectionRowView {
  return {
    id,
    kind: "media",
    primary: { kind: "link", href: `/media/${id}` },
    title: { text: title },
    contributors: [],
    publicationDate: absent(),
    context: absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actionPublication: {
      kind: "ResourceMenu",
      target: TEST_RESOURCE_TARGET,
      groups: { core: [], operations: [], relationships: [], view: [] },
    },
    selected: false,
  };
}

const ROWS = [
  row("a", "First document"),
  row("b", "Second document"),
  row("c", "Third document"),
];

const contributor: ContributorCredit = {
  contributor_handle: "ada",
  contributor_display_name: "Ada Author",
  credited_name: "Ada Author",
  role: "author",
  href: "/authors/ada",
};

const connectedPeer: ConnectionEndpointOut = {
  ref: "media:peer-1",
  scheme: "media",
  id: "peer-1",
  label: "Connected document",
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

function renderView(props: Partial<Parameters<typeof CollectionView>[0]> = {}) {
  return render(
    <CollectionView
      returnScope="Test.Documents"
      rows={ROWS}
      status="ready"
      ariaLabel="Documents"
      surface={false}
      {...props}
    />,
  );
}

describe("canonical CollectionView", () => {
  it("uses one native list path without thumbnail, view, or density modes", () => {
    renderView();

    const list = screen.getByRole("list", { name: "Documents" });
    expect(list).toBeVisible();
    expect(list).not.toHaveAttribute("data-view");
    expect(list).not.toHaveAttribute("data-density");
    expect(
      screen.getByRole("link", { name: "First document" }),
    ).toHaveAttribute("href", "/media/a");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("commits a ready row order and set change in one view transition", async () => {
    installMatchMedia(false);
    const startViewTransition = installStartViewTransition();
    const view = renderView();
    const committedRows = [
      ROWS[2],
      ROWS[0],
      row("d", "Fourth document"),
    ];

    view.rerender(
      <CollectionView
        returnScope="Test.Documents"
        rows={committedRows}
        status="ready"
        ariaLabel="Documents"
        surface={false}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("link").map((link) => link.textContent),
      ).toEqual(["Third document", "First document", "Fourth document"]);
    });
    expect(screen.queryByRole("link", { name: "Second document" })).toBeNull();
    expect(startViewTransition).toHaveBeenCalledOnce();
  });

  it("commits a pure suffix without a view transition or moving focus", async () => {
    installMatchMedia(false);
    const startViewTransition = installStartViewTransition();
    const view = renderView({ rows: ROWS.slice(0, 2) });
    const firstLink = screen.getByRole("link", { name: "First document" });
    firstLink.focus();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    view.rerender(
      <CollectionView
        returnScope="Test.Documents"
        rows={ROWS}
        status="ready"
        ariaLabel="Documents"
        surface={false}
      />,
    );

    await screen.findByRole("link", { name: "Third document" });
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(firstLink).toHaveFocus();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("coalesces a row removal and pending suffix into one transition", async () => {
    installMatchMedia(false);
    const startViewTransition = installStartViewTransition();
    const view = renderView({ collectionBusy: true });

    view.rerender(
      <CollectionView
        returnScope="Test.Documents"
        rows={ROWS.slice(1)}
        status="ready"
        ariaLabel="Documents"
        collectionBusy
        surface={false}
      />,
    );
    view.rerender(
      <CollectionView
        returnScope="Test.Documents"
        rows={[...ROWS.slice(1), row("d", "Fourth document")]}
        status="ready"
        ariaLabel="Documents"
        collectionBusy
        surface={false}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("link").map((link) => link.textContent),
      ).toEqual(["Second document", "Third document", "Fourth document"]);
    });
    expect(startViewTransition).toHaveBeenCalledOnce();
  });

  it("puts collection busy state on the native list", () => {
    renderView({ collectionBusy: true });

    expect(screen.getByRole("list", { name: "Documents" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("starts the committed-row transition during layout before an intermediate paint", async () => {
    installMatchMedia(false);
    const startViewTransition = installStartViewTransition();
    const transitionCallsSeenDuringLayout: number[] = [];
    const committedRows = [
      ROWS[2],
      ROWS[0],
      row("d", "Fourth document"),
    ];
    const Probe = ({ rows }: { rows: readonly CollectionRowView[] }) => {
      useLayoutEffect(() => {
        transitionCallsSeenDuringLayout.push(
          startViewTransition.mock.calls.length,
        );
      });
      return (
        <CollectionView
          returnScope="Test.Documents"
          rows={rows}
          status="ready"
          ariaLabel="Documents"
          surface={false}
        />
      );
    };
    const view = render(<Probe rows={ROWS} />);

    view.rerender(<Probe rows={committedRows} />);

    expect(transitionCallsSeenDuringLayout.at(-1)).toBe(1);
    await waitFor(() => {
      expect(
        screen.getAllByRole("link").map((link) => link.textContent),
      ).toEqual(["Third document", "First document", "Fourth document"]);
    });
    expect(startViewTransition).toHaveBeenCalledOnce();
  });

  it("commits the same ready row change without motion when reduced", async () => {
    installMatchMedia(true);
    const startViewTransition = installStartViewTransition();
    const view = renderView();
    const committedRows = [
      ROWS[2],
      ROWS[0],
      row("d", "Fourth document"),
    ];

    view.rerender(
      <CollectionView
        returnScope="Test.Documents"
        rows={committedRows}
        status="ready"
        ariaLabel="Documents"
        surface={false}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("link").map((link) => link.textContent),
      ).toEqual(["Third document", "First document", "Fourth document"]);
    });
    expect(screen.queryByRole("link", { name: "Second document" })).toBeNull();
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("renders contributors, partial date, and context as one sibling support line", () => {
    renderView({
      rows: [
        {
          ...ROWS[0],
          contributors: [contributor],
          publicationDate: present(decodePublicationDate("2025-02", "date")),
          context: present({ kind: "Text", text: "A compact context" }),
        },
      ],
      rowControls: { a: <button type="button">Primary control</button> },
    });

    const title = screen.getByRole("link", { name: "First document" });
    const contributorLink = screen.getByRole("link", { name: "Ada Author" });
    const date = screen.getByText("February 2025");
    expect(title).not.toContainElement(contributorLink);
    expect(screen.getByRole("listitem")).toHaveTextContent(
      /Ada Author.*February 2025.*A compact context/,
    );
    expect(getComputedStyle(contributorLink).fontSize).toBe(
      getComputedStyle(date).fontSize,
    );
    expect(getComputedStyle(contributorLink).lineHeight).toBe(
      getComputedStyle(date).lineHeight,
    );
    expect(getComputedStyle(contributorLink).color).toBe(
      getComputedStyle(date).color,
    );
  });

  it("keeps native Tab order: title, contributor, primary control, menu", async () => {
    const user = userEvent.setup();
    renderView({
      rows: [
        {
          ...ROWS[0],
          contributors: [contributor],
          actionPublication: {
            kind: "ResourceMenu",
            target: TEST_RESOURCE_TARGET,
            groups: {
              core: [],
              operations: [
                {
                  kind: "command",
                  id: "archive",
                  label: "Archive",
                  onSelect: vi.fn(),
                },
              ],
              relationships: [],
              view: [],
            },
          },
        },
      ],
      rowControls: { a: <button type="button">Primary control</button> },
    });

    await user.tab();
    expect(screen.getByRole("link", { name: "First document" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Ada Author" })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Primary control" }),
    ).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "More actions for First document" }),
    ).toHaveFocus();
  });

  it("gives exceptional operation status priority over normal activity", () => {
    renderView({
      rows: [
        {
          ...ROWS[0],
          activity: present({ kind: "Finished", modality: "Read" }),
          exceptionalStatus: present({
            kind: "MediaProcessing",
            status: "failed",
          }),
        },
      ],
    });

    expect(screen.getByText("Processing failed")).toBeVisible();
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("reveals connections through the overflow instead of a standing button", async () => {
    const user = userEvent.setup();
    renderView({
      rows: [
        {
          ...ROWS[0],
          connections: present({
            total: 1,
            dominantKind: absent(),
            topPeers: [connectedPeer],
          }),
        },
      ],
    });

    expect(screen.queryByRole("button", { name: /connected/i })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "More actions for First document" }),
    );
    await user.click(
      await screen.findByRole("menuitem", {
        name: "Show connections and related",
      }),
    );
    expect(
      await screen.findByRole("link", { name: "Connected document" }),
    ).toHaveAttribute("href", "/media/peer-1");
  });

  it("uses the ellipsis as both menu trigger and drag activator", async () => {
    const onReorder = vi.fn();

    function Harness() {
      const [rows, setRows] = useState(ROWS);
      return (
        <CollectionView
          returnScope="Test.Documents"
          rows={rows}
          status="ready"
          ariaLabel="Documents"
          surface={false}
          sortable={{
            onReorder: (nextRows) => {
              onReorder(nextRows);
              setRows(nextRows);
            },
          }}
        />
      );
    }

    render(<Harness />);
    const firstTrigger = screen.getByRole("button", {
      name: "More actions for First document",
    });
    expect(firstTrigger).toHaveAttribute("data-sortable-activator", "true");
    expect(firstTrigger).toHaveAttribute(
      "aria-keyshortcuts",
      "Alt+ArrowUp Alt+ArrowDown",
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);

    await userEvent.setup().click(firstTrigger);
    expect(
      await screen.findByRole("menuitem", { name: "Move up" }),
    ).toHaveAttribute("aria-disabled", "true");
    await userEvent
      .setup()
      .click(screen.getByRole("menuitem", { name: "Move down" }));

    await waitFor(() =>
      expect(
        screen.getAllByRole("link").map((link) => link.textContent),
      ).toEqual(["Second document", "First document", "Third document"]),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Moved to position 2 of 3",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "More actions for First document",
        }),
      ).toHaveFocus(),
    );

    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "More actions for First document",
      }),
    );
    await userEvent
      .setup()
      .click(screen.getByRole("menuitem", { name: "Move up" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("link").map((link) => link.textContent),
      ).toEqual(["First document", "Second document", "Third document"]),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Moved to position 1 of 3",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "More actions for First document",
        }),
      ).toHaveFocus(),
    );

    await userEvent.setup().keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() =>
      expect(
        screen.getAllByRole("link").map((link) => link.textContent),
      ).toEqual(["Second document", "First document", "Third document"]),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Moved to position 2 of 3",
    );
    expect(
      screen.getByRole("button", {
        name: "More actions for First document",
      }),
    ).toHaveFocus();

    const dragSource = screen.getByRole("button", {
      name: "More actions for First document",
    });
    const dragTarget = screen.getByRole("button", {
      name: "More actions for Third document",
    });
    const sourceRect = dragSource.getBoundingClientRect();
    const targetRect = dragTarget.getBoundingClientRect();
    const sourceX = sourceRect.left + sourceRect.width / 2;
    const sourceY = sourceRect.top + sourceRect.height / 2;
    const targetX = targetRect.left + targetRect.width / 2;
    const targetY = targetRect.top + targetRect.height / 2;
    fireEvent.mouseDown(dragSource, {
      button: 0,
      buttons: 1,
      clientX: sourceX,
      clientY: sourceY,
    });
    fireEvent.mouseMove(document, {
      buttons: 1,
      clientX: sourceX,
      clientY: sourceY + 7,
    });
    expect(onReorder).toHaveBeenCalledTimes(3);
    expect(screen.getAllByRole("listitem")[1]).toHaveAttribute(
      "data-dragging",
      "false",
    );
    fireEvent.mouseMove(document, {
      buttons: 1,
      clientX: targetX,
      clientY: targetY,
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    fireEvent.mouseMove(document, {
      buttons: 1,
      clientX: targetX,
      clientY: targetY,
    });
    fireEvent.mouseUp(document, {
      button: 0,
      clientX: targetX,
      clientY: targetY,
    });
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(4));
    fireEvent.click(dragSource);
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Moved to position 3 of 3",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "More actions for First document",
        }),
      ).toHaveFocus(),
    );

    await new Promise((resolve) => window.setTimeout(resolve, 60));
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "More actions for First document",
      }),
    );
    expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByRole("menuitem", { name: /top|bottom/i })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), {
      key: "Escape",
      code: "Escape",
    });
  });

  it("keeps sub-threshold clicks and Escape cancellation on the same trigger", async () => {
    const onReorder = vi.fn();
    renderView({ rows: ROWS, sortable: { onReorder } });
    const trigger = screen.getByRole("button", {
      name: "More actions for First document",
    });
    const rect = trigger.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    fireEvent.mouseDown(trigger, {
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    });
    fireEvent.mouseMove(document, { buttons: 1, clientX: x, clientY: y + 7 });
    fireEvent.mouseUp(document, { button: 0, clientX: x, clientY: y + 7 });
    fireEvent.click(trigger);
    expect(
      await screen.findByRole("menuitem", { name: "Move down" }),
    ).toBeVisible();
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("menu"), {
      key: "Escape",
      code: "Escape",
    });

    fireEvent.mouseDown(trigger, {
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    });
    fireEvent.mouseMove(document, { buttons: 1, clientX: x, clientY: y + 9 });
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
        "data-dragging",
        "true",
      ),
    );
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
        "data-dragging",
        "false",
      ),
    );
    expect(onReorder).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("requires a 250ms touch hold and cancels a scrolling gesture", async () => {
    const onReorder = vi.fn();

    function Harness() {
      const [rows, setRows] = useState(ROWS);
      return (
        <CollectionView
          returnScope="Test.Documents"
          rows={rows}
          status="ready"
          ariaLabel="Documents"
          surface={false}
          sortable={{
            onReorder: (nextRows) => {
              onReorder(nextRows);
              setRows(nextRows);
            },
          }}
        />
      );
    }

    render(<Harness />);
    const source = screen.getByRole("button", {
      name: "More actions for First document",
    });
    const target = screen.getByRole("button", {
      name: "More actions for Third document",
    });
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const sourceX = sourceRect.left + sourceRect.width / 2;
    const sourceY = sourceRect.top + sourceRect.height / 2;
    const targetX = targetRect.left + targetRect.width / 2;
    const targetY = targetRect.top + targetRect.height / 2;
    const touch = (clientX: number, clientY: number) =>
      new Touch({
        identifier: 1,
        clientX,
        clientY,
        pageX: clientX,
        pageY: clientY,
        screenX: clientX,
        screenY: clientY,
        target: source,
      });

    fireEvent.touchStart(source, { touches: [touch(sourceX, sourceY)] });
    const scrollGestureWasNotCancelled = fireEvent.touchMove(source, {
      touches: [touch(sourceX, sourceY + 9)],
    });
    expect(scrollGestureWasNotCancelled).toBe(true);
    fireEvent.touchEnd(source, {
      touches: [],
      changedTouches: [touch(sourceX, sourceY + 9)],
    });
    await new Promise((resolve) => window.setTimeout(resolve, 275));
    expect(onReorder).not.toHaveBeenCalled();

    fireEvent.touchStart(source, { touches: [touch(sourceX, sourceY)] });
    await new Promise((resolve) => window.setTimeout(resolve, 275));
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
        "data-dragging",
        "true",
      ),
    );
    fireEvent.touchMove(source, {
      touches: [touch(targetX, targetY)],
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    fireEvent.touchMove(source, {
      touches: [touch(targetX, targetY)],
    });
    fireEvent.touchEnd(source, {
      touches: [],
      changedTouches: [touch(targetX, targetY)],
    });
    await waitFor(() => expect(onReorder).toHaveBeenCalledOnce());
    fireEvent.click(source);
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Moved to position 3 of 3",
      ),
    );
    await waitFor(() => expect(source).toHaveFocus());
  });

  it("disables only reorder while leaving unrelated menu actions available", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    const onArchive = vi.fn();
    renderView({
      rows: [
        {
          ...ROWS[0],
          actionPublication: {
            kind: "ResourceMenu",
            target: TEST_RESOURCE_TARGET,
            groups: {
              core: [],
              operations: [
                {
                  kind: "command",
                  id: "archive",
                  label: "Archive",
                  onSelect: onArchive,
                },
              ],
              relationships: [],
              view: [],
            },
          },
        },
      ],
      sortable: { disabled: true, onReorder },
    });

    const trigger = screen.getByRole("button", {
      name: "More actions for First document",
    });
    expect(trigger).not.toHaveAttribute("aria-keyshortcuts");
    expect(trigger).not.toHaveAttribute("aria-describedby");
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledOnce();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("renders loading, error, and empty ownership without row chrome", () => {
    const view = renderView({ status: "loading", rows: [] });
    expect(screen.getByText("Loading Documents…")).toBeVisible();

    view.rerender(
      <CollectionView
        returnScope="Test.Documents"
        rows={[]}
        status="error"
        ariaLabel="Documents"
        error={<p>Could not load</p>}
        surface={false}
      />,
    );
    expect(screen.getByText("Could not load")).toBeVisible();

    view.rerender(
      <CollectionView
        returnScope="Test.Documents"
        rows={[]}
        status="ready"
        ariaLabel="Documents"
        empty={<p>No documents</p>}
        surface={false}
      />,
    );
    expect(screen.getByText("No documents")).toBeVisible();
  });
});
