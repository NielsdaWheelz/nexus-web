"use client";

/** Account-memory podcast commands freeze ids, scope and guards before sending.
 * Dismissal retires presentation only. Admission checks replay the same ids;
 * other checks retain exact guards and never infer success from absent rows.
 * The subject's dialog or import row reads `pending` and owns its presentation;
 * each failed attempt also reports once, since that surface may have closed.
 * Acknowledged changes speak through the refreshed podcast state.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useFeedback, type FeedbackContent, type FeedbackContextValue } from "@/components/feedback/Feedback";
import { assertNever } from "@/lib/assertNever";
import { isApiError, isRefusal, isSameSystemApiDefect, requestWithDeadline } from "@/lib/api/client";
import { invalidateReads, publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { admitPodcast, changePodcastImport, getPodcastImport, stopPodcast, removeEpisodeFromAll } from "./api";
import { setPlacement } from "@/lib/libraries/api";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";

export type PodcastCommand =
  | { kind: "EpisodeSave"; mediaId: string; libraryId: string; body: Schema<"PlaceItemRequest"> }
  | { kind: "EpisodeRemove"; mediaId: string; body: Schema<"PodcastEpisodeRemovalRequest"> }
  | { kind: "Admission"; libraryId: string; mode: "follow"; body: Schema<"PodcastSubscriptionCreateRequest"> }
  | { kind: "Admission"; libraryId: string; mode: "current_episodes"; body: Schema<"PodcastImportCreateRequest"> }
  | { kind: "Stop"; podcastId: string; body: Schema<"PodcastStopRequest"> }
  | { kind: "Import"; libraryId: string; importId: string; action: "cancel"; body: Schema<"PodcastImportCancelRequest"> }
  | { kind: "Import"; libraryId: string; importId: string; action: "retry"; body: Schema<"PodcastImportRetryRequest"> };
interface Entry {
  readonly key: string;
  readonly subject: string;
  readonly title: string;
  readonly command: PodcastCommand;
  readonly body: string;
  unregister: () => void;
  readonly onAccepted: (() => void) | null;
  phase: "Sending" | "Unknown" | "Refused";
  uncertain: boolean;
  requestId: string | null;
  failure: FeedbackContent | null;
  /** Withdraws the latest failure report once the entry is checked, resent or retired. */
  retract: (() => void) | null;
}
const EMPTY: readonly Entry[] = [];

