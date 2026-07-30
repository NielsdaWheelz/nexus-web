import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import usePaneFilterRows from "./usePaneFilterRows";

const UNIT = { singular: "item", plural: "items" };
const getRowStatus = (query: string) => ({
  kind: "Complete" as const,
  visibleCount: query.length === 0 ? 4 : 1,
  totalCount: 4,
  unit: UNIT,
});

describe("usePaneFilterRows", () => {
  it("owns the source-keyed query and memoized publication", () => {
    const { result, rerender } = renderHook(
      ({ sourceKey }) =>
        usePaneFilterRows({
          sourceKey,
          inputLabel: "Filter items",
          placeholder: "Filter",
          getRowStatus,
          activeDomainControlCount: 0,
        }),
      { initialProps: { sourceKey: "source-a" } },
    );
    const initialPublication = result.current.publication;

    rerender({ sourceKey: "source-a" });
    expect(result.current.publication).toBe(initialPublication);

    act(() => result.current.publication.onQueryChange("needle"));
    expect(result.current.query).toBe("needle");
    expect(result.current.publication.rowStatus.visibleCount).toBe(1);

    act(() => result.current.publication.onDismiss());
    expect(result.current.query).toBe("");
  });

  it("never resurrects an earlier source query across A to B to A", () => {
    const { result, rerender } = renderHook(
      ({ sourceKey }) =>
        usePaneFilterRows({
          sourceKey,
          inputLabel: "Filter items",
          placeholder: "Filter",
          getRowStatus,
          activeDomainControlCount: 0,
        }),
      { initialProps: { sourceKey: "source-a" } },
    );

    act(() => result.current.publication.onQueryChange("source-a query"));
    rerender({ sourceKey: "source-b" });
    expect(result.current.query).toBe("");
    rerender({ sourceKey: "source-a" });
    expect(result.current.query).toBe("");
  });

  it("rejects invalid publication counts", () => {
    expect(() =>
      renderHook(() =>
        usePaneFilterRows({
          sourceKey: "source-a",
          inputLabel: "Filter items",
          placeholder: "Filter",
          getRowStatus,
          activeDomainControlCount: -1,
        }),
      ),
    ).toThrow("Pane Filter active domain control count");
    expect(() =>
      renderHook(() =>
        usePaneFilterRows({
          sourceKey: "source-a",
          inputLabel: "Filter items",
          placeholder: "Filter",
          getRowStatus: () => ({
            kind: "Partial",
            visibleCount: 0,
            loadedCount: 1.5,
            unit: UNIT,
          }),
          activeDomainControlCount: 0,
        }),
      ),
    ).toThrow("Pane Filter loaded row count");
  });
});
