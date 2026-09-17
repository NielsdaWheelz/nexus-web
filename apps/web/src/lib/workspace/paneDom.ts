/**
 * Resolves the programmatic chrome focus target owned by one canonical
 * workspace pane wrapper. The wrapper's `data-pane-id` is intentionally the
 * only DOM identity for a pane; nested pane surfaces must not repeat it.
 */
function findPane(paneId: string | null | undefined): HTMLElement | null {
  if (!paneId) return null;
  return document.querySelector<HTMLElement>(
    `[data-pane-id="${CSS.escape(paneId)}"]`,
  );
}

/** A focus target is usable only while it is live and not inside inert chrome. */
function usable(el: HTMLElement | null | undefined): HTMLElement | null {
  return el?.isConnected && !el.closest("[inert]") ? el : null;
}

export function findPaneLandmarkFocusTarget(
  paneId: string | null | undefined,
): HTMLElement | null {
  return usable(
    findPane(paneId)?.querySelector<HTMLElement>(
      "[data-pane-focus-landmark='true']",
    ),
  );
}

export function findPaneChromeFocusTarget(
  paneId: string | null | undefined,
): HTMLElement | null {
  if (!paneId) return null;
  const mobileProjection = document.querySelector<HTMLElement>(
    `[data-pane-chrome-for="${CSS.escape(paneId)}"]`,
  );
  const mobileOptions = usable(
    mobileProjection?.querySelector<HTMLElement>("[data-pane-menu-trigger]"),
  );
  if (mobileOptions) return mobileOptions;

  const pane = findPane(paneId);
  const desktopOptions = usable(
    pane?.querySelector<HTMLElement>("[data-pane-menu-trigger]"),
  );
  if (desktopOptions) return desktopOptions;
  return usable(
    pane?.querySelector<HTMLElement>("[data-pane-chrome-focus='true']"),
  );
}

export function findPaneSearchFocusTarget(
  paneId: string | null | undefined,
): HTMLElement | null {
  if (!paneId) return null;
  const pane = findPane(paneId);
  const input = usable(
    pane?.querySelector<HTMLElement>("[data-pane-search-input]"),
  );
  if (input) return input;
  const action = usable(
    pane?.querySelector<HTMLElement>('[data-action-id="Pane.Search"]'),
  );
  if (action) return action;
  return findPaneChromeFocusTarget(paneId);
}
