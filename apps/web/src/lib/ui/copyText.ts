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
function copyWithCommand(value: string, ref?: string): void {
  if (typeof document === "undefined")
    throw new ClipboardWriteUnavailableError();
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
      JSON.stringify({ ref }),
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
    textArea.remove();
  }
}

/** Copy a navigable address and the identity used by outline link paste. */
export async function copyResourceLink(
  href: string,
  ref: string,
): Promise<void> {
  copyWithCommand(href, ref);
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
