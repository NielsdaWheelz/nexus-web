/**
 * Copy a string to the clipboard. Uses the async Clipboard API when available
 * and falls back to a hidden-textarea `execCommand("copy")` on insecure origins
 * and older browsers. This is the single clipboard-write owner for the app.
 *
 * Failure is observable: callers must await the promise and show truthful
 * feedback instead of optimistically claiming the copy succeeded.
 */

export class ClipboardWriteUnavailableError extends Error {
  constructor() {
    super("Clipboard write is unavailable.");
    this.name = "ClipboardWriteUnavailableError";
  }
}

function fallbackCopyText(value: string): void {
  if (typeof document === "undefined") {
    throw new ClipboardWriteUnavailableError();
  }
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  document.body.appendChild(textArea);
  textArea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new ClipboardWriteUnavailableError();
    }
  } finally {
    document.body.removeChild(textArea);
  }
}

function isClipboardPermissionDenied(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

export async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      if (!isClipboardPermissionDenied(error)) throw error;
      fallbackCopyText(value);
      return;
    }
  }
  fallbackCopyText(value);
}
