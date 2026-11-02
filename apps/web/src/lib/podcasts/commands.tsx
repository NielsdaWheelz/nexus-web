"use client";

/** Account-memory podcast commands freeze ids, scope and guards before sending.
 * Accepted retires a command. Refused retires it and says its fact as a slip, unless the
 * surface that sent it still stands to show a refusal a reread can answer (`shown`): then it
 * stays `Refused` for that surface's `check` to review. Unanswered, it stays `Unknown`, a held
 * line in `feedback` until a replay settles it or `stop tracking` forgets it, never undoing
 * it. A replay sends the same body and ids; an import is checked by reading its operation.
 * Mount `feedback` once. Dismissal changes presentation only.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { Hold, useOutcome, type Outcome } from "@/components/feedback/Feedback";
import type { Line, Verbs } from "@/components/feedback/stage";
import { assertNever } from "@/lib/assertNever";
import { isApiError, isRefusal, isSameSystemApiDefect, requestWithDeadline, type ApiError } from "@/lib/api/client";
import { invalidateReads, publishChange } from "@/lib/api/changes";
import { transportOf } from "@/lib/api/failure";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { admitPodcast, changePodcastImport, getPodcastImport, stopPodcast, removeEpisodeFromAll } from "./api";
import { podcastRefusalReason } from "./paneState";
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
  /** The podcast's or episode's own title. */
  readonly title: string;
  /** The destination's name, or null for the default library, which goes unnamed. */
  readonly library: string | null;
  readonly command: PodcastCommand;
  readonly body: string;
  readonly shown: (() => boolean) | null;
  unregister: () => void;
  readonly onAccepted: (() => void) | null;
  phase: "Sending" | "Unknown" | "Refused";
  /** Sent without an answer: only a confirmed replay or `stop tracking` settles it. */
  uncertain: boolean;
  /** A replay of the unanswered command was refused, so `retry` cannot help. */
  replayRefused: boolean;
  /** Bumps per failed replay or check, so the held line speaks again. */
  attempt: number;
  /** What a standing surface shows while `Refused`. */
  refusal: Line | null;
}
const EMPTY: readonly Entry[] = [];

const to = (library: string | null) => library === null ? "" : ` to ${library}`;

/** What a refused command says, before its reason. */
function refusedFact({ command, title, library }: Entry): string {
  switch (command.kind) {
    case "Admission": return command.mode === "follow" ? `couldn’t subscribe to “${title}”.` : `couldn’t add “${title}”${to(library)}.`;
    case "Stop": return command.body.episodes === "remove" ? `couldn’t remove episodes of “${title}”.` : `couldn’t unsubscribe from “${title}”.`;
    case "EpisodeSave": return `couldn’t add “${title}”${to(library)}.`;
    case "EpisodeRemove": return `couldn’t remove “${title}” from all libraries.`;
    case "Import": return command.action === "cancel" ? `couldn’t cancel adding “${title}”.` : `couldn’t retry adding “${title}”.`;
    default: return assertNever(command);
  }
}

/** The change an unanswered command may have made. */
function unsettledThing({ command, title, library }: Entry): string {
  switch (command.kind) {
    case "Admission": return command.mode === "follow" ? `the subscription to “${title}”` : `the addition of “${title}”`;
    case "Stop": return command.body.episodes === "remove" ? `the removal of “${title}” episodes` : `the unsubscribe from “${title}”`;
    case "EpisodeSave": return `the addition of “${title}”${to(library)}`;
    case "EpisodeRemove": return `the removal of “${title}”`;
    case "Import": return command.action === "cancel" ? `cancelling the addition of “${title}”` : `restarting the addition of “${title}”`;
    default: return assertNever(command);
  }
}

function refusalReason(entry: Entry, error: ApiError): string | undefined {
  if (error.code === "E_PODCAST_SUBSCRIPTION_ACTIVE") return "a podcast subscription includes it.";
  if (error.status === 409) return entry.command.kind === "Import" ? "it changed meanwhile." : "its libraries changed meanwhile.";
  return podcastRefusalReason(error);
}

