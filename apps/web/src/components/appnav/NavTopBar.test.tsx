import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import NavTopBar from "./NavTopBar";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import {
  MobileChromeProvider,
  useMobileChrome,
} from "@/lib/workspace/mobileChrome";

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

function PublishResourceChrome() {
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
            { kind: "authors", credits: [{ label: "Ursula K. Le Guin" }] },
          ],
        },
      },
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
  }, [setPaneChrome]);
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
  const { startReaderScroll, updateReaderScroll } = useMobileChrome();
  return (
    <button
      type="button"
      onClick={() => {
        startReaderScroll({
          scrollTop: 9,
          scrollHeight: 1000,
          clientHeight: 400,
        });
        updateReaderScroll({
          scrollTop: 100,
          scrollHeight: 1000,
          clientHeight: 400,
        });
      }}
    >
      Collapse chrome
    </button>
  );
}

function TrackChrome() {
  const { startReaderScroll, updateReaderScroll } = useMobileChrome();
  return (
    <button
      type="button"
      onClick={() => {
        startReaderScroll({
          scrollTop: 9,
          scrollHeight: 1000,
          clientHeight: 400,
        });
        updateReaderScroll({
          scrollTop: 40,
          scrollHeight: 1000,
          clientHeight: 400,
        });
      }}
    >
      Track chrome
    </button>
  );
}

function MotionPhase() {
  const { motionPhase } = useMobileChrome();
  return <output data-testid="motion-phase">{motionPhase.kind}</output>;
}

describe("NavTopBar", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the active pane's running head (standing head + folio)", () => {
    render(
      <MobileChromeProvider>
        <PublishChrome />
        <NavTopBar
          onOpenSheet={() => {}}
          onOpenCommand={() => {}}
          onOpenAdd={() => {}}
          paneCount={1}
        />
      </MobileChromeProvider>,
    );

    expect(screen.getByText("Libraries")).toBeInTheDocument();
    expect(screen.getByText("37 sources")).toBeInTheDocument();
  });

  it("passes explicit pointer and keyboard modality through mobile navigation", () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    render(
      <MobileChromeProvider>
        <PublishNavigationChrome onBack={onBack} onForward={onForward} />
        <NavTopBar
          onOpenSheet={() => {}}
          onOpenCommand={() => {}}
          onOpenAdd={() => {}}
          paneCount={1}
        />
      </MobileChromeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Go back" }), {
      detail: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Go forward" }));
    expect(onBack).toHaveBeenCalledWith("Pointer");
    expect(onForward).toHaveBeenCalledWith("Keyboard");
  });

  it("renders the active pane's resource identity from the shared model", () => {
    render(
      <MobileChromeProvider>
        <PublishResourceChrome />
        <NavTopBar
          onOpenSheet={() => {}}
          onOpenCommand={() => {}}
          onOpenAdd={() => {}}
          paneCount={1}
        />
      </MobileChromeProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "The Left Hand of Darkness" }),
    ).toHaveAttribute("id", "pane-media-identity");
    const bar = screen.getByRole("banner");
    expect(bar).toHaveAttribute("data-header-kind", "resource");
    expect(bar).toHaveAttribute("data-pane-chrome-for", "pane-media");
  });

  it("keeps the route heading available while only fully hidden controls leave the accessibility tree", async () => {
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
          <NavTopBar
            onOpenSheet={() => {}}
            onOpenCommand={() => {}}
            onOpenAdd={() => {}}
            paneCount={1}
          />
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse chrome" }));
    const navigation = screen.getByRole("banner");
    await waitFor(() =>
      expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Hidden"),
    );
    expect(navigation).not.toHaveAttribute("aria-hidden");
    expect(navigation).not.toHaveAttribute("inert");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "The Left Hand of Darkness",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Search or ask anything/ }),
    ).toBeNull();
    for (const controls of screen.getAllByTestId("top-bar-controls")) {
      expect(controls).toHaveAttribute("aria-hidden", "true");
      expect(controls).toHaveAttribute("inert");
    }
  });

  it("keeps controls available while chrome tracks and settles", () => {
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
          <NavTopBar
            onOpenSheet={() => {}}
            onOpenCommand={() => {}}
            onOpenAdd={() => {}}
            paneCount={1}
          />
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Track chrome" }));
    const navigation = screen.getByRole("banner");
    expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Tracking");
    for (const controls of screen.getAllByTestId("top-bar-controls")) {
      expect(controls).not.toHaveAttribute("aria-hidden");
      expect(controls).not.toHaveAttribute("inert");
    }

    act(() => vi.advanceTimersByTime(120));

    expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Settling");
    for (const controls of screen.getAllByTestId("top-bar-controls")) {
      expect(controls).not.toHaveAttribute("aria-hidden");
      expect(controls).not.toHaveAttribute("inert");
    }
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
          <PublishChrome />
          <CollapseChrome />
          <NavTopBar
            onOpenSheet={() => {}}
            onOpenCommand={() => {}}
            onOpenAdd={() => {}}
            paneCount={1}
          />
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      ),
    );

    const navigation = screen.getByRole("banner");
    const command = screen.getByRole("button", {
      name: /Search or ask anything/,
    });
    fireEvent.focus(command);

    await waitFor(() =>
      expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Pinned"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse chrome" }));
    expect(navigation).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
    expect(command).toBeVisible();

    fireEvent.blur(command);
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
            <NavTopBar
              onOpenSheet={() => {}}
              onOpenCommand={() => {}}
              onOpenAdd={() => {}}
              paneCount={1}
            />
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

  it("keeps Companion immediately before Options at 390px", () => {
    vi.stubGlobal("innerWidth", 390);

    render(
      withRenderEnvironment(
        <MobileChromeProvider>
          <PublishResourceChrome />
          <NavTopBar
            onOpenSheet={() => {}}
            onOpenCommand={() => {}}
            onOpenAdd={() => {}}
            paneCount={1}
          />
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      ),
    );

    const companion = screen.getByRole("button", { name: "Companion" });
    const options = screen.getByRole("button", { name: "Pane options" });
    expect(
      companion.compareDocumentPosition(options) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
