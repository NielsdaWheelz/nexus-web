import { useEffect, useMemo, type ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ActiveMobileSecondaryPaneHost from "@/components/workspace/MobileSecondaryPaneHost";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  MobileChromeProvider,
  useMobileChrome,
} from "@/lib/workspace/mobileChrome";

const publication = {
  groupId: "conversation-context" as const,
  defaultSurfaceId: "conversation-context-refs" as const,
  surfaces: [
    {
      id: "conversation-context-refs" as const,
      body: <button type="button">Context ref action</button>,
    },
    { id: "conversation-forks" as const, body: <div>Forks body</div> },
  ],
};

const secondary = {
  groupId: "conversation-context" as const,
  activeSurfaceId: "conversation-context-refs" as const,
  widthPx: 320,
  visibility: "visible" as const,
};

const readerPublication = {
  groupId: "reader-tools" as const,
  defaultSurfaceId: "reader-contents" as const,
  surfaces: [{ id: "reader-contents" as const, body: <div>Contents body</div> }],
};

const readerSecondary = {
  groupId: "reader-tools" as const,
  activeSurfaceId: "reader-contents" as const,
  widthPx: 360,
  visibility: "visible" as const,
};

function MobileChromePublisher({
  paneId,
  options,
}: {
  paneId: string;
  options: readonly ActionDescriptor[];
}) {
  const { setPaneChrome } = useMobileChrome();
  const chrome = useMemo(
    () => ({
      paneId,
      identityId: `${paneId}-identity`,
      header: {
        kind: "section" as const,
        standingHead: "Libraries",
        folio: { kind: "none" as const },
        pending: false,
      },
      navigation: {
        canGoBack: false,
        canGoForward: false,
        onBack: () => {},
        onForward: () => {},
      },
      options,
    }),
    [options, paneId],
  );
  useEffect(() => {
    setPaneChrome(chrome);
    return () => setPaneChrome(null);
  }, [chrome, setPaneChrome]);
  return null;
}

type TestHostProps = ComponentProps<typeof ActiveMobileSecondaryPaneHost> & {
  options: readonly ActionDescriptor[];
};

function MobileSecondaryPaneHost({ options, ...props }: TestHostProps) {
  return withRenderEnvironment(
    <MobileChromeProvider>
      <MobileChromePublisher paneId={props.primaryPaneId} options={options} />
      <ActiveMobileSecondaryPaneHost {...props} />
    </MobileChromeProvider>,
    { initialViewport: "mobile" },
  );
}

