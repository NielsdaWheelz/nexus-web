"use client";

/** Account-memory podcast commands freeze ids, scope and guards before sending.
 * Dismissal retires presentation only. Admission checks replay the same ids;
 * other checks retain exact guards and never infer success from absent rows.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useFeedback, useWorkspaceCondition, type FeedbackContextValue, type FeedbackContent } from "@/components/feedback/Feedback";
import { assertNever } from "@/lib/assertNever";
import { isApiError, isRefusal, isSameSystemApiDefect } from "@/lib/api/client";
import { invalidateReads, publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { admitPodcast, changePodcastImport, getPodcastImport, stopPodcast } from "./api";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";

export type PodcastCommand =
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
}
const EMPTY: readonly Entry[] = [];

function createOwner(accountId: string, guard: WorkGuard, feedback: FeedbackContextValue, fail: (input: { error: unknown }) => void) {
  let lifetime: AbortController | null = null;
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const emit = () => { snapshot = [...entries.values()]; for (const listener of listeners) listener(); };
  const retire = (entry: Entry) => { entries.delete(entry.subject); entry.unregister(); emit(); };
  const current = (entry: Entry, scope: AbortController) => lifetime === scope && !scope.signal.aborted && entries.get(entry.subject) === entry;
  async function send(entry: Entry): Promise<boolean> {
    const scope = lifetime;
    if (scope === null || scope.signal.aborted || entries.get(entry.subject) !== entry) return false;
    entry.phase = "Sending";
    entry.failure = null;
    emit();
    const command = entry.command;
    try {
      const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(30_000)]);
      switch (command.kind) {
        case "Admission": await admitPodcast(command.libraryId, command.mode, entry.body, signal); break;
        case "Stop": await stopPodcast(command.podcastId, entry.body, signal); break;
        case "Import": await changePodcastImport(command.libraryId, command.importId, command.action, entry.body, signal); break;
        default: assertNever(command);
      }
    } catch (error) {
      if (!current(entry, scope)) return false;
      invalidateReads("Podcasts", "Entries");
      if (isApiError(error)) entry.requestId = error.requestId ?? null;
      if (isRefusal(error)) {
        entry.phase = entry.uncertain ? "Unknown" : "Refused";
        entry.failure = entry.uncertain
          ? { tone: "Warning", title: "change not confirmed", message: "the exact retry was refused. the original request may have succeeded. review the current state before choosing again.", requestId: error.requestId }
          : { tone: "Warning", title: error.status === 409 ? "library changed. review it and choose again." : "podcast change refused.", message: "review the current state before choosing again.", requestId: error.requestId };
      } else {
        entry.uncertain = true;
        entry.phase = "Unknown";
        handleUnauthenticatedApiError(error);
        if ((!isApiError(error) && !isAbortError(error)) || isSameSystemApiDefect(error)) fail({ error });
      }
      emit();
      return false;
    }
    if (!current(entry, scope)) return false;
    retire(entry);
    publishChange("Podcasts", "Entries", "Lectern", "Metadata");
    feedback.settleCondition({ key: entry.key, content: { tone: "Success", title: command.kind === "Admission" ? `${command.mode === "follow" ? "subscribed" : "import started"} · ${entry.title}`
      : command.kind === "Stop" ? `podcast change saved · ${entry.title}`
        : command.action === "cancel" ? `import stopped; arrived episodes kept · ${entry.title}` : `import retry accepted · ${entry.title}` } });
    entry.onAccepted?.();
    return true;
  }
  return {
    subscribe, snapshot: () => snapshot,
    start() {
      const scope = new AbortController(); lifetime = scope;
      return () => { scope.abort(); if (lifetime !== scope) return; lifetime = null; for (const entry of entries.values()) entry.unregister(); entries.clear(); emit(); };
    },
    commands: {
      submit(input: { subject: string; title: string; command: PodcastCommand; onAccepted?: () => void }): Promise<boolean> {
        if (lifetime === null || lifetime.signal.aborted || entries.has(input.subject)) return Promise.resolve(false);
        const key = `podcast-command:${accountId}:${crypto.randomUUID()}`;
        const entry: Entry = { ...input, key, body: JSON.stringify(input.command.body), onAccepted: input.onAccepted ?? null, phase: "Sending", uncertain: false, requestId: null, failure: null,
          unregister: () => {} };
        entry.unregister = guard.register({ id: key, scope: { kind: "account" }, subscribe, read: () => ({ changed: false, unconfirmed: entry.phase !== "Refused", stopsBrowserWork: false }) });
        entries.set(input.subject, entry); emit(); return send(entry);
      },
      pending(subject: string) { return entries.get(subject) ?? null; },
      async check(key: string) {
        const entry = snapshot.find(value => value.key === key), scope = lifetime;
        if (entry === undefined || entry.phase !== "Unknown" || scope === null) return;
        if (entry.command.kind !== "Import") { await send(entry); return; }
        entry.phase = "Sending"; emit();
        try {
          const operation = await getPodcastImport(entry.command.libraryId, entry.command.importId, AbortSignal.any([scope.signal, AbortSignal.timeout(30_000)]));
          if (!current(entry, scope)) return;
          const confirmed = entry.command.action === "cancel"
            ? operation.state === "cancelled" || operation.state === "complete"
            : operation.attempt_version === entry.command.body.expected_attempt_version + 1;
          if (confirmed) {
            retire(entry); publishChange("Podcasts", "Entries");
            feedback.settleCondition({ key: entry.key, content: { tone: "Success", title: entry.command.action === "cancel" ? "import is stopped; arrived episodes kept" : "import retry confirmed" } });
          } else { entry.phase = "Unknown"; emit(); }
        } catch (error) {
          if (!current(entry, scope)) return;
          entry.phase = "Unknown";
          if (isApiError(error)) entry.requestId = error.requestId ?? null;
          else if (!isAbortError(error)) fail({ error });
          emit();
        }
        invalidateReads("Podcasts", "Entries");
      },
      review(key: string) {
        const entry = snapshot.find(value => value.key === key);
        if (entry === undefined || entry.phase === "Sending") return;
        if (entry.phase === "Unknown" && !guard.confirmLoss({ scopes: [], ownerIds: [entry.key] })) return;
        invalidateReads("Podcasts", "Entries"); retire(entry);
      },
    },
  };
}

export function usePodcastCommands(accountId: string, fail: (input: { error: unknown }) => void) {
  const guard = useWorkGuard();
  const feedback = useFeedback();
  const owner = useMemo(() => createOwner(accountId, guard, feedback, fail), [accountId, guard, feedback, fail]);
  useLayoutEffect(() => owner.start(), [owner]);
  const entries = useSyncExternalStore(owner.subscribe, owner.snapshot, () => EMPTY);
  return { commands: { ...owner.commands }, feedback: entries.map(entry => <CommandCondition key={entry.key} entry={entry} commands={owner.commands} />) };
}
function CommandCondition({ entry, commands }: { entry: Entry; commands: ReturnType<typeof createOwner>["commands"] }) {
  const admission = entry.command.kind === "Admission" ? entry.command : null;
  useWorkspaceCondition(entry.key, { priority: "Write", announcement: "Polite",
    content: entry.failure ?? { tone: entry.phase === "Sending" ? "Neutral" : "Warning", title: `${entry.phase === "Sending" ? admission === null ? "changing podcast…" : admission.mode === "follow" ? "subscribing…" : "starting import…" : "change not confirmed"} · ${entry.title}`,
      message: entry.phase === "Unknown" ? "the request may have succeeded. checking retains the original ids and guards." : undefined, requestId: entry.requestId ?? undefined },
    actions: entry.phase === "Sending" ? undefined : entry.phase === "Refused" ? [{ label: "review current state", onClick: () => commands.review(entry.key) }]
      : [{ label: "check change", commandKey: entry.key, onClick: () => { void commands.check(entry.key); } }, { label: "stop tracking", onClick: () => commands.review(entry.key) }],
  });
  return null;
}
