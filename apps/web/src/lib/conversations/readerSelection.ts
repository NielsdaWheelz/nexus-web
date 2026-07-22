/**
 * The reader-quote wire projections and their strict decoders.
 *
 * `ReaderSelectionOut` is the immutable snapshot as it rides on a quoted user
 * message; `ReaderSelectionPreview` is the same plus the compare-on-send
 * `revision` returned by the preview endpoint. Both decode once at the client
 * boundary and then flow through view code as owned values.
 */

import {
  isMediaRetrievalLocator,
  isRetrievalLocator,
  type MediaRetrievalLocator,
} from "@/lib/api/sse/locators";
import {
  normalizeResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { isRecord } from "@/lib/validation";
import {
  parseReaderSelectionKey,
  type ReaderSelectionKey,
} from "./readerSelectionKey";

export interface ReaderSelectionOut {
  key: ReaderSelectionKey;
  sourceLabel: string;
  exact: string;
  prefix: string;
  suffix: string;
  locator: MediaRetrievalLocator;
  activation: ResourceActivation;
}

export interface ReaderSelectionPreview extends ReaderSelectionOut {
  revision: string;
}

const REVISION_RE = /^[0-9a-f]{64}$/;

function decodeReaderSelectionBase(raw: unknown): ReaderSelectionOut | null {
  if (!isRecord(raw) || !isRecord(raw.key)) return null;
  const key = parseReaderSelectionKey({
    mediaId: raw.key.media_id,
    highlightId: raw.key.highlight_id,
  });
  if (key === null) return null;
  if (typeof raw.source_label !== "string" || raw.source_label.length === 0) return null;
  if (typeof raw.exact !== "string" || raw.exact.length === 0) return null;
  const prefix = typeof raw.prefix === "string" ? raw.prefix : "";
  const suffix = typeof raw.suffix === "string" ? raw.suffix : "";
  if (!isRetrievalLocator(raw.locator) || !isMediaRetrievalLocator(raw.locator)) return null;
  const activation = normalizeResourceActivation(raw.activation);
  if (activation === null) return null;
  return {
    key,
    sourceLabel: raw.source_label,
    exact: raw.exact,
    prefix,
    suffix,
    locator: raw.locator,
    activation,
  };
}

/** Strictly decode a message-wire `ReaderSelectionOut`; `null` on any bad field. */
export function decodeReaderSelectionOut(raw: unknown): ReaderSelectionOut | null {
  return decodeReaderSelectionBase(raw);
}

/** Strictly decode a preview `ReaderSelectionPreview` (adds `revision`). */
export function decodeReaderSelectionPreview(raw: unknown): ReaderSelectionPreview | null {
  const base = decodeReaderSelectionBase(raw);
  if (base === null || !isRecord(raw)) return null;
  if (typeof raw.revision !== "string" || !REVISION_RE.test(raw.revision)) return null;
  return { ...base, revision: raw.revision };
}
