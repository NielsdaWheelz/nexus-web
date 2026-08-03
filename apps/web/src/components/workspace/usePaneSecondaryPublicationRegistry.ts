"use client";

import { useCallback, useRef, useState } from "react";

import {
  arePaneSecondaryPublicationsEqual,
  normalizePaneSecondaryPublication,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";

interface PaneSecondaryPublicationRecord {
  readonly routeKey: string;
  readonly publication: PaneSecondaryPublication;
}

interface PaneSecondaryPublicationInput {
  readonly paneId: string;
  readonly routeKey: string;
  readonly publication: PaneSecondaryPublication | null;
}

export function getPaneSecondaryPublication(
  records: ReadonlyMap<string, PaneSecondaryPublicationRecord>,
  paneId: string,
  routeKey: string,
): PaneSecondaryPublication | null {
  const record = records.get(paneId);
  return record?.routeKey === routeKey ? record.publication : null;
}

function upsertOrDeletePaneSecondaryPublicationRecord(
  current: Map<string, PaneSecondaryPublicationRecord>,
  input: PaneSecondaryPublicationInput,
): Map<string, PaneSecondaryPublicationRecord> {
  const existing = current.get(input.paneId);
  if (!input.publication) {
    if (!existing || existing.routeKey !== input.routeKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  if (
    existing?.routeKey === input.routeKey &&
    arePaneSecondaryPublicationsEqual(
      existing.publication,
      input.publication,
    )
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, {
    routeKey: input.routeKey,
    publication: input.publication,
  });
  return next;
}

function prunePaneSecondaryPublicationRecords(
  current: Map<string, PaneSecondaryPublicationRecord>,
  currentRouteKeyByPaneId: ReadonlyMap<string, string>,
): Map<string, PaneSecondaryPublicationRecord> {
  let next: Map<string, PaneSecondaryPublicationRecord> | null = null;
  for (const [paneId, record] of current) {
    if (currentRouteKeyByPaneId.get(paneId) === record.routeKey) continue;
    next ??= new Map(current);
    next.delete(paneId);
  }
  return next ?? current;
}

export function usePaneSecondaryPublicationRegistry() {
  const [records, setRecords] = useState<
    Map<string, PaneSecondaryPublicationRecord>
  >(() => new Map());
  const recordsRef = useRef(records);

  const commit = useCallback(
    (
      transform: (
        current: Map<string, PaneSecondaryPublicationRecord>,
      ) => Map<string, PaneSecondaryPublicationRecord>,
    ) => {
      const next = transform(recordsRef.current);
      recordsRef.current = next;
      setRecords(next);
    },
    [],
  );

  const publish = useCallback(
    (input: PaneSecondaryPublicationInput) => {
      const normalized = {
        ...input,
        publication: input.publication
          ? normalizePaneSecondaryPublication(input.publication)
          : null,
      };
      commit((current) =>
        upsertOrDeletePaneSecondaryPublicationRecord(current, normalized),
      );
    },
    [commit],
  );

  const prune = useCallback(
    (currentRouteKeyByPaneId: ReadonlyMap<string, string>) => {
      commit((current) =>
        prunePaneSecondaryPublicationRecords(
          current,
          currentRouteKeyByPaneId,
        ),
      );
    },
    [commit],
  );

  const current = useCallback(
    (paneId: string, routeKey: string) =>
      getPaneSecondaryPublication(recordsRef.current, paneId, routeKey),
    [],
  );

  return { records, publish, prune, current } as const;
}
