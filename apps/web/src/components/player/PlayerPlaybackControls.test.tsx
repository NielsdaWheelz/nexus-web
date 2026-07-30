import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { PlaybackRateEditor } from "./PlayerPlaybackControls";

function Editor({ initial }: { initial: number }) {
  const [rate, setRate] = useState(initial);
  return (
    <div data-testid="viewport" style={{ width: "100%", maxWidth: 320 }}>
      <PlaybackRateEditor
        value={rate}
        onChange={setRate}
        label="Playback speed"
      />
    </div>
  );
}

describe("PlaybackRateEditor", () => {
  it("shows and edits an arbitrary value without preset coercion", () => {
    render(<Editor initial={1.85} />);

    expect(screen.getByText("1.85x")).toBeVisible();
    expect(
      screen.getByRole("slider", { name: "Playback speed" }),
    ).toHaveAttribute("aria-valuetext", "1.85 times normal");
    expect(
      screen.getByRole("button", { name: "1x" }),
    ).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(
      screen.getByRole("button", { name: "Increase playback speed" }),
    );
    expect(screen.getByText("1.9x")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "1.25x" }));
    expect(screen.getByText("1.25x", { selector: "strong" })).toBeVisible();
  });

  it("preserves an off-grid canonical value until a 0.05 edit", () => {
    render(<Editor initial={1.83} />);

    const slider = screen.getByRole("slider", {
      name: "Playback speed",
    });
    expect(slider).toHaveValue("1.83");
    expect(slider).toHaveAttribute("step", "any");
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      "1.83 times normal",
    );

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(screen.getByText("1.88x")).toBeVisible();
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(screen.getByText("1.83x")).toBeVisible();
    fireEvent.keyDown(slider, { key: "ArrowUp" });
    expect(screen.getByText("1.88x")).toBeVisible();
    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(screen.getByText("1.83x")).toBeVisible();
    fireEvent.keyDown(slider, { key: "Home" });
    expect(screen.getByText("0.5x")).toBeVisible();
    fireEvent.keyDown(slider, { key: "End" });
    expect(screen.getByText("3x")).toBeVisible();

    fireEvent.input(slider, { target: { value: "2.02" } });
    expect(screen.getByText("2x", { selector: "strong" })).toBeVisible();
    expect(slider).toHaveAttribute("step", "0.05");
  });

  it("uses real bounded controls and truthful normal-speed accessibility copy", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PlaybackRateEditor
        value={0.5}
        onChange={onChange}
        label="Default playback speed"
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Decrease default playback speed",
      }),
    ).toBeDisabled();

    rerender(
      <PlaybackRateEditor
        value={1}
        onChange={onChange}
        label="Default playback speed"
      />,
    );
    expect(
      screen.getByRole("slider", { name: "Default playback speed" }),
    ).toHaveAttribute("aria-valuetext", "Normal speed");

    rerender(
      <PlaybackRateEditor
        value={3}
        onChange={onChange}
        label="Default playback speed"
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Increase default playback speed",
      }),
    ).toBeDisabled();
  });

  it("reflows with 44 CSS-pixel controls in a 320 CSS-pixel viewport", async () => {
    await page.viewport(320, 720);
    try {
      render(<Editor initial={1.85} />);
      const viewport = screen.getByTestId("viewport");
      expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
      const controls = [
        ...within(viewport).getAllByRole("button"),
        within(viewport).getByRole("slider", { name: "Playback speed" }),
      ];
      for (const control of controls) {
        const bounds = control.getBoundingClientRect();
        const name =
          control.getAttribute("aria-label") ?? control.textContent ?? "control";
        expect(bounds.width, `${name} width`).toBeGreaterThanOrEqual(44);
        expect(bounds.height, `${name} height`).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await page.viewport(414, 720);
    }
  });

  it("reflows at an equivalent 400 percent page scale", async () => {
    await page.viewport(1280, 720);
    document.documentElement.style.zoom = "4";
    try {
      render(<Editor initial={1.85} />);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
    } finally {
      document.documentElement.style.zoom = "";
      await page.viewport(414, 720);
    }
  });
});
