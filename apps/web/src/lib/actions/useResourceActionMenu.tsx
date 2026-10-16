"use client";

import { useCallback, useRef, useState } from "react";
import menuStyles from "@/components/ui/ActionMenu.module.css";
import {
  projectResourceActions,
  type ResourceActions,
} from "@/lib/actions/project";
import {
  useActionRuntime,
  useBusyActionIds,
} from "@/lib/actions/ResourceActionsProvider";
import { apiFetch } from "@/lib/api/client";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import styles from "./resourceActionMenu.module.css";

type Load =
  | { readonly kind: "Closed" | "Loading" | "Failed" }
  | { readonly kind: "Ready"; readonly facts: ResourceActions };

const LOADING: ActionDescriptor = {
  kind: "custom",
  id: "ResourceActions.Loading",
  label: "Loading actions…",
  render: () => (
    <span role="status" className={styles.status}>
      <span className={styles.spinner} aria-hidden="true" />
      Loading actions…
    </span>
  ),
};

/** What a standalone menu shows when the resource has no verbs. */
export const NO_ACTIONS: ActionDescriptor = {
  kind: "custom",
  id: "ResourceActions.None",
  label: "No actions available.",
  render: () => (
    <span role="status" className={styles.status}>
      No actions available.
    </span>
  ),
};

/**
 * One resource's verbs, fetched each time its menu opens: a loading row until
 * they arrive, an error row with Retry, or the verbs (none: an empty list).
 * Nothing is cached; closing aborts and forgets. A defect while loading breaks
 * the menu's pane: here, or through `onDefect` for a menu rendered outside it.
 */
export function useResourceActionMenu(
  ref: string | null,
  onDefect?: (defect: { readonly error: unknown }) => void,
): {
  readonly options: readonly ActionDescriptor[];
  readonly onOpenChange: (open: boolean) => void;
} {
  const { ctx, run } = useActionRuntime();
  const busy = useBusyActionIds(ref);
  const throwHere = useThrowLater();
  const fail = onDefect ?? throwHere;
  const [load, setLoad] = useState<Load>({ kind: "Closed" });
  const flight = useRef<AbortController | null>(null);

  const fetchActions = useCallback(() => {
    if (ref === null) return;
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    setLoad({ kind: "Loading" });
    apiFetch<ApiJson<"/resource-items/{resource_ref}/actions", "get">>(
      `/api/resource-items/${encodeURIComponent(ref)}/actions`,
      { signal: controller.signal, cache: "no-store" },
    ).then(
      (response) => {
        if (!controller.signal.aborted)
          setLoad({ kind: "Ready", facts: response.data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // A 401 hands off to sign-in; a defect breaks the menu's pane.
        if (modeledApiError(error, fail)) setLoad({ kind: "Failed" });
      },
    );
  }, [fail, ref]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) return fetchActions();
      flight.current?.abort();
      setLoad({ kind: "Closed" });
    },
    [fetchActions],
  );

  if (ref === null) return { options: [], onOpenChange };
  if (load.kind === "Ready")
    return {
      options: projectResourceActions(load.facts, ctx, busy, run),
      onOpenChange,
    };
  if (load.kind !== "Failed") return { options: [LOADING], onOpenChange };
  const failed: ActionDescriptor = {
    kind: "custom",
    id: "ResourceActions.Failed",
    label: "Actions couldn’t load.",
    render: ({ presentation }) => (
      <>
        <span role="status" className={styles.status}>
          Actions couldn’t load.
        </span>
        <button
          type="button"
          role={presentation === "menu" ? "menuitem" : undefined}
          tabIndex={presentation === "menu" ? -1 : 0}
          className={menuStyles.menuItem}
          onClick={fetchActions}
        >
          Retry
        </button>
      </>
    ),
  };
  return { options: [failed], onOpenChange };
}