function createOwner(accountId: string, guard: WorkGuard, feedback: FeedbackContextValue, fail: (input: { error: unknown }) => void) {
  let lifetime: AbortController | null = null;
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const emit = () => { snapshot = [...entries.values()]; for (const listener of listeners) listener(); };
  const retire = (entry: Entry) => { entries.delete(entry.subject); entry.unregister(); entry.retract?.(); emit(); };
  const report = (entry: Entry) => {
    const content = podcastPendingNotice(entry);
    if (content === null) return;
    entry.retract = feedback.receipt({ ...content, title: `${content.title} · ${entry.title}` }, entry.phase === "Unknown"
      ? { label: "check change", onClick: () => { void commands.check(entry.key); } }
      : { label: "review current state", onClick: () => commands.review(entry.key) });
  };
  const current = (entry: Entry, scope: AbortController) => lifetime === scope && !scope.signal.aborted && entries.get(entry.subject) === entry;
  async function send(entry: Entry): Promise<boolean> {
    const scope = lifetime;
    if (scope === null || scope.signal.aborted || entries.get(entry.subject) !== entry) return false;
    entry.phase = "Sending";
    entry.failure = null;
    entry.retract?.(); entry.retract = null;
    emit();
    const command = entry.command;
    try {
      await requestWithDeadline({ signal: scope.signal, timeoutMs: 30_000, request: async signal => {
        switch (command.kind) {
          case "EpisodeSave": await setPlacement({ kind: "Media", id: command.mediaId }, command.libraryId, command.body, signal); break;
          case "EpisodeRemove": await removeEpisodeFromAll(command.mediaId, entry.body, signal); break;
          case "Admission": await admitPodcast(command.libraryId, command.mode, entry.body, signal); break;
          case "Stop": await stopPodcast(command.podcastId, entry.body, signal); break;
          case "Import": await changePodcastImport(command.libraryId, command.importId, command.action, entry.body, signal); break;
          default: assertNever(command);
        }
      } });
    } catch (error) {
      if (!current(entry, scope)) return false;
      invalidateReads("Podcasts", "Entries");
      if (isApiError(error)) entry.requestId = error.requestId ?? null;
      if (isRefusal(error)) {
        entry.phase = entry.uncertain ? "Unknown" : "Refused";
        entry.failure = entry.uncertain
          ? { tone: "Warning", title: "change not confirmed", message: "the exact retry was refused. the original request may have succeeded. review the current state before choosing again.", requestId: error.requestId }
          : { tone: "Warning", title: error.code === "E_PODCAST_SUBSCRIPTION_ACTIVE" ? "included by a podcast subscription"
            : error.status === 409 ? "library changed. review it and choose again." : "podcast change refused.",
            message: error.code === "E_PODCAST_SUBSCRIPTION_ACTIVE" ? "review the podcast subscription before changing its episodes or initial history." : "review the current state before choosing again.", requestId: error.requestId };
      } else {
        entry.uncertain = true;
        entry.phase = "Unknown";
        handleUnauthenticatedApiError(error);
        if ((!isApiError(error) && !isAbortError(error)) || isSameSystemApiDefect(error)) fail({ error });
      }
      emit();
      report(entry);
      return false;
    }
    if (!current(entry, scope)) return false;
    retire(entry);
    publishChange("Podcasts", "Entries", "Lectern", "Metadata");
    entry.onAccepted?.();
    return true;
  }
  const commands = {
    submit(input: { subject: string; title: string; command: PodcastCommand; onAccepted?: () => void }): Promise<boolean> {
      if (lifetime === null || lifetime.signal.aborted || entries.has(input.subject)) return Promise.resolve(false);
      const key = `podcast-command:${accountId}:${crypto.randomUUID()}`;
      const entry: Entry = { ...input, key, body: JSON.stringify(input.command.body), onAccepted: input.onAccepted ?? null, phase: "Sending", uncertain: false, requestId: null, failure: null,
        unregister: () => {}, retract: null };
      entry.unregister = guard.register({ id: key, scope: { kind: "account" }, subscribe, read: () => ({ changed: false, unconfirmed: entry.phase !== "Refused", stopsBrowserWork: false }) });
      entries.set(input.subject, entry); emit(); return send(entry);
    },
    pending(subject: string) { return entries.get(subject) ?? null; },
    async check(key: string) {
      const entry = snapshot.find(value => value.key === key), scope = lifetime;
      if (entry === undefined || entry.phase !== "Unknown" || scope === null) return;
      const command = entry.command;
      if (command.kind !== "Import") { await send(entry); return; }
      entry.phase = "Sending"; entry.retract?.(); entry.retract = null; emit();
      try {
        const operation = await requestWithDeadline({ signal: scope.signal, timeoutMs: 30_000, request: signal => getPodcastImport(command.libraryId, command.importId, signal) });
        if (!current(entry, scope)) return;
        const confirmed = command.action === "cancel"
          ? operation.state === "cancelled" || operation.state === "complete"
          : operation.attempt_version === command.body.expected_attempt_version + 1;
        if (confirmed) { retire(entry); publishChange("Podcasts", "Entries"); }
        else { entry.phase = "Unknown"; emit(); report(entry); }
      } catch (error) {
        if (!current(entry, scope)) return;
        entry.phase = "Unknown";
        if (isApiError(error)) entry.requestId = error.requestId ?? null;
        else if (!isAbortError(error)) fail({ error });
        emit();
        report(entry);
      }
      invalidateReads("Podcasts", "Entries");
    },
    review(key: string) {
      const entry = snapshot.find(value => value.key === key);
      if (entry === undefined || entry.phase === "Sending") return;
      if (entry.phase === "Unknown" && !guard.confirmLoss({ scopes: [], ownerIds: [entry.key] })) return;
      invalidateReads("Podcasts", "Entries"); retire(entry);
    },
  };
  return {
    subscribe, snapshot: () => snapshot, commands,
    start() {
      const scope = new AbortController(); lifetime = scope;
      return () => { scope.abort(); if (lifetime !== scope) return; lifetime = null; for (const entry of entries.values()) entry.unregister(); entries.clear(); emit(); };
    },
  };
}

export function usePodcastCommands(accountId: string, fail: (input: { error: unknown }) => void) {
  const guard = useWorkGuard();
  const feedback = useFeedback();
  const owner = useMemo(() => createOwner(accountId, guard, feedback, fail), [accountId, guard, feedback, fail]);
  useLayoutEffect(() => owner.start(), [owner]);
  // A fresh command object per published change re-renders the subjects that read `pending`.
  useSyncExternalStore(owner.subscribe, owner.snapshot, () => EMPTY);
  return { commands: { ...owner.commands } };
}

/** The subject's own notice for a retained command that did not settle. */
export function podcastPendingNotice(entry: Entry): FeedbackContent | null {
  if (entry.phase === "Sending") return null;
  return entry.failure ?? {
    tone: "Warning", title: "change not confirmed",
    message: "the request may have succeeded. checking retains the original ids and guards.",
    requestId: entry.requestId ?? undefined,
  };
}
