import { createRef, StrictMode, type RefCallback } from "react";
import { createRoot, type RootOptions } from "react-dom/client";
import { act, render } from "@testing-library/react";
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

  it("replays callback refs in StrictMode and releases each mounted generation once", async () => {
    const objectRef = createRef<HTMLDivElement>();
    const lifecycle: string[] = [];
    const withoutCleanup: RefCallback<HTMLDivElement> = (node) => {
      lifecycle.push(node ? "plain:mount" : "plain:release");
    };
    const withCleanup: RefCallback<HTMLDivElement> = (node) => {
      if (node === null) {
        lifecycle.push("owned:null");
        return;
      }
      lifecycle.push("owned:mount");
      return () => {
        lifecycle.push("owned:release");
      };
    };
    const ref = composeRefs(objectRef, withoutCleanup, withCleanup);
    function RefOwner() {
      return <div ref={ref} />;
    }

    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container, {
      unstable_strictMode: true,
    } as RootOptions & { unstable_strictMode: true });
    // This is ReactDOM's root, not Testing Library's already-wrapped render.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <StrictMode>
          <RefOwner />
        </StrictMode>,
      );
    });

    expect(lifecycle).toEqual([
      "plain:mount",
      "owned:mount",
      "owned:release",
      "plain:release",
      "plain:mount",
      "owned:mount",
    ]);
    expect(objectRef.current).toBeInstanceOf(HTMLDivElement);

    await act(async () => {
      root.unmount();
    });
    container.remove();

    expect(lifecycle).toEqual([
      "plain:mount",
      "owned:mount",
      "owned:release",
      "plain:release",
      "plain:mount",
      "owned:mount",
      "owned:release",
      "plain:release",
    ]);
    expect(lifecycle).not.toContain("owned:null");
    expect(objectRef.current).toBeNull();
  });
});
