"use client";

import { useCallback, useEffect, useState } from "react";
import {
  apiFetch,
  decodeApiPayload,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  decodeGenerationCatalogResponse,
  type GenerationCatalog,
} from "@/lib/conversations/generationCatalog";

let cachedCatalog: GenerationCatalog | null = null;
let catalogRequest: Promise<GenerationCatalog> | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function loadGenerationCatalog(input?: {
  readonly refresh?: boolean;
}): Promise<GenerationCatalog> {
  if (!input?.refresh && cachedCatalog !== null) {
    return Promise.resolve(cachedCatalog);
  }
  if (catalogRequest !== null) return catalogRequest;
  catalogRequest = apiFetch<unknown>("/api/llm-catalog", { cache: "no-store" })
    .then((raw) =>
      decodeApiPayload(
        raw,
        decodeGenerationCatalogResponse,
        "Generation catalog",
      ),
    )
    .then((catalog) => {
      cachedCatalog = catalog;
      notifyListeners();
      return catalog;
    })
    .finally(() => {
      catalogRequest = null;
    });
  return catalogRequest;
}

interface UseGenerationCatalog {
  readonly catalog: GenerationCatalog | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly retry: () => void;
}

export function useGenerationCatalog(input?: {
  readonly enabled?: boolean;
}): UseGenerationCatalog {
  const enabled = input?.enabled ?? true;
  const [catalog, setCatalog] = useState<GenerationCatalog | null>(
    () => cachedCatalog,
  );
  const [loading, setLoading] = useState(cachedCatalog === null);
  const [error, setError] = useState<Error | null>(null);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);

  const refresh = useCallback((force: boolean) => {
    if (cachedCatalog === null) setLoading(true);
    setError(null);
    void loadGenerationCatalog({ refresh: force })
      .then((next) => {
        setCatalog(next);
      })
      .catch((failure: unknown) => {
        if (handleUnauthenticatedApiError(failure)) return;
        if (isSameSystemApiDefect(failure)) {
          setDefect({ error: failure });
          return;
        }
        setError(
          failure instanceof Error
            ? failure
            : new Error("Generation catalog request failed"),
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const onCatalog = () => setCatalog(cachedCatalog);
    listeners.add(onCatalog);
    if (enabled && cachedCatalog === null) refresh(false);
    return () => {
      listeners.delete(onCatalog);
    };
  }, [enabled, refresh]);

  const retry = useCallback(() => refresh(true), [refresh]);

  if (defect !== null) throw defect.error;

  return { catalog, loading, error, retry };
}
