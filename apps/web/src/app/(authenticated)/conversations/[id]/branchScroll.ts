/**
 * Branch-scroll capture and restore for the conversation chat view.
 *
 * When the user switches branches the chat re-renders. We snapshot a stable
 * anchor (the first visible message + its offset, plus the activation anchor
 * if any) before the swap so the new branch settles at the same eye-line.
 */

export type BranchScroll = {
  anchorMessageId: string | null;
  anchorOffsetTop: number;
  activationAnchorMessageId: string | null;
  activationAnchorOffsetTop: number | null;
  scrollTop: number;
};

export function captureBranchScroll(
  scrollport: HTMLElement,
  activationAnchorMessageId: string | null,
): BranchScroll {
  const scrollTop = scrollport.scrollTop;
  const viewportBottom = scrollTop + scrollport.clientHeight;
  let anchorMessageId: string | null = null;
  let anchorOffsetTop = 0;
  let activationAnchorOffsetTop: number | null = null;

  for (const element of scrollport.querySelectorAll<HTMLElement>(
    "[data-message-id]",
  )) {
    const messageId = element.dataset.messageId ?? null;
    if (!messageId) continue;

    const offsetTop = element.offsetTop - scrollTop;
    if (messageId === activationAnchorMessageId) {
      activationAnchorOffsetTop = offsetTop;
    }
    if (element.offsetTop + element.offsetHeight <= scrollTop) continue;
    if (element.offsetTop >= viewportBottom) continue;

    if (!anchorMessageId || (anchorOffsetTop < 0 && offsetTop >= 0)) {
      anchorMessageId = messageId;
      anchorOffsetTop = offsetTop;
    }
  }

  return {
    anchorMessageId,
    anchorOffsetTop,
    activationAnchorMessageId,
    activationAnchorOffsetTop,
    scrollTop,
  };
}

export function restoreBranchScroll(
  scrollport: HTMLElement,
  scroll: BranchScroll,
) {
  if (
    scroll.anchorMessageId &&
    restoreMessageOffset(
      scrollport,
      scroll.anchorMessageId,
      scroll.anchorOffsetTop,
    )
  ) {
    return;
  }
  if (
    scroll.activationAnchorMessageId &&
    scroll.activationAnchorOffsetTop !== null &&
    restoreMessageOffset(
      scrollport,
      scroll.activationAnchorMessageId,
      scroll.activationAnchorOffsetTop,
    )
  ) {
    return;
  }
  scrollport.scrollTop = scroll.scrollTop;
}

function restoreMessageOffset(
  scrollport: HTMLElement,
  messageId: string,
  offsetTop: number,
) {
  const target = findRenderedMessage(scrollport, messageId);
  if (!target) return false;
  scrollport.scrollTop = Math.max(0, target.offsetTop - offsetTop);
  return true;
}

export function findRenderedMessage(scrollport: HTMLElement, messageId: string) {
  for (const element of scrollport.querySelectorAll<HTMLElement>(
    "[data-message-id]",
  )) {
    if (element.dataset.messageId === messageId) {
      return element;
    }
  }
  return null;
}
