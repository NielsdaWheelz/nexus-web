import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    render(
      <Pane>
        <div>Content</div>
      </Pane>
    );

    const pane = screen.getByTestId("pane");
    expect(pane.style.width).toBe("480px");
  });

  it("applies custom default width", () => {
    render(
      <Pane defaultWidth={600}>
        <div>Content</div>
      </Pane>
    );

    const pane = screen.getByTestId("pane");
    expect(pane.style.width).toBe("600px");
  });

  it("supports keyboard resize from the handle", () => {
    render(
      <Pane defaultWidth={500} minWidth={300} maxWidth={700}>
        <div>Content</div>
      </Pane>
    );
    const pane = screen.getByTestId("pane");
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

  it("keeps pane chrome visible on mobile scroll", () => {
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

    const paneEl = screen.getByTestId("pane");
    const paneChrome = screen.getByTestId("pane-chrome");
    const paneContent = screen.getByTestId("pane-content");
    expect(paneEl).not.toHaveAttribute("data-mobile-chrome-hidden");
    expect(paneChrome).toBeVisible();

    paneContent.scrollTop = 20;
    fireEvent.scroll(paneContent);
    expect(paneChrome).toBeVisible();

    paneContent.scrollTop = 27;
    fireEvent.scroll(paneContent);
    expect(paneChrome).toBeVisible();

    paneContent.scrollTop = 260;
    fireEvent.scroll(paneContent);
    expect(paneChrome).toBeVisible();

    paneContent.scrollTop = 12;
    fireEvent.scroll(paneContent);
    expect(paneChrome).toBeVisible();
  });

  describe("mobile toolbar", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("renders toolbar within chrome on mobile viewport", () => {
      vi.stubGlobal("innerWidth", 390);
      window.dispatchEvent(new Event("resize"));

      render(
        <Pane
          title="Reader"
          toolbar={
            <>
              <button type="button" aria-label="Previous">Prev</button>
              <span data-testid="page-label">Page 2 of 10</span>
              <button type="button" aria-label="Next">Next</button>
            </>
          }
        >
          <div>Content</div>
        </Pane>
      );

      expect(screen.getByTestId("pane-chrome")).toBeInTheDocument();

      // Toolbar items are accessible within the pane
      expect(screen.getByRole("button", { name: "Previous" })).toBeInTheDocument();
      expect(screen.getByTestId("page-label")).toHaveTextContent("Page 2 of 10");
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    });
  });
});
