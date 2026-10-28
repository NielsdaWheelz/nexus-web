// What an event's target is, for handlers that must stand down or must not
// double-activate. Native inheritance owns editability; an explicit false HTML
// island also bounds ancestor textbox semantics. Read-only controls stay interactive.
const TEXT_INPUT_TYPES = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);
const INTERACTIVE = [
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
  "[tabindex]:not([tabindex='-1'])",
  ...[
    "button",
    "checkbox",
    "combobox",
    "gridcell",
    "link",
    "listbox",
    "menu",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "treeitem",
  ].map((role) => `[role='${role}']`),
].join(",");

function isEditableRegion(target: Element): boolean {
  let context: Element | null = target;
  while (context && !(context instanceof HTMLElement)) context = context.parentElement;
  if (context instanceof HTMLElement && context.isContentEditable) return true;
  const textbox = target.closest("[role='textbox']");
  if (!textbox) return false;
  for (let boundary = context; boundary; boundary = boundary.parentElement)
    if (boundary instanceof HTMLElement && boundary.contentEditable === "false") return boundary.contains(textbox);
  return true;
}

/** A typing surface (any input, textarea, select, editable region): global shortcuts stand down. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.matches("input, textarea, select") ||
      isEditableRegion(target))
  );
}

/** Input that relinquishes a pending navigation or destination-focus handoff. */
export const NAVIGATION_ATTENTION_EVENTS = [
  "pointerdown", "keydown", "wheel", "touchstart", "beforeinput", "input", "compositionstart",
] as const;

export function isNavigationAttention(event: Event): boolean {
  if (!event.isTrusted) return false;
  if (event instanceof KeyboardEvent &&
    (["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(event.key) || (event.key === "Enter" && event.repeat))) return false;
  if (["beforeinput", "input", "compositionstart"].includes(event.type)) return isEditableTarget(event.target);
  return true;
}

/** A control that summons a soft keyboard; narrower than editable (no select, checkbox, radio). */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.matches("textarea")) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLSelectElement) return false;
  return isEditableRegion(target);
}

/**
 * An interactive element at or above the target; with `boundary`, one strictly
 * inside it, so a click on the boundary's own inert content does not count.
 */
export function isInteractiveTarget(
  target: EventTarget | null,
  boundary?: Element | null,
): boolean {
  const hit = target instanceof Element ? target.closest(INTERACTIVE) : null;
  if (!hit) return false;
  return !boundary || (hit !== boundary && boundary.contains(hit));
}
