import { createRef, type RefCallback } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { composeRefs } from "@/lib/ui/composeRefs";

describe("composeRefs", () => {
  it("releases every ref once in reverse order across replacement and unmount", () => {
    const objectRef = createRef<HTMLElement>();
    const releases: string[] = [];
    const withoutCleanup = vi.fn<RefCallback<HTMLElement>>((node) => {
      if (node === null) releases.push("callback-null");
    });
    const firstCleanup = vi.fn<RefCallback<HTMLElement>>((node) => {
      if (node === null) return;
      return () => {
        releases.push("first-cleanup");
      };
    });
    const secondCleanup = vi.fn<RefCallback<HTMLElement>>((node) => {
      if (node === null) return;
      return () => {
        releases.push("second-cleanup");
      };
    });
    const ref = composeRefs(
      objectRef,
      withoutCleanup,
      firstCleanup,
      secondCleanup,
    );

    const view = render(<div key="first" ref={ref} data-testid="first" />);
    const firstNode = objectRef.current;
    expect(firstNode).toBeInstanceOf(HTMLDivElement);

    view.rerender(<section key="second" ref={ref} data-testid="second" />);

    expect(releases).toEqual([
      "second-cleanup",
      "first-cleanup",
      "callback-null",
    ]);
    expect(objectRef.current).toBeInstanceOf(HTMLElement);
    expect(objectRef.current).not.toBe(firstNode);

    view.unmount();

    expect(releases).toEqual([
      "second-cleanup",
      "first-cleanup",
      "callback-null",
      "second-cleanup",
      "first-cleanup",
      "callback-null",
    ]);
    expect(objectRef.current).toBeNull();
    expect(withoutCleanup).toHaveBeenCalledTimes(4);
    expect(firstCleanup).toHaveBeenCalledTimes(2);
    expect(secondCleanup).toHaveBeenCalledTimes(2);
  });
});
