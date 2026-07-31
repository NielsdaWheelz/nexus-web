import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import MobilePaneBar from "./MobilePaneBar";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import {
  MobileChromeProvider,
  useMobileChrome,
  useMobileChromeReaderScrollport,
} from "@/lib/workspace/mobileChrome";
import type { TargetLinkMouseEvent } from "@/lib/panes/targetLinkActivation";

const noopActivateIdentityAnchor = () => {};

function PublishChrome() {
  const { setPaneChrome } = useMobileChrome();
  useEffect(() => {
    setPaneChrome({
      paneId: "pane-a",
      routeKey: "libraries:/libraries",
      identityId: "pane-a-identity",
      header: {
        kind: "section",
        standingHead: "Libraries",
        folio: { kind: "count", value: 37, unit: "source" },
        pending: false,
      },
      activateIdentityAnchor: noopActivateIdentityAnchor,
      navigation: {
        canGoBack: false,
        canGoForward: false,
        onBack: () => {},
        onForward: () => {},
      },
      actions: [],
      options: [],
    });
    return () => setPaneChrome(null);
  }, [setPaneChrome]);
  return null;
}

function PublishActiveFilterChrome() {
  const { setPaneChrome } = useMobileChrome();
  useEffect(() => {
    setPaneChrome({
      paneId: "pane-a",
      routeKey: "libraries:/libraries",
      identityId: "pane-a-identity",
      header: {
        kind: "section",
        standingHead: "Libraries",
        folio: { kind: "count", value: 37, unit: "source" },
        pending: false,
      },
      activateIdentityAnchor: noopActivateIdentityAnchor,
      navigation: {
        canGoBack: false,
        canGoForward: false,
        onBack: () => {},
        onForward: () => {},
      },
      actions: [
        {
          kind: "command",
          id: "Pane.Search",
          label: "Filter, 2 controls active",
          indicator: { kind: "Status" },
          icon: <span aria-hidden="true">filter</span>,
          state: {
            kind: "disclosure",
            expanded: false,
            menuLabels: {
              collapsed: "Filter, 2 controls active",
              expanded: "Close filter",
            },
          },
          onSelect: () => {},
        },
      ],
      options: [],
    });
    return () => setPaneChrome(null);
  }, [setPaneChrome]);
  return null;
}

function PublishResourceChrome({
  activateIdentityAnchor = noopActivateIdentityAnchor,
}: {
  activateIdentityAnchor?: (
    event: TargetLinkMouseEvent,
    anchor: HTMLAnchorElement,
  ) => void;
}) {
  const { setPaneChrome } = useMobileChrome();
  useEffect(() => {
    setPaneChrome({
      paneId: "pane-media",
      routeKey: "media:/media/media-a",
      identityId: "pane-media-identity",
      header: {
        kind: "resource",
        resource: {
          status: "ready",
          title: "The Left Hand of Darkness",
          creditGroups: [
            {
              kind: "authors",
              credits: [
                {
                  label: "Ursula K. Le Guin",
                  href: "/authors/ursula-k-le-guin",
                },
              ],
            },
          ],
        },
      },
      activateIdentityAnchor,
      navigation: {
        canGoBack: false,
        canGoForward: false,
        onBack: () => {},
        onForward: () => {},
      },
      actions: [
        {
          kind: "command",
          id: "resource-inspector-companion",
          label: "Companion",
          icon: <span aria-hidden="true">panel</span>,
          onSelect: () => {},
        },
      ],
      options: [
        {
          kind: "command",
          id: "credits",
          label: "Credits",
          onSelect: () => {},
        },
      ],
    });
    return () => setPaneChrome(null);
  }, [activateIdentityAnchor, setPaneChrome]);
  return null;
}

function PublishNavigationChrome({
  onBack,
  onForward,
}: {
  onBack: (modality: "Keyboard" | "Pointer") => void;
  onForward: (modality: "Keyboard" | "Pointer") => void;
}) {
  const { setPaneChrome } = useMobileChrome();
  useEffect(() => {
    setPaneChrome({
      paneId: "pane-a",
      routeKey: "libraries:/libraries",
      identityId: "pane-a-identity",
      header: {
        kind: "section",
        standingHead: "Libraries",
        folio: { kind: "none" },
        pending: false,
      },
      activateIdentityAnchor: noopActivateIdentityAnchor,
      navigation: {
        canGoBack: true,
        canGoForward: true,
        onBack,
        onForward,
      },
      actions: [],
      options: [],
    });
    return () => setPaneChrome(null);
  }, [onBack, onForward, setPaneChrome]);
  return null;
}

