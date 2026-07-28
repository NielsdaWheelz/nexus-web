/**
 * The portal container for a transient overlay (ActionMenu, LibraryChooserSurface).
 * A base-page overlay portals to document.body. A modal-owned overlay must portal
 * into its containing [role="dialog"] so focus, layering, and dismissal stay scoped
 * to that modal — never escape to the body.
 */
export function resolveTransientPortalContainer(
  trigger: HTMLElement | null,
  modalOwned: boolean,
): HTMLElement {
  if (!modalOwned) return document.body;
  const modal = trigger?.closest<HTMLElement>('[role="dialog"]');
  if (!modal) {
    throw new Error(
      "A modal-owned transient overlay requires a containing dialog element.",
    );
  }
  return modal;
}
