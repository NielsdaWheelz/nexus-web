import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NavTopBar from "./NavTopBar";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { MobileChromeProvider, useMobileChrome } from "@/lib/workspace/mobileChrome";

function PublishChrome() {
  const { setPaneChrome } = useMobileChrome();
  useEffect(() => {
    setPaneChrome({
      paneId: "pane-a",
      standingHead: "Libraries",
      folio: { kind: "count", value: 37, unit: "source" },
      navigation: {
        canGoBack: false,
        canGoForward: false,
        onBack: () => {},
        onForward: () => {},
      },
      options: [],
    });
    return () => setPaneChrome(null);
  }, [setPaneChrome]);
  return null;
}

function HideChrome() {
  const { onDocumentScroll } = useMobileChrome();
  return (
    <button
      type="button"
      onClick={() => {
        onDocumentScroll({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
        onDocumentScroll({ scrollTop: 130, scrollHeight: 1000, clientHeight: 400 });
      }}
    >
      Hide chrome
    </button>
  );
}

describe("NavTopBar", () => {
  afterEach(() => {
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

  it("makes hide-on-scroll chrome inert as well as visually hidden", async () => {
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
          <HideChrome />
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

    fireEvent.click(screen.getByRole("button", { name: "Hide chrome" }));
    const navigation = screen.getByRole("banner", { hidden: true });
    await waitFor(() => expect(navigation).toHaveAttribute("aria-hidden", "true"));
    expect(navigation).toHaveAttribute("inert");
  });
});
