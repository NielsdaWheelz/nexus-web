/**
 * Copy a string to the clipboard. Uses the async Clipboard API when available
 * and falls back to a hidden-textarea `execCommand("copy")` on insecure origins
 * and older browsers. This is the single clipboard-write owner for the app.
 *
 * Failure is observable: callers must await the promise and show truthful
 * feedback instead of optimistically claiming the copy succeeded.
 */

function fallbackCopyText(value: string): void {
  if (typeof document === "undefined") {
    throw new Error("Clipboard access is unavailable");
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
      throw new Error("Clipboard access was denied");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}

export async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      fallbackCopyText(value);
      return;
    }
  }
  fallbackCopyText(value);
}
