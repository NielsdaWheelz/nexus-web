import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PageLayout from "@/components/ui/PageLayout";

describe("PageLayout", () => {
  it("renders shared header controls for page surfaces", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();

    render(
      <PageLayout
        title="Podcasts"
        description="Discover and manage podcast media"
        options={[{ id: "archive", label: "Archive", onSelect: onArchive }]}
      >
        <div>Page body</div>
      </PageLayout>
    );

    expect(screen.getByRole("heading", { level: 1, name: "Podcasts" })).toBeInTheDocument();
    expect(screen.getByText("Discover and manage podcast media")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });
});
