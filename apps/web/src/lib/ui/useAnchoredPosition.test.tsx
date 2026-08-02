import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useAnchoredPosition } from "./useAnchoredPosition";
import { readViewportSafeBounds } from "./viewportSafeArea";

const FLOAT_W = 100;
const FLOAT_H = 40;

function Host({
  anchor,
  opts,
}: {
  anchor: DOMRect | null;
  opts: Parameters<typeof useAnchoredPosition>[1];
}) {
  const { ref, style } = useAnchoredPosition(anchor, opts);
  return (
    <div
      ref={ref}
      data-testid="floating"
      style={{ ...style, width: FLOAT_W, height: FLOAT_H }}
    />
  );
}

function floating() {
  return screen.getByTestId("floating");
}

describe("useAnchoredPosition", () => {
  beforeEach(() => {
    document.documentElement.style.setProperty("--viewport-safe-top", "0px");
    document.documentElement.style.setProperty("--viewport-safe-right", "0px");
    document.documentElement.style.setProperty("--viewport-safe-bottom", "0px");
    document.documentElement.style.setProperty("--viewport-safe-left", "0px");
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--viewport-safe-top");
    document.documentElement.style.removeProperty("--viewport-safe-right");
    document.documentElement.style.removeProperty("--viewport-safe-bottom");
    document.documentElement.style.removeProperty("--viewport-safe-left");
  });

  it("places below the anchor with start alignment", async () => {
    render(
      <Host
        anchor={new DOMRect(50, 50, 80, 20)}
        opts={{ enabled: true, placement: "below", align: "start", gap: 4 }}
      />,
    );
    await waitFor(() => {
      expect(floating().style.position).toBe("fixed");
      expect(floating().style.top).toBe("74px"); // anchor.bottom(70) + gap(4)
      expect(floating().style.left).toBe("50px"); // anchor.left
    });
  });

  it("centers the floating element over the anchor", async () => {
    render(
      <Host
        anchor={new DOMRect(200, 100, 80, 20)}
        opts={{ enabled: true, placement: "below", align: "center", gap: 4 }}
      />,
    );
    // left = anchor.left(200) + anchor.width/2(40) - float.width/2(50)
    await waitFor(() => expect(floating().style.left).toBe("190px"));
  });

  it("flips above when there is no room below", async () => {
    const anchorTop = window.innerHeight - 30;
    render(
      <Host
        anchor={new DOMRect(50, anchorTop, 80, 20)}
        opts={{ enabled: true, placement: "below", gap: 4, flip: true }}
      />,
    );
    // above = anchor.top - float.height(40) - gap(4)
    await waitFor(() =>
      expect(floating().style.top).toBe(`${anchorTop - FLOAT_H - 4}px`),
    );
  });

  it("clamps into the viewport padding", async () => {
    render(
      <Host
        anchor={new DOMRect(window.innerWidth - 10, 50, 80, 20)}
        opts={{ enabled: true, placement: "below", align: "start" }}
      />,
    );
    // left clamps to innerWidth - viewportPadding(8) - float.width(100)
    await waitFor(() =>
      expect(floating().style.left).toBe(`${window.innerWidth - 8 - FLOAT_W}px`),
    );
  });

  /* eslint-disable testing-library/no-node-access -- The hidden probe has no accessible query. */
  it("fails loudly for missing or malformed safe-area tokens without leaking its probe", () => {
    const root = document.documentElement;
    const bodyChildCount = document.body.childElementCount;

    root.style.removeProperty("--viewport-safe-top");
    expect(() =>
      readViewportSafeBounds({ viewportPadding: 8 }),
    ).toThrow(/top/);
    expect(document.body.childElementCount).toBe(bodyChildCount);

    root.style.setProperty("--viewport-safe-top", "0px");
    root.style.setProperty("--viewport-safe-right", "not-a-length");
    expect(() =>
      readViewportSafeBounds({ viewportPadding: 8 }),
    ).toThrow(/right/);
    expect(document.body.childElementCount).toBe(bodyChildCount);

    for (const edge of ["top", "right", "bottom", "left"] as const) {
      root.style.setProperty(
        `--viewport-safe-${edge}`,
        `env(safe-area-inset-${edge})`,
      );
    }
    expect(() =>
      readViewportSafeBounds({ viewportPadding: 8 }),
    ).not.toThrow();
    expect(document.body.childElementCount).toBe(bodyChildCount);
  });
  /* eslint-enable testing-library/no-node-access */

  it("rejects safe-area indirection and noncanonical environment sources", () => {
    const root = document.documentElement;
    root.style.setProperty("--nested-safe-top", "0px");

    try {
      for (const token of [
        "var(--nested-safe-top)",
        "var(--missing-safe-top)",
        "env(unknown-safe-top)",
        "env(safe-area-inset-left)",
      ]) {
        root.style.setProperty("--viewport-safe-top", token);
        expect(() =>
          readViewportSafeBounds({ viewportPadding: 8 }),
        ).toThrow(/top/);
      }

      root.style.setProperty(
        "--viewport-safe-top",
        "env(safe-area-inset-top)",
      );
      expect(() =>
        readViewportSafeBounds({ viewportPadding: 8 }),
      ).not.toThrow();
    } finally {
      root.style.removeProperty("--nested-safe-top");
    }
  });

  it("preserves zero-inset clamps and reclamps inside all four safe edges", async () => {
    const { rerender } = render(
      <Host
        anchor={new DOMRect(-20, -20, 10, 10)}
        opts={{ enabled: true, placement: "above", align: "start" }}
      />,
    );
    await waitFor(() => {
      expect(floating().style.top).toBe("8px");
      expect(floating().style.left).toBe("8px");
    });

    rerender(
      <Host
        anchor={new DOMRect(window.innerWidth, window.innerHeight, 10, 10)}
        opts={{ enabled: true, placement: "below", align: "end" }}
      />,
    );
    await waitFor(() => {
      expect(floating().style.top).toBe(
        `${window.innerHeight - 8 - FLOAT_H}px`,
      );
      expect(floating().style.left).toBe(
        `${window.innerWidth - 8 - FLOAT_W}px`,
      );
    });

    document.documentElement.style.setProperty("--viewport-safe-top", "11px");
    document.documentElement.style.setProperty("--viewport-safe-right", "13px");
    document.documentElement.style.setProperty(
      "--viewport-safe-bottom",
      "17px",
    );
    document.documentElement.style.setProperty("--viewport-safe-left", "19px");
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      expect(floating().style.top).toBe(
        `${window.innerHeight - 8 - 17 - FLOAT_H}px`,
      );
      expect(floating().style.left).toBe(
        `${window.innerWidth - 8 - 13 - FLOAT_W}px`,
      );
    });

    rerender(
      <Host
        anchor={new DOMRect(-20, -20, 10, 10)}
        opts={{ enabled: true, placement: "above", align: "start" }}
      />,
    );
    await waitFor(() => {
      expect(floating().style.top).toBe("19px");
      expect(floating().style.left).toBe("27px");
    });
  });

  it("places to the right of the anchor with start alignment", async () => {
    render(
      <Host
        anchor={new DOMRect(50, 100, 80, 20)}
        opts={{ enabled: true, placement: "right", align: "start", gap: 4 }}
      />,
    );
    await waitFor(() => {
      expect(floating().style.left).toBe("134px"); // anchor.right(130) + gap(4)
      expect(floating().style.top).toBe("100px"); // anchor.top (align: start)
    });
  });

  it("places to the left of the anchor with center alignment", async () => {
    render(
      <Host
        anchor={new DOMRect(300, 100, 80, 20)}
        opts={{ enabled: true, placement: "left", align: "center", gap: 4 }}
      />,
    );
    await waitFor(() => {
      // left = anchor.left(300) - float.width(100) - gap(4)
      expect(floating().style.left).toBe("196px");
      // top = anchor.top(100) + anchor.height/2(10) - float.height/2(20)
      expect(floating().style.top).toBe("90px");
    });
  });

  it("flips right to the left side when near the right edge", async () => {
    const anchorLeft = window.innerWidth - 30;
    render(
      <Host
        anchor={new DOMRect(anchorLeft, 100, 20, 20)}
        opts={{ enabled: true, placement: "right", gap: 4, flip: true }}
      />,
    );
    // left = anchor.left - float.width(100) - gap(4)
    await waitFor(() =>
      expect(floating().style.left).toBe(`${anchorLeft - FLOAT_W - 4}px`),
    );
  });

  it("stays hidden and unpositioned while disabled", async () => {
    render(
      <Host
        anchor={new DOMRect(50, 50, 80, 20)}
        opts={{ enabled: false, placement: "below" }}
      />,
    );
    await waitFor(() => expect(floating().style.visibility).toBe("hidden"));
    expect(floating().style.top).toBe("");
  });
});
