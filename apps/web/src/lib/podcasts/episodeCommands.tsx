"use client";

/**
 * Account-memory transcript commands outlive panes. Uncertainty requires inspection
 * and a fresh intent; a stale forecast fingerprint is never replayed.
 * Remote admission precedes sending; a known-unsent refusal creates no uncertainty.
 * Only the current command in its original lifetime can settle or forget itself.
 * A failed attempt reports once; an unconfirmed one stays on the transcript dialog.
 * Queued episodes speak through their own transcript state.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useFeedback, type FeedbackAction, type FeedbackContent, type FeedbackContextValue } from "@/components/feedback/Feedback";
import { ApiError, isApiError, isRefusal, isSameSystemApiDefect, isUnauthenticatedApiError, outcomeUnknown, requestWithDeadline } from "@/lib/api/client";
import { invalidateReads, publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { publishImportsInvalidation } from "@/lib/imports/api";
import { requestEpisodeTranscripts } from "@/lib/podcasts/api";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { useLatestWorkspace, type WorkspaceStoreValue } from "@/lib/workspace/store";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { remoteReady } from "@/lib/native/admission";

const REQUEST_TIMEOUT_MS = 30_000;
type Command = { kind: "Transcripts"; body: Schema<"PodcastEpisodeQueryTranscriptRequest"> };
interface Entry {
  readonly podcastId: string;
  readonly title: string;
  readonly scopeLabel: string;
  readonly commandKey: string;
  readonly kind: Command["kind"];
  readonly body: string;
  readonly unregister: () => void;
  /** Withdraws the unconfirmed report once this entry is forgotten or retired. */
  retract: (() => void) | null;
  phase: "sending" | "unconfirmed";
  uncertain: boolean;
  requestId: string | null;
  failure: FeedbackContent | null;
}
const EMPTY: readonly Entry[] = [];
export const UNCONFIRMED_TRANSCRIPTS: FeedbackContent = { tone: "Warning", title: "transcript request unconfirmed",
  message: "it may have been accepted. inspect episode status and imports before requesting another batch." };

/** Imports own the evidence for an unconfirmed request; opening them rereads it. */
export function viewImportsAction(workspace: () => WorkspaceStoreValue, inspect: () => void): FeedbackAction {
  return { label: "view imports", href: "/imports", onActivate: event => {
    const current = workspace();
    const handled = activateTargetLink({ event, target: { href: "/imports" },
      runtime: { activateTarget: request => current.activateWorkspaceTarget({ ...request, originPaneId: current.state.active_primary_pane_id }) },
    });
    if (handled === "handled-default" || handled === "handled-new-pane") inspect();
    return handled;
  } };
}

