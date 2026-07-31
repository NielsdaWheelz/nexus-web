const INTERACTIVE_TARGET_SELECTOR = [
  "a[href]",
  "audio[controls]",
  "button",
  "iframe",
  "input",
  "select",
  "summary",
  "textarea",
  "video[controls]",
  "[contenteditable]",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='gridcell']",
  "[role='link']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='treeitem']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function isInteractiveTarget(
  target: EventTarget | null,
  boundary?: Element | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(INTERACTIVE_TARGET_SELECTOR);
  if (!interactive) return false;
  if (!boundary) return true;
  return interactive !== boundary && boundary.contains(interactive);
}
