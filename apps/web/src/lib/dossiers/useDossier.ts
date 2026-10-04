"use client";

import { useEffect, useRef, useState } from "react";
import { apiErrorCopy } from "@/components/dossier/dossierCopy";
import { isApiError } from "@/lib/api/client";
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
  | { readonly kind: "Failed"; readonly message: string }
  | { readonly kind: "Ready"; readonly value: Schema<"DossierHeadOut"> };

export interface Dossier {
  readonly head: Head;
  readonly busy: "generate" | "cancel" | null;
  /** The last command's error, shown near its control without moving focus. */
  readonly error: string | null;
  /** Generate and regenerate. */
  generate(instruction: string | null): void;
  /** A new build with the last unsuccessful build's instruction. */
  retry(): void;
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
  const reload = () => setLoads((count) => count + 1);

  useEffect(() => {
    let live = true;
    fetchDossierHead(targetRef.current).then(
      (value) => {
        if (live) setLoaded({ key, head: { kind: "Ready", value } });
      },
      (failure: unknown) => {
        if (!live || handleUnauthenticatedApiError(failure)) return;
        // A failed refresh keeps the head already on screen.
        setLoaded((current) =>
          current.key === key && current.head.kind === "Ready"
            ? current
            : { key, head: { kind: "Failed", message: apiErrorCopy(failure) } },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [key, loads]);

  const ready = head.kind === "Ready" ? head.value : null;
  const watched =
    ready?.active_build.kind === "Present"
      ? ready.active_build.value.handle
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
                  kind: "Ready",
                  value: {
                    ...current.head.value,
                    active_build: { kind: "Present", value: build },
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
    setBusy(kind);
    setError(null);
    command()
      .catch((failure: unknown) => {
        if (handleUnauthenticatedApiError(failure)) return;
        // Canceling a build that has already ended is what the user wanted.
        if (
          !isApiError(failure) ||
          failure.code !== "E_DOSSIER_BUILD_NOT_ACTIVE"
        )
          setError(apiErrorCopy(failure));
      })
      .finally(() => {
        setBusy(null);
        reload();
      });
  };
  const generate = (instruction: string | null) =>
    run("generate", () =>
      createDossierBuild(targetRef.current, instruction, crypto.randomUUID()),
    );

  return {
    head,
    busy,
    error,
    generate,
    retry() {
      const failure = ready?.last_failure;
      generate(
        failure?.kind === "Present" &&
          failure.value.instruction.kind === "Present"
          ? failure.value.instruction.value
          : null,
      );
    },
    cancel() {
      if (watched) run("cancel", () => cancelDossierBuild(watched));
    },
    reload,
  };
}