describe("MobileSecondaryPaneHost", () => {
  // Model history locally (MobileSheet.test.tsx pattern) so the sheet's
  // history-dismiss bookkeeping never touches the real history stack.
  let fakeState: unknown = null;

  beforeEach(() => {
    fakeState = null;
    vi.spyOn(history, "pushState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "replaceState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      fakeState = null;
    });
    vi.spyOn(history, "state", "get").mockImplementation(() => fakeState);
  });

  afterEach(() => {
    document.body.style.overflow = "";
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("locks body scroll, focuses the active tab, closes on Escape, and restores focus", async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Return target</button>
        <MobileSecondaryPaneHost
          primaryPaneId="pane-1"
          secondaryPaneId="secondary-1"
          secondary={secondary}
          publication={publication}
          onClose={onClose}
          onActiveSurfaceChange={vi.fn()}
          returnFocusTo={() => null}
          options={[]}
        />
      </>,
    );
    screen.getByRole("button", { name: "Return target" }).focus();

    const dialog = screen.getByRole("dialog", { name: "Context" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Context" })).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("secondary-1");
  });

  it("returns focus and restores body scroll on unmount", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Opener";
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <MobileSecondaryPaneHost
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        secondary={secondary}
        publication={publication}
        onClose={vi.fn()}
        onActiveSurfaceChange={vi.fn()}
        returnFocusTo={() => null}
        options={[]}
      />,
    );

    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("uses roving focus for mobile secondary tabs", () => {
    const onActiveSurfaceChange = vi.fn();
    render(
      <MobileSecondaryPaneHost
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        secondary={secondary}
        publication={publication}
        onClose={vi.fn()}
        onActiveSurfaceChange={onActiveSurfaceChange}
        returnFocusTo={() => null}
        options={[]}
      />,
    );

    const contextRefsTab = screen.getByRole("tab", { name: "Context" });
    const forksTab = screen.getByRole("tab", { name: "Forks" });
    expect(contextRefsTab).toHaveAttribute("tabIndex", "0");
    expect(forksTab).toHaveAttribute("tabIndex", "-1");
    const contextPanel = screen.getByRole("tabpanel", { name: "Context" });
    const forksPanel = screen
      .getAllByRole("tabpanel", { hidden: true })
      .find((panel) => panel.id === forksTab.getAttribute("aria-controls"));
    expect(forksPanel).toBeDefined();
    expect(contextPanel.id).toBe(contextRefsTab.getAttribute("aria-controls"));
    expect(contextPanel).not.toHaveAttribute("hidden");
    expect(forksPanel!).toHaveAttribute("hidden");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      contextRefsTab.id,
    );

    fireEvent.keyDown(contextRefsTab, { key: "ArrowRight" });
    expect(onActiveSurfaceChange).toHaveBeenCalledWith(
      "secondary-1",
      "conversation-forks",
    );
  });

  it("renders reader Contents with the mobile secondary icon map", () => {
    render(
      <MobileSecondaryPaneHost
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        secondary={readerSecondary}
        publication={readerPublication}
        onClose={vi.fn()}
        onActiveSurfaceChange={vi.fn()}
        returnFocusTo={() => null}
        options={[]}
      />,
    );

    expect(screen.getByRole("tab", { name: "Contents" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Contents" })).toHaveAttribute(
      "id",
      "pane-pane-1-secondary-reader-tools",
    );
  });

  it("keeps the expanded pane action reachable inside the modal subtree", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn(() => onClose("secondary-1"));
    render(
      <MobileSecondaryPaneHost
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        secondary={readerSecondary}
        publication={readerPublication}
        onClose={onClose}
        onActiveSurfaceChange={vi.fn()}
        returnFocusTo={() => null}
        options={[
          {
            kind: "command",
            id: "document-map",
            label: "Document Map",
            state: {
              kind: "disclosure",
              expanded: true,
              controls: "pane-pane-1-secondary-reader-tools",
              menuLabels: {
                collapsed: "Show Document Map",
                expanded: "Hide Document Map",
              },
            },
            onSelect,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pane options" }));
    const hideItem = await screen.findByRole("menuitem", {
      name: "Hide Document Map",
    });
    const dialog = screen.getByRole("dialog", { name: "Contents" });
    expect(dialog).toContainElement(hideItem);
    expect(hideItem).not.toHaveAttribute("aria-expanded");
    expect(hideItem).not.toHaveAttribute("aria-controls");

    fireEvent.keyDown(hideItem, { key: "Escape" });
    expect(
      screen.queryByRole("menuitem", { name: "Hide Document Map" }),
    ).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Pane options" }));

    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Hide Document Map" }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("secondary-1");
  });

  it("returns to the explicit Options trigger, then falls back to pane chrome", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Options";
    document.body.append(trigger);
    trigger.focus();

    const props = {
      primaryPaneId: "pane-1",
      secondaryPaneId: "secondary-1",
      publication: readerPublication,
      onClose: vi.fn(),
      onActiveSurfaceChange: vi.fn(),
    };
    const { rerender } = render(
      <MobileSecondaryPaneHost
        {...props}
        secondary={readerSecondary}
        returnFocusTo={() => trigger}
        options={[]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Contents" })).toHaveFocus(),
    );
    rerender(
      <MobileSecondaryPaneHost
        {...props}
        secondary={{ ...readerSecondary, visibility: "collapsed" }}
        returnFocusTo={() => trigger}
        options={[]}
      />,
    );
    await waitFor(() => expect(trigger).toHaveFocus());

    trigger.focus();
    rerender(
      <>
        <div data-pane-chrome-for="pane-1">
          <button data-pane-options-trigger="pane-1">Projected Options</button>
        </div>
        <div data-pane-id="pane-1">
          <div data-pane-chrome-focus="true" tabIndex={-1} />
          <MobileSecondaryPaneHost
            {...props}
            secondary={readerSecondary}
            returnFocusTo={() => trigger}
            options={[]}
          />
        </div>
      </>,
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Contents" })).toHaveFocus(),
    );
    trigger.remove();
    rerender(
      <>
        <div data-pane-chrome-for="pane-1">
          <button data-pane-options-trigger="pane-1">Projected Options</button>
        </div>
        <div data-pane-id="pane-1">
          <div data-pane-chrome-focus="true" tabIndex={-1} />
          <MobileSecondaryPaneHost
            {...props}
            secondary={{ ...readerSecondary, visibility: "collapsed" }}
            returnFocusTo={() => trigger}
            options={[]}
          />
        </div>
      </>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Projected Options" }),
      ).toHaveFocus(),
    );
  });

  it("browser back (popstate) closes the sheet exactly once without popping again", async () => {
    const onClose = vi.fn();
    render(
      <MobileSecondaryPaneHost
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        secondary={secondary}
        publication={publication}
        onClose={onClose}
        onActiveSurfaceChange={vi.fn()}
        returnFocusTo={() => null}
        options={[]}
      />,
    );
    expect(history.pushState).toHaveBeenCalledTimes(1);

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await act(async () => {
      await Promise.resolve(); // drain the deferred-pop microtask (useHistoryDismiss)
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("secondary-1");
    expect(history.back).not.toHaveBeenCalled();
  });

  it("routes successive Back presses through the modal-local menu, then the sheet", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <MobileSecondaryPaneHost
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        secondary={readerSecondary}
        publication={readerPublication}
        onClose={onClose}
        onActiveSurfaceChange={vi.fn()}
        returnFocusTo={() => null}
        options={[
          {
            kind: "command",
            id: "credits",
            label: "Credits…",
            onSelect,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pane options" }));
    expect(
      await screen.findByRole("menuitem", { name: "Credits…" }),
    ).toBeInTheDocument();
    expect(history.pushState).toHaveBeenCalledTimes(1);

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await act(async () => Promise.resolve());
    expect(
      screen.queryByRole("menuitem", { name: "Credits…" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Contents" })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await act(async () => Promise.resolve());
    expect(onClose).toHaveBeenCalledWith("secondary-1");
  });

  it("panel --keyboard-inset reflects the stubbed keyboard", () => {
    const vv = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    vv.height = window.innerHeight - 300;
    vv.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });

    render(
      <MobileSecondaryPaneHost
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        secondary={secondary}
        publication={publication}
        onClose={vi.fn()}
        onActiveSurfaceChange={vi.fn()}
        returnFocusTo={() => null}
        options={[]}
      />,
    );

    const panel = screen.getByTestId("mobile-secondary-host");
    expect(panel.style.getPropertyValue("--keyboard-inset")).toBe("300px");

    act(() => {
      vv.height = window.innerHeight;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(panel.style.getPropertyValue("--keyboard-inset")).toBe("0px");
  });
});
