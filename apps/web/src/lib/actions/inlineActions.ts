/** Inline controls share presentation; resource command owners retain execution. */
import type { ReactElement } from "react";
import type { ActionId } from "@/lib/actions/catalog";
import type { ApiError } from "@/lib/api/client";
import type { ServerValue } from "@/lib/api/serverState";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import type { PlayerDescriptor } from "@/lib/player/playerRuntime";
import { feedTargetKey, type FeedActionResolution, type FeedActionResult, type FeedTarget } from "@/lib/feeds/api";


export type FeedActionFacts =
  | { readonly kind: "Ready"; readonly resolution: FeedActionResolution }
  | { readonly kind: "Resolving"; readonly observedSubscribed: boolean | null }
  | { readonly kind: "Failed"; readonly observedSubscribed: boolean | null; readonly error: ApiError; readonly retry: () => void; readonly retrying: boolean };

export type FeedActionSubject = {
  readonly target: FeedTarget;
  readonly feedKind: "podcast" | "article";
  readonly title: string;
  readonly facts: FeedActionFacts;
};

export type ResourceActionSubject =
  | { readonly kind: "Media"; readonly subject: MediaSubject; readonly knownDescriptor: PlayerDescriptor | null }
  | { readonly kind: "Feed"; readonly subject: FeedActionSubject };

export interface FeedActionFocus {
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
  /** `disabledReason` names a wait: a screen reader reads it, the control does not show it. */
  readonly waiting: boolean;
  readonly busy: boolean;
  readonly hasPopup: "dialog" | null;
  readonly invoke: (input: FeedActionFocus) => void;
}

/** Retained facts can open canonical reviews; a failed read always blocks them. */
export function feedActionFacts(
  read: ServerValue<ReadonlyMap<string, FeedActionResult>>,
  target: FeedTarget,
  gate: { readonly kind: "Resolving" } | { readonly kind: "Failed"; readonly error: ApiError; readonly retry: () => void; readonly retrying: boolean } | null,
): FeedActionFacts {
  const result = read.status === "ready" ? read.data.get(feedTargetKey(target)) : undefined;
  const observedSubscribed = result?.resolution.kind === "Canonical" ? result.resolution.subscribed
    : result?.resolution.kind === "Discovery" ? false : null;
  if (gate?.kind === "Failed") return { ...gate, observedSubscribed };
  const error = read.status === "loading" ? null : read.error;
  if (error !== null) return {
    kind: "Failed", observedSubscribed, error, retry: read.refetch,
    retrying: read.status === "failed" ? read.retrying : read.status === "ready" && read.refreshing,
  };
  if (gate !== null) return { ...gate, observedSubscribed };
  if (read.status !== "ready" || read.refreshing) return { kind: "Resolving", observedSubscribed };
  if (result === undefined) throw new Error("feed action facts omitted a requested target");
  return { kind: "Ready", resolution: result.resolution };
}
