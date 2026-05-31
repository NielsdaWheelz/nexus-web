import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecondarySurfaceTabs, {
  secondarySurfacePanelId,
  secondarySurfaceTabId,
} from "@/components/workspace/SecondarySurfaceTabs";

const surfaces = [
  { id: "reader-highlights" as const, body: <div /> },
  { id: "reader-doc-chat" as const, body: <div /> },
  { id: "reader-contents" as const, body: <div /> },
];

describe("SecondarySurfaceTabs", () => {
  it("applies roving focus and links each tab to its own panel id", () => {
    render(
      <SecondarySurfaceTabs
        baseId="base"
        surfaces={surfaces}
        activeSurfaceId="reader-doc-chat"
        onSelect={vi.fn()}
      />,
    );

    const highlights = screen.getByRole("tab", { name: "Highlights" });
    const docChat = screen.getByRole("tab", { name: "Document chat" });
    expect(highlights).toHaveAttribute("tabIndex", "-1");
    expect(docChat).toHaveAttribute("tabIndex", "0");
    expect(highlights.id).toBe(secondarySurfaceTabId("base", "reader-highlights"));
    expect(highlights).toHaveAttribute(
      "aria-controls",
      secondarySurfacePanelId("base", "reader-highlights"),
    );
  });

  it("selects the first surface on Home and the last on End", () => {
    const onSelect = vi.fn();
    render(
      <SecondarySurfaceTabs
        baseId="base"
        surfaces={surfaces}
        activeSurfaceId="reader-doc-chat"
        onSelect={onSelect}
      />,
    );

    const docChat = screen.getByRole("tab", { name: "Document chat" });
    fireEvent.keyDown(docChat, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("reader-contents");
    fireEvent.keyDown(docChat, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("reader-highlights");
  });

  it("wraps around with ArrowLeft from the first surface", () => {
    const onSelect = vi.fn();
    render(
      <SecondarySurfaceTabs
        baseId="base"
        surfaces={surfaces}
        activeSurfaceId="reader-highlights"
        onSelect={onSelect}
      />,
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "Highlights" }), {
      key: "ArrowLeft",
    });
    expect(onSelect).toHaveBeenLastCalledWith("reader-contents");
  });
});
