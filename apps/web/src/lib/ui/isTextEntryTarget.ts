const TEXT_INPUT_TYPES = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

/**
 * Whether focus belongs to a control that accepts typed text.
 *
 * This is intentionally narrower than `isEditableTarget`: selects, checkboxes,
 * radios, buttons, and other interactive controls do not summon a text-entry
 * keyboard and must not hide fixed mobile chrome.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === "textarea") {
    return true;
  }
  if (tagName === "input") {
    return TEXT_INPUT_TYPES.has(
      target.getAttribute("type")?.toLowerCase() ?? "text",
    );
  }

  const contenteditable = target.closest("[contenteditable]");
  if (
    contenteditable &&
    contenteditable.getAttribute("contenteditable")?.toLowerCase() !== "false"
  ) {
    return true;
  }

  return target.closest("[role='textbox']") !== null;
}