function createCommands(accountId: string, guard: WorkGuard, feedback: FeedbackContextValue, workspace: () => WorkspaceStoreValue, fail: (input: { error: unknown }) => void) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  let lifetime: AbortController | null = null;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const publish = () => {
    snapshot = [...entries.values()];
    for (const listener of listeners) listener();
  };
  const current = (entry: Entry, scope: AbortController) =>
    lifetime === scope && !scope.signal.aborted && entries.get(entry.podcastId) === entry;
  const retire = (entry: Entry) => {
    entries.delete(entry.podcastId);
    entry.unregister();
    entry.retract?.();
    publish();
  };
  const inspectEntry = () => {
    invalidateReads("PodcastEpisodes");
    publishImportsInvalidation();
  };
  async function send(entry: Entry, scope: AbortController) {
    if (!current(entry, scope)) return;
    entry.phase = "sending";
    entry.failure = null;
    publish();
    let sent = false;
    let acknowledged = false;
    try {
      const write = async () => {
        if (!current(entry, scope)) return null;
        return requestWithDeadline<Schema<"PodcastEpisodeQueryTranscriptRequestOut"> | null>({ signal: scope.signal, timeoutMs: REQUEST_TIMEOUT_MS, request: signal => {
          if (!current(entry, scope)) return Promise.resolve(null);
          if (!remoteReady()) throw new ApiError(0, "E_NETWORK", "requires a connection");
          sent = true;
          return requestEpisodeTranscripts(entry.body, signal);
        } });
      };
      const result = await write();
      if (!current(entry, scope) || result === null) return;
      acknowledged = true;
      retire(entry);
    } catch (error) {
      if (!current(entry, scope)) return;
      if (isApiError(error) && error.requestId !== undefined) entry.requestId = error.requestId;
      if (sent) handleUnauthenticatedApiError(error);
      const unauthenticated = sent && isUnauthenticatedApiError(error);
      const defect = (!isApiError(error) && !isAbortError(error)) || isSameSystemApiDefect(error);
      if (!sent) {
        entry.failure = { tone: "Neutral", title: "requires a connection", message: "this attempt sent no transcript request. review again after reconnecting." };
      } else if (isRefusal(error)) {
        const conflict = error.code === "E_RESOURCE_CONFLICT" || error.code === "E_SELECTION_CHANGED" || error.code === "E_CONFLICT";
        entry.failure = { tone: "Warning", title: conflict
          ? "eligible episodes changed"
          : "episode action refused", message: conflict
          ? "review the selection before requesting transcripts again."
          : "this attempt was refused. review the show before starting another action.", requestId: error.requestId };
      } else {
        entry.uncertain = true;
      }
      if (sent && defect) entry.uncertain = true;
      if (!entry.uncertain) {
        const content = entry.failure;
        retire(entry);
        if (!defect && content !== null) feedback.receipt({ ...content, title: `${content.title} · ${entry.title}` });
      } else {
        entry.phase = "unconfirmed";
        publish();
        entry.retract = feedback.receipt({ ...UNCONFIRMED_TRANSCRIPTS, title: `${UNCONFIRMED_TRANSCRIPTS.title} · ${entry.title}`,
          message: `selection: ${entry.scopeLabel}. ${UNCONFIRMED_TRANSCRIPTS.message}${entry.failure === null ? "" : ` ${entry.failure.title}. ${entry.failure.message ?? ""}`}`,
          requestId: entry.requestId ?? undefined }, viewImportsAction(workspace, inspectEntry));
      }
      if (defect || (sent && !isRefusal(error) && !outcomeUnknown(error) && !isAbortError(error) && !unauthenticated)) fail({ error });
    } finally {
      if (sent && lifetime === scope && !scope.signal.aborted) {
        if (acknowledged) {
          publishChange("PodcastEpisodes"); publishImportsInvalidation();
        } else inspectEntry();
      }
    }
  }
  const find = (commandKey: string) => snapshot.find(entry => entry.commandKey === commandKey);
  return {
    subscribe,
    snapshot: () => snapshot,
    start() {
      const scope = new AbortController();
      lifetime = scope;
      return () => {
        scope.abort();
        if (lifetime !== scope) return;
        lifetime = null;
        for (const entry of entries.values()) entry.unregister();
        entries.clear();
        publish();
      };
    },
    commands: {
      submit(input: { podcastId: string; title: string; scopeLabel: string; command: Command }): "Started" | "Pending" | "OwnerGone" | "Unavailable" {
        const scope = lifetime;
        if (scope === null || scope.signal.aborted) return "OwnerGone";
        if (!remoteReady()) return "Unavailable";
        if (entries.has(input.podcastId)) return "Pending";
        const commandKey = `podcast-episodes:${accountId}:${crypto.randomUUID()}`;
        const entry: Entry = {
          podcastId: input.podcastId, title: input.title, scopeLabel: input.scopeLabel,
          commandKey, kind: input.command.kind, body: JSON.stringify(input.command.body),
          phase: "sending", uncertain: false, failure: null, requestId: null, retract: null,
          unregister: guard.register({ id: commandKey, scope: { kind: "account" }, read: () => ({ changed: false, unconfirmed: true, stopsBrowserWork: false }), subscribe }),
        };
        entries.set(entry.podcastId, entry);
        publish();
        void send(entry, scope);
        return "Started";
      },
      pending(podcastId: string) {
        const entry = entries.get(podcastId);
        return entry === undefined ? null : { phase: entry.phase, kind: entry.kind, commandKey: entry.commandKey };
      },
      inspect(commandKey: string) {
        const entry = find(commandKey);
        if (entry !== undefined && lifetime !== null) inspectEntry();
      },
      forget(commandKey: string) {
        const entry = find(commandKey);
        if (entry === undefined || entry.phase === "sending" || lifetime === null) return;
        if (guard.confirmLoss({ scopes: [], ownerIds: [commandKey] }) && find(commandKey) === entry) retire(entry);
      },
    },
  };
}

export function usePodcastEpisodeCommands(accountId: string, reportDefect: (input: { error: unknown }) => void) {
  const guard = useWorkGuard();
  const feedback = useFeedback();
  const workspace = useLatestWorkspace();
  const owner = useMemo(() => createCommands(accountId, guard, feedback, workspace, reportDefect), [accountId, guard, feedback, workspace, reportDefect]);
  useLayoutEffect(() => owner.start(), [owner]);
  // A fresh command object per published change re-renders the dialog that reads `pending`.
  useSyncExternalStore(owner.subscribe, owner.snapshot, () => EMPTY);
  return { commands: { ...owner.commands } };
}
