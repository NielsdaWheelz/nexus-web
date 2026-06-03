/**
 * Copy a string to the clipboard, best-effort. Uses the async Clipboard API when
 * available and falls back to a hidden-textarea `execCommand("copy")` on insecure
 * origins / older browsers. The single clipboard-write owner for the app.
 */

function fallbackCopyText(value: string): void {
  if (typeof document === "undefined") return;
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

export function copyText(value: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value).catch(() => fallbackCopyText(value));
    return;
  }
  fallbackCopyText(value);
}
