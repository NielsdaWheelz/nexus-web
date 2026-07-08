import { describe, expect, it } from "vitest";
import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import NavTopBar from "./NavTopBar";
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

describe("NavTopBar", () => {
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
});
