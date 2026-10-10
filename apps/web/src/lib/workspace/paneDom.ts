// A pane's one DOM identity is its wrap's `data-pane-id`; these find the focus
// targets inside it, and in the mobile top bar that projects its chrome. A
// target is usable only while it is connected and outside inert chrome.
function usable(element: Element | null | undefined): HTMLElement | null {
  return element instanceof HTMLElement &&
    element.isConnected &&
    !element.closest("[inert]")
    ? element
    : null;
}

function inPane(paneId: string, selector: string): HTMLElement | null {
  return usable(
    document
      .querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`)
      ?.querySelector(selector),
  );
}

export function findPaneLandmarkFocusTarget(
  paneId: string | null | undefined,
): HTMLElement | null {
  return paneId ? inPane(paneId, "[data-pane-focus-landmark='true']") : null;
}

/** Mobile: the top bar's More trigger; desktop: the pane's chrome. */
export function findPaneChromeFocusTarget(
  paneId: string | null | undefined,
): HTMLElement | null {
  if (!paneId) return null;
  return (
    usable(
      document
        .querySelector(`[data-pane-chrome-for="${CSS.escape(paneId)}"]`)
        ?.querySelector("[data-pane-menu-trigger]"),
    ) ?? inPane(paneId, "[data-pane-chrome-focus='true']")
  );
}
