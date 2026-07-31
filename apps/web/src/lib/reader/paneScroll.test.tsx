import { act, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ReaderScrollPositioner,
  useReaderScrollPositioner,
} from "@/lib/reader/paneScroll";
import {
  MobileChromeProvider,
  useMobileChrome,
} from "@/lib/workspace/mobileChrome";

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => true,
}));

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 400,
    width: 400,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function Harness({
  positionerRef,
}: {
  positionerRef: React.MutableRefObject<ReaderScrollPositioner | null>;
}) {
  const positioner = useReaderScrollPositioner();
  const { motionPhase } = useMobileChrome();
  useLayoutEffect(() => {
    positionerRef.current = positioner;
    return () => {
      positionerRef.current = null;
    };
  }, [positioner, positionerRef]);
  return <output data-testid="phase">{motionPhase.kind}</output>;
}

describe("useReaderScrollPositioner", () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
  });

  async function flushFrames(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
    const queued = frames;
    frames = [];
    await act(async () => {
      queued.forEach((callback) => callback(0));
      await Promise.resolve();
    });
  }

  it("owns reader mutations and holds visible chrome through the final layout sample", async () => {
    const positionerRef = { current: null } as React.MutableRefObject<
      ReaderScrollPositioner | null
    >;
    render(
      <MobileChromeProvider>
        <Harness positionerRef={positionerRef} />
      </MobileChromeProvider>,
    );
    const scrollport = document.createElement("div");
    const target = document.createElement("div");
    let scrollTop = 0;
    Object.defineProperty(scrollport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    vi.spyOn(scrollport, "getBoundingClientRect").mockReturnValue(rect(100, 500));
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(520, 560));

    let completion: Promise<void> | null = null;
    act(() => {
      completion = positionerRef.current!.run((commands) => {
        commands.setTop(scrollport, 80);
        commands.adjustTop(scrollport, -20);
        commands.reveal(scrollport, target);
      });
    });

    expect(scrollport.scrollTop).toBe(120);
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    await flushFrames();
    await completion;

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("does not move a target already inside the supplied scrollport", async () => {
    const positionerRef = { current: null } as React.MutableRefObject<
      ReaderScrollPositioner | null
    >;
    render(
      <MobileChromeProvider>
        <Harness positionerRef={positionerRef} />
      </MobileChromeProvider>,
    );
    const scrollport = document.createElement("div");
    const target = document.createElement("div");
    let scrollTop = 80;
    Object.defineProperty(scrollport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    vi.spyOn(scrollport, "getBoundingClientRect").mockReturnValue(rect(100, 500));
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(120, 160));

    let completion: Promise<void> | null = null;
    act(() => {
      completion = positionerRef.current!.run((commands) => {
        commands.reveal(scrollport, target);
      });
    });
    await flushFrames();
    await completion;

    expect(scrollport.scrollTop).toBe(80);
  });
});
