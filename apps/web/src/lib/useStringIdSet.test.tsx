import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStringIdSet } from "./useStringIdSet";

describe("useStringIdSet", () => {
  it("starts with an empty Set", () => {
    const { result } = renderHook(() => useStringIdSet());
    expect(result.current.ids.size).toBe(0);
  });

  it("adds and removes ids without mutating prior sets", () => {
    const { result } = renderHook(() => useStringIdSet());
    const firstIds = result.current.ids;
    act(() => result.current.add("a"));
    expect(result.current.ids).not.toBe(firstIds);
    expect(result.current.ids.has("a")).toBe(true);

    act(() => result.current.remove("a"));
    expect(result.current.ids.has("a")).toBe(false);
  });

  it("skips the state update when add() repeats an existing id", () => {
    const { result } = renderHook(() => useStringIdSet());
    act(() => result.current.add("a"));
    const afterAdd = result.current.ids;
    act(() => result.current.add("a"));
    expect(result.current.ids).toBe(afterAdd);
  });

  it("skips the state update when remove() targets an absent id", () => {
    const { result } = renderHook(() => useStringIdSet());
    const initial = result.current.ids;
    act(() => result.current.remove("ghost"));
    expect(result.current.ids).toBe(initial);
  });

  it("replace() swaps in the new set; clear() empties it", () => {
    const { result } = renderHook(() => useStringIdSet());
    act(() => result.current.replace(["a", "b", "c"]));
    expect(Array.from(result.current.ids).sort()).toEqual(["a", "b", "c"]);

    act(() => result.current.clear());
    expect(result.current.ids.size).toBe(0);
  });

  it("clear() skips the state update when already empty", () => {
    const { result } = renderHook(() => useStringIdSet());
    const initial = result.current.ids;
    act(() => result.current.clear());
    expect(result.current.ids).toBe(initial);
  });
});
