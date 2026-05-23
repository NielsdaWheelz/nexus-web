/**
 * Whether an event target is, or sits inside, a text-editable surface
 * (input, textarea, select, or a contenteditable region). Used by global
 * keyboard handlers to suppress shortcuts while the user is typing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }
  return Boolean(target.closest("[contenteditable]:not([contenteditable='false'])"));
}
