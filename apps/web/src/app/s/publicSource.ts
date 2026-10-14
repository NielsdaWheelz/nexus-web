// The anonymous share's transport and reader source. The token lives in the url
// fragment, so the page request never carries it; it travels only in this
// header, on requests that send no credentials, skip every cache and refuse
// redirects. The pdf's bytes ride it too: pdf.js's own fetches send cookies.
import { ApiError, readResponse } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { readerDocument } from "@/lib/documentReader/model";
import type { ReaderSource } from "@/lib/documentReader/ports";
import { isAbortError } from "@/lib/errors";

const SHARE_API = "/api/public/resource-share";

/** One share request; a request that never got an answer is E_NETWORK. */
export async function publicFetch(
  path: string,
  token: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<Response> {
  try {
    return await fetch(`${SHARE_API}${path}`, {
      headers: { ...headers, "X-Nexus-Share-Token": token },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(0, "E_NETWORK", "Network request failed");
  }
}

export function publicSource(token: string): ReaderSource {
  const pdf = {
    ranges: (range: string, signal: AbortSignal) =>
      publicFetch("/file", token, signal, { range }),
  };
  return {
    async load(signal) {
      const body = await readResponse<
        ApiJson<"/public/resource-share/document", "get">
      >(await publicFetch("/document", token, signal));
      const doc = readerDocument(body.data);
      return doc.kind === "pdf" ? { ...doc, file: pdf } : doc;
    },
    refreshPdf: async () => pdf,
    // Epub images load by ordinal, with the token, as blob urls revoked with the unit.
    hydrate(unit, signal) {
      for (const image of unit.querySelectorAll<HTMLImageElement>(
        "img[data-nexus-public-asset]",
      )) {
        void publicFetch(
          `/assets/${image.dataset.nexusPublicAsset}`,
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
