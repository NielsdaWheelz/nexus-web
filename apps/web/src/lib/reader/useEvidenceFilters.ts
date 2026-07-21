"use client";

import { useCallback, useState } from "react";
import type {
  ReaderEvidenceItem,
  ReaderEvidenceSemanticKind,
} from "@/lib/reader/documentMap";
import { semanticKindForEvidenceItem } from "@/lib/reader/documentMap";

export type EvidenceFilterKind = ReaderEvidenceSemanticKind;

export type EvidenceFilterState = Record<EvidenceFilterKind, boolean>;

export interface EvidenceFilters {
  filter: EvidenceFilterState;
  toggleFilter: (kind: EvidenceFilterKind) => void;
  showAll: () => void;
}

export const ALL_EVIDENCE_FILTERS: EvidenceFilterState = {
  highlight: true,
  citation: true,
  link: true,
  synapse: true,
};

export function evidenceItemPassesFilters(
  item: ReaderEvidenceItem,
  filters: EvidenceFilterState,
): boolean {
  return filters[semanticKindForEvidenceItem(item)];
}

export function useEvidenceFilters(): EvidenceFilters {
  const [filter, setFilter] =
    useState<EvidenceFilterState>(ALL_EVIDENCE_FILTERS);

  const toggleFilter = useCallback((kind: EvidenceFilterKind) => {
    setFilter((previous) => ({ ...previous, [kind]: !previous[kind] }));
  }, []);

  const showAll = useCallback(() => {
    setFilter(ALL_EVIDENCE_FILTERS);
  }, []);

  return { filter, toggleFilter, showAll };
}
