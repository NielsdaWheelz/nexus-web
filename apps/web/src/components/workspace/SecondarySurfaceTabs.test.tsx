import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecondarySurfaceTabs, {
  secondarySurfacePanelId,
  secondarySurfaceTabId,
} from "@/components/workspace/SecondarySurfaceTabs";

const surfaces = [
  { id: "reader-highlights" as const, body: <div /> },
  { id: "reader-contents" as const, body: <div /> },
  { id: "reader-apparatus" as const, body: <div /> },
  { id: "reader-resource-chat" as const, body: <div /> },
];

describe("SecondarySurfaceTabs", () => {
  it("applies roving focus and links each tab to its own panel id", () => {
    render(
      <SecondarySurfaceTabs
        baseId="base"
        surfaces={surfaces}
        activeSurfaceId="reader-resource-chat"
        onSelect={vi.fn()}
      />,
    );

    const highlights = screen.getByRole("tab", { name: "Highlights" });
    const resourceChat = screen.getByRole("tab", { name: "Chat" });
    expect(highlights).toHaveAttribute("tabIndex", "-1");
    expect(resourceChat).toHaveAttribute("tabIndex", "0");
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
        activeSurfaceId="reader-resource-chat"
        onSelect={onSelect}
      />,
    );

    const resourceChat = screen.getByRole("tab", { name: "Chat" });
    fireEvent.keyDown(resourceChat, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("reader-resource-chat");
    fireEvent.keyDown(resourceChat, { key: "Home" });
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
    expect(onSelect).toHaveBeenLastCalledWith("reader-resource-chat");
  });
});
