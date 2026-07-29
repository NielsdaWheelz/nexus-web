import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ResourceList from "@/components/ui/ResourceList";

describe("ResourceList", () => {
  it("owns one plain labelled ul", () => {
    render(
      <ResourceList ariaLabel="Documents">
        <li>First document</li>
      </ResourceList>,
    );

    const list = screen.getByRole("list", { name: "Documents" });
    expect(list).toContainElement(
      screen.getByText("First document"),
    );
    expect(list).not.toHaveAttribute("data-view");
    expect(list).not.toHaveAttribute("data-density");
  });

  it("owns collection busy state", () => {
    render(
      <ResourceList ariaLabel="Documents" busy>
        <li>First document</li>
      </ResourceList>,
    );

    expect(screen.getByRole("list", { name: "Documents" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});
