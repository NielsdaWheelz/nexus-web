import { isPositiveFinite } from "@/lib/validation";

const TEXT_ANCHOR_TOP_PADDING_PX = 56;

function isScrollableY(element: HTMLElement): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const computed = window.getComputedStyle(element);
  return (
    /(auto|scroll|overlay)/.test(computed.overflowY) &&
    element.scrollHeight > element.clientHeight
  );
}

export function getPaneScrollContainer(
  contentNode: HTMLElement | null,
): HTMLElement | null {
  if (!contentNode) {
    return null;
  }

  const explicitPaneViewport = contentNode.closest<HTMLElement>(
    '[data-testid="document-viewport"], [data-pane-content="true"]',
  );
  if (explicitPaneViewport && isScrollableY(explicitPaneViewport)) {
    return explicitPaneViewport;
  }

  let candidate: HTMLElement | null = contentNode;
  while (candidate && candidate !== document.body) {
    if (isScrollableY(candidate)) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }

  const paneContent = contentNode.closest<HTMLElement>(
    '[data-pane-content="true"]',
  );
  if (paneContent) {
    return paneContent;
  }

  if (typeof document !== "undefined" && document.scrollingElement) {
    return document.scrollingElement as HTMLElement;
  }
  return null;
}

type ScrollIntoViewOptionsWithContainer = ScrollIntoViewOptions & {
  container?: "all" | "nearest";
};

export function getPaneScrollTopPaddingPx(container: HTMLElement): number {
  if (typeof window === "undefined") {
    return TEXT_ANCHOR_TOP_PADDING_PX;
  }

  const parsed = Number.parseFloat(
    window.getComputedStyle(container).scrollPaddingTop,
  );
  if (isPositiveFinite(parsed)) {
    return parsed;
  }
  return TEXT_ANCHOR_TOP_PADDING_PX;
}

export function isElementInPaneView(
  container: HTMLElement,
  target: HTMLElement,
): boolean {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.bottom > containerRect.top && targetRect.top < containerRect.bottom;
}

export function scrollElementIntoPaneView(
  container: HTMLElement,
  target: HTMLElement,
  options: { block?: "start" | "center" } = {},
): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const topPaddingPx = getPaneScrollTopPaddingPx(container);
  const block = options.block ?? "start";
  const delta =
    block === "center"
      ? targetRect.top -
        containerRect.top -
        Math.max(0, (containerRect.height - targetRect.height) / 2)
      : targetRect.top - containerRect.top - topPaddingPx;
  container.scrollTop = Math.max(0, container.scrollTop + delta);
  if (!isElementInPaneView(container, target)) {
    target.scrollIntoView({
      block,
      inline: "nearest",
      behavior: "auto",
      container: "nearest",
    } as ScrollIntoViewOptionsWithContainer);
  }
}
