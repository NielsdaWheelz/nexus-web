function describeElement(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label") ??
    element.getAttribute("role") ??
    element.tagName.toLowerCase()
  );
}

export function horizontallyScrollableElements(root: HTMLElement): string[] {
  return [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]
    .filter((element) => {
      const overflowX = getComputedStyle(element).overflowX;
      return (
        (overflowX === "auto" || overflowX === "scroll") &&
        element.scrollWidth > element.clientWidth + 1
      );
    })
    .map(describeElement);
}
