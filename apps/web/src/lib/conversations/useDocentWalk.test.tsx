import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CitationOut } from "@/lib/conversations/citationOut";
import { useDocentWalk } from "./useDocentWalk";

function makeCitation(ordinal: number, deepLink: string | null = `/media/m${ordinal}#evidence-span-${ordinal}`): CitationOut {
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

describe("useDocentWalk", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("adopts the first source when a walk starts", () => {
    const activateTarget = vi.fn();
    const { result } = renderHook(() => useDocentWalk({ activateTarget }));

    act(() => {
      result.current.startWalk([makeCitation(1), makeCitation(2)], "Claim [1] and fact [2].");
    });

    expect(activateTarget).toHaveBeenCalledWith({
      target: { href: "/media/m1#evidence-span-1", labelHint: "Source 1" },
      disposition: { kind: "Adopt" },
    });
  });

  it("adopts each next source without firing for a broken step", () => {
    const activateTarget = vi.fn();
    const { result } = renderHook(() => useDocentWalk({ activateTarget }));

    act(() => {
      result.current.startWalk([makeCitation(1, null), makeCitation(2)], "Claim [1] and fact [2].");
    });
    act(() => result.current.next());

    expect(activateTarget).toHaveBeenCalledTimes(1);
    expect(activateTarget).toHaveBeenLastCalledWith({
      target: { href: "/media/m2#evidence-span-2", labelHint: "Source 2" },
      disposition: { kind: "Adopt" },
    });
  });

  it("re-drives the first source when a fresh walk starts", () => {
    const activateTarget = vi.fn();
    const { result } = renderHook(() => useDocentWalk({ activateTarget }));

    act(() => result.current.startWalk([makeCitation(1)], "Claim [1]."));
    act(() => result.current.startWalk([makeCitation(3)], "Claim [3]."));

    expect(activateTarget).toHaveBeenCalledTimes(2);
    expect(activateTarget).toHaveBeenLastCalledWith({
      target: { href: "/media/m3#evidence-span-3", labelHint: "Source 3" },
      disposition: { kind: "Adopt" },
    });
  });

  it("uses walk keys while active but leaves text input alone", () => {
    const { result } = renderHook(() => useDocentWalk({ activateTarget: vi.fn() }));
    act(() => result.current.startWalk([makeCitation(1), makeCitation(2)], "Claim [1] and fact [2]."));

    fireEvent.keyDown(document, { key: "n" });
    expect(result.current.walk.index).toBe(1);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "p" });
    document.body.removeChild(input);
    expect(result.current.walk.index).toBe(1);
  });

  it("moves back with p and leaves with Escape", () => {
    const { result } = renderHook(() => useDocentWalk({ activateTarget: vi.fn() }));
    act(() => result.current.startWalk([makeCitation(1), makeCitation(2)], "Claim [1] and fact [2]."));
    fireEvent.keyDown(document, { key: "n" });
    fireEvent.keyDown(document, { key: "p" });
    expect(result.current.walk.index).toBe(0);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(result.current.walk.status).toBe("idle");
    fireEvent.keyDown(document, { key: "n" });
    expect(result.current.walk.index).toBe(0);
  });
});
