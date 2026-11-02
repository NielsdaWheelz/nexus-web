"use client";

/** Independent playback defaults belong to the account, never a subscription or
 * dialog lifetime. Commands freeze row identity, exact version and desired pair.
 * The settings dialog and the player show the save's state. The owner says each outcome
 * once, as a slip, since either may have closed; an unconfirmed save is held in `feedback`
 * until a read settles it. Mount `feedback` once.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { Hold, useOutcome, type Outcome } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { type ApiError, outcomeUnknown, requestWithDeadline } from "@/lib/api/client";
import { invalidateReads, publishChange } from "@/lib/api/changes";
import { modeledApiError, requestWithRetry } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { getPodcastSettings, savePodcastSettings, type PodcastSettings } from "./api";

type Patch = Schema<"PodcastPlaybackSettingsRequest">;
type Command = { readonly patch: Patch };
type Reason = "Conflict" | "Unknown";
type SettingsSave =
  | { readonly kind: "Saving"; readonly command: Command }
  | { readonly kind: "Accepted"; readonly command: Command; readonly current: PodcastSettings }
  | { readonly kind: "Rejected"; readonly command: Command; readonly error: ApiError }
  | { readonly kind: "Unknown"; readonly command: Command; readonly error: ApiError }
  | { readonly kind: "Reading"; readonly command: Command; readonly reason: Reason }
  | { readonly kind: "Review"; readonly command: Command; readonly reason: Reason; readonly current: PodcastSettings }
  | { readonly kind: "ReadFailed"; readonly command: Command; readonly reason: Reason; readonly error: ApiError }
  | { readonly kind: "Absent"; readonly command: Command }
  | { readonly kind: "Replaced"; readonly command: Command };
interface Entry {
  readonly podcastId: string;
  /** The podcast's own title. */
  readonly title: string;
  readonly ownerId: string;
  unregister: () => void;
  state: SettingsSave;
  busy: boolean;
  /** Bumps per failed check of an unconfirmed save, so its held line speaks again. */
  attempt: number;
}
const EMPTY: readonly Entry[] = [];
/** The save may have landed until a read says otherwise. */
const unconfirmed = (state: SettingsSave) =>
  state.kind === "Unknown" || (state.kind === "Reading" || state.kind === "ReadFailed") && state.reason === "Unknown";
