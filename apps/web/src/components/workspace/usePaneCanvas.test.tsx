import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePaneCanvas } from "./usePaneCanvas";

const paneIds = ["a", "b", "c"];

function Harness({ enabled }: { enabled: boolean }) {
  const { canvasRef, onWheel, edges, inViewPaneIds, handleChromeMouseDown } =
    usePaneCanvas({ enabled, paneIds });

  return (
    <>
      <div
        ref={canvasRef}
        onWheel={onWheel}
        data-testid="canvas"
        style={{
          width: 200,
          height: 100,
          display: "flex",
          flexDirection: "row",
          overflowX: "auto",
        }}
      >
        {paneIds.map((id) => (
          <div key={id} data-pane-id={id} style={{ width: 300, flex: "0 0 auto" }}>
            <header
              data-testid={`chrome-${id}`}
              onMouseDown={handleChromeMouseDown}
            >
              {id}
              {id === "a" ? <button type="button">menu</button> : null}
            </header>
            {id === "b" ? (
              <div
                data-testid="scrollable"
                style={{ height: 40, overflowY: "auto" }}
              >
                <div style={{ height: 200 }} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div
        data-testid="edges"
        data-at-start={String(edges.atStart)}
        data-at-end={String(edges.atEnd)}
      />
      <div data-testid="inview">{[...inViewPaneIds].sort().join(",")}</div>
    </>
  );
}

describe("usePaneCanvas", () => {
  it("pans the canvas on a vertical wheel", () => {
    render(<Harness enabled />);
    const canvas = screen.getByTestId("canvas");

    fireEvent.wheel(canvas, { deltaY: 150 });

    expect(canvas.scrollLeft).toBeCloseTo(150, 0);
  });

  it("does not pan when the wheel targets a vertically scrollable child", () => {
    render(<Harness enabled />);
    const canvas = screen.getByTestId("canvas");
    const before = canvas.scrollLeft;

    fireEvent.wheel(screen.getByTestId("scrollable"), { deltaY: 150 });

    expect(canvas.scrollLeft).toBe(before);
  });

  it("pans the canvas on a header drag past the threshold", () => {
    render(<Harness enabled />);
    const canvas = screen.getByTestId("canvas");

    fireEvent.mouseDown(screen.getByTestId("chrome-b"), {
      button: 0,
      clientX: 150,
    });
    fireEvent.mouseMove(document, { clientX: 60 });
    fireEvent.mouseUp(document);

    expect(canvas.scrollLeft).toBeCloseTo(90, 0);
  });

  it("does not pan on a sub-threshold header drag", () => {
    render(<Harness enabled />);
    const canvas = screen.getByTestId("canvas");
    const before = canvas.scrollLeft;

    fireEvent.mouseDown(screen.getByTestId("chrome-b"), {
      button: 0,
      clientX: 150,
    });
    fireEvent.mouseMove(document, { clientX: 148 });
    fireEvent.mouseUp(document);

    expect(canvas.scrollLeft).toBe(before);
  });

  it("does not start a drag from a mousedown on an interactive header element", () => {
    render(<Harness enabled />);
    const canvas = screen.getByTestId("canvas");
    const before = canvas.scrollLeft;

    fireEvent.mouseDown(screen.getByRole("button", { name: "menu" }), {
      button: 0,
      clientX: 150,
    });
    fireEvent.mouseMove(document, { clientX: 60 });
    fireEvent.mouseUp(document);

    expect(canvas.scrollLeft).toBe(before);
  });

  it("tracks the scroll edges", async () => {
    render(<Harness enabled />);
    const canvas = screen.getByTestId("canvas");
    const edges = screen.getByTestId("edges");

    await waitFor(() => {
      expect(edges).toHaveAttribute("data-at-end", "true");
    });
    expect(edges).toHaveAttribute("data-at-start", "false");

    canvas.scrollLeft = 700;
    fireEvent.scroll(canvas);

    await waitFor(() => {
      expect(edges).toHaveAttribute("data-at-start", "true");
    });
  });

  it("reports the panes intersecting the canvas viewport", async () => {
    render(<Harness enabled />);
    const inview = screen.getByTestId("inview");

    await waitFor(() => {
      expect(inview.textContent).toContain("a");
    });
    expect(inview.textContent).not.toContain("c");
  });

  it("is inert when disabled", () => {
    render(<Harness enabled={false} />);
    const canvas = screen.getByTestId("canvas");

    fireEvent.wheel(canvas, { deltaY: 150 });
    expect(canvas.scrollLeft).toBe(0);

    fireEvent.mouseDown(screen.getByTestId("chrome-b"), {
      button: 0,
      clientX: 150,
    });
    fireEvent.mouseMove(document, { clientX: 60 });
    fireEvent.mouseUp(document);
    expect(canvas.scrollLeft).toBe(0);
  });
});
