import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PageLayout from "@/components/ui/PageLayout";

describe("PageLayout", () => {
  it("renders shared header controls for page surfaces", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();

    render(
      <PageLayout
        title="Podcasts"
        description="Followed shows and subscription settings"
        options={[{ id: "archive", label: "Archive", onSelect: onArchive }]}
      >
        <div>Page body</div>
      </PageLayout>
    );

    expect(screen.getByRole("heading", { level: 1, name: "Podcasts" })).toBeInTheDocument();
    expect(screen.getByText("Followed shows and subscription settings")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("hides mobile header chrome on scroll down and restores on scroll up", async () => {
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));

    render(
      <div style={{ height: "520px" }}>
        <PageLayout title="Mobile Layout">
          <div style={{ height: "2200px" }}>Tall page body</div>
        </PageLayout>
      </div>
    );

    expect(screen.getByRole("heading", { level: 1, name: "Mobile Layout" })).toBeInTheDocument();
    const container = screen.getByTestId("page-layout-container");
    expect(container.className).toMatch(/mobileHeaderVisible/);
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });

    container.scrollTop = 280;
    fireEvent.scroll(container);
    await waitFor(() => {
      expect(container.className).toMatch(/mobileHeaderHidden/);
    });

    container.scrollTop = 8;
    fireEvent.scroll(container);
    await waitFor(() => {
      expect(container.className).toMatch(/mobileHeaderVisible/);
    });
  });
});
