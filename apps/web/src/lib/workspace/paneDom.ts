/**
 * Resolves the programmatic chrome focus target owned by one canonical
 * workspace pane wrapper. The wrapper's `data-pane-id` is intentionally the
 * only DOM identity for a pane; nested pane surfaces must not repeat it.
 */
export function findPaneChromeFocusTarget(
  paneId: string | null | undefined,
): HTMLElement | null {
  if (!paneId) return null;
  const mobileProjection = Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane-chrome-for]"),
  ).find((candidate) => candidate.dataset.paneChromeFor === paneId);
  const mobileOptions = mobileProjection?.querySelector<HTMLElement>(
    "[data-pane-options-trigger]",
  );
  if (mobileOptions?.isConnected && !mobileOptions.closest("[inert]")) {
    return mobileOptions;
  }

  const pane = Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane-id]"),
  ).find((candidate) => candidate.dataset.paneId === paneId);
  const desktopOptions = pane?.querySelector<HTMLElement>(
    "[data-pane-options-trigger]",
  );
  if (desktopOptions?.isConnected) return desktopOptions;
  return (
    pane?.querySelector<HTMLElement>("[data-pane-chrome-focus='true']") ??
    null
  );
}

export function findPaneLandmarkFocusTarget(
  paneId: string | null | undefined,
): HTMLElement | null {
  if (!paneId) return null;
  const pane = Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane-id]"),
  ).find((candidate) => candidate.dataset.paneId === paneId);
  const landmark = pane?.querySelector<HTMLElement>(
    "[data-pane-focus-landmark='true']",
  );
  if (landmark?.isConnected && !landmark.closest("[inert]")) return landmark;
  return null;
}

export function findPaneSearchFocusTarget(
  paneId: string | null | undefined,
): HTMLElement | null {
  if (!paneId) return null;
  const pane = Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane-id]"),
  ).find((candidate) => candidate.dataset.paneId === paneId);
  const input = pane?.querySelector<HTMLElement>("[data-pane-search-input]");
  if (input?.isConnected && !input.closest("[inert]")) return input;
  const action = pane?.querySelector<HTMLElement>(
    '[data-action-id="Pane.Search"]',
  );
  if (action?.isConnected && !action.closest("[inert]")) return action;
  return findPaneChromeFocusTarget(paneId);
}
