import { apiFetch } from "@/lib/api/client";
import { isRecord } from "@/lib/validation";

export const PODCAST_OPML_MAX_BYTES = 1_000_000;

export interface PodcastOpmlImportResult {
  total: number;
  imported: number;
  skipped_already_subscribed: number;
  skipped_invalid: number;
  errors: readonly {
    feed_url: string | null;
    error: string;
  }[];
}

export class PodcastOpmlContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed owned OPML success payloads violate the
    // same-system API contract and are not import outcomes.
    super(message);
    this.name = "PodcastOpmlContractDefect";
  }
}

export class PodcastOpmlEncodingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PodcastOpmlEncodingError";
  }
}

export function getPodcastOpmlFileError(file: File): string | null {
  const name = file.name.toLowerCase();
  const supportedName = name.endsWith(".opml") || name.endsWith(".xml");
  const supported =
    supportedName ||
    file.type === "text/xml" ||
    file.type === "application/xml";
  if (!supported) return "Choose an OPML or XML file.";
  if (file.size === 0) return "OPML files must not be empty.";
  if (file.size > PODCAST_OPML_MAX_BYTES) {
    return "OPML files must be 1 MB or smaller.";
  }
  return null;
}

export async function importPodcastOpml({
  file,
  libraryIds,
  signal,
}: {
  file: File;
  libraryIds: readonly string[];
  signal?: AbortSignal;
}): Promise<PodcastOpmlImportResult> {
  const error = getPodcastOpmlFileError(file);
  if (error) throw new Error(error);
  signal?.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  let opml: string;
  try {
    opml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PodcastOpmlEncodingError("OPML files must use UTF-8 encoding.", {
      cause: error,
    });
  }
  const response = await apiFetch<unknown>("/api/podcasts/import/opml", {
    method: "POST",
    body: JSON.stringify({
      opml,
      default_library_ids: libraryIds,
      per_feed_library_ids: {},
    }),
    signal,
  });
  return decodePodcastOpmlImportResponse(response);
}

export function decodePodcastOpmlImportResponse(
  raw: unknown,
): PodcastOpmlImportResult {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new PodcastOpmlContractDefect(
      "Invalid OPML import response: expected a data object.",
    );
  }
  const data = raw.data;
  const total = nonnegativeInteger(data.total, "total");
  const imported = nonnegativeInteger(data.imported, "imported");
  const already = nonnegativeInteger(
    data.skipped_already_subscribed,
    "skipped_already_subscribed",
  );
  const invalid = nonnegativeInteger(data.skipped_invalid, "skipped_invalid");
  if (imported + already + invalid > total) {
    throw new PodcastOpmlContractDefect(
      "Invalid OPML import response: classified outcomes exceed total.",
    );
  }
  if (!Array.isArray(data.errors)) {
    throw new PodcastOpmlContractDefect(
      "Invalid OPML import response: errors must be an array.",
    );
  }
  const errors = data.errors.map((entry) => {
    if (
      !isRecord(entry) ||
      (entry.feed_url !== null && typeof entry.feed_url !== "string") ||
      typeof entry.error !== "string"
    ) {
      throw new PodcastOpmlContractDefect(
        "Invalid OPML import response: invalid error entry.",
      );
    }
    return { feed_url: entry.feed_url, error: entry.error };
  });
  return {
    total,
    imported,
    skipped_already_subscribed: already,
    skipped_invalid: invalid,
    errors,
  };
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PodcastOpmlContractDefect(
      `Invalid OPML import response: ${field} must be a nonnegative integer.`,
    );
  }
  return value;
}
