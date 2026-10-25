/** Inline controls share presentation; resource command owners retain execution. */
import type { ReactElement } from "react";
import type { ActionId } from "@/lib/actions/catalog";
import type { ApiError } from "@/lib/api/client";
import type { ServerValue } from "@/lib/api/serverState";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import type { PlayerDescriptor } from "@/lib/player/playerRuntime";
import { podcastTargetKey, type PodcastActionResolution, type PodcastActionResult, type PodcastTarget } from "@/lib/podcasts/api";

export type PodcastActionFacts =
  | { readonly kind: "Ready"; readonly resolution: PodcastActionResolution }
  | { readonly kind: "Resolving"; readonly observedSubscribed: boolean | null }
  | { readonly kind: "Failed"; readonly observedSubscribed: boolean | null; readonly error: ApiError; readonly retry: () => void; readonly retrying: boolean };

export type PodcastActionSubject = {
  readonly target: PodcastTarget;
  readonly title: string;
  readonly facts: PodcastActionFacts;
};

export type ResourceActionSubject =
  | { readonly kind: "Media"; readonly subject: MediaSubject; readonly knownDescriptor: PlayerDescriptor | null }
  | { readonly kind: "Podcast"; readonly subject: PodcastActionSubject };

export interface PodcastActionFocus {
  readonly trigger: HTMLElement | null;
  readonly returnFocus: () => HTMLElement | null;
  readonly afterRemoval: () => HTMLElement | null;
}

export interface ActionButtonSpec {
  readonly controlKey: string;
  readonly id: ActionId;
  readonly menuLabel: string;
  readonly accessibleLabel: string;
  readonly icon: ReactElement;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly busy: boolean;
  readonly hasPopup: "dialog" | null;
  readonly invoke: (input: PodcastActionFocus) => void;
}

/** Retained facts describe a disabled control; only a settled matching read admits intent. */
export function podcastActionFacts(
  read: ServerValue<ReadonlyMap<string, PodcastActionResult>>,
  target: PodcastTarget,
  gate: { readonly kind: "Resolving" } | { readonly kind: "Failed"; readonly error: ApiError; readonly retry: () => void; readonly retrying: boolean } | null,
): PodcastActionFacts {
  const result = read.status === "ready" ? read.data.get(podcastTargetKey(target)) : undefined;
  const observedSubscribed = result?.resolution.kind === "Canonical" ? result.resolution.subscribed
    : result?.resolution.kind === "Discovery" ? false : null;
  if (gate !== null) return { ...gate, observedSubscribed };
  const error = read.status === "loading" ? null : read.error;
  if (error !== null) return {
    kind: "Failed", observedSubscribed, error, retry: read.refetch,
    retrying: read.status === "failed" ? read.retrying : read.status === "ready" && read.refreshing,
  };
  if (read.status !== "ready" || read.refreshing) return { kind: "Resolving", observedSubscribed };
  if (result === undefined) throw new Error("podcast action facts omitted a requested target");
  return { kind: "Ready", resolution: result.resolution };
}
