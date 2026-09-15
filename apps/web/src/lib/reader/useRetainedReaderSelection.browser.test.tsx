import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  useRetainedReaderSelection,
  type RetainedReaderSelectionSnapshot,
} from "./useRetainedReaderSelection";

interface TestSelection extends RetainedReaderSelectionSnapshot {
  readonly semanticKey: string;
}

function selection(semanticKey: string, left: number): TestSelection {
  const rect = new DOMRect(left, 20, 80, 24);
  return { semanticKey, rect, lineRects: [rect] };
}

function renderRetainedSelection() {
  return renderHook(() =>
    useRetainedReaderSelection<TestSelection>({
      sameSemanticSelection: (left, right) =>
        left.semanticKey === right.semanticKey,
    }),
  );
}

describe("retained reader selection", () => {
  it("publishes immediate captures synchronously", () => {
    const { result } = renderRetainedSelection();
    const captured = selection("passage-a", 10);

    act(() => {
      result.current.capture({
        snapshot: captured,
        publication: "Immediate",
      });
    });

    expect(result.current.visible).toBe(captured);
    expect(result.current.readCaptured()).toBe(captured);
  });

  it("stabilizes the latest capture after its geometry changes", async () => {
    const { result } = renderRetainedSelection();

    act(() => {
      result.current.capture({
        snapshot: selection("passage-a", 10),
        publication: "Stabilized",
      });
      result.current.refreshCaptured((captured) =>
        selection(captured.semanticKey, 40),
      );
    });

    expect(result.current.visible).toBeNull();

    await waitFor(() => {
      expect(result.current.visible?.semanticKey).toBe("passage-a");
      expect(result.current.visible?.rect.left).toBe(40);
    });

    act(() => {
      result.current.capture({
        snapshot: selection("passage-b", 20),
        publication: "Stabilized",
      });
      result.current.capture({
        snapshot: selection("passage-c", 30),
        publication: "Stabilized",
      });
    });

    await waitFor(() =>
      expect(result.current.visible?.semanticKey).toBe("passage-c"),
    );
  });

  it("retains visible captures but clears hidden or invalid captures", () => {
    const { result } = renderRetainedSelection();

    act(() => {
      result.current.capture({
        snapshot: selection("pending", 10),
        publication: "Stabilized",
      });
      result.current.retainVisibleOrClear();
    });

    expect(result.current.visible).toBeNull();
    expect(result.current.readCaptured()).toBeNull();

    act(() => {
      result.current.capture({
        snapshot: selection("visible", 20),
        publication: "Immediate",
      });
      result.current.retainVisibleOrClear();
    });

    expect(result.current.visible?.semanticKey).toBe("visible");
    expect(result.current.readCaptured()?.semanticKey).toBe("visible");
    const visible = result.current.visible;

    act(() => {
      result.current.refreshCaptured(() => selection("visible", 20));
    });

    expect(result.current.visible).toBe(visible);

    act(() => {
      result.current.refreshCaptured(() => null);
    });

    expect(result.current.visible).toBeNull();
    expect(result.current.readCaptured()).toBeNull();
  });

  it("clears captured and visible state atomically", () => {
    const { result } = renderRetainedSelection();

    act(() => {
      result.current.capture({
        snapshot: selection("stale", 10),
        publication: "Stabilized",
      });
      result.current.clear();
    });

    expect(result.current.visible).toBeNull();
    expect(result.current.readCaptured()).toBeNull();
  });
});
