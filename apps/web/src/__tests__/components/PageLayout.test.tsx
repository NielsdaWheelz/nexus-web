import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PageLayout from "@/components/ui/PageLayout";

describe("PageLayout", () => {
  it("renders shared header controls for page surfaces", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onArchive = vi.fn();

    render(
      <PageLayout
        title="Podcasts"
        description="Discover and manage podcast media"
        back={{ label: "Back to Discover", onClick: onBack }}
        navigation={{
          label: "Episode 4 of 12",
          previous: { label: "Previous episode", onClick: onPrev },
          next: { label: "Next episode", onClick: onNext },
        }}
        options={[{ id: "archive", label: "Archive", onSelect: onArchive }]}
      >
        <div>Page body</div>
      </PageLayout>
    );

    expect(screen.getByRole("heading", { level: 1, name: "Podcasts" })).toBeInTheDocument();
    expect(screen.getByText("Discover and manage podcast media")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to Discover" }));
    await user.click(screen.getByRole("button", { name: "Previous episode" }));
    await user.click(screen.getByRole("button", { name: "Next episode" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });
});
