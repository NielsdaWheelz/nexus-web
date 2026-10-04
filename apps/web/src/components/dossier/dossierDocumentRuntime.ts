function dossierDocumentRuntime(): void {
  "use strict";

  const channel = document.documentElement.dataset.nexusChannel;
  if (!channel) {
    throw new Error("Dossier document runtime requires a channel.");
  }

  function post(message: Record<string, unknown>): void {
    window.parent.postMessage({ channel, ...message }, "*");
  }

  document.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest(
            "button.dossier-citation[data-nexus-citation]",
          )
        : null;
    if (!target) return;
    event.preventDefault();
    const raw = target.getAttribute("data-nexus-citation");
    if (!raw || !/^[1-9][0-9]*$/u.test(raw)) return;
    const ordinal = Number(raw);
    if (!Number.isSafeInteger(ordinal)) return;
    const disposition =
      event.shiftKey && event.detail !== 0 ? "Fork" : "Follow";
    post({ kind: "Citation", ordinal, disposition });
  });
}

/** Fixed runtime only. Generated title, article or citation data never enters it. */
export const DOSSIER_DOCUMENT_RUNTIME = `(${dossierDocumentRuntime.toString()})();`;
