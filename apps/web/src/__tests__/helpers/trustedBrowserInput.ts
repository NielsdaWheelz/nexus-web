export interface TouchCoordinate {
  readonly x: number;
  readonly y: number;
}

export function toTopLevelCdpCoordinate(coordinate: TouchCoordinate): TouchCoordinate {
  let sourceWindow: Window = window;
  let x = coordinate.x;
  let y = coordinate.y;

  while (sourceWindow !== sourceWindow.parent) {
    const frame = sourceWindow.frameElement;
    if (
      !frame ||
      sourceWindow.innerWidth <= 0 ||
      sourceWindow.innerHeight <= 0
    ) {
      throw new Error("Cannot project trusted input through the Vitest frame");
    }
    const frameRect = frame.getBoundingClientRect();
    x = frameRect.left + x * (frameRect.width / sourceWindow.innerWidth);
    y = frameRect.top + y * (frameRect.height / sourceWindow.innerHeight);
    sourceWindow = sourceWindow.parent;
  }

  return { x, y };
}
