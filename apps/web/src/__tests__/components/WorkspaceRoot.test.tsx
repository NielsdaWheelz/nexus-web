import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import WorkspaceRoot from "@/components/workspace/WorkspaceRoot";
import type { WorkspacePaneGroupStateV2 } from "@/lib/workspace/schema";

describe("WorkspaceRoot", () => {
  it("marks only the active group as mobile-visible", () => {
    const groups: WorkspacePaneGroupStateV2[] = [
      {
        id: "group-a",
        activeTabId: "tab-a",
        tabs: [{ id: "tab-a", href: "/libraries" }],
      },
      {
        id: "group-b",
        activeTabId: "tab-b",
        tabs: [{ id: "tab-b", href: "/conversations" }],
      },
    ];

    const { rerender } = render(
      <WorkspaceRoot
        groups={groups}
        activeGroupId="group-a"
        onActivateGroup={vi.fn()}
        onActivateTab={vi.fn()}
        renderTabContent={() => <div>Tab content</div>}
      />
    );

    const groupShells = document.querySelectorAll('[data-workspace-group-shell="true"]');
    expect(groupShells).toHaveLength(2);
    expect(groupShells[0]).toHaveAttribute("data-mobile-visible", "true");
    expect(groupShells[1]).toHaveAttribute("data-mobile-visible", "false");
    expect(screen.getAllByText("Tab content")).toHaveLength(2);

    rerender(
      <WorkspaceRoot
        groups={groups}
        activeGroupId="group-b"
        onActivateGroup={vi.fn()}
        onActivateTab={vi.fn()}
        renderTabContent={() => <div>Tab content</div>}
      />
    );

    const updatedShells = document.querySelectorAll('[data-workspace-group-shell="true"]');
    expect(updatedShells[0]).toHaveAttribute("data-mobile-visible", "false");
    expect(updatedShells[1]).toHaveAttribute("data-mobile-visible", "true");
  });
});
