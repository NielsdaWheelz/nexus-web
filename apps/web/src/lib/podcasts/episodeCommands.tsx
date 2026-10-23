"use client";

/**
 * Account-memory episode commands outlive panes. Consumption retries send the
 * captured bytes; transcript uncertainty requires inspection and a fresh intent.
 * Only the current command in its original lifetime can settle or forget itself.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useFeedback, useWorkspaceCondition, type FeedbackContent, type FeedbackContextValue } from "@/components/feedback/Feedback";
import { isApiError, isRefusal, isSameSystemApiDefect, isUnauthenticatedApiError, outcomeUnknown, requestWithDeadline } from "@/lib/api/client";
import { invalidateReads, publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { ProgressPreparationError } from "@/lib/consumption/progressFence";
import { withProgressFence } from "@/lib/consumption/state";
import { isAbortError } from "@/lib/errors";
import { publishImportsInvalidation } from "@/lib/imports/api";
import { applyEpisodeConsumption, requestEpisodeTranscripts } from "@/lib/podcasts/api";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { useLatestWorkspace } from "@/lib/workspace/store";

const REQUEST_TIMEOUT_MS = 30_000;
type Command =
  | { kind: "Consumption"; body: Schema<"PodcastEpisodeConsumptionRequest"> }
  | { kind: "Transcripts"; body: Schema<"PodcastEpisodeQueryTranscriptRequest"> };
interface Entry {
  readonly podcastId: string;
  readonly title: string;
  readonly scopeLabel: string;
  readonly commandKey: string;
  readonly kind: Command["kind"];
  readonly body: string;
  readonly mediaIds: readonly string[];
  readonly desiredState: "played" | "unplayed" | null;
  readonly unregister: () => void;
  phase: "sending" | "unconfirmed";
  uncertain: boolean;
  requestId: string | null;
  failure: FeedbackContent | null;
}
const EMPTY: readonly Entry[] = [];

function createCommands(accountId: string, guard: WorkGuard, feedback: FeedbackContextValue, fail: (input: { error: unknown }) => void) {
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
    publish();
  };
  const inspectEntry = (entry: Entry) => {
    if (entry.kind === "Consumption") invalidateReads("Podcasts", "Consumption");
    else {
      invalidateReads("PodcastEpisodes");
      publishImportsInvalidation();
    }
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
        return requestWithDeadline<Schema<"PodcastEpisodeConsumptionOut"> | Schema<"PodcastEpisodeQueryTranscriptRequestOut"> | null>({ signal: scope.signal, timeoutMs: REQUEST_TIMEOUT_MS, request: signal => {
          if (!current(entry, scope)) return Promise.resolve(null);
          sent = true;
          if (entry.kind === "Consumption") return applyEpisodeConsumption(entry.podcastId, entry.body, signal);
          return requestEpisodeTranscripts(entry.body, signal);
        } });
      };
      const result = entry.kind === "Consumption" ? await withProgressFence(entry.mediaIds, write) : await write();
      if (!current(entry, scope) || result === null) return;
      acknowledged = true;
      retire(entry);
      const count = result.matched_count;
      feedback.receipt({ tone: "Success", title: "queued_count" in result
        ? `${result.queued_count} of ${count} eligible episode${count === 1 ? "" : "s"} queued. · ${entry.title}`
        : `${count} episode${count === 1 ? " is" : "s are"} marked as ${entry.desiredState}. · ${entry.title}` });
    } catch (error) {
      if (!current(entry, scope)) return;
      if (isApiError(error) && error.requestId !== undefined) entry.requestId = error.requestId;
      if (sent) handleUnauthenticatedApiError(error);
      const unauthenticated = sent && isUnauthenticatedApiError(error);
      const defect = (!isApiError(error) && !isAbortError(error) && !(error instanceof ProgressPreparationError)) || isSameSystemApiDefect(error);
      if (!sent) {
        entry.failure = { tone: "Warning", title: "progress couldn’t be saved", message: "this attempt did not send the episode-state change. resolve the player or reader save before trying again.", requestId: isApiError(error) ? error.requestId : undefined };
      } else if (isRefusal(error)) {
        const conflict = error.code === "E_RESOURCE_CONFLICT" || error.code === "E_SELECTION_CHANGED" || error.code === "E_CONFLICT";
        entry.failure = { tone: "Warning", title: conflict
          ? entry.kind === "Consumption" ? "episode states changed meanwhile" : "eligible episodes changed"
          : "episode action refused", message: conflict
          ? entry.kind === "Consumption" ? "this attempt changed nothing. review the current states before starting another change." : "review the selection before requesting transcripts again."
          : "this attempt was refused. review the show before starting another action.", requestId: error.requestId };
      } else {
        entry.uncertain = true;
      }
      if (sent && defect) entry.uncertain = true;
      if (!entry.uncertain) {
        const content = entry.failure;
        retire(entry);
        if (!defect && content !== null) feedback.offer({ key: entry.commandKey, content: { ...content, title: `${content.title} · ${entry.title}` }, announcement: "Polite" });
      } else {
        entry.phase = "unconfirmed";
        publish();
      }
      if (defect || (sent && !isRefusal(error) && !outcomeUnknown(error) && !isAbortError(error) && !unauthenticated)) fail({ error });
    } finally {
      if (sent && lifetime === scope && !scope.signal.aborted) {
        if (acknowledged) {
          if (entry.kind === "Consumption") publishChange("Podcasts", "Consumption");
          else { publishChange("PodcastEpisodes"); publishImportsInvalidation(); }
        } else inspectEntry(entry);
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
      submit(input: { podcastId: string; title: string; scopeLabel: string; command: Command }): "Started" | "Pending" | "OwnerGone" {
        const scope = lifetime;
        if (scope === null || scope.signal.aborted) return "OwnerGone";
        if (entries.has(input.podcastId)) return "Pending";
        const commandKey = `podcast-episodes:${accountId}:${crypto.randomUUID()}`;
        const entry: Entry = {
          podcastId: input.podcastId, title: input.title, scopeLabel: input.scopeLabel,
          commandKey, kind: input.command.kind, body: JSON.stringify(input.command.body),
          mediaIds: input.command.kind === "Consumption" ? input.command.body.items.map(item => item.media_id) : [],
          desiredState: input.command.kind === "Consumption" ? input.command.body.desired_state : null,
          phase: "sending", uncertain: false, failure: null, requestId: null,
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
      retrySame(commandKey: string) {
        const entry = find(commandKey);
        if (entry === undefined || entry.kind !== "Consumption" || entry.phase === "sending" || lifetime === null) return;
        void send(entry, lifetime);
      },
      inspect(commandKey: string) {
        const entry = find(commandKey);
        if (entry !== undefined && lifetime !== null) inspectEntry(entry);
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
  const owner = useMemo(() => createCommands(accountId, guard, feedback, reportDefect), [accountId, guard, feedback, reportDefect]);
  useLayoutEffect(() => owner.start(), [owner]);
  const entries = useSyncExternalStore(owner.subscribe, owner.snapshot, () => EMPTY);
  return { commands: { ...owner.commands }, feedback: entries.map(entry => <CommandCondition key={entry.commandKey} entry={entry} commands={owner.commands} />) };
}

function CommandCondition({ entry, commands }: { entry: Entry; commands: ReturnType<typeof createCommands>["commands"] }) {
  const online = useConnectivity() === "Online";
  const workspace = useLatestWorkspace();
  const sending = entry.phase === "sending";
  const title = sending ? entry.kind === "Consumption" ? `marking episodes as ${entry.desiredState}…` : "requesting transcripts…"
    : entry.kind === "Consumption" ? "episode-state change unconfirmed" : "transcript request unconfirmed";
  const message = entry.kind === "Consumption" ? "it may already have completed. retry sends the same selection and desired state."
    : "it may have been accepted. inspect episode status and imports before requesting another batch.";
  useWorkspaceCondition(entry.commandKey, {
    priority: "Write", announcement: "Polite",
    content: { tone: sending ? "Neutral" : "Warning", title: `${title} · ${entry.title}`, message: `selection: ${entry.scopeLabel}.${sending ? "" : ` ${message}${entry.failure === null ? "" : ` ${entry.failure.title}. ${entry.failure.message ?? ""}`}`}`, requestId: entry.requestId ?? undefined },
    actions: sending ? undefined : [
      entry.kind === "Consumption" ? { label: "retry same request", commandKey: entry.commandKey, disabledReason: online ? undefined : "this request needs a connection", onClick: () => commands.retrySame(entry.commandKey) }
        : { label: "view imports", commandKey: entry.commandKey, onClick: () => { commands.inspect(entry.commandKey); workspace().activateWorkspaceTarget({ originPaneId: workspace().state.active_primary_pane_id, target: { href: "/imports" }, disposition: { kind: "Follow" } }); } },
      { label: "stop tracking", commandKey: entry.commandKey, onClick: () => commands.forget(entry.commandKey) },
    ],
  });
  return null;
}