function CollapseChrome() {
  const registerScrollport = useMobileChromeReaderScrollport<HTMLDivElement>({
    sourceKey: "mobile-pane-bar-collapse",
    enabled: true,
  });
  return (
    <>
      <div
        ref={registerScrollport}
        data-testid="collapse-scrollport"
        style={{ height: 100, overflowY: "auto" }}
      >
        <div style={{ height: 1_000 }} />
      </div>
      <button
        type="button"
        onClick={() => {
          const scrollport = screen.getByTestId("collapse-scrollport");
          scrollport.scrollTop = 9;
          fireEvent.scroll(scrollport);
          scrollport.scrollTop = 100;
          fireEvent.scroll(scrollport);
        }}
      >
        Collapse chrome
      </button>
    </>
  );
}

function TrackChrome() {
  const registerScrollport = useMobileChromeReaderScrollport<HTMLDivElement>({
    sourceKey: "mobile-pane-bar-track",
    enabled: true,
  });
  return (
    <>
      <div
        ref={registerScrollport}
        data-testid="track-scrollport"
        style={{ height: 100, overflowY: "auto" }}
      >
        <div style={{ height: 1_000 }} />
      </div>
      <button
        type="button"
        onClick={() => {
          const scrollport = screen.getByTestId("track-scrollport");
          scrollport.scrollTop = 9;
          fireEvent.scroll(scrollport);
          scrollport.scrollTop = 40;
          fireEvent.scroll(scrollport);
        }}
      >
        Track chrome
      </button>
    </>
  );
}

function MotionPhase() {
  const { motionPhase } = useMobileChrome();
  return <output data-testid="motion-phase">{motionPhase.kind}</output>;
}

