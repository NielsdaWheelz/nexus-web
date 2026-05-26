import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FileText, Highlighter, Library } from "lucide-react";
import SecondaryRail, { type SecondaryRailTab } from "./SecondaryRail";

function readerTabs(): SecondaryRailTab[] {
  return [
    {
      id: "highlights",
      icon: Highlighter,
      tooltip: "Highlights for this document",
      body: <div>Highlights body</div>,
    },
    {
      id: "doc-chat",
      icon: FileText,
      tooltip: "Chat about this document",
      body: <div>Doc chat body</div>,
    },
    {
      id: "library-chat",
      icon: Library,
      tooltip: "Chat about this library",
      body: <div>Library chat body</div>,
    },
  ];
}

describe("SecondaryRail", () => {
  it("renders only the collapsed slot when collapsed", () => {
    render(
      <SecondaryRail
        ariaLabel="Reader tools"
        expanded={false}
        onExpandedChange={() => {}}
        collapsed={<button type="button">Open rail</button>}
      />,
    );

    expect(
      screen.getByRole("complementary", { name: "Reader tools" }),
    ).toHaveAttribute("data-expanded", "false");
    expect(screen.getByRole("button", { name: "Open rail" })).toBeTruthy();
    expect(screen.queryByText("Highlights body")).toBeNull();
  });

  it("renders three icon-only tab triggers in order with the spec tooltips", () => {
    render(
      <SecondaryRail
        ariaLabel="Reader tools"
        expanded
        onExpandedChange={() => {}}
        tabs={readerTabs()}
        activeTabId="highlights"
        onActiveTabIdChange={() => {}}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAccessibleName("Highlights for this document");
    expect(tabs[1]).toHaveAccessibleName("Chat about this document");
    expect(tabs[2]).toHaveAccessibleName("Chat about this library");
    expect(tabs[0]).toHaveAttribute("title", "Highlights for this document");
    expect(tabs[1]).toHaveAttribute("title", "Chat about this document");
    expect(tabs[2]).toHaveAttribute("title", "Chat about this library");
  });

  it("marks the active tab with data-active=true for the bronze accent glow", () => {
    render(
      <SecondaryRail
        ariaLabel="Reader tools"
        expanded
        onExpandedChange={() => {}}
        tabs={readerTabs()}
        activeTabId="doc-chat"
        onActiveTabIdChange={() => {}}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("data-active", "false");
    expect(tabs[1]).toHaveAttribute("data-active", "true");
    expect(tabs[2]).toHaveAttribute("data-active", "false");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  });

  it("renders the active tab body and switches when a different tab is clicked", async () => {
    const user = userEvent.setup();
    const onActiveTabIdChange = vi.fn();

    render(
      <SecondaryRail
        ariaLabel="Reader tools"
        expanded
        onExpandedChange={() => {}}
        tabs={readerTabs()}
        activeTabId="highlights"
        onActiveTabIdChange={onActiveTabIdChange}
      />,
    );

    expect(screen.getByText("Highlights body")).toBeVisible();
    expect(screen.queryByText("Doc chat body")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Chat about this document" }));
    expect(onActiveTabIdChange).toHaveBeenCalledWith("doc-chat");
  });

  it("reports collapse from the expanded header", async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();

    render(
      <SecondaryRail
        ariaLabel="Chat context"
        expanded
        onExpandedChange={onExpandedChange}
        tabs={readerTabs()}
        activeTabId="highlights"
        onActiveTabIdChange={() => {}}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Collapse secondary rail" }),
    );
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("moves focus across tabs with arrow keys", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [activeTabId, setActiveTabId] = useState<SecondaryRailTab["id"]>("highlights");
      return (
        <SecondaryRail
          ariaLabel="Reader tools"
          expanded
          onExpandedChange={() => {}}
          tabs={readerTabs()}
          activeTabId={activeTabId}
          onActiveTabIdChange={setActiveTabId}
        />
      );
    }

    render(<Harness />);

    const highlightsTab = screen.getByRole("tab", {
      name: "Highlights for this document",
    });
    highlightsTab.focus();
    await user.keyboard("{ArrowRight}");

    const docChatTab = screen.getByRole("tab", {
      name: "Chat about this document",
    });
    await waitFor(() => expect(docChatTab).toHaveFocus());
    expect(docChatTab).toHaveAttribute("aria-selected", "true");
  });
});
