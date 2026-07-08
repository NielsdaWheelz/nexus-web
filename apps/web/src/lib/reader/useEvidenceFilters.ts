"use client";

import { useCallback, useState } from "react";

/**
 * The kind-filter state shared by the Evidence sidecar (the control owner) and
 * the wide-viewport MarginRail. Lifted out of EvidencePaneSurface-local state so
 * both presenters honor one source of truth (§4.1 / AC-9). The sidecar header is
 * the only writer; the margin only reads.
 */
export type EvidenceRowKind = "highlight" | "apparatus" | "connection";

export interface EvidenceFilterState {
  highlight: boolean;
  apparatus: boolean;
  connection: boolean;
}

export interface EvidenceFilters {
  filter: EvidenceFilterState;
  toggleFilter: (kind: EvidenceRowKind) => void;
}

export function useEvidenceFilters(): EvidenceFilters {
  const [filter, setFilter] = useState<EvidenceFilterState>({
    highlight: true,
    apparatus: true,
    connection: true,
  });

  const toggleFilter = useCallback((kind: EvidenceRowKind) => {
    setFilter((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }, []);

  return { filter, toggleFilter };
}