describe("MobilePaneBar", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the active pane's running head (standing head + folio)", () => {
    render(
      <MobileChromeProvider>
        <PublishChrome />
        <MobilePaneBar />
      </MobileChromeProvider>,
    );

    expect(screen.getByText("Libraries")).toBeInTheDocument();
    expect(screen.getByText("37 sources")).toBeInTheDocument();
  });

  it("marks and names Options when the collapsed Filter has active controls", () => {
    render(
      <MobileChromeProvider>
        <PublishActiveFilterChrome />
        <MobilePaneBar />
      </MobileChromeProvider>,
    );

    const options = screen.getByRole("button", {
      name: "Pane options, Filter, 2 controls active",
    });
    expect(options).toBeVisible();
    expect(screen.getByTestId("pane-filter-active-marker")).toBeVisible();

    fireEvent.click(options);
    expect(
      screen.getByRole("menuitem", {
        name: "Filter, 2 controls active",
      }),
    ).toBeVisible();
  });

  it("keeps Back in chrome and moves Forward into the pane menu", () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    render(
      <MobileChromeProvider>
        <PublishNavigationChrome onBack={onBack} onForward={onForward} />
        <MobilePaneBar />
      </MobileChromeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Go back" }), {
      detail: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Pane options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Go forward" }));
    expect(onBack).toHaveBeenCalledWith("Pointer");
    expect(onForward).toHaveBeenCalledWith("Pointer");
  });

  it("renders the active pane's resource identity from the shared model", () => {
    render(
      <MobileChromeProvider>
        <PublishResourceChrome />
        <MobilePaneBar />
      </MobileChromeProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "The Left Hand of Darkness" }),
    ).toHaveAttribute("id", "pane-media-identity");
    const bar = screen.getByRole("banner");
    expect(bar).toHaveAttribute("data-header-kind", "resource");
    expect(bar).toHaveAttribute("data-pane-chrome-for", "pane-media");
  });

  it("delegates identity-link activation to the active pane", () => {
    const activateIdentityAnchor = vi.fn(
      (event: TargetLinkMouseEvent, anchor: HTMLAnchorElement) => {
        event.preventDefault();
        return anchor;
      },
    );
    render(
      <MobileChromeProvider>
        <PublishResourceChrome
          activateIdentityAnchor={activateIdentityAnchor}
        />
        <MobilePaneBar />
      </MobileChromeProvider>,
    );

    const link = screen.getByRole("link", { name: "Ursula K. Le Guin" });
    fireEvent.click(link, { detail: 1 });

    expect(activateIdentityAnchor).toHaveBeenCalledOnce();
    expect(activateIdentityAnchor.mock.calls[0]?.[1]).toBe(link);
  });

  it("removes the entire AppBar surface from interaction when hidden", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("max-width"),
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );

    render(
      withRenderEnvironment(
        <MobileChromeProvider>
          <PublishResourceChrome />
          <CollapseChrome />
          <MobilePaneBar />
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      ),
    );

    const navigation = screen.getByRole("banner");
    fireEvent.click(screen.getByRole("button", { name: "Collapse chrome" }));
    await waitFor(() =>
      expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Hidden"),
    );
    expect(navigation).toHaveAttribute("aria-hidden", "true");
    expect(navigation).toHaveAttribute("inert");
    expect(navigation).toHaveStyle({ pointerEvents: "none" });
    expect(
      screen.queryByRole("heading", {
        level: 1,
        name: "The Left Hand of Darkness",
      }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Pane options" })).toBeNull();
  });

  it("removes the entire AppBar surface from interaction while tracking and settling", () => {
    vi.useFakeTimers();
    vi.stubGlobal("innerWidth", 390);
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("max-width"),
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );

    render(
      withRenderEnvironment(
        <MobileChromeProvider>
          <PublishChrome />
          <TrackChrome />
          <MobilePaneBar />
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      ),
    );

    const navigation = screen.getByRole("banner");
    fireEvent.click(screen.getByRole("button", { name: "Track chrome" }));
    expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Tracking");
    expect(navigation).toHaveAttribute("aria-hidden", "true");
    expect(navigation).toHaveAttribute("inert");
    expect(navigation).toHaveStyle({ pointerEvents: "none" });
    expect(screen.queryByRole("button", { name: "Pane options" })).toBeNull();

    act(() => vi.advanceTimersByTime(120));

    expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Settling");
    expect(navigation).toHaveAttribute("aria-hidden", "true");
    expect(navigation).toHaveAttribute("inert");
    expect(navigation).toHaveStyle({ pointerEvents: "none" });
    expect(screen.queryByRole("button", { name: "Pane options" })).toBeNull();
  });

  it("pins visible controls while focus remains in the chrome", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("max-width"),
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );

    render(
      withRenderEnvironment(
        <MobileChromeProvider>
          <PublishResourceChrome />
          <CollapseChrome />
          <MobilePaneBar />
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      ),
    );

    const navigation = screen.getByRole("banner");
    const options = screen.getByRole("button", { name: "Pane options" });
    options.focus();

    await waitFor(() =>
      expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Pinned"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse chrome" }));
    expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
    expect(options).toBeVisible();

    options.blur();
    await waitFor(() =>
      expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Visible"),
    );
  });

  it("releases an open action-menu lock when the top bar unmounts", async () => {
    vi.stubGlobal("innerWidth", 390);
    const tree = (showTopBar: boolean) =>
      withRenderEnvironment(
        <MobileChromeProvider>
          <PublishResourceChrome />
          <CollapseChrome />
          <MotionPhase />
          {showTopBar ? (
            <MobilePaneBar />
          ) : null}
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      );
    const view = render(tree(true));

    fireEvent.click(screen.getByRole("button", { name: "Pane options" }));
    await waitFor(() =>
      expect(screen.getByTestId("motion-phase")).toHaveTextContent("Pinned"),
    );

    view.rerender(tree(false));
    await waitFor(() =>
      expect(screen.getByTestId("motion-phase")).toHaveTextContent("Visible"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse chrome" }));
    await waitFor(() =>
      expect(screen.getByTestId("motion-phase")).toHaveTextContent("Hidden"),
    );
  });

  it("projects promoted actions and pane options through one overflow menu", () => {
    vi.stubGlobal("innerWidth", 390);

    render(
      withRenderEnvironment(
        <MobileChromeProvider>
          <PublishResourceChrome />
          <MobilePaneBar />
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      ),
    );

    const options = screen.getByRole("button", { name: "Pane options" });
    expect(screen.queryByRole("button", { name: "Companion" })).toBeNull();
    fireEvent.click(options);
    expect(screen.getByRole("menuitem", { name: "Companion" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Credits" })).toBeVisible();
  });
});
