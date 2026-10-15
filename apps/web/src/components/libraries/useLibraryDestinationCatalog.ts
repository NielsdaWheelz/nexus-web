"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";

export type LibraryDestinationCatalogResult<Failure> =
  | { kind: "catalog"; destinations: readonly LibraryDestinationSelection[] }
  | { kind: "failure"; failure: Failure }
  | { kind: "handled" };

/** Complete task-local catalog. Query and matching belong to the chooser.
 * `read` is a stable transport callback; its expected failures are values.
 * A refresh keeps the last good catalog but disables creation until it succeeds.
 */
export function useLibraryDestinationCatalog<Failure>({
  active,
  changeStamp,
  read,
}: {
  active: boolean;
  changeStamp: string;
  read: (request: { signal: AbortSignal }) => Promise<LibraryDestinationCatalogResult<Failure>>;
}) {
  const [destinations, setDestinations] = useState<readonly LibraryDestinationSelection[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useLayoutEffect(() => {
    const current = ++generation.current;
    setReady(false);
    setLoading(active);
    if (!active) return;
    const controller = new AbortController();
    setFailure(null);
    void read({ signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || current !== generation.current) return;
      setLoading(false);
      switch (result.kind) {
        case "catalog":
          setDestinations(result.destinations);
          setReady(true);
          break;
        case "failure": setFailure(result.failure); break;
        case "handled": break;
      }
    }, (error: unknown) => {
      if (!controller.signal.aborted && current === generation.current) setDefect({ error });
    });
    return () => {
      controller.abort();
    };
  }, [active, changeStamp, read, attempt]);

  if (defect) throw defect.error;
  return {
    destinations,
    loading,
    ready,
    failure,
    retry: () => { if (active) setAttempt((current) => current + 1); },
  };
}
