"use client";

import { useEffect, useRef, useState } from "react";
import { apiErrorCopy } from "@/components/dossier/dossierCopy";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { isApiError, isRefusal } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  cancelDossierBuild,
  createDossierBuild,
  fetchDossierHead,
  watchDossierBuild,
  type DossierTarget,
} from "@/lib/dossiers/dossierApi";

type Head =
  | { readonly kind: "Loading" }
  | { readonly kind: "Failed"; readonly message: string; readonly retrying: boolean }
  | { readonly kind: "Ready"; readonly value: Schema<"DossierHeadOut">; readonly refreshing: boolean; readonly refreshFailure: string | null };

export interface Dossier {
  readonly head: Head;
  readonly busy: "generate" | "cancel" | null;
  /** The last command's error, shown near its control without moving focus. */
  readonly error: string | null;
  /** Generate and regenerate. */
  generate(instruction: string | null, id: string): Promise<"accepted" | "refused" | "unconfirmed">;
  cancel(): void;
  reload(): void;
}

const LOADING: Head = { kind: "Loading" };

/**
 * One dossier head, read on mount and after every command, with its active
 * build followed live: each frame replaces `active_build`, the last one reloads
 * the head. A lost stream reloads once and does not reopen for the same build,
 * so a stream that keeps failing cannot spin.
 */
export function useDossier(target: DossierTarget): Dossier {
  const { ctx } = useActionRuntime();
  const key =
    target.kind === "Subject"
      ? `${target.scheme}/${target.handle}`
      : target.artifactRef;
  const targetRef = useRef(target);
  targetRef.current = target;
  const [loads, setLoads] = useState(0);
  const [loaded, setLoaded] = useState({ key, head: LOADING });
  const [busy, setBusy] = useState<Dossier["busy"]>(null);
  const [error, setError] = useState<string | null>(null);
  const head = loaded.key === key ? loaded.head : LOADING;
  const reload = () => {
    if (head.kind === "Failed" && head.retrying || head.kind === "Ready" && head.refreshing) return;
    setLoaded((current) => current.key !== key ? current : current.head.kind === "Failed"
      ? { ...current, head: { ...current.head, retrying: true } }
      : current.head.kind === "Ready" ? { ...current, head: { ...current.head, refreshing: true } } : current);
    setLoads((count) => count + 1);
  };

  useEffect(() => {
    let live = true;
    fetchDossierHead(targetRef.current).then(
      (value) => {
        if (live) setLoaded({ key, head: { kind: "Ready", value, refreshing: false, refreshFailure: null } });
      },
      (failure: unknown) => {
        if (!live || handleUnauthenticatedApiError(failure)) return;
        // A failed refresh keeps the head already on screen.
        setLoaded((current) =>
          current.key === key && current.head.kind === "Ready"
            ? { ...current, head: { ...current.head, refreshing: false, refreshFailure: apiErrorCopy(failure) } }
            : { key, head: { kind: "Failed", message: apiErrorCopy(failure), retrying: false } },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [key, loads]);

  const ready = head.kind === "Ready" ? head.value : null;
  const watched =
    ready?.active_build != null
      ? ready.active_build.handle
      : null;
  useEffect(() => {
    if (!watched) return;
    let live = true;
    const stop = watchDossierBuild(
      watched,
      (build) => {
        if (!live) return;
        if (build.status !== "Active") return setLoads((count) => count + 1);
        setLoaded((current) =>
          current.head.kind === "Ready"
            ? {
                ...current,
                head: {
                  ...current.head,
                  value: {
                    ...current.head.value,
                    active_build: build,
                  },
                },
              }
            : current,
        );
      },
      () => {
        if (live) setLoads((count) => count + 1);
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [watched]);

  const run = (
    kind: "generate" | "cancel",
    command: () => Promise<unknown>,
  ) => {
    const signal = ctx.sessionSignal();
    setBusy(kind);
    setError(null);
    return command()
      .then(() => "accepted" as const)
      .catch((failure: unknown) => {
        if (signal.aborted || handleUnauthenticatedApiError(failure)) return "refused" as const;
        // Canceling a build that has already ended is what the user wanted.
        if (
          !isApiError(failure) ||
          failure.code !== "E_DOSSIER_BUILD_NOT_ACTIVE"
        )
          setError(apiErrorCopy(failure));
        return isRefusal(failure) ? "refused" as const : "unconfirmed" as const;
      })
      .finally(() => {
        if (signal.aborted) return;
        setBusy(null);
        reload();
      });
  };
  const generate = (instruction: string | null, id: string) =>
    run("generate", () =>
      createDossierBuild(targetRef.current, instruction, id),
    );

  return {
    head,
    busy,
    error,
    generate,
    cancel() {
      if (watched) run("cancel", () => cancelDossierBuild(watched));
    },
    reload,
  };
}
