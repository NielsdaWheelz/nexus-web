"use client";

/**
 * Account-memory transcript commands outlive panes. A request that was not sent, or was
 * refused, leaves nothing to track: it says its fact once and retires, and a new intent needs
 * a new forecast, since a stale forecast fingerprint is never replayed. A sent request with no
 * answer is held until imports are viewed and the owner stops tracking it. Only the current
 * command in its original lifetime can settle or forget itself. Mount `feedback` once.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { Hold, useOutcome, type Outcome } from "@/components/feedback/Feedback";
import type { LinkVerb } from "@/components/feedback/stage";
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
  readonly commandKey: string;
  readonly kind: Command["kind"];
  readonly body: string;
  unregister: () => void;
  phase: "sending" | "unconfirmed";
}
const EMPTY: readonly Entry[] = [];

/** The one fact for a request that did not go through. */
export const transcriptsRefused = (title: string) => `couldn’t request transcripts for “${title}”.`;

/** Imports own the evidence for an unconfirmed request; opening them rereads it. */
function viewImports(workspace: () => WorkspaceStoreValue, inspect: () => void): LinkVerb {
  return { label: "view imports", href: "/imports", onActivate: event => {
    const current = workspace();
    const handled = activateTargetLink({ event, target: { href: "/imports" },
      runtime: { activateTarget: request => current.activateWorkspaceTarget({ ...request, originPaneId: current.state.active_primary_pane_id }) },
    });
    if (handled === "handled-default" || handled === "handled-new-pane") inspect();
    return handled;
  } };
}

function createCommands(accountId: string, guard: WorkGuard, fail: (input: { error: unknown }) => void, outcome: Outcome) {
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
  const inspectEntry = () => {
    invalidateReads("PodcastEpisodes");
    publishImportsInvalidation();
  };
  async function send(entry: Entry, scope: AbortController) {
    if (!current(entry, scope)) return;
    entry.phase = "sending";
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
      if (sent) handleUnauthenticatedApiError(error);
      const unauthenticated = sent && isUnauthenticatedApiError(error);
      const defect = (!isApiError(error) && !isAbortError(error)) || isSameSystemApiDefect(error);
      if (!sent) {
        retire(entry);
        outcome.say({ fact: transcriptsRefused(entry.title), reason: "nothing was sent." });
      } else if (isRefusal(error)) {
        retire(entry);
        if (error.code === "E_RESOURCE_CONFLICT" || error.code === "E_SELECTION_CHANGED" || error.code === "E_CONFLICT")
          outcome.say({ fact: transcriptsRefused(entry.title), reason: "the eligible episodes changed." });
        else outcome.fail(error, transcriptsRefused(entry.title));
      } else {
        entry.phase = "unconfirmed";
        publish();
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
      submit(input: { podcastId: string; title: string; command: Command }): "Started" | "Pending" | "OwnerGone" | "Unavailable" {
        const scope = lifetime;
        if (scope === null || scope.signal.aborted) return "OwnerGone";
        if (!remoteReady()) return "Unavailable";
        if (entries.has(input.podcastId)) return "Pending";
        const commandKey = `podcast-episodes:${accountId}:${crypto.randomUUID()}`;
        const entry: Entry = {
          podcastId: input.podcastId, title: input.title,
          commandKey, kind: input.command.kind, body: JSON.stringify(input.command.body),
          phase: "sending", unregister: () => {},
        };
        entry.unregister = guard.register({id: commandKey, scope: {kind: "account"}, read: () => ({changed: false, unconfirmed: true, stopsBrowserWork: false}), subscribe});
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
  const workspace = useLatestWorkspace();
  const outcome = useOutcome();
  const owner = useMemo(() => createCommands(accountId, guard, reportDefect, outcome), [accountId, guard, reportDefect, outcome]);
  useLayoutEffect(() => owner.start(), [owner]);
  // A fresh command object per published change re-renders the dialog that reads `pending`.
  const entries = useSyncExternalStore(owner.subscribe, owner.snapshot, () => EMPTY);
  const commands = { ...owner.commands };
  return { commands, feedback: entries.filter(entry => entry.phase === "unconfirmed").map(entry =>
    <Hold key={entry.commandKey} id={entry.commandKey}
      line={{ fact: `not sure the transcript request for “${entry.title}” saved.`, reason: "it may have gone through." }}
      verbs={[viewImports(workspace, () => commands.inspect(entry.commandKey)),
        { label: "stop tracking", commandKey: `forget ${entry.commandKey}`, run: () => commands.forget(entry.commandKey) }]} />) };
}
