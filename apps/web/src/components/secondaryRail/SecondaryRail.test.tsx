import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SecondaryRail from "./SecondaryRail";

describe("SecondaryRail", () => {
  it("renders only the collapsed slot when collapsed", () => {
    render(
      <SecondaryRail
        ariaLabel="Reader tools"
        expanded={false}
        onExpandedChange={() => {}}
        collapsed={<button type="button">Open rail</button>}
      >
        <div>Expanded body</div>
      </SecondaryRail>,
    );

    expect(screen.getByRole("complementary", { name: "Reader tools" })).toHaveAttribute(
      "data-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Open rail" })).toBeTruthy();
    expect(screen.queryByText("Expanded body")).toBeNull();
  });

  it("renders tabs and reports tab selection when expanded", async () => {
    const user = userEvent.setup();
    const onActiveTabChange = vi.fn();

    render(
      <SecondaryRail
        ariaLabel="Reader tools"
        expanded
        onExpandedChange={() => {}}
        collapsed={<button type="button">Open rail</button>}
        tabs={[
          { id: "highlights", label: "Highlights" },
          { id: "ask", label: "Ask" },
        ]}
        activeTabId="highlights"
        onActiveTabChange={onActiveTabChange}
      >
        <div>Expanded body</div>
      </SecondaryRail>,
    );

    expect(screen.getByRole("tab", { name: "Highlights" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Ask" }));
    expect(onActiveTabChange).toHaveBeenCalledWith("ask");
  });

  it("reports collapse from the expanded header", async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();

    render(
      <SecondaryRail
        ariaLabel="Chat context"
        expanded
        onExpandedChange={onExpandedChange}
        collapsed={<button type="button">Open rail</button>}
      >
        <div>Expanded body</div>
      </SecondaryRail>,
    );

    await user.click(screen.getByRole("button", { name: "Collapse secondary rail" }));
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });
});
