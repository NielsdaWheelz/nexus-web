import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import type { ConnectionOut } from "@/lib/resourceGraph/connections";
import type { EdgeOrigin } from "@/lib/resourceGraph/edges";

export interface ReaderConnectionAnchor {
  ref: string;
  media_id: string;
  locator: Record<string, unknown> | null;
  page_number: number | null;
  fragment_id: string | null;
  highlight_id: string | null;
  evidence_span_id: string | null;
  order_key: string | null;
}

export interface ReaderConnectionRow {
  id: string;
  connection: ConnectionOut;
  anchor: ReaderConnectionAnchor | null;
  source_category:
    | "chat"
    | "library_intelligence"
    | "oracle"
    | "note"
    | "highlight_note"
    | "user_link"
    | "synapse"
    | "system"
    | "other";
  title: string;
  subtitle: string | null;
  excerpt: string | null;
  href: string | null;
}

export interface ReaderConnectionPage {
  anchored: ReaderConnectionRow[];
  unanchored: ReaderConnectionRow[];
  next_cursor: string | null;
}

interface ReaderConnectionResponse {
  data: ReaderConnectionPage;
}

export async function listReaderConnections(
  mediaId: string,
  options: {
    origins?: EdgeOrigin[];
    sourceSchemes?: ResourceScheme[];
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<ReaderConnectionPage> {
  const params = new URLSearchParams();
  for (const origin of options.origins ?? []) params.append("origin", origin);
  for (const scheme of options.sourceSchemes ?? []) params.append("source_scheme", scheme);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await apiFetch<ReaderConnectionResponse>(
    `/api/media/${mediaId}/reader-connections${suffix}` as ApiPath,
    { signal: options.signal },
  );
  return response.data;
}
