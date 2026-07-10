"use client";

import { useEffect } from "react";
import { useResource } from "@/lib/api/useResource";

interface ConcordanceEntry {
  readonly id: string;
}

/**
 * Loads the concordance peers for one selected oracle folio (READINGS layer).
 * Extracted verbatim from the former oracle-scoped AtlasPaneBody; still drives
 * the readings-layer constellation lines in the grand atlas.
 */
export default function AtlasConcordancePeerLoader({
  readingId,
  onPeerIds,
}: {
  readingId: string;
  onPeerIds: (peerIds: readonly string[]) => void;
}) {
  const concordanceResource = useResource<{ data: ConcordanceEntry[] }>({
    cacheKey: readingId,
    path: (id) => `/api/oracle/readings/${id}/concordance`,
  });

  useEffect(() => {
    if (concordanceResource.status === "ready") {
      onPeerIds(concordanceResource.data.data.map((entry) => entry.id));
      return;
    }
    if (concordanceResource.status === "error") {
      onPeerIds([]);
    }
  }, [concordanceResource, onPeerIds]);

  return null;
}