function createOwner(accountId: string, guard: WorkGuard, defect: (input: { error: unknown }) => void, outcome: Outcome) {
  let lifetime: AbortController | null = null;
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const emit = () => { snapshot = [...entries.values()]; for (const listener of listeners) listener(); };
  const retire = (entry: Entry) => { entries.delete(entry.subject); entry.unregister(); emit(); };
  const current = (entry: Entry, scope: AbortController) => lifetime === scope && !scope.signal.aborted && entries.get(entry.subject) === entry;
  /** A standing sender keeps a refusal its `check` can act on: the domain's, or one the server
   * gave no reason for. Sign-in, a stale build and a busy server are the transport's to say, with
   * its verb, since a reread cannot answer them. */
  const refuse = (entry: Entry, error: ApiError) => {
    const fact = refusedFact(entry);
    const reason = refusalReason(entry, error);
    const reviewable = reason !== undefined || transportOf(error) === "Refused";
    if (reviewable && entry.shown?.()) {
      entry.phase = "Refused";
      entry.refusal = { fact, reason };
      emit();
      return;
    }
    retire(entry);
    if (reason === undefined) outcome.fail(error, fact);
    else outcome.say({ fact, reason });
  };
  async function send(entry: Entry): Promise<boolean> {
    const scope = lifetime;
    if (scope === null || scope.signal.aborted || entries.get(entry.subject) !== entry) return false;
    entry.phase = "Sending";
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
      if (isRefusal(error) && !entry.uncertain) refuse(entry, error);
      else {
        if (entry.uncertain) entry.attempt += 1;
        entry.uncertain = true;
        entry.replayRefused ||= isRefusal(error);
        entry.phase = "Unknown";
        handleUnauthenticatedApiError(error);
        if ((!isApiError(error) && !isAbortError(error)) || isSameSystemApiDefect(error)) defect({ error });
        emit();
      }
      return false;
    }
    if (!current(entry, scope)) return false;
    retire(entry);
    publishChange("Podcasts", "Entries", "Lectern", "Metadata");
    entry.onAccepted?.();
    return true;
  }
  const commands = {
    /** `title` is the subject's own; `library` names a non-default destination. `shown` is true
     * while the sender's surface stands to show a refusal, with `check` reviewing it. */
    submit(input: { subject: string; title: string; library?: string | null; command: PodcastCommand; onAccepted?: () => void; shown?: () => boolean }): Promise<boolean> {
      if (lifetime === null || lifetime.signal.aborted || entries.has(input.subject)) return Promise.resolve(false);
      const key = `podcast-command:${accountId}:${crypto.randomUUID()}`;
      const entry: Entry = { key, subject: input.subject, title: input.title, library: input.library ?? null, command: input.command,
        body: JSON.stringify(input.command.body), shown: input.shown ?? null, onAccepted: input.onAccepted ?? null,
        phase: "Sending", uncertain: false, replayRefused: false, attempt: 0, refusal: null, unregister: () => {} };
      entry.unregister = guard.register({ id: key, scope: { kind: "account" }, subscribe, read: () => ({ changed: false, unconfirmed: entry.phase !== "Refused", stopsBrowserWork: false }) });
      entries.set(input.subject, entry); emit(); return send(entry);
    },
    pending(subject: string) { return entries.get(subject) ?? null; },
    /** An unanswered command: a replay of its exact request, or an import's read of its operation. */
    async check(key: string) {
      const entry = snapshot.find(value => value.key === key), scope = lifetime;
      if (entry === undefined || entry.phase !== "Unknown" || scope === null) return;
      const command = entry.command;
      if (command.kind !== "Import") { await send(entry); return; }
      entry.phase = "Sending"; emit();
      try {
        const operation = await requestWithDeadline({ signal: scope.signal, timeoutMs: 30_000, request: signal => getPodcastImport(command.libraryId, command.importId, signal) });
        if (!current(entry, scope)) return;
        const confirmed = command.action === "cancel"
          ? operation.state === "cancelled" || operation.state === "complete"
          : operation.attempt_version === command.body.expected_attempt_version + 1;
        if (confirmed) { retire(entry); publishChange("Podcasts", "Entries"); }
        else { entry.phase = "Unknown"; entry.attempt += 1; emit(); }
      } catch (error) {
        if (!current(entry, scope)) return;
        entry.phase = "Unknown";
        entry.attempt += 1;
        if (!isApiError(error) && !isAbortError(error)) defect({ error });
        emit();
      }
      invalidateReads("Podcasts", "Entries");
    },
    /** A refused command's `check`, or an unanswered one's `stop tracking`: it forgets the
     * command after the loss prompt, and never undoes it. */
    review(key: string) {
      const entry = snapshot.find(value => value.key === key);
      if (entry === undefined || entry.phase === "Sending" && !entry.uncertain) return;
      if (entry.uncertain && !guard.confirmLoss({ scopes: [], ownerIds: [entry.key] })) return;
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

export function usePodcastCommands(accountId: string, defect: (input: { error: unknown }) => void) {
  const guard = useWorkGuard();
  const outcome = useOutcome();
  const owner = useMemo(() => createOwner(accountId, guard, defect, outcome), [accountId, guard, defect, outcome]);
  useLayoutEffect(() => owner.start(), [owner]);
  // A fresh command object per published change re-renders the subjects that read `pending`.
  const entries = useSyncExternalStore(owner.subscribe, owner.snapshot, () => EMPTY);
  const commands = { ...owner.commands };
  return { commands, feedback: entries.filter(entry => entry.uncertain).map(entry => {
    const forget = { label: "stop tracking", commandKey: `forget ${entry.key}`, run: () => commands.review(entry.key) };
    const resolve = { label: entry.command.kind === "Import" ? "check" : "retry", commandKey: `check ${entry.key}`, run: () => void commands.check(entry.key), busy: entry.phase === "Sending" };
    const verbs: Verbs = entry.replayRefused && entry.command.kind !== "Import" ? [forget] : [resolve, forget];
    return <Hold key={entry.key} id={entry.key} attempt={entry.attempt}
      line={{ fact: `not sure ${unsettledThing(entry)} saved.`, reason: "it may have gone through." }} verbs={verbs} />;
  }) };
}
