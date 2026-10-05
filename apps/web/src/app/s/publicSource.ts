// The anonymous share's reader source. The token lives in the url fragment, so
// the page request never carries it; it travels only in this header, on
// requests that send no credentials, skip every cache and refuse redirects.
import type { ApiJson } from "@/lib/api/wire";
import { readerDocument } from "@/lib/documentReader/model";
import type { ReaderSource } from "@/lib/documentReader/ports";

const SHARE_API = "/api/public/resource-share";

export function publicFetch(
  path: string,
  token: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${SHARE_API}${path}`, {
    headers: { "X-Nexus-Share-Token": token },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal,
  });
}

export function publicSource(token: string): ReaderSource {
  const pdf = {
    url: `${SHARE_API}/file`,
    headers: { "X-Nexus-Share-Token": token },
    expiresAtMs: null,
  };
  return {
    async load(signal) {
      const response = await publicFetch("/document", token, signal);
      if (!response.ok)
        throw new Error(`public document responded ${response.status}`);
      const body = (await response.json()) as ApiJson<
        "/public/resource-share/document",
        "get"
      >;
      const doc = readerDocument(body.data);
      return doc.kind === "pdf" ? { ...doc, file: pdf } : doc;
    },
    refreshPdf: async () => pdf,
    // Epub images load by handle, with the token, as blob urls revoked with the unit.
    hydrate(unit, signal) {
      for (const image of unit.querySelectorAll<HTMLImageElement>(
        "img[data-nexus-public-asset-handle]",
      )) {
        void publicFetch(
          `/assets/${image.dataset.nexusPublicAssetHandle}`,
          token,
          signal,
        )
          .then((response) => (response.ok ? response.blob() : null))
          .then((blob) => {
            if (!blob || signal.aborted) return;
            const url = URL.createObjectURL(blob);
            signal.addEventListener("abort", () => URL.revokeObjectURL(url), {
              once: true,
            });
            image.src = url;
          })
          .catch(() => undefined);
      }
    },
  };
}