const unsaved = (entry: Entry) => `couldn’t save the defaults for “${entry.title}”.`;
function createOwner(accountId: string, guard: WorkGuard, fail: (input: { error: unknown }) => void, outcome: Outcome) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  let lifetime: AbortController | null = null;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const emit = () => { snapshot = [...entries.values()]; for (const listener of listeners) listener(); };
  const current = (entry: Entry, scope: AbortController) => lifetime === scope && !scope.signal.aborted && entries.get(entry.podcastId) === entry;
  async function read(entry: Entry, reason: Reason, scope: AbortController): Promise<PodcastSettings | null> {
    const command = entry.state.command;
    entry.state = { kind: "Reading", command, reason }; emit();
    invalidateReads("Podcasts");
    try {
      const value = await requestWithDeadline({ signal: scope.signal, timeoutMs: 30_000, request: signal => requestWithRetry(s => getPodcastSettings(entry.podcastId, s), signal) });
      if (!current(entry, scope)) return null;
      if (value.id !== null && value.id !== command.patch.id) {
        entry.state = { kind: "Replaced", command }; emit();
        outcome.say({ fact: unsaved(entry), reason: "they were replaced elsewhere." });
        return null;
      }
      if (reason === "Unknown" && value.id === command.patch.id && value.default_playback_speed === command.patch.default_playback_speed && value.pause_shortening_mode === command.patch.pause_shortening_mode) {
        entry.state = { kind: "Accepted", command, current: value }; emit(); publishChange("Podcasts"); return value;
      }
      entry.state = { kind: "Review", command, reason, current: value }; emit();
      outcome.say({ fact: unsaved(entry), reason: "they changed elsewhere." });
    } catch (caught) {
      if (!current(entry, scope)) return null;
      const error = modeledApiError(caught, fail);
      if (error === null) { emit(); return null; }
      if (error.code === "E_NOT_FOUND") {
        entry.state = { kind: "Absent", command }; emit();
        outcome.say({ fact: unsaved(entry), reason: "it isn’t available anymore." });
        return null;
      }
      entry.state = { kind: "ReadFailed", command, reason, error };
      if (reason === "Unknown") entry.attempt += 1;
      emit();
      if (reason === "Conflict") outcome.say({ fact: unsaved(entry), reason: "they changed elsewhere." },
        [{ label: "check", commandKey: `check ${entry.ownerId}`, run: () => void commands.check(entry.podcastId) }]);
    }
    return null;
  }
  async function send(entry: Entry): Promise<PodcastSettings | null> {
    const scope = lifetime;
    if (scope === null || scope.signal.aborted || entry.busy) return null;
    const command = entry.state.command;
    entry.busy = true; entry.state = { kind: "Saving", command }; emit();
    try {
      const value = await requestWithDeadline({ signal: scope.signal, timeoutMs: 30_000, request: signal => savePodcastSettings(entry.podcastId, command.patch, signal) });
      if (!current(entry, scope)) return null;
      entry.state = { kind: "Accepted", command, current: value }; emit(); return value;
    } catch (caught) {
      if (!current(entry, scope)) return null;
      const error = modeledApiError(caught, fail);
      if (error?.status === 409) return await read(entry, "Conflict", scope);
      if (error !== null) entry.state = error.code === "E_NOT_FOUND" ? { kind: "Absent", command } : { kind: outcomeUnknown(error) ? "Unknown" : "Rejected", command, error };
      invalidateReads("Podcasts"); emit();
      if (entry.state.kind === "Absent") outcome.say({ fact: unsaved(entry), reason: "it isn’t available anymore." });
      if (entry.state.kind === "Rejected") outcome.fail(entry.state.error, unsaved(entry),
        { label: "retry", commandKey: `retry ${entry.ownerId}`, run: () => void commands.retry(entry.podcastId) });
      return null;
    } finally { if (current(entry, scope)) { entry.busy = false; emit(); } }
  }
  const commands = {
    state: (id: string | null) => id === null ? null : entries.get(id)?.state ?? null,
    save(id: string, title: string, patch: Patch) {
      const old = entries.get(id);
      if (old?.busy || old?.state.kind === "Unknown" || old?.state.kind === "ReadFailed") return Promise.resolve(null);
      old?.unregister();
      const ownerId = `podcast-settings:${accountId}:${id}`;
      const entry: Entry = { podcastId: id, title, ownerId, state: { kind: "Saving", command: { patch: { ...patch } } }, busy: false,
        attempt: 0, unregister: () => {} };
      entry.unregister = guard.register({ id: ownerId, scope: { kind: "account" }, subscribe, read: () => ({ changed: false, unconfirmed: entry.state.kind === "Saving" || unconfirmed(entry.state), stopsBrowserWork: false }) });
      entries.set(id, entry); return send(entry);
    },
    reset(id: string) { const entry = entries.get(id); if (entry === undefined || entry.busy || entry.state.kind === "Unknown" || entry.state.kind === "ReadFailed" || entry.state.kind === "Rejected") return; entries.delete(id); entry.unregister(); emit(); },
    retry(id: string) { const entry = entries.get(id); return entry?.state.kind === "Rejected" ? send(entry) : Promise.resolve(null); },
    async check(id: string) {
      const entry = entries.get(id), scope = lifetime;
      if (scope === null || entry === undefined || entry.busy || (entry.state.kind !== "Unknown" && entry.state.kind !== "ReadFailed")) return null;
      const reason = entry.state.kind === "Unknown" ? "Unknown" : entry.state.reason;
      entry.busy = true;
      try { return await read(entry, reason, scope); } finally { if (current(entry, scope)) { entry.busy = false; emit(); } }
    },
  };
  return { subscribe, snapshot: () => snapshot, commands,
    start() { const scope = new AbortController(); lifetime = scope; return () => { scope.abort(); if (lifetime !== scope) return; lifetime = null; for (const entry of entries.values()) entry.unregister(); entries.clear(); emit(); }; },
  };
}
export function usePodcastSettingsOwner(accountId: string, fail: (input: { error: unknown }) => void) {
  const guard = useWorkGuard();
  const outcome = useOutcome();
  const owner = useMemo(() => createOwner(accountId, guard, fail, outcome), [accountId, guard, fail, outcome]);
  useLayoutEffect(() => owner.start(), [owner]);
  // Its dialog and the player read `state`; a fresh command object re-renders them.
  const entries = useSyncExternalStore(owner.subscribe, owner.snapshot, () => EMPTY);
  const commands = { ...owner.commands };
  return { commands, feedback: entries.filter(entry => unconfirmed(entry.state)).map(entry =>
    <Hold key={entry.ownerId} id={entry.ownerId} attempt={entry.attempt}
      line={{ fact: `not sure the defaults for “${entry.title}” saved.`, reason: "it may have gone through." }}
      verbs={[{ label: "check", commandKey: `check ${entry.ownerId}`, run: () => void commands.check(entry.podcastId), busy: entry.state.kind === "Reading" }]} />) };
}

export function usePodcastSettingsSave(podcastId: string | null, title: string, subject: string | null) {
  const { ctx } = useActionRuntime();
  const commands = ctx.podcastSettings;
  const state = commands.state(podcastId);
  return { state, busy: state?.kind === "Saving" || state?.kind === "Reading",
    reset: () => { if (podcastId !== null) commands.reset(podcastId); },
    save: (patch: Patch) => podcastId !== null && subject !== null ? commands.save(podcastId, title, patch) : Promise.resolve(null),
  };
}
