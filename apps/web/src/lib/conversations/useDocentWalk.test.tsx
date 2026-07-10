import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import type { CitationOut } from "@/lib/conversations/citationOut";
import type { PaneScopedRouter } from "@/lib/panes/paneRuntime";
import { useDocentWalk } from "./useDocentWalk";

function makeCitation(
  ordinal: number,
  deepLink: string | null = `/media/m${ordinal}#evidence-span-${ordinal}`,
): CitationOut {
  return {
    ordinal,
    role: "supports",
    target_ref: { type: "evidence_span", id: `span-${ordinal}` },
    activation: {
      resourceRef: `evidence_span:span-${ordinal}`,
      kind: "route",
      href: `/media/m${ordinal}`,
      unresolvedReason: null,
    },
    media_id: `m${ordinal}`,
    locator: null,
    deep_link: deepLink,
    snapshot: {
      title: `Source ${ordinal}`,
      excerpt: null,
      section_label: null,
      result_type: null,
      summary_md: null,
    },
  };
}

function makeRouter(): PaneScopedRouter {
  return {
    canGoBack: false,
    canGoForward: false,
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  };
}

describe("useDocentWalk", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls openInNewPane with step href on startWalk", () => {
    const openInNewPane = vi.fn();
    const router = makeRouter();
    const { result } = renderHook(() =>
      useDocentWalk({ openInNewPane, router, isMobile: false }),
    );

    act(() => {
      result.current.startWalk(
        [makeCitation(1), makeCitation(2)],
        "Claim [1] and fact [2].",
      );
    });

    expect(openInNewPane).toHaveBeenCalledWith(
      "/media/m1#evidence-span-1",
      "Source 1",
    );
  });

  it("re-drives the pane when a fresh walk starts while active at index 0", () => {
    // Regression: starting a walk on a second message while already sitting on
    // step 1 (index 0) of a first walk keeps (status, index) = (active, 0). The
    // epoch bump is what lets the pane-driving effect re-fire for the new source.
    const openInNewPane = vi.fn();
    const router = makeRouter();
    const { result } = renderHook(() =>
      useDocentWalk({ openInNewPane, router, isMobile: false }),
    );

    act(() => {
      result.current.startWalk(
        [makeCitation(1), makeCitation(2)],
        "Claim [1] and fact [2].",
      );
    });
    expect(openInNewPane).toHaveBeenLastCalledWith(
      "/media/m1#evidence-span-1",
      "Source 1",
    );

    // Second message's walk — different first source, still index 0.
    act(() => {
      result.current.startWalk(
        [makeCitation(3), makeCitation(4)],
        "Other claim [3] and fact [4].",
      );
    });

    expect(openInNewPane).toHaveBeenCalledTimes(2);
    expect(openInNewPane).toHaveBeenLastCalledWith(
      "/media/m3#evidence-span-3",
      "Source 3",
    );
  });

  it("calls openInNewPane with next step href when next() is called", () => {
    const openInNewPane = vi.fn();
    const router = makeRouter();
    const { result } = renderHook(() =>
      useDocentWalk({ openInNewPane, router, isMobile: false }),
    );

    act(() => {
      result.current.startWalk(
        [makeCitation(1), makeCitation(2)],
        "Claim [1] and fact [2].",
      );
    });

    act(() => {
      result.current.next();
    });

    expect(openInNewPane).toHaveBeenCalledTimes(2);
    expect(openInNewPane).toHaveBeenLastCalledWith(
      "/media/m2#evidence-span-2",
      "Source 2",
    );
  });

  it("does not call openInNewPane when step href is null (broken step)", () => {
    const openInNewPane = vi.fn();
    const router = makeRouter();
    const { result } = renderHook(() =>
      useDocentWalk({ openInNewPane, router, isMobile: false }),
    );

    act(() => {
      result.current.startWalk(
        [makeCitation(1, null), makeCitation(2)],
        "Claim [1] and fact [2].",
      );
    });

    expect(openInNewPane).not.toHaveBeenCalled();
  });

  it("calls router.push instead of openInNewPane on mobile", () => {
    const openInNewPane = vi.fn();
    const router = makeRouter();
    const { result } = renderHook(() =>
      useDocentWalk({ openInNewPane, router, isMobile: true }),
    );

    act(() => {
      result.current.startWalk(
        [makeCitation(1), makeCitation(2)],
        "Claim [1] and fact [2].",
      );
    });

    expect(openInNewPane).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/media/m1#evidence-span-1");
  });

  it("attaches keydown listener while walk is active; n calls next", () => {
    const openInNewPane = vi.fn();
    const router = makeRouter();
    const { result } = renderHook(() =>
      useDocentWalk({ openInNewPane, router, isMobile: false }),
    );

    act(() => {
      result.current.startWalk(
        [makeCitation(1), makeCitation(2)],
        "Claim [1] and fact [2].",
      );
    });

    fireEvent.keyDown(document, { key: "n" });

    expect(result.current.walk.index).toBe(1);
  });

  it("attaches keydown listener while walk is active; p calls prev", () => {
    const openInNewPane = vi.fn();
    const router = makeRouter();
    const { result } = renderHook(() =>
      useDocentWalk({ openInNewPane, router, isMobile: false }),
    );

    act(() => {
      result.current.startWalk(
        [makeCitation(1), makeCitation(2)],
        "Claim [1] and fact [2].",
      );
    });

    // Advance first
    fireEvent.keyDown(document, { key: "n" });
    expect(result.current.walk.index).toBe(1);

    // Now retreat
    fireEvent.keyDown(document, { key: "p" });
    expect(result.current.walk.index).toBe(0);
  });

  it("Escape calls leave and removes keydown listener", () => {
    const openInNewPane = vi.fn();
    const router = makeRouter();
    const { result } = renderHook(() =>
      useDocentWalk({ openInNewPane, router, isMobile: false }),
    );

    act(() => {
      result.current.startWalk(
        [makeCitation(1), makeCitation(2)],
        "Claim [1] and fact [2].",
      );
    });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(result.current.walk.status).toBe("idle");

    // After leaving, n keydown should have no effect on walk state
    const prevIndex = result.current.walk.index;
    fireEvent.keyDown(document, { key: "n" });
    expect(result.current.walk.index).toBe(prevIndex);
  });

  it("does not fire key handlers when focus is inside an input", () => {
    const openInNewPane = vi.fn();
    const router = makeRouter();
    const { result } = renderHook(() =>
      useDocentWalk({ openInNewPane, router, isMobile: false }),
    );

    act(() => {
      result.current.startWalk(
        [makeCitation(1), makeCitation(2)],
        "Claim [1] and fact [2].",
      );
    });

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "n" });
    document.body.removeChild(input);

    // Still at index 0 — keydown inside input was suppressed
    expect(result.current.walk.index).toBe(0);
  });
});
