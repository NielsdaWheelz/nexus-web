// The app's one clipboard writer. Failure is observable: callers await and
// report a failed copy truthfully instead of claiming success.

export class ClipboardWriteUnavailableError extends Error {
  constructor() {
    super("Clipboard write is unavailable.");
    this.name = "ClipboardWriteUnavailableError";
  }
}

/** The identity outline link paste reads beside the plain address. */
export const RESOURCE_CLIPBOARD_TYPE = "application/x-nexus-reference+json";

/** A hidden-textarea `execCommand("copy")`, for insecure origins, older browsers and custom types. */
function copyWithCommand(value: string, ref?: string, field: "annotation" | null = null): void {
  if (typeof document === "undefined")
    throw new ClipboardWriteUnavailableError();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const nativeSelection = previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement
    ? { start: previous.selectionStart, end: previous.selectionEnd, direction: previous.selectionDirection,
      left: previous.scrollLeft, top: previous.scrollTop } : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const anchor = selection?.anchorNode ?? null;
  const focus = selection?.focusNode ?? null;
  const anchorOffset = selection?.anchorOffset ?? 0;
  const focusOffset = selection?.focusOffset ?? 0;
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.readOnly = true;
  textArea.style.cssText = "position:fixed;top:-1000px";
  document.body.append(textArea);
  textArea.select();
  let written = false;
  const writeIdentity = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", value);
    event.clipboardData.setData(
      RESOURCE_CLIPBOARD_TYPE,
      JSON.stringify({ ref, field }),
    );
    event.preventDefault();
    written = true;
  };
  if (ref !== undefined) document.addEventListener("copy", writeIdentity);
  try {
    if (!document.execCommand("copy") || (ref !== undefined && !written))
      throw new ClipboardWriteUnavailableError();
  } finally {
    document.removeEventListener("copy", writeIdentity);
    const ownedFocus = document.activeElement === textArea;
    textArea.remove();
    if (ownedFocus && previous?.isConnected && !previous.closest("[hidden], [inert]")) {
      previous.focus({ preventScroll: true });
      // Focus handlers may have deliberately handed interaction to another live control.
      if (document.activeElement === previous) {
        if (nativeSelection && nativeSelection.start !== null && nativeSelection.end !== null
          && (previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement)) {
          previous.setSelectionRange(nativeSelection.start, nativeSelection.end, nativeSelection.direction ?? "none");
          previous.scrollLeft = nativeSelection.left; previous.scrollTop = nativeSelection.top;
        } else if (selection) {
          selection.removeAllRanges();
          for (const range of ranges) if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range);
          if (ranges.length === 1 && anchor?.isConnected && focus?.isConnected)
            selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
        }
      }
    }
  }
}

/** Copy a navigable address and the identity used by outline link paste. */
export async function copyResourceLink(
  href: string,
  ref: string,
  field: "annotation" | null = null,
): Promise<void> {
  copyWithCommand(href, ref, field);
}

export async function copyText(value: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
    return copyWithCommand(value);
  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotAllowedError"))
      throw error;
    copyWithCommand(value);
  }
}
