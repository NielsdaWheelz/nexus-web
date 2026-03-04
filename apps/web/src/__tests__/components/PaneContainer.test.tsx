import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PaneContainer from "@/components/PaneContainer";

describe("PaneContainer", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 800);
  });

  it("renders children without mobile tabs when mobileLabels not provided", () => {
    render(
      <PaneContainer>
        <div data-testid="pane-1">Content</div>
        <div data-testid="pane-2">Highlights</div>
      </PaneContainer>
    );

    expect(screen.getByTestId("pane-1")).toBeInTheDocument();
    expect(screen.getByTestId("pane-2")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("shows Content and Highlights tabs on mobile viewport when mobileLabels provided", async () => {
    vi.stubGlobal("innerWidth", 400);
    window.dispatchEvent(new Event("resize"));

    render(
      <PaneContainer mobileLabels={["Content", "Highlights"]}>
        <div data-testid="pane-1">Content pane</div>
        <div data-testid="pane-2">Highlights pane</div>
      </PaneContainer>
    );

    await waitFor(() => {
      expect(screen.getByRole("tablist", { name: /content and highlights/i })).toBeInTheDocument();
    });
  });

  it("switches visible pane when mobile tab is clicked", async () => {
    vi.stubGlobal("innerWidth", 400);

    render(
      <PaneContainer mobileLabels={["Content", "Highlights"]}>
        <div data-testid="pane-1">Content pane</div>
        <div data-testid="pane-2">Highlights pane</div>
      </PaneContainer>
    );

    const contentTab = await screen.findByRole("tab", { name: /content/i });
    const highlightsTab = await screen.findByRole("tab", { name: /highlights/i });

    expect(contentTab).toHaveAttribute("aria-selected", "true");
    expect(highlightsTab).toHaveAttribute("aria-selected", "false");

    await userEvent.click(highlightsTab);

    expect(highlightsTab).toHaveAttribute("aria-selected", "true");
    expect(contentTab).toHaveAttribute("aria-selected", "false");
  });
});
