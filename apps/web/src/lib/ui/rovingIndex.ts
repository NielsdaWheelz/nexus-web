export type RovingIndexOrientation = "horizontal" | "vertical";

export function nextRovingIndexForKey({
  key,
  currentIndex,
  itemCount,
  orientation,
  wrap = false,
  homeEnd = true,
}: {
  key: string;
  currentIndex: number;
  itemCount: number;
  orientation: RovingIndexOrientation;
  wrap?: boolean;
  homeEnd?: boolean;
}): number | null {
  if (itemCount <= 0) {
    return null;
  }

  const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  let nextIndex: number;
  if (key === previousKey) {
    nextIndex = currentIndex - 1;
  } else if (key === nextKey) {
    nextIndex = currentIndex + 1;
  } else if (homeEnd && key === "Home") {
    nextIndex = 0;
  } else if (homeEnd && key === "End") {
    nextIndex = itemCount - 1;
  } else {
    return null;
  }

  if (wrap && (key === previousKey || key === nextKey)) {
    return (nextIndex + itemCount) % itemCount;
  }
  return Math.max(0, Math.min(itemCount - 1, nextIndex));
}
