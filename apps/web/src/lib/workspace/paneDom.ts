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
  if (mobileOptions?.isConnected) return mobileOptions;

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
