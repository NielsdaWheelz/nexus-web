import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ResourceList from "@/components/ui/ResourceList";

describe("ResourceList", () => {
  it("renders section copy, list semantics, and footer actions", () => {
    render(
      <ResourceList
        label="Documents"
        description="Imported and discovered documents."
        footer={<button>Load more</button>}
      >
        <li>First document</li>
      </ResourceList>,
    );

    expect(screen.getByRole("heading", { name: "Documents" })).toBeVisible();
    expect(screen.getByText("Imported and discovered documents.")).toBeVisible();
    expect(screen.getByRole("list")).toContainElement(
      screen.getByText("First document"),
    );
    expect(screen.getByRole("button", { name: "Load more" })).toBeVisible();
  });

  it("does not render an empty section header for footer-only lists", () => {
    render(
      <ResourceList footer={<button>Load more</button>}>
        <li>First document</li>
      </ResourceList>,
    );

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("list")).toContainElement(
      screen.getByText("First document"),
    );
    expect(screen.getByRole("button", { name: "Load more" })).toBeVisible();
  });
});
