import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Pane from "@/components/Pane";

describe("Pane", () => {
  it("renders children", () => {
    render(
      <Pane>
        <div>Test Content</div>
      </Pane>
    );

    expect(screen.getByText("Test Content")).toBeInTheDocument();
  });

  it("renders title when provided", () => {
    render(
      <Pane title="Test Title">
        <div>Content</div>
      </Pane>
    );

    expect(screen.getByText("Test Title")).toBeInTheDocument();
  });

  it("shows close button when onClose is provided", () => {
    const onClose = vi.fn();
    render(
      <Pane title="Test" onClose={onClose}>
        <div>Content</div>
      </Pane>
    );

    const closeButton = screen.getByLabelText("Close pane");
    expect(closeButton).toBeInTheDocument();

    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not show close button when onClose is not provided", () => {
    render(
      <Pane title="Test">
        <div>Content</div>
      </Pane>
    );

    expect(screen.queryByLabelText("Close pane")).not.toBeInTheDocument();
  });

  it("applies default width", () => {
    const { container } = render(
      <Pane>
        <div>Content</div>
      </Pane>
    );

    const pane = container.firstChild as HTMLElement;
    expect(pane.style.width).toBe("480px");
  });

  it("applies custom default width", () => {
    const { container } = render(
      <Pane defaultWidth={600}>
        <div>Content</div>
      </Pane>
    );

    const pane = container.firstChild as HTMLElement;
    expect(pane.style.width).toBe("600px");
  });

  it("supports keyboard resize from the handle", () => {
    const { container } = render(
      <Pane defaultWidth={500} minWidth={300} maxWidth={700}>
        <div>Content</div>
      </Pane>
    );
    const pane = container.firstChild as HTMLElement;
    const handle = screen.getByLabelText("Resize pane");

    expect(pane.style.width).toBe("500px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(pane.style.width).toBe("516px");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(pane.style.width).toBe("300px");

    fireEvent.keyDown(handle, { key: "End" });
    expect(pane.style.width).toBe("700px");
  });

  it("renders shared pane chrome controls with toolbar", async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onDelete = vi.fn();

    render(
      <Pane
        title="Design doc"
        subtitle="EPUB"
        toolbar={
          <>
            <button type="button" onClick={onPrev} aria-label="Previous page">Previous page</button>
            <span>Page 2 of 10</span>
            <button type="button" onClick={onNext} aria-label="Next page">Next page</button>
          </>
        }
        options={[{ id: "delete", label: "Delete", onSelect: onDelete, tone: "danger" }]}
      >
        <div>Body content</div>
      </Pane>
    );

    expect(screen.getAllByRole("heading", { name: "Design doc" })).toHaveLength(1);
    expect(screen.getByText("EPUB")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 10")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("hides pane chrome on mobile scroll down and restores on scroll up", async () => {
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));

    render(
      <div style={{ height: "520px" }}>
        <Pane
          title="Mobile Reader"
          toolbar={<button type="button">Toolbar Action</button>}
        >
          <div style={{ height: "2000px" }}>Long content</div>
        </Pane>
      </div>
    );

    const pane = screen
      .getByText("Long content")
      .closest<HTMLElement>('[data-mobile-chrome-hidden]');
    expect(pane).not.toBeNull();
    const paneEl = pane as HTMLElement;
    const paneContent = paneEl.querySelector<HTMLElement>('[data-pane-content="true"]');
    expect(paneContent).not.toBeNull();
    expect(paneEl).toHaveAttribute("data-mobile-chrome-hidden", "false");

    (paneContent as HTMLElement).scrollTop = 20;
    fireEvent.scroll(paneContent as HTMLElement);
    expect(paneEl).toHaveAttribute("data-mobile-chrome-hidden", "false");

    (paneContent as HTMLElement).scrollTop = 27;
    fireEvent.scroll(paneContent as HTMLElement);
    expect(paneEl).toHaveAttribute("data-mobile-chrome-hidden", "false");

    (paneContent as HTMLElement).scrollTop = 260;
    fireEvent.scroll(paneContent as HTMLElement);
    await waitFor(() => {
      expect(paneEl).toHaveAttribute("data-mobile-chrome-hidden", "true");
    });

    (paneContent as HTMLElement).scrollTop = 12;
    fireEvent.scroll(paneContent as HTMLElement);
    await waitFor(() => {
      expect(paneEl).toHaveAttribute("data-mobile-chrome-hidden", "false");
    });
  });
});
