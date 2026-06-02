import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useAnchoredPosition } from "./useAnchoredPosition";

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
