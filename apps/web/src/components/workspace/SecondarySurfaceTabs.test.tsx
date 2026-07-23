import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecondarySurfaceTabs, {
  secondarySurfacePanelId,
  secondarySurfaceTabId,
} from "@/components/workspace/SecondarySurfaceTabs";

const surfaces = [
  { id: "resource-contents" as const, body: <div /> },
  { id: "resource-evidence" as const, body: <div /> },
];

describe("SecondarySurfaceTabs", () => {
  it("applies roving focus and links each tab to its own panel id", () => {
    render(
      <SecondarySurfaceTabs
        baseId="base"
        surfaces={surfaces}
        activeSurfaceId="resource-evidence"
        onSelect={vi.fn()}
      />,
    );

    const contents = screen.getByRole("tab", { name: "Contents" });
    const evidence = screen.getByRole("tab", { name: "Evidence" });
    expect(contents).toHaveAttribute("tabIndex", "-1");
    expect(evidence).toHaveAttribute("tabIndex", "0");
    expect(contents.id).toBe(secondarySurfaceTabId("base", "resource-contents"));
    expect(contents).toHaveAttribute(
      "aria-controls",
      secondarySurfacePanelId("base", "resource-contents"),
    );
  });

  it("selects the first surface on Home and the last on End", () => {
    const onSelect = vi.fn();
    render(
      <SecondarySurfaceTabs
        baseId="base"
        surfaces={surfaces}
        activeSurfaceId="resource-evidence"
        onSelect={onSelect}
      />,
    );

    const evidence = screen.getByRole("tab", { name: "Evidence" });
    fireEvent.keyDown(evidence, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("resource-evidence");
    fireEvent.keyDown(evidence, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("resource-contents");
  });

  it("wraps around with ArrowLeft from the first surface", () => {
    const onSelect = vi.fn();
    render(
      <SecondarySurfaceTabs
        baseId="base"
        surfaces={surfaces}
        activeSurfaceId="resource-contents"
        onSelect={onSelect}
      />,
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "Contents" }), {
      key: "ArrowLeft",
    });
    expect(onSelect).toHaveBeenLastCalledWith("resource-evidence");
  });
});
